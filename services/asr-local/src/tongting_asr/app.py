"""FastAPI 应用：GET /health 与 POST /v1/transcribe（契约见 src/providers/asr/types.ts）。"""

from __future__ import annotations

import asyncio
import re
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import anyio
import numpy as np
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.requests import ClientDisconnect
from starlette.responses import JSONResponse, Response

from . import __version__
from .config import ServiceConfig
from .errors import ApiError, api_error_response, error_response
from .gate import BusyError, ClientDisconnected, GateClosed, InferenceGate
from .log import LogThrottle, describe_exception, get_logger
from .model_manager import ModelManager
from .security import SecurityMiddleware, TokenVerifier
from .transcriber import TranscriptionResult
from .wav import WAV_MIME_TYPES, PcmAudio, parse_wav
from .youtube import YoutubePreloader, parse_window, unavailable

logger = get_logger("http")

_LANGUAGE_RE = re.compile(r"^[a-z]{2,3}$")
_CLOSE = {"Connection": "close"}


class ClientGone(Exception):
    """客户端在上传或排队期间断开。"""

    def __init__(self, stage: str) -> None:
        super().__init__(stage)
        self.stage = stage


def parse_language(values: list[str]) -> str | None:
    """返回 None 表示自动检测。接受 BCP 47 形式（如 en-US、zh-Hans），只取主语言子标签。"""
    if len(values) > 1:
        raise ApiError(400, "invalid_language", "language 参数只能出现一次。")
    raw = values[0].strip().lower() if values else "auto"
    if raw in ("", "auto"):
        return None
    primary = re.split(r"[-_]", raw, maxsplit=1)[0]
    if not _LANGUAGE_RE.fullmatch(primary):
        raise ApiError(400, "invalid_language", "language 必须是 auto 或语言代码（如 en、ja、zh）。")
    return primary


def _too_large(max_bytes: int) -> ApiError:
    limit = f"{max_bytes // (1024 * 1024)} MB" if max_bytes >= 1024 * 1024 else f"{max_bytes} 字节"
    return ApiError(413, "payload_too_large", f"请求体超过上限 {limit}。", headers=_CLOSE)


async def read_body_limited(request: Request, max_bytes: int, timeout_s: float) -> bytes:
    """读取请求体：先按 Content-Length 预检，再在流式读取时计数；整体有读取时限。"""
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            declared = int(content_length)
        except ValueError:
            raise ApiError(400, "invalid_request", "Content-Length 不合法。", headers=_CLOSE) from None
        if declared < 0:
            raise ApiError(400, "invalid_request", "Content-Length 不合法。", headers=_CLOSE)
        if declared > max_bytes:
            raise _too_large(max_bytes)
    body = bytearray()
    try:
        with anyio.fail_after(timeout_s):
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise _too_large(max_bytes)
    except TimeoutError:
        raise ApiError(
            408,
            "request_timeout",
            f"上传音频超时：{timeout_s:g} 秒内未收完请求体。",
            headers=_CLOSE,
        ) from None
    except ClientDisconnect:
        raise ClientGone("upload") from None
    return bytes(body)


def _round(value: float, digits: int = 4) -> float:
    return round(float(value), digits)


def transcription_payload(result: TranscriptionResult, audio: PcmAudio, processing_ms: int) -> dict:
    return {
        "text": result.text,
        "language": result.language,
        "languageProbability": _round(result.language_probability),
        "durationMs": audio.duration_ms,
        "processingMs": processing_ms,
        "segments": [
            {
                "startMs": segment.start_ms,
                "endMs": segment.end_ms,
                "text": segment.text,
                "avgLogprob": _round(segment.avg_logprob),
                "noSpeechProb": _round(segment.no_speech_prob),
            }
            for segment in result.segments
        ],
    }


class ShutdownState:
    """停止状态：只在事件循环线程中修改。"""

    def __init__(self) -> None:
        self.event = asyncio.Event()
        self.deadline: float | None = None

    @property
    def stopping(self) -> bool:
        return self.event.is_set()

    async def wait_deadline_passed(self) -> None:
        await self.event.wait()
        assert self.deadline is not None
        remaining = self.deadline - time.monotonic()
        if remaining > 0:
            await asyncio.sleep(remaining)


def _consume_task_result(task: asyncio.Future) -> None:
    # 被放弃等待的推理任务结束后读取一次结果，避免 asyncio 打印「exception was never retrieved」。
    if not task.cancelled():
        task.exception()


def create_app(
    *,
    config: ServiceConfig,
    manager: ModelManager,
    verify_token: TokenVerifier,
    log_throttle: LogThrottle | None = None,
) -> FastAPI:
    gate = InferenceGate(config.queue_size)
    shutdown = ShutdownState()
    youtube = YoutubePreloader(enabled=config.youtube_preload)
    throttle = log_throttle or LogThrottle(get_logger("security"))

    def begin_shutdown() -> None:
        """进入停止中（幂等，须在事件循环线程调用）：排队与新请求立即 503，只等正在进行的一段识别。"""
        if shutdown.stopping:
            return
        shutdown.deadline = time.monotonic() + config.shutdown_grace_s
        shutdown.event.set()
        youtube.close()
        gate.close()
        manager.begin_shutdown(shutdown.deadline)
        running = manager.active_inferences
        if running:
            logger.info("开始停止：拒绝新请求与排队请求，最多再等 %.0f 秒让进行中的识别完成。", config.shutdown_grace_s)
        else:
            logger.info("开始停止：拒绝新请求与排队请求。")

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        manager.start()
        try:
            yield
        finally:
            begin_shutdown()
            await run_in_threadpool(manager.close)
            throttle.flush()

    app = FastAPI(
        title="tongting-asr",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.gate = gate
    app.state.manager = manager
    app.state.shutdown = shutdown
    app.state.begin_shutdown = begin_shutdown
    app.state.log_throttle = throttle
    app.state.service_config = config
    app.state.youtube = youtube

    @app.exception_handler(ApiError)
    async def _api_error(_: Request, exc: ApiError) -> JSONResponse:
        return api_error_response(exc)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        codes = {404: ("not_found", "接口不存在。"), 405: ("method_not_allowed", "请求方法不被允许。")}
        code, message = codes.get(exc.status_code, ("http_error", "请求无法处理。"))
        return error_response(exc.status_code, code, message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(_: Request, __: RequestValidationError) -> JSONResponse:
        # 不回显请求内容。
        return error_response(400, "invalid_request", "请求参数不合法。")

    @app.exception_handler(Exception)
    async def _unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        logger.error("未处理的内部错误：%s", describe_exception(exc))
        return error_response(500, "internal_error", "服务内部错误，请查看服务日志。")

    @app.get("/health")
    async def health() -> JSONResponse:
        snapshot = manager.snapshot()
        return JSONResponse(
            {
                "status": snapshot.status,
                "ready": snapshot.ready,
                "model": snapshot.model,
                "device": snapshot.device,
                "computeType": snapshot.compute_type,
                "version": __version__,
                "youtubePreload": youtube.available,
            }
        )

    def client_closed(stage: str) -> Response:
        if stage == "upload":
            logger.info("客户端在上传音频时断开，已丢弃该请求。")
        else:
            logger.info("客户端在排队期间断开，已跳过该段音频。")
        return error_response(499, "client_closed_request", "客户端已断开。", _CLOSE)

    def stopping_error() -> ApiError:
        return ApiError(503, "model_unavailable", "服务正在停止，不再接受新的识别请求。", headers=_CLOSE)

    @app.post("/v1/youtube/transcribe")
    async def transcribe_youtube(request: Request) -> Response:
        if shutdown.stopping:
            raise stopping_error()
        if not youtube.available:
            raise unavailable()
        if request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ApiError(415, "unsupported_media_type", "Content-Type 必须是 application/json。")
        try:
            body = await read_body_limited(request, 4096, config.body_timeout_s)
        except ClientGone as exc:
            return client_closed(exc.stage)
        window = parse_window(body)
        language = parse_language([window.language])
        transcriber = manager.require_ready()
        if language is not None and language not in transcriber.supported_languages:
            raise ApiError(400, "unsupported_language", "当前模型不支持该语言代码。")
        try:
            # Fetching and inference share the same bounded queue. Rapid seeks cannot
            # launch unlimited downloaders, and live capture never races a second model call.
            async with gate.slot(request.is_disconnected):
                if await request.is_disconnected():
                    raise ClientDisconnected()
                audio = await _await_prefetch(youtube.fetch(window), request, shutdown)
                if await request.is_disconnected():
                    raise ClientDisconnected()
                if shutdown.stopping:
                    raise GateClosed()
                started = time.perf_counter()
                result = await _await_inference(manager, audio.to_float32(), language, shutdown)
                if result is None:
                    raise stopping_error()
                processing_ms = round((time.perf_counter() - started) * 1000)
                gate.record_processing_ms(processing_ms)
        except BusyError as exc:
            raise ApiError(429, "busy", "识别服务繁忙，请稍后重试。", headers={"Retry-After": str(exc.retry_after_s)}) from None
        except GateClosed:
            raise stopping_error() from None
        except ClientDisconnected:
            return client_closed("queue")
        payload = transcription_payload(result, audio, processing_ms)
        payload["startMs"] = window.start_ms
        return JSONResponse(payload)

    @app.post("/v1/transcribe")
    async def transcribe(request: Request) -> Response:
        if shutdown.stopping:
            raise stopping_error()
        mime = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
        if mime not in WAV_MIME_TYPES:
            raise ApiError(415, "unsupported_media_type", "Content-Type 必须是 audio/wav。")
        language = parse_language(request.query_params.getlist("language"))

        try:
            body = await read_body_limited(request, config.max_body_bytes, config.body_timeout_s)
        except ClientGone as exc:
            return client_closed(exc.stage)
        audio = parse_wav(body, max_audio_ms=config.max_audio_ms)
        del body

        transcriber = manager.require_ready()
        if language is not None and language not in transcriber.supported_languages:
            raise ApiError(400, "unsupported_language", "当前模型不支持该语言代码。")

        try:
            async with gate.slot(request.is_disconnected):
                if await request.is_disconnected():
                    raise ClientDisconnected()
                samples = audio.to_float32()
                started = time.perf_counter()
                result = await _await_inference(manager, samples, language, shutdown)
                if result is None:
                    logger.warning("停止等待已到上限，放弃等待进行中的识别并返回 503。")
                    raise ApiError(
                        503, "model_unavailable", "服务正在停止，已放弃等待本段识别。", headers=_CLOSE
                    )
                processing_ms = round((time.perf_counter() - started) * 1000)
                gate.record_processing_ms(processing_ms)
        except BusyError as exc:
            logger.info("推理繁忙，返回 429（排队 %d/%d）。", gate.pending, gate.capacity)
            raise ApiError(
                429,
                "busy",
                "识别服务繁忙，请稍后重试。",
                headers={"Retry-After": str(exc.retry_after_s)},
            ) from None
        except GateClosed:
            raise stopping_error() from None
        except ClientDisconnected:
            return client_closed("queue")

        logger.info(
            "转写完成：音频 %d ms，处理 %d ms（RTF %.2f），语言 %s（%.2f），片段 %d，字符 %d。",
            audio.duration_ms,
            processing_ms,
            processing_ms / max(audio.duration_ms, 1),
            result.language,
            result.language_probability,
            len(result.segments),
            len(result.text),
        )
        return JSONResponse(transcription_payload(result, audio, processing_ms))

    # 安全中间件位于路由与异常处理之外，未通过检查的请求不会进入任何业务代码。
    app.add_middleware(
        SecurityMiddleware,
        port=config.port,
        verify_token=verify_token,
        allowed_extension_ids=config.allowed_extension_ids,
        log_throttle=throttle,
    )
    return app


async def _await_prefetch(fetch, request: Request, shutdown: ShutdownState) -> PcmAudio:
    """Abort network/decoder processes promptly on disconnect, shutdown or route cancellation."""
    monitoring = True

    async def disconnected() -> None:
        # Starlette's nonblocking receive uses an AnyIO cancellation scope. An
        # external cancellation arriving inside that scope can be consumed there;
        # an explicit stop condition keeps successful fetches from waiting forever.
        while monitoring and not await request.is_disconnected():
            if not monitoring:
                return
            await asyncio.sleep(0.1)

    work = asyncio.create_task(fetch)
    closed = asyncio.create_task(disconnected())
    stopped = asyncio.create_task(shutdown.event.wait())
    tasks = {work, closed, stopped}
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        if stopped in done:
            raise GateClosed()
        if closed in done:
            raise ClientDisconnected()
        return work.result()
    finally:
        monitoring = False
        for task in tasks:
            if not task.done():
                task.cancel()
        # Wait for child termination and pipe cleanup before releasing the inference slot.
        await asyncio.gather(*tasks, return_exceptions=True)


async def _await_inference(
    manager: ModelManager,
    samples: np.ndarray,
    language: str | None,
    shutdown: ShutdownState,
) -> TranscriptionResult | None:
    """等待推理结果；服务停止且等待到达上限时返回 None（推理线程无法中断，会在后台跑完）。"""
    inference = asyncio.ensure_future(run_in_threadpool(_run_inference, manager, samples, language))
    deadline_passed = asyncio.ensure_future(shutdown.wait_deadline_passed())
    try:
        done, _ = await asyncio.wait({inference, deadline_passed}, return_when=asyncio.FIRST_COMPLETED)
    except BaseException:
        inference.add_done_callback(_consume_task_result)
        raise
    finally:
        deadline_passed.cancel()
    if inference in done:
        return inference.result()
    inference.add_done_callback(_consume_task_result)
    return None


def _run_inference(manager: ModelManager, samples: np.ndarray, language: str | None) -> TranscriptionResult:
    with manager.lease() as transcriber:
        try:
            return transcriber.transcribe(samples, language)
        except ApiError:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.error("转写失败：%s", describe_exception(exc))
            raise ApiError(500, "transcription_failed", "转写失败，请查看服务日志。") from None

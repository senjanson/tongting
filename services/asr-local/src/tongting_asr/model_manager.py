"""模型生命周期：后台加载、状态查询、关闭释放。"""

from __future__ import annotations

import gc
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass

from .errors import ApiError
from .log import describe_exception, get_logger
from .transcriber import ModelLoadError, PhaseCallback, Transcriber

logger = get_logger("model")

TranscriberFactory = Callable[[PhaseCallback], Transcriber]

# 内部阶段；对外 /health 只映射为 loading / ok / error。
PHASE_PENDING = "pending"
PHASE_DOWNLOADING = "downloading"
PHASE_LOADING = "loading"
PHASE_READY = "ready"
PHASE_ERROR = "error"
PHASE_STOPPING = "stopping"
PHASE_CLOSED = "closed"

_PROGRESS_LOG_INTERVAL_S = 15.0
# 未经 begin_shutdown 直接 close 时，等待进行中推理结束的上限；
# 超时则只丢弃引用，不强行卸载正在使用的模型。
_DEFAULT_CLOSE_WAIT_S = 30.0


@dataclass(frozen=True)
class HealthSnapshot:
    status: str
    ready: bool
    model: str
    device: str
    compute_type: str
    phase: str


class ModelManager:
    def __init__(
        self,
        factory: TranscriberFactory,
        *,
        model_name: str,
        device: str,
        compute_type: str,
    ) -> None:
        self._factory = factory
        self._lock = threading.Lock()
        self._idle = threading.Condition(self._lock)
        self._active = 0
        self._phase = PHASE_PENDING
        self._transcriber: Transcriber | None = None
        self._model_name = model_name
        self._device = device
        self._compute_type = compute_type
        self._thread: threading.Thread | None = None
        self._closed = False
        self._stopping = False
        self._close_deadline: float | None = None
        self._done = threading.Event()

    # ---- 状态 ----

    @property
    def phase(self) -> str:
        with self._lock:
            return self._phase

    def snapshot(self) -> HealthSnapshot:
        with self._lock:
            phase = self._phase
            if phase == PHASE_READY:
                status = "ok"
            elif phase in (PHASE_ERROR, PHASE_STOPPING, PHASE_CLOSED):
                status = "error"
            else:
                status = "loading"
            return HealthSnapshot(
                status=status,
                ready=phase == PHASE_READY,
                model=self._model_name,
                device=self._device,
                compute_type=self._compute_type,
                phase=phase,
            )

    def require_ready(self) -> Transcriber:
        with self._lock:
            return self._ready_locked()

    def _ready_locked(self) -> Transcriber:
        phase = self._phase
        transcriber = self._transcriber
        if phase == PHASE_READY and transcriber is not None:
            return transcriber
        if phase in (PHASE_PENDING, PHASE_DOWNLOADING, PHASE_LOADING):
            message = "模型正在下载，请稍后重试。" if phase == PHASE_DOWNLOADING else "模型正在加载，请稍后重试。"
            raise ApiError(503, "model_loading", message, headers={"Retry-After": "5"})
        if phase in (PHASE_STOPPING, PHASE_CLOSED):
            raise ApiError(503, "model_unavailable", "服务正在停止，不再接受新的识别请求。")
        raise ApiError(503, "model_unavailable", "模型不可用：加载失败，请查看服务日志。")

    @contextmanager
    def lease(self) -> Iterator[Transcriber]:
        """在推理期间持有模型；close() 会等待所有租用结束后再卸载。"""
        with self._lock:
            transcriber = self._ready_locked()
            self._active += 1
        try:
            yield transcriber
        finally:
            with self._lock:
                self._active -= 1
                self._idle.notify_all()

    def wait_until_settled(self, timeout: float | None = None) -> bool:
        """等待加载结束（成功或失败）。供 bench 与测试使用。"""
        return self._done.wait(timeout)

    # ---- 生命周期 ----

    def start(self) -> None:
        with self._lock:
            if self._thread is not None or self._closed:
                return
            self._phase = PHASE_LOADING
            self._thread = threading.Thread(target=self._load, name="tongting-asr-model-loader", daemon=True)
            thread = self._thread
        thread.start()

    @property
    def active_inferences(self) -> int:
        with self._lock:
            return self._active

    def begin_shutdown(self, deadline: float) -> None:
        """进入停止中：不再发放新的推理租用；close() 最多等到 deadline（time.monotonic 时间）。"""
        with self._lock:
            if self._closed or self._stopping:
                return
            self._stopping = True
            self._close_deadline = deadline
            self._phase = PHASE_STOPPING

    def _set_phase(self, phase: str) -> None:
        with self._lock:
            if self._closed or self._stopping or self._phase in (PHASE_READY, PHASE_ERROR):
                return
            self._phase = phase
        logger.info("模型状态：%s", "下载中" if phase == PHASE_DOWNLOADING else "加载中")

    def _progress_logger(self, started: float) -> None:
        while not self._done.wait(_PROGRESS_LOG_INTERVAL_S):
            phase = self.phase
            if phase not in (PHASE_DOWNLOADING, PHASE_LOADING):
                return
            label = "下载" if phase == PHASE_DOWNLOADING else "加载"
            logger.info("模型仍在%s中（已用 %.0f 秒）……", label, time.monotonic() - started)

    def _load(self) -> None:
        started = time.monotonic()
        logger.info("开始准备模型 %s（device=%s，compute_type=%s）。", self._model_name, self._device, self._compute_type)
        threading.Thread(
            target=self._progress_logger, args=(started,), name="tongting-asr-load-progress", daemon=True
        ).start()
        try:
            transcriber = self._factory(self._set_phase)
        except ModelLoadError as exc:
            self._fail(str(exc))
            return
        except BaseException as exc:  # noqa: BLE001 - 任何失败都要落到 error 状态
            self._fail(f"模型加载失败：{describe_exception(exc)}")
            return

        with self._lock:
            closed = self._closed
            if not closed:
                self._transcriber = transcriber
                self._device = transcriber.device
                self._compute_type = transcriber.compute_type
                if not self._stopping:
                    self._phase = PHASE_READY
        if closed:
            # 加载期间服务已停止：立即释放，不转入可用状态。
            self._safe_close(transcriber)
        else:
            logger.info("模型就绪，总用时 %.1f 秒。", time.monotonic() - started)
        self._done.set()

    def _fail(self, message: str) -> None:
        with self._lock:
            if not self._closed and not self._stopping:
                self._phase = PHASE_ERROR
        logger.error("%s", message)
        self._done.set()

    @staticmethod
    def _safe_close(transcriber: Transcriber) -> None:
        try:
            transcriber.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("释放模型时出错：%s", describe_exception(exc))

    def close(self) -> None:
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._phase = PHASE_CLOSED
            transcriber, self._transcriber = self._transcriber, None
            if self._close_deadline is not None:
                timeout = max(0.0, self._close_deadline - time.monotonic())
            else:
                timeout = _DEFAULT_CLOSE_WAIT_S
            idle = self._idle.wait_for(lambda: self._active == 0, timeout=timeout)
        if transcriber is None:
            return
        if idle:
            self._safe_close(transcriber)
            logger.info("模型已释放。")
        else:
            logger.warning(
                "停止等待已到上限，仍有 1 段识别在进行；不强行卸载模型，进程会在该段推理线程结束后退出。"
            )
        del transcriber
        gc.collect()

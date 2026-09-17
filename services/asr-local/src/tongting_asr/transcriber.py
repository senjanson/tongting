"""转写器接口与 faster-whisper 实现。

服务端只依赖 `Transcriber` 协议，测试注入假转写器即可覆盖 HTTP 行为而不下载模型。
"""

from __future__ import annotations

import math
import os
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np

from .config import SAMPLE_RATE, ModelConfig, display_model_name
from .log import describe_exception, get_logger, sanitize_text

logger = get_logger("model")

# 阶段回调：下载/加载进度只用于日志与健康状态，不影响契约字段。
PhaseCallback = Callable[[str], None]


@dataclass(frozen=True)
class SegmentResult:
    start_ms: int
    end_ms: int
    text: str
    avg_logprob: float
    no_speech_prob: float


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    language_probability: float
    segments: list[SegmentResult]


class Transcriber(Protocol):
    model_name: str
    device: str
    compute_type: str
    supported_languages: frozenset[str]

    def transcribe(self, audio: np.ndarray, language: str | None) -> TranscriptionResult: ...

    def close(self) -> None: ...


class ModelLoadError(RuntimeError):
    """模型下载或加载失败；消息已脱敏，可写入日志。"""


def _finite(value: Any, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    return number if math.isfinite(number) else fallback


def build_segments(raw_segments: Iterable[Any], duration_ms: int) -> tuple[str, list[SegmentResult]]:
    """把 faster-whisper 的秒级片段转换为毫秒片段；时间夹在 [0, durationMs] 内。"""
    texts: list[str] = []
    segments: list[SegmentResult] = []
    for raw in raw_segments:
        raw_text = str(getattr(raw, "text", "") or "")
        text = raw_text.strip()
        if not text:
            continue
        texts.append(raw_text)
        start_ms = min(max(round(_finite(raw.start, 0.0) * 1000), 0), duration_ms)
        end_ms = min(max(round(_finite(raw.end, 0.0) * 1000), start_ms), duration_ms)
        segments.append(
            SegmentResult(
                start_ms=start_ms,
                end_ms=end_ms,
                text=text,
                avg_logprob=_finite(getattr(raw, "avg_logprob", None), -100.0),
                no_speech_prob=min(max(_finite(getattr(raw, "no_speech_prob", None), 0.0), 0.0), 1.0),
            )
        )
    # 英文片段自带前导空格，中日文没有；直接拼接再去首尾空白。
    return "".join(texts).strip(), segments


class FasterWhisperTranscriber:
    def __init__(
        self,
        model: Any,
        *,
        model_name: str,
        device: str,
        compute_type: str,
        beam_size: int,
        supported_languages: Iterable[str],
    ) -> None:
        self._model = model
        self.model_name = model_name
        self.device = device
        self.compute_type = compute_type
        self.beam_size = beam_size
        self.supported_languages = frozenset(supported_languages)

    def transcribe(self, audio: np.ndarray, language: str | None) -> TranscriptionResult:
        model = self._model
        if model is None:
            raise RuntimeError("模型已释放")
        duration_ms = round(audio.shape[0] * 1000 / SAMPLE_RATE)
        raw_segments, info = model.transcribe(
            audio,
            language=language,
            task="transcribe",
            beam_size=self.beam_size,
            # 减少静音/音乐段幻觉：VAD 先切掉非人声，且不把上一窗口文本当作提示。
            vad_filter=True,
            condition_on_previous_text=False,
            without_timestamps=False,
            word_timestamps=False,
            log_progress=False,
        )
        # segments 是惰性生成器，真正的解码在迭代时发生。
        text, segments = build_segments(raw_segments, duration_ms)
        return TranscriptionResult(
            text=text,
            language=str(info.language),
            language_probability=min(max(_finite(info.language_probability, 0.0), 0.0), 1.0),
            segments=segments,
        )

    def close(self) -> None:
        model, self._model = self._model, None
        if model is not None:
            unload = getattr(getattr(model, "model", None), "unload_model", None)
            if callable(unload):
                try:
                    unload()
                except Exception as exc:  # noqa: BLE001 - 释放失败不应阻止退出
                    logger.warning("释放模型时出错：%s", describe_exception(exc))
            del model


def _hf_endpoint_for_log() -> str:
    endpoint = os.environ.get("HF_ENDPOINT")
    if not endpoint:
        return "https://huggingface.co（默认；可用 HF_ENDPOINT 指定镜像）"
    return sanitize_text(endpoint) + "（来自 HF_ENDPOINT）"


def load_faster_whisper(config: ModelConfig, on_phase: PhaseCallback) -> FasterWhisperTranscriber:
    """在后台线程中调用：必要时下载模型，然后加载到 CPU。"""
    try:
        import ctranslate2
        from faster_whisper import WhisperModel
        from faster_whisper.tokenizer import _LANGUAGE_CODES
        from faster_whisper.utils import download_model
    except Exception as exc:  # noqa: BLE001
        raise ModelLoadError(f"无法导入 faster-whisper：{describe_exception(exc)}") from exc

    device = config.device
    if device != "auto":
        try:
            supported = set(ctranslate2.get_supported_compute_types(device))
        except Exception as exc:  # noqa: BLE001
            raise ModelLoadError(f"设备 {device} 不可用：{describe_exception(exc)}") from exc
        if config.compute_type not in supported:
            raise ModelLoadError(
                f"设备 {device} 不支持 compute_type={config.compute_type}；"
                f"可用：{', '.join(sorted(supported))}"
            )

    model_ref = os.path.expanduser(config.model)
    cache_dir = str(config.model_dir) if config.model_dir else None
    if os.path.isdir(model_ref):
        model_path = model_ref
        logger.info("使用本地模型目录：%s", display_model_name(config.model))
    else:
        try:
            model_path = download_model(config.model, local_files_only=True, cache_dir=cache_dir)
            logger.info("在本地缓存中找到模型 %s。", config.model)
        except ValueError as exc:
            raise ModelLoadError(f"模型名称无效：{sanitize_text(str(exc))}") from exc
        except Exception:  # noqa: BLE001 - 本地缓存缺失
            if config.local_files_only:
                raise ModelLoadError(
                    f"离线模式下本地缓存没有模型 {config.model}；请先联网下载或去掉 --offline。"
                ) from None
            on_phase("downloading")
            logger.info(
                "本地缓存没有模型 %s，开始首次下载（实测 small 约 464 MB、base 约 153 MB）。下载源：%s；缓存目录：%s",
                config.model,
                _hf_endpoint_for_log(),
                cache_dir or "Hugging Face 默认缓存",
            )
            started = time.monotonic()
            try:
                model_path = download_model(config.model, cache_dir=cache_dir)
            except Exception as exc:  # noqa: BLE001
                raise ModelLoadError(
                    f"模型下载失败：{describe_exception(exc)}。"
                    "若无法访问 huggingface.co，可设置 HF_ENDPOINT 为可访问的镜像；"
                    "使用镜像时若出现 xet/CAS 401 等错误，再加上 HF_HUB_DISABLE_XET=1，然后重启服务。"
                ) from exc
            logger.info("模型下载完成，用时 %.1f 秒。", time.monotonic() - started)

    on_phase("loading")
    started = time.monotonic()
    try:
        model = WhisperModel(
            model_path,
            device=device,
            compute_type=config.compute_type,
            cpu_threads=config.cpu_threads,
        )
    except Exception as exc:  # noqa: BLE001
        raise ModelLoadError(f"模型加载失败：{describe_exception(exc)}") from exc
    actual_compute_type = str(getattr(model.model, "compute_type", config.compute_type))
    actual_device = str(getattr(model.model, "device", device))
    logger.info(
        "模型加载完成，用时 %.1f 秒（device=%s，compute_type=%s，cpu_threads=%s）。",
        time.monotonic() - started,
        actual_device,
        actual_compute_type,
        config.cpu_threads or "默认",
    )
    languages = _LANGUAGE_CODES if model.model.is_multilingual else ("en",)
    return FasterWhisperTranscriber(
        model,
        model_name=display_model_name(config.model),
        device=actual_device,
        compute_type=actual_compute_type,
        beam_size=config.beam_size,
        supported_languages=languages,
    )

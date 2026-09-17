"""离线性能测试：与服务使用同一加载与解码参数，测量模型加载、处理耗时与实时率（RTF）。

RTF = 处理耗时 / 音频时长；小于 1 表示处理快于实时。结果只代表运行它的那台机器。
"""

from __future__ import annotations

import json
import os
import platform
import statistics
import sys
import time
from dataclasses import asdict, dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import numpy as np

from .config import SAMPLE_RATE, ModelConfig
from .errors import ApiError
from .transcriber import ModelLoadError, load_faster_whisper
from .wav import parse_wav


@dataclass
class SampleResult:
    name: str
    duration_ms: int
    runs_ms: list[int]
    median_ms: int
    rtf: float
    language: str
    language_probability: float
    segments: int
    text: str


@dataclass
class BenchReport:
    environment: dict[str, str]
    model: str
    device: str
    compute_type: str
    cpu_threads: int
    beam_size: int
    downloaded: bool
    download_s: float | None
    load_s: float
    warmup_ms: int | None
    peak_rss_mb: float | None = None
    load_avg_before: list[float] | None = None
    load_avg_after: list[float] | None = None
    samples: list[SampleResult] = field(default_factory=list)


def _pkg_version(name: str) -> str:
    try:
        return version(name)
    except PackageNotFoundError:
        return "未安装"


def environment_info() -> dict[str, str]:
    return {
        "platform": platform.platform(),
        "cpu_count": str(os.cpu_count()),
        "machine": platform.machine(),
        "processor": platform.processor() or "未知",
        "python": platform.python_version(),
        "faster-whisper": _pkg_version("faster-whisper"),
        "ctranslate2": _pkg_version("ctranslate2"),
        "onnxruntime": _pkg_version("onnxruntime"),
    }


def _load_samples(paths: list[Path], include_silence: bool) -> list[tuple[str, np.ndarray, int]]:
    samples: list[tuple[str, np.ndarray, int]] = []
    for path in paths:
        try:
            audio = parse_wav(path.read_bytes())
        except ApiError as exc:
            raise SystemExit(f"{path} 不符合服务要求的 WAV 格式：{exc.message}") from None
        samples.append((path.name, audio.to_float32(), audio.duration_ms))
    if include_silence:
        samples.append(("silence_5s（生成的全零静音）", np.zeros(5 * SAMPLE_RATE, dtype=np.float32), 5000))
    return samples


def run_bench(
    config: ModelConfig,
    audio_paths: list[Path],
    *,
    repeat: int,
    language: str | None,
    include_silence: bool,
) -> BenchReport:
    samples = _load_samples(audio_paths, include_silence)
    if not samples:
        raise SystemExit("没有可测试的音频：请传入 16 kHz 单声道 16-bit WAV 文件。")

    marks: dict[str, float] = {}
    load_before = _load_average()
    started = time.monotonic()

    def on_phase(phase: str) -> None:
        marks[phase] = time.monotonic()

    try:
        transcriber = load_faster_whisper(config, on_phase)
    except ModelLoadError as exc:
        raise SystemExit(str(exc)) from None
    finished = time.monotonic()
    downloaded = "downloading" in marks
    download_s = (marks["loading"] - marks["downloading"]) if downloaded else None
    load_s = finished - marks.get("loading", started)

    report = BenchReport(
        environment=environment_info(),
        model=transcriber.model_name,
        device=transcriber.device,
        compute_type=transcriber.compute_type,
        cpu_threads=config.cpu_threads,
        beam_size=config.beam_size,
        downloaded=downloaded,
        download_s=round(download_s, 2) if download_s is not None else None,
        load_s=round(load_s, 2),
        warmup_ms=None,
        load_avg_before=load_before,
    )
    try:
        # 预热一次（首次推理包含内存分配等一次性开销），不计入统计。
        warm_started = time.perf_counter()
        transcriber.transcribe(samples[0][1], language)
        report.warmup_ms = round((time.perf_counter() - warm_started) * 1000)

        for name, audio, duration_ms in samples:
            runs: list[int] = []
            result = None
            for _ in range(repeat):
                run_started = time.perf_counter()
                result = transcriber.transcribe(audio, language)
                runs.append(round((time.perf_counter() - run_started) * 1000))
            assert result is not None
            median_ms = round(statistics.median(runs))
            report.samples.append(
                SampleResult(
                    name=name,
                    duration_ms=duration_ms,
                    runs_ms=runs,
                    median_ms=median_ms,
                    rtf=round(median_ms / duration_ms, 3),
                    language=result.language,
                    language_probability=round(result.language_probability, 3),
                    segments=len(result.segments),
                    text=result.text,
                )
            )
        report.peak_rss_mb = _peak_rss_mb()
        report.load_avg_after = _load_average()
    finally:
        transcriber.close()
    return report


def _load_average() -> list[float] | None:
    # 系统负载会显著影响 CPU 推理耗时，随报告一起记录，便于判断数字是否可信。
    try:
        return [round(v, 2) for v in os.getloadavg()]
    except OSError:
        return None


def _peak_rss_mb() -> float | None:
    try:
        import resource  # 仅 POSIX 可用
    except ImportError:
        return None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    # macOS 单位为字节，Linux 为 KB。
    divisor = 1024 * 1024 if sys.platform == "darwin" else 1024
    return round(peak / divisor, 1)


def format_report(report: BenchReport) -> str:
    env = report.environment
    lines = [
        "== tongting-asr bench ==",
        f"环境：{env['platform']}；CPU 逻辑核 {env['cpu_count']}；Python {env['python']}；"
        f"faster-whisper {env['faster-whisper']}；ctranslate2 {env['ctranslate2']}",
        f"模型：{report.model}；device={report.device}；compute_type={report.compute_type}；"
        f"cpu_threads={report.cpu_threads or '默认'}；beam_size={report.beam_size}",
        (
            f"首次下载：{report.download_s:.1f} 秒"
            if report.downloaded and report.download_s is not None
            else "首次下载：否（使用本地缓存）"
        ),
        f"模型加载：{report.load_s:.2f} 秒；预热推理：{report.warmup_ms} ms；进程峰值内存：{report.peak_rss_mb} MB",
        f"系统负载（1/5/15 分钟）：开始 {report.load_avg_before}，结束 {report.load_avg_after}",
        "",
    ]
    for sample in report.samples:
        lines.append(
            f"[{sample.name}] 时长 {sample.duration_ms} ms；处理 {sample.runs_ms} ms（中位 {sample.median_ms} ms）；"
            f"RTF {sample.rtf:.3f}；语言 {sample.language}（{sample.language_probability:.3f}）；片段 {sample.segments}"
        )
        lines.append(f"    文本：{sample.text or '（空）'}")
    return "\n".join(lines)


def report_to_json(report: BenchReport) -> str:
    return json.dumps(asdict(report), ensure_ascii=False, indent=2)

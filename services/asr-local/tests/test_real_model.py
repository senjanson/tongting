"""可选：用本地已缓存的真实模型转写合成语音样本。

默认跳过（不下载模型、不占用 CPU）。启用方式：

    TONGTING_ASR_REAL_MODEL=1 uv run pytest tests/test_real_model.py

需要先通过 `tongting-asr serve` 或 `tongting-asr bench` 下载过模型（默认 small）；
本测试以离线模式加载，不会联网。可用 TONGTING_ASR_REAL_MODEL_NAME 指定其他模型。
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tongting_asr.config import ModelConfig, default_data_dir, default_model_dir
from tongting_asr.transcriber import ModelLoadError, load_faster_whisper
from tongting_asr.wav import parse_wav

pytestmark = pytest.mark.skipif(
    os.environ.get("TONGTING_ASR_REAL_MODEL") != "1",
    reason="设置 TONGTING_ASR_REAL_MODEL=1 才运行真实模型测试",
)

FIXTURES = Path(__file__).parent / "fixtures"

# (文件, 期望语言, 识别文本中应包含的关键片段)
CASES = [
    ("en_5s.wav", "en", ["meeting", "quarterly report"]),
    ("ja_5s.wav", "ja", ["会議", "資料"]),
    ("zh_5s.wav", "zh", ["会议室", "翻译"]),
]


@pytest.fixture(scope="module")
def transcriber():
    config = ModelConfig(
        model=os.environ.get("TONGTING_ASR_REAL_MODEL_NAME", "small"),
        model_dir=default_model_dir(default_data_dir()),
        local_files_only=True,
    )
    try:
        loaded = load_faster_whisper(config, lambda phase: None)
    except ModelLoadError as exc:
        pytest.skip(f"本地没有可用模型：{exc}")
    yield loaded
    loaded.close()


@pytest.mark.parametrize(("filename", "language", "fragments"), CASES)
def test_auto_language_detection_and_text(transcriber, filename, language, fragments):
    audio = parse_wav((FIXTURES / filename).read_bytes())
    result = transcriber.transcribe(audio.to_float32(), None)
    assert result.language == language
    assert result.language_probability > 0.8
    for fragment in fragments:
        assert fragment in result.text.lower()
    assert result.segments
    for segment in result.segments:
        assert 0 <= segment.start_ms <= segment.end_ms <= audio.duration_ms


def test_silence_produces_no_segments(transcriber):
    import numpy as np

    result = transcriber.transcribe(np.zeros(5 * 16000, dtype=np.float32), None)
    assert result.segments == []
    assert result.text == ""

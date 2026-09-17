"""WAV 校验：只接受 RIFF/WAVE、PCM 整数、单声道、16 kHz、16-bit，时长 ≤ 30 秒。

全部在内存中完成，不写临时文件。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

from .config import MAX_AUDIO_MS, SAMPLE_RATE
from .errors import ApiError

WAVE_FORMAT_PCM = 0x0001
WAVE_FORMAT_EXTENSIBLE = 0xFFFE
# KSDATAFORMAT_SUBTYPE_PCM 的 GUID 除前 2 字节（格式码）以外的部分。
_PCM_SUBFORMAT_TAIL = b"\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"

WAV_MIME_TYPES = frozenset({"audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"})


@dataclass(frozen=True)
class PcmAudio:
    pcm: bytes  # 小端 int16 样本
    sample_count: int

    @property
    def duration_ms(self) -> int:
        return round(self.sample_count * 1000 / SAMPLE_RATE)

    def to_float32(self) -> np.ndarray:
        samples = np.frombuffer(self.pcm, dtype="<i2", count=self.sample_count)
        return samples.astype(np.float32) / 32768.0


def _invalid(message: str) -> ApiError:
    return ApiError(415, "invalid_wav", message)


def _unsupported(message: str) -> ApiError:
    return ApiError(415, "unsupported_wav_format", message)


def parse_wav(data: bytes, *, max_audio_ms: int = MAX_AUDIO_MS) -> PcmAudio:
    size = len(data)
    if size < 12 or data[0:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise _invalid("请求体不是 RIFF/WAVE 格式的 WAV 音频。")

    fmt: tuple[int, int, int, int, int, int] | None = None
    offset = 12
    while offset + 8 <= size:
        chunk_id = data[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", data, offset + 4)
        body_start = offset + 8
        body_end = body_start + chunk_size

        if chunk_id == b"fmt ":
            if chunk_size < 16 or body_end > size:
                raise _invalid("WAV fmt 块不完整。")
            audio_format, channels, sample_rate, byte_rate, block_align, bits = struct.unpack_from(
                "<HHIIHH", data, body_start
            )
            if audio_format == WAVE_FORMAT_EXTENSIBLE:
                if chunk_size < 40:
                    raise _invalid("WAV 扩展 fmt 块不完整。")
                sub_format = data[body_start + 24 : body_start + 40]
                if sub_format[0:2] != b"\x01\x00" or sub_format[2:] != _PCM_SUBFORMAT_TAIL:
                    raise _unsupported("只支持 PCM 整数编码的 WAV。")
                audio_format = WAVE_FORMAT_PCM
            fmt = (audio_format, channels, sample_rate, byte_rate, block_align, bits)
        elif chunk_id == b"data":
            if fmt is None:
                raise _invalid("WAV 缺少位于 data 块之前的 fmt 块。")
            if body_end > size:
                raise _invalid("WAV data 块长度超出请求体，音频可能被截断。")
            _check_format(fmt)
            if chunk_size % 2 != 0:
                raise _invalid("WAV data 块长度不是 16-bit 样本的整数倍。")
            sample_count = chunk_size // 2
            if sample_count == 0:
                raise ApiError(415, "empty_audio", "WAV 不包含音频样本。")
            if sample_count * 1000 > max_audio_ms * SAMPLE_RATE:
                raise ApiError(
                    413,
                    "audio_too_long",
                    f"音频时长超过上限 {max_audio_ms // 1000} 秒。",
                )
            return PcmAudio(pcm=bytes(data[body_start:body_end]), sample_count=sample_count)

        # RIFF 块按偶数字节对齐。
        offset = body_end + (chunk_size & 1)

    if fmt is None:
        raise _invalid("WAV 缺少 fmt 块。")
    raise _invalid("WAV 缺少 data 块。")


def _check_format(fmt: tuple[int, int, int, int, int, int]) -> None:
    audio_format, channels, sample_rate, byte_rate, block_align, bits = fmt
    if audio_format != WAVE_FORMAT_PCM:
        raise _unsupported("只支持 PCM 整数编码的 WAV（不支持浮点、压缩编码）。")
    if channels != 1:
        raise _unsupported(f"只支持单声道，收到 {channels} 声道。")
    if sample_rate != SAMPLE_RATE:
        raise _unsupported(f"只支持 16000 Hz 采样率，收到 {sample_rate} Hz。")
    if bits != 16:
        raise _unsupported(f"只支持 16-bit 样本，收到 {bits}-bit。")
    if block_align != 2 or byte_rate != SAMPLE_RATE * 2:
        raise _invalid("WAV fmt 块的 blockAlign/byteRate 与 16 kHz 单声道 16-bit 不一致。")

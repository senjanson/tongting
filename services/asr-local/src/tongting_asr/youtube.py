"""Optional public YouTube audio prefetch. Audio and signed URLs never touch disk."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import math
import os
import re
import shutil
import signal
import sys
import time
from collections import OrderedDict
from dataclasses import dataclass
from urllib.parse import urlsplit

from .config import SAMPLE_RATE
from .errors import ApiError
from .wav import PcmAudio

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_START_MS = 86_400_000
MAX_DURATION_MS = 30_000
CACHE_TTL_S = 120
CACHE_SIZE = 8
FETCH_TIMEOUT_S = 60


def unavailable() -> ApiError:
    return ApiError(503, "youtube_preload_unavailable", "本地服务未启用视频预读，或缺少 yt-dlp、ffmpeg、Node.js。")


@dataclass(frozen=True)
class YoutubeWindow:
    video_id: str
    start_ms: int
    duration_ms: int
    language: str


def parse_window(body: bytes) -> YoutubeWindow:
    try:
        data = json.loads(body)
    except (ValueError, UnicodeError):
        raise ApiError(400, "invalid_request", "请求体必须是 JSON 对象。") from None
    if not isinstance(data, dict) or set(data) - {"videoId", "startMs", "durationMs", "language"}:
        raise ApiError(400, "invalid_request", "视频预读参数不合法。")
    video_id, start_ms = data.get("videoId"), data.get("startMs")
    duration_ms, language = data.get("durationMs", 20_000), data.get("language", "auto")
    if not isinstance(video_id, str) or VIDEO_ID.fullmatch(video_id) is None:
        raise ApiError(400, "invalid_video_id", "videoId 必须是 11 位 YouTube 视频 ID。")
    if type(start_ms) is not int or not 0 <= start_ms <= MAX_START_MS:
        raise ApiError(400, "invalid_range", "startMs 必须是 0–86400000 的整数。")
    if type(duration_ms) is not int or not 1 <= duration_ms <= MAX_DURATION_MS:
        raise ApiError(400, "invalid_range", "durationMs 必须是 1–30000 的整数。")
    if not isinstance(language, str) or len(language) > 32:
        raise ApiError(400, "invalid_language", "language 必须是语言代码或 auto。")
    return YoutubeWindow(video_id, start_ms, duration_ms, language)


def validate_media_url(value: object) -> str:
    try:
        parts = urlsplit(value) if isinstance(value, str) else None
        valid = (
            parts is not None
            and parts.scheme == "https"
            and parts.hostname is not None
            and parts.hostname.endswith(".googlevideo.com")
            and parts.port in (None, 443)
            and parts.username is None
            and parts.password is None
            and not parts.fragment
            and not any(ord(char) < 33 for char in value)
        )
    except ValueError:
        valid = False
    if not valid:
        raise ApiError(422, "youtube_unsupported", "视频没有可安全预读的公开音轨。")
    return value


@dataclass(frozen=True)
class MediaSource:
    url: str
    duration_ms: int
    expires_at: float


class YoutubePreloader:
    def __init__(self, *, enabled: bool) -> None:
        self.ffmpeg = shutil.which("ffmpeg")
        self.node = shutil.which(os.environ.get("TONGTING_ASR_NODE_PATH", "node"))
        self.available = bool(enabled and self.ffmpeg and self.node and importlib.util.find_spec("yt_dlp"))
        self._cache: OrderedDict[str, MediaSource] = OrderedDict()
        self._closed = False

    def close(self) -> None:
        self._closed = True
        self.available = False
        self._cache.clear()

    async def fetch(self, window: YoutubeWindow) -> PcmAudio:
        if not self.available or self._closed:
            raise unavailable()
        try:
            async with asyncio.timeout(FETCH_TIMEOUT_S):
                source = await self._resolve(window.video_id)
                if window.start_ms >= source.duration_ms:
                    raise ApiError(416, "youtube_range_unavailable", "预读位置已超过视频结尾。")
                duration_ms = min(window.duration_ms, source.duration_ms - window.start_ms)
                # Input seeking with accurate_seek decodes/discards the leading keyframe portion;
                # it avoids downloading/decoding the entire preceding video when seeking far ahead.
                pcm = await self._run(
                    [
                        sys.executable,
                        "-m",
                        "tongting_asr.youtube_audio",
                        self.ffmpeg,
                        "-nostdin",
                        "-hide_banner",
                        "-loglevel",
                        "error",
                        "-protocol_whitelist",
                        "http,https,tls,tcp",
                        "-rw_timeout",
                        "15000000",
                        "-ss",
                        f"{window.start_ms / 1000:.3f}",
                        "-accurate_seek",
                        "-i",
                        source.url,
                        "-t",
                        f"{duration_ms / 1000:.3f}",
                        "-map",
                        "0:a:0",
                        "-vn",
                        "-sn",
                        "-dn",
                        "-ac",
                        "1",
                        "-ar",
                        str(SAMPLE_RATE),
                        "-f",
                        "s16le",
                        "pipe:1",
                    ],
                    max_bytes=duration_ms * SAMPLE_RATE * 2 // 1000,
                )
                if not pcm or len(pcm) % 2:
                    raise ApiError(502, "youtube_audio_failed", "未取得可识别的音频片段。")
                return PcmAudio(pcm=pcm, sample_count=len(pcm) // 2)
        except TimeoutError:
            self._cache.pop(window.video_id, None)
            raise ApiError(504, "youtube_preload_timeout", "视频音频预读超时，请检查网络或代理后重试。") from None
        except BaseException:
            # Failed or cancelled requests must not retain newly resolved signed URLs.
            self._cache.pop(window.video_id, None)
            raise

    async def _resolve(self, video_id: str) -> MediaSource:
        cached = self._cache.get(video_id)
        if cached is not None and cached.expires_at > time.monotonic():
            self._cache.move_to_end(video_id)
            return cached
        self._cache.pop(video_id, None)
        data = await self._run(
            [sys.executable, "-m", "tongting_asr.youtube_resolver", video_id, self.node],
            max_bytes=64 * 1024,
        )
        try:
            info = json.loads(data)
            duration = info.get("duration")
            if (
                info.get("live") is not False
                or info.get("drm") is not False
                or info.get("availability") != "public"
                or not isinstance(duration, (int, float))
                or isinstance(duration, bool)
                or not math.isfinite(duration)
                or duration <= 0
            ):
                raise ValueError
            source = MediaSource(validate_media_url(info.get("url")), round(duration * 1000), time.monotonic() + CACHE_TTL_S)
        except (ValueError, TypeError, AttributeError):
            raise ApiError(422, "youtube_unsupported", "只支持普通公开录播；直播、登录限制与受保护的视频无法预读。") from None
        if self._closed:
            raise unavailable()
        self._cache[video_id] = source
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return source

    async def _run(self, args: list[str], *, max_bytes: int) -> bytes:
        # A dedicated POSIX process group also owns yt-dlp's JavaScript helper children.
        # Shield creation so cancellation cannot lose the PID between spawn and assignment.
        spawn = asyncio.create_task(
            asyncio.create_subprocess_exec(
                *args,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
        )
        try:
            process = await asyncio.shield(spawn)
            assert process.stdout is not None
            output = bytearray()
            while chunk := await process.stdout.read(32 * 1024):
                output.extend(chunk)
                if len(output) > max_bytes:
                    raise ApiError(502, "youtube_audio_failed", "视频音频预读结果超过安全上限。")
            if await process.wait() != 0:
                raise ApiError(502, "youtube_audio_failed", "无法读取公开视频音频，请检查视频访问权限、网络或代理。")
            return bytes(output)
        except OSError:
            raise unavailable() from None
        finally:

            async def terminate() -> None:
                # Await even if cancellation landed between spawning and PID assignment.
                try:
                    child = await spawn
                except OSError:
                    return
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                # A killed child can still have a full pipe buffer. Drain it before
                # waiting, otherwise asyncio Process.wait can hang on backpressure.
                await child.communicate()

            cleanup = asyncio.create_task(terminate())
            cancelled = False
            while not cleanup.done():
                try:
                    await asyncio.shield(cleanup)
                except asyncio.CancelledError:
                    # Disconnect and shutdown may cancel the same request twice.
                    # Physical child termination must finish before either returns.
                    cancelled = True
            cleanup.result()
            if cancelled:
                raise asyncio.CancelledError

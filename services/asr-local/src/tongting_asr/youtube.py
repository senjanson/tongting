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
from urllib.parse import parse_qs, urlsplit

from .config import SAMPLE_RATE
from .errors import ApiError
from .wav import PcmAudio

VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
MAX_START_MS = 86_400_000
MAX_DURATION_MS = 30_000
CACHE_TTL_S = 120
CACHE_SIZE = 8
FETCH_TIMEOUT_S = 60
# 416 responses report where readable audio ends, so clients can finish at the real end of media
# instead of treating an end-of-video request as an error.
MEDIA_END_HEADER = "X-Tongting-Media-End-Ms"
# An audio track can end slightly before its format duration. An empty decode this close to the
# end means the audio is exhausted; further from the end it still indicates a failed read.
AUDIO_END_TOLERANCE_MS = 2_000


def unavailable() -> ApiError:
    return ApiError(503, "youtube_preload_unavailable", "本地服务未启用视频预读，或缺少 yt-dlp、ffmpeg、Node.js。")


def range_unavailable(media_end_ms: int) -> ApiError:
    return ApiError(
        416,
        "youtube_range_unavailable",
        "预读位置已超过视频结尾。",
        headers={MEDIA_END_HEADER: str(media_end_ms)},
    )


def format_duration_ms(url: str) -> int | None:
    """Duration of the selected format from its signed URL (``dur``, YouTube's approxDurationMs).

    yt-dlp's ``duration`` is YouTube's whole-second lengthSeconds, which can end almost a second
    before the audio and the player's fractional duration.
    """
    values = parse_qs(urlsplit(url).query).get("dur")
    try:
        seconds = float(values[0]) if values is not None and len(values) == 1 else math.nan
    except ValueError:
        return None
    if not math.isfinite(seconds):
        return None
    duration_ms = round(seconds * 1000)
    return duration_ms if 0 < duration_ms <= MAX_START_MS else None


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
        source: MediaSource | None = None
        resolved_now = False
        try:
            async with asyncio.timeout(FETCH_TIMEOUT_S):
                source, resolved_now = await self._resolve(window.video_id)
                if window.start_ms >= source.duration_ms:
                    raise range_unavailable(source.duration_ms)
                duration_ms = min(window.duration_ms, source.duration_ms - window.start_ms)
                try:
                    pcm = await self._decode(source.url, window.start_ms, duration_ms)
                except ApiError:
                    # A signed URL can be rejected (for example 403 after expiry) before its cache
                    # TTL; the decoder cannot say why it failed, so the next request resolves again.
                    self._forget(window.video_id, source)
                    raise
                if pcm and not len(pcm) % 2:
                    return PcmAudio(pcm=pcm, sample_count=len(pcm) // 2)
                if not pcm and window.start_ms >= source.duration_ms - AUDIO_END_TOLERANCE_MS:
                    raise range_unavailable(window.start_ms)
                self._forget(window.video_id, source)
                raise ApiError(502, "youtube_audio_failed", "未取得可识别的音频片段。")
        except TimeoutError:
            # A read stalled for the whole budget suggests a throttled or invalid URL.
            self._forget(window.video_id, source)
            raise ApiError(504, "youtube_preload_timeout", "视频音频预读超时，请检查网络或代理后重试。") from None
        except BaseException as error:
            # Failed or cancelled requests must not retain signed URLs they resolved themselves.
            # Cancellation (seeking) keeps entries other requests already proved, and an
            # end-of-media 416 does not mean that the URL is bad.
            if resolved_now and not (isinstance(error, ApiError) and error.status == 416):
                self._forget(window.video_id, source)
            raise

    async def _decode(self, url: str, start_ms: int, duration_ms: int) -> bytes:
        # Input seeking with accurate_seek decodes/discards the leading keyframe portion;
        # it avoids downloading/decoding the entire preceding video when seeking far ahead.
        return await self._run(
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
                f"{start_ms / 1000:.3f}",
                "-accurate_seek",
                "-i",
                url,
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

    def _forget(self, video_id: str, source: MediaSource | None) -> None:
        # Identity check: never drop an entry that another request resolved in the meantime.
        if source is not None and self._cache.get(video_id) is source:
            del self._cache[video_id]

    async def _resolve(self, video_id: str) -> tuple[MediaSource, bool]:
        """Return the media source and whether this call resolved it (rather than the cache)."""
        cached = self._cache.get(video_id)
        if cached is not None and cached.expires_at > time.monotonic():
            self._cache.move_to_end(video_id)
            return cached, False
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
            url = validate_media_url(info.get("url"))
            duration_ms = format_duration_ms(url) or round(duration * 1000)
            source = MediaSource(url, duration_ms, time.monotonic() + CACHE_TTL_S)
        except (ValueError, TypeError, AttributeError):
            raise ApiError(422, "youtube_unsupported", "只支持普通公开录播；直播、登录限制与受保护的视频无法预读。") from None
        if self._closed:
            raise unavailable()
        self._cache[video_id] = source
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return source, True

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

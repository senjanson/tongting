"""Bounded media ranges and the disposable FFmpeg bridge."""

from __future__ import annotations

import io
import shutil
import subprocess
import sys

import pytest

from conftest import make_wav
from tongting_asr import youtube_audio
from tongting_asr.errors import ApiError
from tongting_asr.wav import parse_wav

URL = "https://rr1.example.googlevideo.com/videoplayback?secret=test"


class FakeResponse(io.BytesIO):
    def __init__(self, body, *, status, content_range):
        super().__init__(body)
        self.status = status
        self.headers = {"Content-Range": content_range}


class FakeOpener:
    def __init__(self, *, status=206, content_range=None, truncated=False):
        self.status = status
        self.content_range = content_range
        self.truncated = truncated
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        match = youtube_audio.RANGE.fullmatch(request.get_header("Range"))
        start, end = int(match.group(1)), int(match.group(2))
        return FakeResponse(
            b"x" * (end - start + 1 - int(self.truncated)),
            status=self.status,
            content_range=self.content_range or f"bytes {start}-{end}/1000000",
        )


def test_ranges_are_bounded_and_require_consistent_coverage(monkeypatch):
    opener = FakeOpener()
    monkeypatch.setattr(youtube_audio, "build_opener", lambda _: opener)
    audio = youtube_audio.RangedAudio(URL)
    assert audio.size == 1000000
    assert audio.read(500, 50) == b"x" * 50
    assert opener.requests[-1].get_header("Range") == "bytes=500-549"
    with pytest.raises(ValueError):
        audio.read(0, youtube_audio.BLOCK_BYTES + 1)
    monkeypatch.setattr(youtube_audio, "MAX_FETCH_BYTES", 52)
    with pytest.raises(ValueError):
        audio.read(600, 2)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"status": 200},
        {"content_range": "bytes 1-1/100"},
        {"content_range": "bytes 0-9/100"},
        {"content_range": "broken"},
        {"truncated": True},
    ],
)
def test_rejects_unbounded_ignored_or_incomplete_range_responses(monkeypatch, kwargs):
    monkeypatch.setattr(youtube_audio, "build_opener", lambda _: FakeOpener(**kwargs))
    with pytest.raises(ValueError):
        youtube_audio.RangedAudio(URL)


def test_redirect_cannot_leave_media_allowlist():
    with pytest.raises(ApiError):
        youtube_audio.SafeRedirect().redirect_request(None, None, 302, "", {}, "http://127.0.0.1/secret")


def test_ffmpeg_bridge_preserves_exact_seek_and_subsecond_duration(monkeypatch):
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        pytest.skip("FFmpeg is an optional preloading dependency")
    wav = make_wav(2.0)
    expected_pcm = parse_wav(wav).pcm[8000 * 2 : 12000 * 2]

    class FixtureAudio:
        size = len(wav)

        def __init__(self, url):
            assert url == URL

        def read(self, start, count):
            return wav[start : start + count]

    monkeypatch.setattr(youtube_audio, "RangedAudio", FixtureAudio)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "youtube_audio",
            ffmpeg,
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            "0.5",
            "-accurate_seek",
            "-i",
            URL,
            "-t",
            "0.25",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-f",
            "s16le",
            "pipe:1",
        ],
    )
    original = subprocess.run
    outputs = []

    def run(args, **kwargs):
        result = original(args, **kwargs, stdout=subprocess.PIPE, timeout=5)
        outputs.append(result.stdout)
        return result

    monkeypatch.setattr(youtube_audio.subprocess, "run", run)
    assert youtube_audio.main() == 0
    assert outputs == [expected_pcm]

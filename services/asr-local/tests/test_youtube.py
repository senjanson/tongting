"""Public-video preloading: bounded requests, media validation, API and process lifecycle."""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading

import pytest

from conftest import asgi_call, make_plain_app, running_app
from test_security import assert_error
from tongting_asr import youtube
from tongting_asr.cli import build_parser
from tongting_asr.errors import ApiError
from tongting_asr.wav import PcmAudio
from tongting_asr.youtube import YoutubePreloader, YoutubeWindow, parse_window, validate_media_url

BODY = {"videoId": "ZA-tUyM_y7s", "startMs": 40_000, "durationMs": 20_000, "language": "en-US"}
MEDIA = {
    "url": "https://rr1.example.googlevideo.com/videoplayback?secret=TEST",
    "duration": 70,
    "live": False,
    "drm": False,
    "availability": "public",
}


class FakePreloader:
    def __init__(self, *, enabled: bool):
        self.available = enabled
        self.calls = []
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.cancelled = threading.Event()
        self.error = None

    async def fetch(self, window):
        self.calls.append(window)
        self.started.set()
        try:
            while not self.release.is_set():
                await asyncio.sleep(0.01)
            if self.error is not None:
                raise self.error
            return PcmAudio(pcm=b"\0\0" * 40_000, sample_count=40_000)
        except asyncio.CancelledError:
            self.cancelled.set()
            raise

    def close(self):
        self.available = False


@pytest.fixture
def fake_preloader(monkeypatch):
    monkeypatch.setattr("tongting_asr.app.YoutubePreloader", FakePreloader)


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"videoId": "https://youtube.com/watch?v=ZA-tUyM_y7s"}, "invalid_video_id"),
        ({"videoId": "../bad/path!"}, "invalid_video_id"),
        ({"videoId": "too-short"}, "invalid_video_id"),
        ({"startMs": -1}, "invalid_range"),
        ({"startMs": True}, "invalid_range"),
        ({"startMs": 1.5}, "invalid_range"),
        ({"startMs": 86_400_001}, "invalid_range"),
        ({"durationMs": 30_001}, "invalid_range"),
        ({"durationMs": 0}, "invalid_range"),
        ({"durationMs": False}, "invalid_range"),
        ({"language": []}, "invalid_language"),
        ({"url": MEDIA["url"]}, "invalid_request"),
    ],
)
def test_rejects_invalid_parameters(changes, code):
    with pytest.raises(ApiError) as error:
        parse_window(json.dumps({**BODY, **changes}).encode())
    assert error.value.code == code


@pytest.mark.parametrize("body", [b"[]", b"null", b"{", b"\xff"])
def test_rejects_invalid_json(body):
    with pytest.raises(ApiError):
        parse_window(body)


def test_defaults_and_cli_opt_in():
    assert parse_window(b'{"videoId":"ZA-tUyM_y7s","startMs":0}') == YoutubeWindow("ZA-tUyM_y7s", 0, 20_000, "auto")
    assert build_parser().parse_args(["serve"]).youtube_preload is False
    assert build_parser().parse_args(["serve", "--youtube-preload"]).youtube_preload is True
    assert parse_window(json.dumps({**BODY, "durationMs": 1}).encode()).duration_ms == 1


@pytest.mark.parametrize(
    "url",
    [
        "http://rr1.googlevideo.com/media",
        "https://googlevideo.com.evil.test/media",
        "file:///etc/passwd",
        "https://127.0.0.1/media",
        "https://u:p@rr1.googlevideo.com/media",
        "https://rr1.googlevideo.com:8080/media",
        "https://rr1.googlevideo.com:invalid/media",
        "https://rr1.googlevideo.com/media\n",
        None,
    ],
)
def test_rejects_unsafe_media_url(url):
    with pytest.raises(ApiError):
        validate_media_url(url)


def test_health_requires_flag_and_all_dependencies(monkeypatch):
    monkeypatch.setattr(youtube.shutil, "which", lambda _: "/bin/fake")
    monkeypatch.setattr(youtube.importlib.util, "find_spec", lambda _: object())
    assert YoutubePreloader(enabled=False).available is False
    assert YoutubePreloader(enabled=True).available is True
    monkeypatch.setattr(youtube.importlib.util, "find_spec", lambda _: None)
    assert YoutubePreloader(enabled=True).available is False
    monkeypatch.setattr(youtube.importlib.util, "find_spec", lambda _: object())
    monkeypatch.setattr(youtube.shutil, "which", lambda command: None if command == "ffmpeg" else "/bin/fake")
    assert YoutubePreloader(enabled=True).available is False


def loader_with_fake_process(monkeypatch, metadata=None, pcm=None):
    loader = YoutubePreloader(enabled=False)
    loader.available = True
    loader.ffmpeg = "/bin/ffmpeg"
    loader.node = "/bin/node"
    calls = []

    async def run(args, *, max_bytes):
        calls.append((args, max_bytes))
        return json.dumps(metadata or MEDIA).encode() if "tongting_asr.youtube_resolver" in args else (pcm or b"\0\0" * 16_000)

    monkeypatch.setattr(loader, "_run", run)
    return loader, calls


def test_seeks_precisely_limits_audio_and_caches_only_media_metadata(monkeypatch):
    loader, calls = loader_with_fake_process(monkeypatch)

    async def scenario():
        first = await loader.fetch(parse_window(json.dumps(BODY).encode()))
        second = await loader.fetch(YoutubeWindow(BODY["videoId"], 65_000, 20_000, "auto"))
        return first, second

    first, second = asyncio.run(scenario())
    assert first.duration_ms == second.duration_ms == 1000  # Actual PCM coverage, not requested coverage.
    assert len(calls) == 3  # Resolve once, decode twice.
    assert calls[1][0][calls[1][0].index("-ss") + 1] == "40.000"
    assert calls[2][0][calls[2][0].index("-t") + 1] == "5.000"  # Clamp to real video end.
    assert calls[2][1] == 5000 * 32
    assert "-accurate_seek" in calls[1][0]
    assert all("-cookies" not in arg for args, _ in calls for arg in args)
    assert len(loader._cache) == 1
    loader.close()
    assert not loader.available and not loader._cache


def test_media_cache_is_bounded_and_expires(monkeypatch):
    loader, calls = loader_with_fake_process(monkeypatch)
    now = [100.0]
    monkeypatch.setattr(youtube.time, "monotonic", lambda: now[0])

    async def scenario():
        for i in range(12):
            await loader._resolve(f"{i:011}")
        assert len(loader._cache) == youtube.CACHE_SIZE
        await loader._resolve("00000000011")
        assert len(calls) == 12
        now[0] += youtube.CACHE_TTL_S + 1
        await loader._resolve("00000000011")
        assert len(calls) == 13

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "change",
    [
        {"live": True},
        {"drm": True},
        {"availability": "private"},
        {"availability": "needs_auth"},
        {"availability": None},
        {"duration": None},
        {"duration": float("inf")},
        {"url": "http://127.0.0.1/secret"},
    ],
)
def test_rejects_live_restricted_or_invalid_metadata(monkeypatch, change):
    loader, calls = loader_with_fake_process(monkeypatch, {**MEDIA, **change})
    with pytest.raises(ApiError) as error:
        asyncio.run(loader.fetch(YoutubeWindow(BODY["videoId"], 0, 20_000, "auto")))
    assert error.value.code == "youtube_unsupported"
    assert len(calls) == 1
    assert not loader._cache


def test_end_range_is_explicit_and_does_not_decode(monkeypatch):
    loader, calls = loader_with_fake_process(monkeypatch)
    with pytest.raises(ApiError) as error:
        asyncio.run(loader.fetch(YoutubeWindow(BODY["videoId"], 70_000, 20_000, "auto")))
    assert error.value.status == 416
    assert len(calls) == 1


def test_fetch_timeout_cancels_work_and_drops_cache(monkeypatch):
    loader, _ = loader_with_fake_process(monkeypatch)
    cancelled = []

    async def hung(*args, **kwargs):
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.append(True)

    monkeypatch.setattr(loader, "_run", hung)
    monkeypatch.setattr(youtube, "FETCH_TIMEOUT_S", 0.03)
    with pytest.raises(ApiError) as error:
        asyncio.run(loader.fetch(YoutubeWindow(BODY["videoId"], 0, 20_000, "auto")))
    assert error.value.code == "youtube_preload_timeout"
    assert cancelled == [True] and not loader._cache


def test_subprocess_cancellation_kills_and_reaps(monkeypatch):
    original = asyncio.create_subprocess_exec
    processes = []

    async def spawn(*args, **kwargs):
        process = await original(*args, **kwargs)
        processes.append(process)
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)

    async def scenario():
        loader = YoutubePreloader(enabled=False)
        task = asyncio.create_task(loader._run([sys.executable, "-c", "import time; time.sleep(60)"], max_bytes=32))
        while not processes:
            await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
        assert processes[0].returncode is not None and processes[0].returncode < 0

    asyncio.run(scenario())


def test_cancel_during_spawn_does_not_orphan_child(monkeypatch):
    original = asyncio.create_subprocess_exec
    processes = []

    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()

        async def spawn(*args, **kwargs):
            entered.set()
            await release.wait()
            process = await original(*args, **kwargs)
            processes.append(process)
            return process

        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        task = asyncio.create_task(
            YoutubePreloader(enabled=False)._run(
                [sys.executable, "-c", "import time; time.sleep(60)"],
                max_bytes=32,
            )
        )
        await entered.wait()
        task.cancel()
        await asyncio.sleep(0)
        task.cancel()  # Disconnect followed by service shutdown while PID creation is pending.
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, 3)
        assert processes[0].returncode is not None and processes[0].returncode < 0

    asyncio.run(scenario())


def test_cancellation_also_terminates_worker_children(tmp_path):
    marker = tmp_path / "child-pid"
    program = (
        "import subprocess,sys,time,pathlib; "
        "child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); "
        "pathlib.Path(sys.argv[1]).write_text(str(child.pid)); time.sleep(60)"
    )

    async def scenario():
        task = asyncio.create_task(
            YoutubePreloader(enabled=False)._run(
                [sys.executable, "-c", program, str(marker)],
                max_bytes=32,
            )
        )
        try:
            async with asyncio.timeout(3):
                while not marker.exists():
                    await asyncio.sleep(0.01)
            child_pid = int(marker.read_text())
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 3)
            async with asyncio.timeout(3):
                while True:
                    try:
                        os.kill(child_pid, 0)
                    except ProcessLookupError:
                        break
                    await asyncio.sleep(0.01)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

    asyncio.run(scenario())


def test_subprocess_output_is_bounded_and_errors_redacted():
    async def scenario():
        loader = YoutubePreloader(enabled=False)
        with pytest.raises(ApiError) as oversized:
            await loader._run([sys.executable, "-c", "print('x'*10000)"], max_bytes=16)
        assert oversized.value.code == "youtube_audio_failed"
        with pytest.raises(ApiError) as failed:
            await loader._run([sys.executable, "-c", "import sys; print('SECRET',file=sys.stderr); sys.exit(1)"], max_bytes=16)
        assert "SECRET" not in failed.value.message

    asyncio.run(scenario())


def test_overflow_with_full_pipe_does_not_hang_reaping_child():
    async def scenario():
        loader = YoutubePreloader(enabled=False)
        with pytest.raises(ApiError):
            await asyncio.wait_for(
                loader._run(
                    [
                        sys.executable,
                        "-c",
                        "import os;\nwhile True: os.write(1, b'x' * 1048576)",
                    ],
                    max_bytes=16,
                ),
                3,
            )

    asyncio.run(scenario())


def test_api_disabled_requires_auth_even_before_capability_check(harness):
    assert_error(harness.client.post("/v1/youtube/transcribe", json=BODY), 401, "unauthorized")
    response = harness.client.post("/v1/youtube/transcribe", json=BODY, headers=harness.auth)
    assert_error(response, 503, "youtube_preload_unavailable")


def test_api_success_and_health(fake_preloader):
    with running_app(youtube_preload=True) as h:
        assert h.client.get("/health").json()["youtubePreload"] is True
        response = h.client.post("/v1/youtube/transcribe", json=BODY, headers=h.auth)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["startMs"] == 40_000 and data["durationMs"] == 2500
        assert data["segments"][0]["startMs"] == 0
        assert h.transcriber.calls == [(40_000, "en")]
        assert response.headers["cache-control"] == "no-store"
        assert h.gate().pending == 0


@pytest.mark.parametrize(
    "changes,code",
    [
        ({"language": "english!"}, "invalid_language"),
        ({"language": "xx"}, "unsupported_language"),
        ({"durationMs": 0}, "invalid_range"),
    ],
)
def test_api_bad_parameters_never_fetch(fake_preloader, changes, code):
    with running_app(youtube_preload=True) as h:
        assert_error(h.client.post("/v1/youtube/transcribe", json={**BODY, **changes}, headers=h.auth), 400, code)
        assert not h.client.app.state.youtube.calls


def test_api_rejects_foreign_origin_invalid_mime_and_large_body(fake_preloader):
    with running_app(youtube_preload=True) as h:
        assert_error(
            h.client.post("/v1/youtube/transcribe", json=BODY, headers={**h.auth, "Origin": "https://example.com"}),
            403,
            "origin_not_allowed",
        )
        assert_error(h.client.post("/v1/youtube/transcribe", content=b"{}", headers=h.auth), 415, "unsupported_media_type")
        assert_error(
            h.client.post("/v1/youtube/transcribe", content=b" " * 4097, headers={**h.auth, "Content-Type": "application/json"}),
            413,
            "payload_too_large",
        )
        assert not h.client.app.state.youtube.calls


def test_api_failure_frees_slot(fake_preloader):
    with running_app(youtube_preload=True) as h:
        loader = h.client.app.state.youtube
        loader.error = ApiError(502, "youtube_audio_failed", "无法读取公开视频音频。")
        assert_error(h.client.post("/v1/youtube/transcribe", json=BODY, headers=h.auth), 502, "youtube_audio_failed")
        assert h.gate().pending == 0 and not h.transcriber.calls
        loader.error = None
        assert h.client.post("/v1/youtube/transcribe", json=BODY, headers=h.auth).status_code == 200


def test_api_prefetch_shares_bounded_queue_and_shutdown_cancels(fake_preloader):
    with running_app(youtube_preload=True, queue_size=0) as h:
        loader = h.client.app.state.youtube
        loader.release.clear()
        responses = []
        thread = threading.Thread(
            target=lambda: responses.append(h.client.post("/v1/youtube/transcribe", json=BODY, headers=h.auth)),
        )
        thread.start()
        assert loader.started.wait(3)
        assert_error(h.client.post("/v1/youtube/transcribe", json=BODY, headers=h.auth), 429, "busy")
        h.client.portal.call(h.client.app.state.begin_shutdown)
        thread.join(3)
        assert not thread.is_alive()
        assert_error(responses[0], 503, "model_unavailable")
        assert loader.cancelled.is_set() and not h.transcriber.calls
        assert h.gate().pending == 0
        assert h.client.get("/health").json()["youtubePreload"] is False


def test_api_disconnect_cancels_fetch_before_inference(fake_preloader):
    app, manager, token = make_plain_app(youtube_preload=True)
    manager.start()
    assert manager.wait_until_settled(3)
    loader = app.state.youtube
    loader.release.clear()

    async def scenario():
        sent_body = False
        disconnected = asyncio.Event()

        async def receive():
            nonlocal sent_body
            if not sent_body:
                sent_body = True
                return {"type": "http.request", "body": json.dumps(BODY).encode(), "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        request = asyncio.create_task(
            asgi_call(app, receive, token=token, path="/v1/youtube/transcribe", headers=[("content-type", "application/json")])
        )
        while not loader.started.is_set():
            await asyncio.sleep(0.01)
        disconnected.set()
        result = await asyncio.wait_for(request, 3)
        assert result.status == 499
        assert loader.cancelled.is_set() and app.state.gate.pending == 0

    try:
        asyncio.run(scenario())
        assert not manager.active_inferences
    finally:
        manager.close()

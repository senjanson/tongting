"""/v1/transcribe 的格式校验、模型状态、并发与响应结构。"""

from __future__ import annotations

import asyncio
import logging
import threading

import pytest

from conftest import (
    FakeTranscriber,
    asgi_call,
    make_plain_app,
    make_raw_wav,
    make_wav,
    pcm_fmt,
    running_app,
    wait_for,
)
from test_security import HEALTH_KEYS, assert_error
from tongting_asr.token_store import FileTokenVerifier, TokenStore
from tongting_asr.transcriber import ModelLoadError, SegmentResult, TranscriptionResult

TRANSCRIPTION_KEYS = {"text", "language", "languageProbability", "durationMs", "processingMs", "segments"}
SEGMENT_KEYS = {"startMs", "endMs", "text", "avgLogprob", "noSpeechProb"}


# ---- 正常转写 ----


def test_successful_transcription_matches_contract(harness):
    response = harness.post_wav(make_wav(2.5), params={"language": "auto"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    body = response.json()
    assert set(body) == TRANSCRIPTION_KEYS
    assert body["text"] == "Hello world. 你好"
    assert body["language"] == "en"
    assert body["languageProbability"] == pytest.approx(0.9877, abs=1e-4)
    assert body["durationMs"] == 2500
    assert isinstance(body["durationMs"], int)
    assert isinstance(body["processingMs"], int) and body["processingMs"] >= 0
    assert len(body["segments"]) == 2
    for segment in body["segments"]:
        assert set(segment) == SEGMENT_KEYS
        assert isinstance(segment["startMs"], int)
        assert isinstance(segment["endMs"], int)
        assert isinstance(segment["avgLogprob"], float)
        assert isinstance(segment["noSpeechProb"], float)
    assert body["segments"][0] == {
        "startMs": 0,
        "endMs": 1234,
        "text": "Hello world.",
        "avgLogprob": -0.21,
        "noSpeechProb": 0.01,
    }
    # 服务端把 PCM16 转成 float32 样本，auto 传给转写器为 None。
    assert harness.transcriber.calls == [(40000, None)]


def test_missing_language_defaults_to_auto(harness):
    assert harness.post_wav(make_wav()).status_code == 200
    assert harness.transcriber.calls[-1][1] is None


@pytest.mark.parametrize(("value", "expected"), [("en", "en"), ("ja", "ja"), ("zh-CN", "zh"), ("EN-us", "en"), ("zh_Hans", "zh")])
def test_language_codes_are_normalized(harness, value, expected):
    assert harness.post_wav(make_wav(), params={"language": value}).status_code == 200
    assert harness.transcriber.calls[-1][1] == expected


def test_invalid_language_is_400(harness):
    assert_error(harness.post_wav(make_wav(), params={"language": "english!"}), 400, "invalid_language")
    assert_error(harness.post_wav(make_wav(), params={"language": "xx"}), 400, "unsupported_language")
    assert harness.transcriber.calls == []


def test_exactly_30_seconds_is_accepted(harness):
    response = harness.post_wav(make_wav(30.0))
    assert response.status_code == 200
    assert response.json()["durationMs"] == 30000


def test_alternative_wav_mime_types_are_accepted(harness):
    for mime in ("audio/x-wav", "audio/wave", "audio/wav; codecs=1"):
        assert harness.post_wav(make_wav(), headers={"Content-Type": mime}).status_code == 200


# ---- 格式错误 415 / 过大 413 ----


@pytest.mark.parametrize("content_type", ["text/plain", "application/octet-stream", "audio/mpeg", "audio/webm"])
def test_wrong_content_type_is_415(harness, content_type):
    assert_error(harness.post_wav(make_wav(), headers={"Content-Type": content_type}), 415, "unsupported_media_type")


def test_missing_content_type_is_415(harness):
    response = harness.client.post("/v1/transcribe", content=make_wav(), headers=harness.auth)
    assert_error(response, 415, "unsupported_media_type")


def test_non_wav_body_is_415(harness):
    assert_error(harness.post_wav(b"ID3\x03\x00\x00\x00 fake mp3 data" * 10), 415, "invalid_wav")
    assert_error(harness.post_wav(b""), 415, "invalid_wav")


@pytest.mark.parametrize(
    ("kwargs", "code"),
    [
        ({"sample_rate": 44100}, "unsupported_wav_format"),
        ({"sample_rate": 8000}, "unsupported_wav_format"),
        ({"channels": 2}, "unsupported_wav_format"),
        ({"sampwidth": 1}, "unsupported_wav_format"),
    ],
)
def test_wrong_wav_parameters_are_415(harness, kwargs, code):
    assert_error(harness.post_wav(make_wav(1.0, **kwargs)), 415, code)
    assert harness.transcriber.calls == []


def test_float_wav_is_415(harness):
    body = make_raw_wav(pcm_fmt(audio_format=3, bits=32), b"\x00" * 64000)
    assert_error(harness.post_wav(body), 415, "unsupported_wav_format")


def test_empty_wav_is_415(harness):
    assert_error(harness.post_wav(make_raw_wav(pcm_fmt(), b"")), 415, "empty_audio")


def test_longer_than_30_seconds_is_413(harness):
    assert_error(harness.post_wav(make_wav(30.1)), 413, "audio_too_long")
    assert harness.transcriber.calls == []


def test_body_over_2mb_with_content_length_is_413(harness):
    body = make_raw_wav(pcm_fmt(), b"\x00" * (2 * 1024 * 1024))
    assert_error(harness.post_wav(body), 413, "payload_too_large")


def test_chunked_body_over_2mb_is_413(harness):
    chunk = b"\x00" * (256 * 1024)

    def stream():
        yield make_raw_wav(pcm_fmt(), b"")[:44]
        for _ in range(10):
            yield chunk

    response = harness.client.post(
        "/v1/transcribe",
        content=stream(),
        headers={"Content-Type": "audio/wav", **harness.auth},
    )
    assert_error(response, 413, "payload_too_large")
    assert harness.transcriber.calls == []


# ---- 模型状态 503 ----


def test_loading_model_returns_503_then_recovers():
    release = threading.Event()
    transcriber = FakeTranscriber()

    def slow_factory(on_phase):
        on_phase("downloading")
        assert release.wait(10)
        on_phase("loading")
        return transcriber

    with running_app(factory=slow_factory, transcriber=transcriber, wait_ready=False) as h:
        health = h.client.get("/health").json()
        assert set(health) == HEALTH_KEYS
        assert health["status"] == "loading"
        assert health["ready"] is False

        response = h.post_wav(make_wav())
        assert_error(response, 503, "model_loading")
        assert response.headers["retry-after"].isdigit()

        # 格式错误仍优先返回 415，便于客户端尽早发现问题。
        assert_error(h.post_wav(b"garbage"), 415, "invalid_wav")

        release.set()
        assert h.manager.wait_until_settled(5)
        assert h.client.get("/health").json()["status"] == "ok"
        assert h.post_wav(make_wav()).status_code == 200


def test_failed_model_load_reports_error_and_503():
    def broken_factory(on_phase):
        raise ModelLoadError("模型下载失败：ConnectionError")

    with running_app(factory=broken_factory) as h:
        health = h.client.get("/health").json()
        assert health["status"] == "error"
        assert health["ready"] is False
        assert_error(h.post_wav(make_wav()), 503, "model_unavailable")


def test_unexpected_loader_exception_is_error_state():
    def broken_factory(on_phase):
        raise RuntimeError("boom")

    with running_app(factory=broken_factory) as h:
        assert h.client.get("/health").json()["status"] == "error"


# ---- 并发 429 ----


def test_busy_returns_429_with_retry_after_and_serializes_inference():
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    with running_app(transcriber=transcriber, queue_size=1) as h:
        results: list[int] = []

        def call():
            results.append(h.post_wav(make_wav()).status_code)

        first = threading.Thread(target=call)
        first.start()
        assert transcriber.started.acquire(timeout=5)  # 第 1 个在推理中
        second = threading.Thread(target=call)
        second.start()
        wait_for(lambda: h.gate().pending == 2)  # 第 2 个在排队

        response = h.post_wav(make_wav())
        assert_error(response, 429, "busy")
        retry_after = int(response.headers["retry-after"])
        assert 1 <= retry_after <= 60

        release.set()
        first.join(10)
        second.join(10)
        assert sorted(results) == [200, 200]
        assert transcriber.max_active == 1  # 同一时刻只有 1 个推理
        wait_for(lambda: h.gate().pending == 0)
        assert h.post_wav(make_wav()).status_code == 200


def test_transcriber_exception_is_500_without_internal_details(harness):
    harness.transcriber.error = RuntimeError("secret internal detail /Users/someone/model.bin")
    response = harness.post_wav(make_wav())
    assert_error(response, 500, "transcription_failed")
    assert "secret internal detail" not in response.text
    # 失败不占用并发槽位。
    harness.transcriber.error = None
    assert harness.post_wav(make_wav()).status_code == 200


def test_shutdown_releases_model():
    transcriber = FakeTranscriber()
    with running_app(transcriber=transcriber) as h:
        assert h.post_wav(make_wav()).status_code == 200
        assert not transcriber.closed
    assert transcriber.closed
    assert h.manager.snapshot().status == "error"


# ---- 令牌轮换（HTTP 层） ----


def test_token_rotation_takes_effect_over_http_without_restart(tmp_path):
    store = TokenStore(tmp_path / "home")
    old, _ = store.ensure()
    with running_app(verify_token=FileTokenVerifier(store), token=old) as h:
        assert h.post_wav(make_wav()).status_code == 200
        new = store.rotate()
        assert_error(h.post_wav(make_wav()), 401, "unauthorized")
        response = h.client.post(
            "/v1/transcribe",
            content=make_wav(),
            headers={"Content-Type": "audio/wav", "Authorization": f"Bearer {new}"},
        )
        assert response.status_code == 200


# ---- 日志不含令牌与转写全文 ----


def test_logs_never_contain_token_or_transcript_text(caplog):
    caplog.set_level(logging.DEBUG)
    secret_text = "SECRET-TRANSCRIPT-机密文本"
    transcriber = FakeTranscriber(
        result=TranscriptionResult(
            text=secret_text,
            language="zh",
            language_probability=0.9,
            segments=[SegmentResult(0, 500, secret_text, -0.1, 0.01)],
        )
    )
    with running_app(transcriber=transcriber) as h:
        assert h.post_wav(make_wav()).status_code == 200
        h.client.post(
            "/v1/transcribe",
            content=make_wav(),
            headers={"Content-Type": "audio/wav", "Authorization": f"Bearer {h.token}x"},
        )
        h.client.get("/health", headers={"Origin": "https://evil.example"})
        h.post_wav(b"RIFF" + h.token.encode())
        transcriber.error = RuntimeError("decoder failed")
        h.post_wav(make_wav())
        token = h.token
    formatter = logging.Formatter()
    assert caplog.records
    for record in caplog.records:
        text = record.getMessage()
        if record.exc_info:
            text += formatter.formatException(record.exc_info)
        if record.exc_text:
            text += record.exc_text
        assert token not in text, record.name
        assert secret_text not in text, record.name


# ---- 请求体读取：Content-Length 预检、流式计数、时限、上传中断开（ASGI 直调） ----


def _receiver(chunks: list[bytes], *, then: str = "end", stall: asyncio.Event | None = None):
    """按顺序返回请求体分片。

    then='end'：最后一片 more_body=False；之后的 receive（断开检测）等待 stall 事件再返回断开，
    未给 stall 时立即返回断开。then='disconnect'：分片后发送断开。then='stall'：分片后永远等待（慢速上传）。
    """
    calls = {"count": 0}
    queue = list(chunks)

    async def receive() -> dict:
        calls["count"] += 1
        if queue:
            body = queue.pop(0)
            more = bool(queue) or then != "end"
            return {"type": "http.request", "body": body, "more_body": more}
        if then == "stall":
            await asyncio.Event().wait()
        if then == "end" and stall is not None:
            await stall.wait()
        return {"type": "http.disconnect"}

    return receive, calls


def test_content_length_precheck_rejects_without_reading_body():
    app, _, token = make_plain_app()
    receive, calls = _receiver([b"x" * 10])
    result = asyncio.run(
        asgi_call(
            app,
            receive,
            token=token,
            headers=[("content-type", "audio/wav"), ("content-length", str(3 * 1024 * 1024))],
        )
    )
    assert result.status == 413
    assert result.json()["error"]["code"] == "payload_too_large"
    assert result.headers["connection"] == "close"
    assert calls["count"] == 0


def test_streaming_count_rejects_oversized_body_without_content_length():
    app, _, token = make_plain_app()
    chunk = b"\x00" * (512 * 1024)
    receive, calls = _receiver([chunk] * 10)
    result = asyncio.run(asgi_call(app, receive, token=token, headers=[("content-type", "audio/wav")]))
    assert result.status == 413
    assert result.json()["error"]["code"] == "payload_too_large"
    # 超过 2 MB 的那一片读完就停止，不会把 10 片全部读完。
    assert calls["count"] == 5


def test_forged_small_content_length_is_still_limited_by_streaming_count():
    app, _, token = make_plain_app()
    receive, calls = _receiver([b"\x00" * (1024 * 1024)] * 4)
    result = asyncio.run(
        asgi_call(app, receive, token=token, headers=[("content-type", "audio/wav"), ("content-length", "100")])
    )
    assert result.status == 413
    assert calls["count"] == 3


@pytest.mark.parametrize("value", ["abc", "-1", "1e3"])
def test_invalid_content_length_is_400(value):
    app, _, token = make_plain_app()
    receive, _ = _receiver([make_wav()])
    result = asyncio.run(
        asgi_call(app, receive, token=token, headers=[("content-type", "audio/wav"), ("content-length", value)])
    )
    assert result.status == 400
    assert result.json()["error"]["code"] == "invalid_request"


def test_slow_upload_times_out_with_408_and_connection_close():
    app, _, token = make_plain_app(body_timeout_s=0.3)
    receive, calls = _receiver([make_wav()[:100]], then="stall")
    result = asyncio.run(asgi_call(app, receive, token=token, headers=[("content-type", "audio/wav")]))
    assert result.status == 408
    assert result.json()["error"]["code"] == "request_timeout"
    assert result.headers["connection"] == "close"
    assert calls["count"] == 2


def test_client_disconnect_during_upload_is_499_without_error_log(caplog):
    caplog.set_level(logging.INFO)
    app, _, token = make_plain_app()
    receive, _ = _receiver([make_wav()[:100]], then="disconnect")
    result = asyncio.run(asgi_call(app, receive, token=token, headers=[("content-type", "audio/wav")]))
    assert result.status == 499
    assert result.json()["error"]["code"] == "client_closed_request"
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []
    assert sum("上传音频时断开" in r.getMessage() for r in caplog.records) == 1


def test_client_disconnect_while_queued_is_499_and_skips_inference():
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    app, manager, token = make_plain_app(transcriber=transcriber, queue_size=2)
    manager.start()
    assert manager.wait_until_settled(5)
    wav = make_wav()

    async def until(predicate) -> None:
        async def loop() -> None:
            while not predicate():
                await asyncio.sleep(0.01)

        await asyncio.wait_for(loop(), 5)

    async def scenario():
        gate = app.state.gate
        first_receive, _ = _receiver([wav], stall=asyncio.Event())  # 第 1 个客户端一直在线
        first = asyncio.create_task(
            asgi_call(app, first_receive, token=token, headers=[("content-type", "audio/wav")])
        )
        await until(lambda: gate.running == 1)
        disconnect = asyncio.Event()
        second_receive, _ = _receiver([wav], stall=disconnect)
        second = asyncio.create_task(
            asgi_call(app, second_receive, token=token, headers=[("content-type", "audio/wav")])
        )
        await until(lambda: gate.pending == 2)
        disconnect.set()  # 之后 receive 立即返回 http.disconnect
        second_result = await asyncio.wait_for(second, 5)
        assert gate.pending == 1
        release.set()
        first_result = await asyncio.wait_for(first, 5)
        return first_result, second_result

    try:
        first_result, second_result = asyncio.run(scenario())
    finally:
        release.set()
        manager.close()
    assert second_result.status == 499
    assert second_result.json()["error"]["code"] == "client_closed_request"
    assert first_result.status == 200
    assert len(transcriber.calls) == 1


# ---- 停止中（应用层） ----


def test_begin_shutdown_rejects_queued_and_new_requests_but_finishes_running():
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    with running_app(transcriber=transcriber, queue_size=2) as h:
        results: dict[str, int] = {}
        bodies: dict[str, dict] = {}

        def call(key: str) -> None:
            response = h.post_wav(make_wav())
            results[key] = response.status_code
            bodies[key] = response.json()

        running = threading.Thread(target=call, args=("running",))
        running.start()
        assert transcriber.started.acquire(timeout=5)
        queued = threading.Thread(target=call, args=("queued",))
        queued.start()
        wait_for(lambda: h.gate().pending == 2)

        h.client.portal.call(h.client.app.state.begin_shutdown)

        queued.join(5)
        assert not queued.is_alive()
        assert results["queued"] == 503
        assert bodies["queued"]["error"]["code"] == "model_unavailable"
        assert_error(h.post_wav(make_wav()), 503, "model_unavailable")
        health = h.client.get("/health").json()
        assert (health["status"], health["ready"]) == ("error", False)
        assert running.is_alive()

        release.set()
        running.join(5)
        assert results["running"] == 200
        assert len(transcriber.calls) == 1
    assert transcriber.closed

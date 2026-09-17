"""不经过 HTTP 的单元测试：配置、令牌、WAV 解析、并发闸门、片段转换、模型生命周期、端口与 CLI。"""

from __future__ import annotations

import asyncio
import os
import socket
import stat
import struct
import threading
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from conftest import FakeTranscriber, make_raw_wav, make_wav, pcm_fmt, wait_for
from tongting_asr import cli
from tongting_asr.config import ConfigError, ModelConfig, ServiceConfig, validate_bind_host, validate_extension_id
from tongting_asr.errors import ApiError
from tongting_asr.gate import BusyError, ClientDisconnected, InferenceGate
from tongting_asr.log import RedactingFilter, sanitize_text
from tongting_asr.model_manager import ModelManager
from tongting_asr.server import PortInUseError, create_listen_socket
from tongting_asr.token_store import FileTokenVerifier, TokenError, TokenStore
from tongting_asr.transcriber import FasterWhisperTranscriber, build_segments
from tongting_asr.wav import parse_wav

# ---- 绑定地址 ----


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "::1", "192.168.1.10", "10.0.0.1", "example.com", "127.0.0.2", ""])
def test_non_loopback_bind_host_is_rejected(host):
    with pytest.raises(ConfigError):
        validate_bind_host(host)
    with pytest.raises(ConfigError):
        ServiceConfig(host=host)


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", " LOCALHOST "])
def test_loopback_bind_host_is_accepted(host):
    assert validate_bind_host(host) == "127.0.0.1"


def test_cli_serve_refuses_non_loopback_before_creating_token(tmp_path, capsys):
    code = cli.main(["serve", "--host", "0.0.0.0", "--data-dir", str(tmp_path / "home")])
    assert code == cli.EXIT_CONFIG
    assert "127.0.0.1" in capsys.readouterr().err
    assert not (tmp_path / "home").exists()


@pytest.mark.parametrize("value", ["ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP", "abc", "qbcdefghijklmnopabcdefghijklmnop"])
def test_invalid_extension_id_is_rejected(value):
    with pytest.raises(ConfigError):
        validate_extension_id(value)


def test_extension_id_accepts_full_origin():
    assert validate_extension_id("chrome-extension://abcdefghijklmnopabcdefghijklmnop/") == "abcdefghijklmnopabcdefghijklmnop"


def test_model_config_validation():
    with pytest.raises(ConfigError):
        ModelConfig(device="metal")
    with pytest.raises(ConfigError):
        ModelConfig(beam_size=0)


# ---- 端口冲突 ----


def test_port_conflict_gives_clear_error(capsys, tmp_path):
    occupied = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    occupied.bind(("127.0.0.1", 0))
    occupied.listen(1)
    port = occupied.getsockname()[1]
    try:
        with pytest.raises(PortInUseError) as info:
            create_listen_socket("127.0.0.1", port)
        assert str(port) in str(info.value)
        assert "已被占用" in str(info.value)

        code = cli.main(["serve", "--port", str(port), "--data-dir", str(tmp_path / "home")])
        assert code == cli.EXIT_PORT_IN_USE
        assert "已被占用" in capsys.readouterr().err
    finally:
        occupied.close()


def test_listen_socket_binds_loopback_only():
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    sock = create_listen_socket("localhost", port)
    try:
        assert sock.getsockname() == ("127.0.0.1", port)
    finally:
        sock.close()


# ---- 令牌 ----


def test_token_is_created_with_private_permissions(tmp_path):
    store = TokenStore(tmp_path / "home")
    token, created = store.ensure()
    assert created
    assert len(token) >= 43
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    assert stat.S_IMODE(store.data_dir.stat().st_mode) == 0o700
    again, created_again = store.ensure()
    assert (again, created_again) == (token, False)
    assert [p.name for p in store.data_dir.iterdir()] == ["token"]  # 不残留临时文件


def test_rotate_invalidates_old_token_without_restart(tmp_path):
    store = TokenStore(tmp_path)
    old, _ = store.ensure()
    verifier = FileTokenVerifier(store)
    assert verifier(old)
    assert not verifier(old + "x")
    new = store.rotate()
    assert new != old
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600
    assert not verifier(old)
    assert verifier(new)


def test_verifier_fails_closed_when_token_file_missing_or_corrupt(tmp_path):
    store = TokenStore(tmp_path)
    token, _ = store.ensure()
    verifier = FileTokenVerifier(store)
    assert verifier(token)
    store.path.write_text("not a token!\n")
    assert not verifier(token)
    store.path.unlink()
    assert not verifier(token)


def test_loose_token_permissions_are_fixed(tmp_path):
    store = TokenStore(tmp_path)
    token, _ = store.ensure()
    os.chmod(store.path, 0o644)
    assert store.read() == token
    assert stat.S_IMODE(store.path.stat().st_mode) == 0o600


def test_corrupt_token_file_raises(tmp_path):
    store = TokenStore(tmp_path)
    store.path.write_text("short")
    os.chmod(store.path, 0o600)
    with pytest.raises(TokenError):
        store.read()


def test_print_and_rotate_token_commands(tmp_path, capsys):
    home = str(tmp_path / "home")
    assert cli.main(["print-token", "--data-dir", home]) == 0
    first = capsys.readouterr().out.strip()
    assert cli.main(["print-token", "--data-dir", home]) == 0
    assert capsys.readouterr().out.strip() == first
    assert cli.main(["rotate-token", "--data-dir", home]) == 0
    rotated = capsys.readouterr().out.strip()
    assert rotated != first
    assert TokenStore(Path(home)).read() == rotated


# ---- 日志脱敏 ----


def test_sanitize_text_removes_credentials_and_query_strings():
    text = "GET https://user:pw@cdn.example/file?Signature=abc&X=1 failed; Authorization: Bearer abc.def"
    cleaned = sanitize_text(text)
    assert "Signature" not in cleaned
    assert "pw@" not in cleaned
    assert "abc.def" not in cleaned


def test_redacting_filter_hides_registered_secret():
    import logging

    flt = RedactingFilter()
    flt.add_secret("s3cr3t-token-value")
    record = logging.LogRecord("x", logging.INFO, __file__, 1, "token=%s", ("s3cr3t-token-value",), None)
    flt.filter(record)
    assert "s3cr3t-token-value" not in record.getMessage()


# ---- WAV 解析 ----


def test_parse_wav_from_wave_module():
    audio = parse_wav(make_wav(1.5))
    assert audio.sample_count == 24000
    assert audio.duration_ms == 1500
    samples = audio.to_float32()
    assert samples.dtype == np.float32
    assert float(np.abs(samples).max()) <= 1.0


def test_parse_wav_skips_unknown_chunks_with_padding():
    odd_chunk = b"LIST" + struct.pack("<I", 3) + b"abc" + b"\x00"
    body = make_raw_wav(pcm_fmt(), b"\x01\x00" * 1600, extra_chunks=odd_chunk)
    assert parse_wav(body).sample_count == 1600


def test_parse_wav_accepts_extensible_pcm():
    guid = b"\x01\x00" + b"\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71"
    fmt = pcm_fmt(audio_format=0xFFFE) + struct.pack("<HHI", 22, 16, 4) + guid
    assert parse_wav(make_raw_wav(fmt, b"\x00\x00" * 160)).sample_count == 160


@pytest.mark.parametrize(
    ("body", "status", "code"),
    [
        (b"RIFF\x00\x00\x00\x00WAVE", 415, "invalid_wav"),
        (b"RIFX" + b"\x00" * 40, 415, "invalid_wav"),
        (make_raw_wav(pcm_fmt(), b"\x00\x00" * 100)[:-10], 415, "invalid_wav"),  # data 截断
        (make_raw_wav(pcm_fmt(), b"\x00" * 101), 415, "invalid_wav"),  # 奇数字节
        (make_raw_wav(pcm_fmt(bits=24), b"\x00" * 300), 415, "unsupported_wav_format"),
        (make_raw_wav(pcm_fmt(), b"\x00\x00" * (30 * 16000 + 1)), 413, "audio_too_long"),
    ],
)
def test_parse_wav_errors(body, status, code):
    with pytest.raises(ApiError) as info:
        parse_wav(body)
    assert (info.value.status, info.value.code) == (status, code)


def test_parse_wav_rejects_data_before_fmt():
    data_first = b"WAVE" + b"data" + struct.pack("<I", 4) + b"\x00" * 4 + b"fmt " + struct.pack("<I", 16) + pcm_fmt()
    body = b"RIFF" + struct.pack("<I", len(data_first)) + data_first
    with pytest.raises(ApiError):
        parse_wav(body)


# ---- 并发闸门 ----


def test_gate_frees_queue_slot_when_waiting_client_disconnects():
    async def scenario():
        gate = InferenceGate(queue_size=1)
        hold = asyncio.Event()
        disconnected = asyncio.Event()

        async def never_disconnected() -> bool:
            return False

        async def maybe_disconnected() -> bool:
            return disconnected.is_set()

        async def running():
            async with gate.slot(never_disconnected):
                await hold.wait()

        runner = asyncio.create_task(running())
        await asyncio.sleep(0)
        assert gate.running == 1

        async def queued():
            async with gate.slot(maybe_disconnected):
                raise AssertionError("断开的请求不应拿到推理许可")

        waiter = asyncio.create_task(queued())
        await asyncio.sleep(0.05)
        assert gate.pending == 2
        with pytest.raises(BusyError):
            async with gate.slot(never_disconnected):
                pass

        disconnected.set()
        with pytest.raises(ClientDisconnected):
            await waiter
        assert gate.pending == 1

        hold.set()
        await runner
        assert gate.pending == 0
        # 许可没有泄漏：新请求可以立即拿到。
        async with gate.slot(never_disconnected):
            assert gate.running == 1

    asyncio.run(scenario())


# ---- faster-whisper 片段转换（不加载模型） ----


def test_build_segments_converts_to_clamped_milliseconds():
    raw = [
        SimpleNamespace(start=0.0, end=1.2344, text=" Hello", avg_logprob=-0.2, no_speech_prob=0.1),
        SimpleNamespace(start=1.3, end=1.3, text="   ", avg_logprob=-0.2, no_speech_prob=0.1),
        SimpleNamespace(start=1.5, end=9.0, text=" world.", avg_logprob=float("-inf"), no_speech_prob=float("nan")),
    ]
    text, segments = build_segments(raw, duration_ms=5000)
    assert text == "Hello world."
    assert [(s.start_ms, s.end_ms, s.text) for s in segments] == [(0, 1234, "Hello"), (1500, 5000, "world.")]
    assert segments[1].avg_logprob == -100.0
    assert segments[1].no_speech_prob == 0.0


def test_faster_whisper_transcriber_uses_hallucination_reducing_options():
    captured = {}

    class FakeModel:
        def transcribe(self, audio, **kwargs):
            captured.update(kwargs)
            segments = iter([SimpleNamespace(start=0.0, end=0.8, text="こんにちは", avg_logprob=-0.3, no_speech_prob=0.0)])
            return segments, SimpleNamespace(language="ja", language_probability=0.97)

    transcriber = FasterWhisperTranscriber(
        FakeModel(), model_name="small", device="cpu", compute_type="int8", beam_size=5, supported_languages=["ja"]
    )
    result = transcriber.transcribe(np.zeros(16000, dtype=np.float32), None)
    assert captured["vad_filter"] is True
    assert captured["condition_on_previous_text"] is False
    assert captured["language"] is None
    assert captured["without_timestamps"] is False
    assert result.language == "ja"
    assert result.text == "こんにちは"
    transcriber.close()
    with pytest.raises(RuntimeError):
        transcriber.transcribe(np.zeros(160, dtype=np.float32), "ja")


# ---- 模型生命周期 ----


def test_model_loaded_after_close_is_released_immediately():
    release = threading.Event()
    transcriber = FakeTranscriber()

    def factory(on_phase):
        assert release.wait(5)
        return transcriber

    manager = ModelManager(factory, model_name="fake", device="cpu", compute_type="int8")
    manager.start()
    manager.close()
    release.set()
    assert manager.wait_until_settled(5)
    assert transcriber.closed
    assert manager.snapshot().ready is False


def test_close_waits_for_running_inference_before_unloading():
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    manager = ModelManager(lambda on_phase: transcriber, model_name="fake", device="cpu", compute_type="int8")
    manager.start()
    assert manager.wait_until_settled(5)

    def infer():
        with manager.lease() as t:
            t.transcribe(np.zeros(160, dtype=np.float32), None)

    worker = threading.Thread(target=infer)
    worker.start()
    assert transcriber.started.acquire(timeout=5)
    closer = threading.Thread(target=manager.close)
    closer.start()
    wait_for(lambda: manager.snapshot().phase == "closed")
    assert not transcriber.closed  # 推理未结束前不卸载
    release.set()
    worker.join(5)
    closer.join(5)
    assert transcriber.closed


# ================= 审查修复补充 =================

import errno as _errno  # noqa: E402
import logging as _logging  # noqa: E402
import time as _time  # noqa: E402

from conftest import running_app  # noqa: E402
from tongting_asr.config import display_model_name  # noqa: E402
from tongting_asr.gate import GateClosed  # noqa: E402
from tongting_asr.log import LogThrottle  # noqa: E402
from tongting_asr.server import make_loop_exception_handler, raise_nofile_limit  # noqa: E402

# ---- 日志限速 ----


class _Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_log_throttle_logs_first_then_summarizes_after_interval(caplog):
    caplog.set_level(_logging.INFO)
    clock = _Clock()
    throttle = LogThrottle(_logging.getLogger("t.throttle"), interval_s=60, clock=clock)
    key = ("reject", "origin_not_allowed", "https://evil.example")
    for _ in range(5):
        throttle.log(key, _logging.WARNING, "拒绝请求 origin", "拒绝 %s", "detail")
    assert [r.getMessage() for r in caplog.records] == ["拒绝 detail"]
    clock.now += 61
    throttle.flush_expired()
    messages = [r.getMessage() for r in caplog.records]
    assert len(messages) == 2 and "另有 4 次" in messages[1]
    # 窗口结束后同一 key 重新记录首条。
    throttle.log(key, _logging.WARNING, "拒绝请求 origin", "拒绝 %s", "detail")
    assert len(caplog.records) == 3


def test_log_throttle_caps_number_of_keys(caplog):
    caplog.set_level(_logging.INFO)
    throttle = LogThrottle(_logging.getLogger("t.cap"), max_keys=3, clock=_Clock())
    for i in range(50):
        throttle.log(("reject", "origin", f"https://evil{i}.example"), _logging.WARNING, "拒绝请求（x）", "拒绝 %d", i)
    assert len(throttle._entries) <= 4
    assert len(caplog.records) == 4  # 3 个独立来源 + 1 个「其他来源」桶的首条


def test_security_rejections_are_logged_once_per_reason_and_source(caplog):
    caplog.set_level(_logging.INFO)
    with running_app() as h:
        for _ in range(20):
            h.client.get("/health", headers={"Origin": "https://www.youtube.com"})
        for _ in range(5):
            h.client.get("/health", headers={"Origin": "https://evil.example"})
    rejects = [r for r in caplog.records if r.name == "tongting_asr.security" and "拒绝请求 GET" in r.getMessage()]
    assert len(rejects) == 2
    # 应用停止时把被合并的次数汇总输出。
    assert any("另有 19 次" in r.getMessage() for r in caplog.records)


def test_redacting_filter_redacts_exception_text_and_stack_info():
    flt = RedactingFilter()
    flt.add_secret("s3cr3t-token-value")
    try:
        raise RuntimeError("boom s3cr3t-token-value Authorization: Bearer abc.def")
    except RuntimeError:
        import sys

        record = _logging.LogRecord("x", _logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    record.stack_info = "Stack: s3cr3t-token-value"
    flt.filter(record)
    formatted = _logging.Formatter().format(record)
    assert "s3cr3t-token-value" not in formatted
    assert "abc.def" not in formatted
    assert "RuntimeError" in formatted


def test_loop_exception_handler_throttles_accept_resource_errors(caplog):
    caplog.set_level(_logging.INFO)
    defaults: list[dict] = []
    loop = SimpleNamespace(default_exception_handler=defaults.append)
    handler = make_loop_exception_handler(LogThrottle(_logging.getLogger("t.loop"), clock=_Clock()))
    for _ in range(100):
        context = {"message": "socket.accept() out of system resource", "exception": OSError(_errno.EMFILE, "EMFILE")}
        handler(loop, context)
    assert len(caplog.records) == 1 and caplog.records[0].exc_info is None
    handler(loop, {"message": "other", "exception": ValueError("x")})
    assert len(defaults) == 1


def test_raise_nofile_limit_raises_soft_limit_within_hard_limit(monkeypatch):
    import resource

    calls = []
    monkeypatch.setattr(resource, "getrlimit", lambda _: (256, 10240))
    monkeypatch.setattr(resource, "setrlimit", lambda kind, limits: calls.append(limits))
    assert raise_nofile_limit(4096) == (256, 4096)
    assert calls == [(4096, 10240)]
    monkeypatch.setattr(resource, "getrlimit", lambda _: (8192, 10240))
    assert raise_nofile_limit(4096) == (8192, 8192)


# ---- 模型名称展示 ----


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("small", "small"),
        ("large-v3", "large-v3"),
        ("/Users/someone/private/models/whisper-x", "whisper-x"),
        ("/does/not/exist/model-dir/", "model-dir"),
        ("~/models/x", "x"),
        ("./models/abc", "abc"),
        ("Systran/faster-whisper-small", "faster-whisper-small"),
        ("C:\\Users\\x\\model", "model"),
        ("~", "local-model"),
        ("/", "local-model"),
    ],
)
def test_display_model_name_never_echoes_paths(value, expected):
    assert display_model_name(value) == expected


# ---- 数据目录与令牌文件属主/权限 ----


def test_group_writable_data_dir_is_refused(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    os.chmod(home, 0o777)
    with pytest.raises(TokenError, match="可写"):
        TokenStore(home).ensure()
    assert not (home / "token").exists()


def test_foreign_owner_is_refused(tmp_path, monkeypatch):
    store = TokenStore(tmp_path / "home")
    store.ensure()
    real_uid = os.getuid()
    monkeypatch.setattr(os, "getuid", lambda: real_uid + 1)
    with pytest.raises(TokenError, match="属主"):
        store.read()
    with pytest.raises(TokenError, match="属主"):
        store.rotate()


def test_symlinked_token_file_is_refused(tmp_path):
    home = tmp_path / "home"
    home.mkdir(mode=0o700)
    target = tmp_path / "elsewhere"
    target.write_text("a" * 43)
    os.symlink(target, home / "token")
    with pytest.raises(TokenError, match="符号链接"):
        TokenStore(home).ensure()


def test_cli_refuses_unsafe_data_dir(tmp_path, capsys):
    home = tmp_path / "home"
    home.mkdir()
    os.chmod(home, 0o770)
    assert cli.main(["print-token", "--data-dir", str(home)]) == cli.EXIT_CONFIG
    assert "可写" in capsys.readouterr().err


# ---- 令牌只在终端打印 / Windows 提示 ----


def test_new_token_is_not_printed_when_stdout_is_not_a_terminal(tmp_path, monkeypatch, capsys, caplog):
    caplog.set_level(_logging.INFO)
    store = TokenStore(tmp_path / "home")
    token, created = store.ensure()
    monkeypatch.setattr(cli, "_stdout_is_terminal", lambda: False)
    cli._announce_token(store, token, created)
    captured = capsys.readouterr()
    assert token not in captured.out + captured.err
    assert all(token not in r.getMessage() for r in caplog.records)
    assert any("print-token" in r.getMessage() for r in caplog.records)

    monkeypatch.setattr(cli, "_stdout_is_terminal", lambda: True)
    cli._announce_token(store, token, created)
    assert token in capsys.readouterr().out


def test_windows_is_refused_with_clear_message(monkeypatch, capsys, tmp_path):
    monkeypatch.setattr(cli, "_platform_unsupported", lambda: True)
    assert cli.main(["print-token", "--data-dir", str(tmp_path / "home")]) == cli.EXIT_CONFIG
    assert "Windows" in capsys.readouterr().err
    assert not (tmp_path / "home").exists()


# ---- 闸门：取消分支与停止 ----


async def _never() -> bool:
    return False


def test_gate_cancelled_waiter_frees_queue_slot_and_permit():
    async def scenario():
        gate = InferenceGate(queue_size=2, disconnect_poll_s=10)
        hold = asyncio.Event()

        async def holder():
            async with gate.slot(_never):
                await hold.wait()

        async def queued():
            async with gate.slot(_never):
                pass

        t1 = asyncio.create_task(holder())
        await asyncio.sleep(0)
        t2 = asyncio.create_task(queued())
        while not gate._semaphore._waiters:
            await asyncio.sleep(0)
        t2.cancel()
        with pytest.raises(asyncio.CancelledError):
            await t2
        assert gate.pending == 1
        hold.set()
        await t1
        assert gate.pending == 0 and gate._semaphore._value == 1

    asyncio.run(scenario())


def test_gate_waiter_woken_then_cancelled_returns_permit_to_next_waiter():
    async def scenario():
        gate = InferenceGate(queue_size=3, disconnect_poll_s=10)
        tasks: dict[str, asyncio.Task] = {}
        third_entered = asyncio.Event()

        async def holder():
            async with gate.slot(_never):
                while not (gate._semaphore._waiters and len(gate._semaphore._waiters) == 2):
                    await asyncio.sleep(0)
                # 同一步内：先取消第 2 个，再退出 with 释放许可（许可会先被转交给第 2 个）。
                tasks["second"].cancel()

        async def second():
            async with gate.slot(_never):
                raise AssertionError("被取消的请求不应拿到许可")

        async def third():
            async with gate.slot(_never):
                third_entered.set()

        tasks["holder"] = asyncio.create_task(holder())
        await asyncio.sleep(0)
        tasks["second"] = asyncio.create_task(second())
        while not gate._semaphore._waiters:
            await asyncio.sleep(0)
        tasks["third"] = asyncio.create_task(third())
        await asyncio.wait_for(third_entered.wait(), 5)
        await tasks["holder"]
        await tasks["third"]
        with pytest.raises(asyncio.CancelledError):
            await tasks["second"]
        assert gate.pending == 0 and gate._semaphore._value == 1 and not gate._semaphore.locked()

    asyncio.run(scenario())


def test_gate_close_wakes_queued_and_rejects_new_but_keeps_running():
    async def scenario():
        gate = InferenceGate(queue_size=2, disconnect_poll_s=10)
        hold = asyncio.Event()

        async def holder():
            async with gate.slot(_never):
                await hold.wait()

        async def queued():
            async with gate.slot(_never):
                pass

        t1 = asyncio.create_task(holder())
        await asyncio.sleep(0)
        t2 = asyncio.create_task(queued())
        while not gate._semaphore._waiters:
            await asyncio.sleep(0)
        started = _time.monotonic()
        gate.close()
        with pytest.raises(GateClosed):
            await asyncio.wait_for(t2, 5)
        assert _time.monotonic() - started < 1
        with pytest.raises(GateClosed):
            async with gate.slot(_never):
                pass
        assert gate.running == 1
        hold.set()
        await t1
        assert gate.pending == 0 and gate._semaphore._value == 1

    asyncio.run(scenario())


def test_manager_begin_shutdown_rejects_new_leases_and_bounds_close_wait():
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    manager = ModelManager(lambda on_phase: transcriber, model_name="fake", device="cpu", compute_type="int8")
    manager.start()
    assert manager.wait_until_settled(5)
    def infer() -> None:
        with manager.lease() as leased:
            leased.transcribe(np.zeros(160, dtype=np.float32), None)

    worker = threading.Thread(target=infer)
    worker.start()
    assert transcriber.started.acquire(timeout=5)
    manager.begin_shutdown(_time.monotonic() + 0.2)
    assert manager.snapshot().status == "error"
    with pytest.raises(ApiError) as info:
        manager.require_ready()
    assert info.value.code == "model_unavailable"
    started = _time.monotonic()
    manager.close()  # 推理仍在进行：只等到截止时间，不卸载模型
    assert _time.monotonic() - started < 2
    assert not transcriber.closed
    release.set()
    worker.join(5)

"""测试公共设施：内存 WAV 构造、可控的假转写器、应用客户端、ASGI 直调与真实 uvicorn 服务。

所有测试都不下载模型、不访问外网；需要等待的地方都等待明确条件，不依赖固定 sleep。
"""

from __future__ import annotations

import http.client
import io
import json
import logging
import math
import secrets
import socket
import struct
import threading
import time
import wave
from collections.abc import Awaitable, Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field

import numpy as np
import pytest
from starlette.testclient import TestClient

from tongting_asr.app import create_app
from tongting_asr.config import ServiceConfig
from tongting_asr.model_manager import ModelManager
from tongting_asr.server import TongtingServer, build_server
from tongting_asr.token_store import StaticTokenVerifier
from tongting_asr.transcriber import SegmentResult, TranscriptionResult

PORT = 8765
BASE_URL = f"http://127.0.0.1:{PORT}"
EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"


@pytest.fixture(autouse=True)
def _restore_logging() -> Iterator[None]:
    """cli.main 会调用 setup_logging 替换根 logger 处理器；每个测试后恢复，避免污染后续测试。"""
    root = logging.getLogger()
    handlers = list(root.handlers)
    level = root.level
    yield
    for handler in list(root.handlers):
        if handler not in handlers:
            root.removeHandler(handler)
    for handler in handlers:
        if handler not in root.handlers:
            root.addHandler(handler)
    root.setLevel(level)


def make_wav(
    duration_s: float = 1.0,
    *,
    sample_rate: int = 16000,
    channels: int = 1,
    sampwidth: int = 2,
    frequency: float = 440.0,
) -> bytes:
    frames = int(duration_s * sample_rate)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as writer:
        writer.setnchannels(channels)
        writer.setsampwidth(sampwidth)
        writer.setframerate(sample_rate)
        if sampwidth == 2:
            samples = (
                (0.3 * 32767 * np.sin(2 * math.pi * frequency * np.arange(frames) / sample_rate))
                .astype("<i2")
                .repeat(channels)
            )
            writer.writeframes(samples.tobytes())
        else:
            writer.writeframes(bytes([128]) * frames * channels * sampwidth)
    return buffer.getvalue()


def make_raw_wav(fmt_chunk: bytes, data: bytes, *, extra_chunks: bytes = b"") -> bytes:
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt_chunk)) + fmt_chunk + extra_chunks
    body += b"data" + struct.pack("<I", len(data)) + data
    return b"RIFF" + struct.pack("<I", len(body)) + body


def pcm_fmt(
    *,
    audio_format: int = 1,
    channels: int = 1,
    sample_rate: int = 16000,
    bits: int = 16,
) -> bytes:
    block_align = channels * bits // 8
    return struct.pack("<HHIIHH", audio_format, channels, sample_rate, sample_rate * block_align, block_align, bits)


@dataclass
class FakeTranscriber:
    model_name: str = "fake-small"
    device: str = "cpu"
    compute_type: str = "int8"
    supported_languages: frozenset[str] = frozenset({"en", "ja", "zh"})
    result: TranscriptionResult | None = None
    block: threading.Event | None = None
    error: Exception | None = None
    calls: list[tuple[int, str | None]] = field(default_factory=list)
    started: threading.Semaphore = field(default_factory=lambda: threading.Semaphore(0))
    closed: bool = False
    active: int = 0
    max_active: int = 0
    _lock: threading.Lock = field(default_factory=threading.Lock)

    def transcribe(self, audio: np.ndarray, language: str | None) -> TranscriptionResult:
        assert audio.dtype == np.float32
        with self._lock:
            self.active += 1
            self.max_active = max(self.max_active, self.active)
            self.calls.append((int(audio.shape[0]), language))
        self.started.release()
        try:
            if self.block is not None:
                assert self.block.wait(10), "测试未释放阻塞的假转写器"
            if self.error is not None:
                raise self.error
            return self.result or TranscriptionResult(
                text="Hello world. 你好",
                language=language or "en",
                language_probability=0.98765,
                segments=[
                    SegmentResult(start_ms=0, end_ms=1234, text="Hello world.", avg_logprob=-0.21, no_speech_prob=0.01),
                    SegmentResult(start_ms=1234, end_ms=2000, text="你好", avg_logprob=-0.4, no_speech_prob=0.02),
                ],
            )
        finally:
            with self._lock:
                self.active -= 1

    def close(self) -> None:
        self.closed = True


def instant_factory(transcriber: FakeTranscriber) -> Callable:
    def factory(on_phase: Callable[[str], None]) -> FakeTranscriber:
        on_phase("loading")
        return transcriber

    return factory


@dataclass
class Harness:
    client: TestClient
    manager: ModelManager
    transcriber: FakeTranscriber
    token: str

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"}

    def post_wav(self, body: bytes, *, headers: dict[str, str] | None = None, params: dict | None = None):
        merged = {"Content-Type": "audio/wav", **self.auth, **(headers or {})}
        return self.client.post("/v1/transcribe", content=body, headers=merged, params=params)

    def gate(self):
        return self.client.app.state.gate  # type: ignore[attr-defined]


def wait_for(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise AssertionError("等待条件超时")


@contextmanager
def running_app(
    *,
    transcriber: FakeTranscriber | None = None,
    factory: Callable | None = None,
    queue_size: int = 2,
    allowed_extension_ids: frozenset[str] = frozenset(),
    wait_ready: bool = True,
    verify_token: Callable[[str], bool] | None = None,
    token: str | None = None,
    **config_overrides,
) -> Iterator[Harness]:
    transcriber = transcriber or FakeTranscriber()
    token = token or secrets.token_urlsafe(32)
    manager = ModelManager(
        factory or instant_factory(transcriber),
        model_name="fake-small",
        device="cpu",
        compute_type="int8",
    )
    app = create_app(
        config=ServiceConfig(
            port=PORT, queue_size=queue_size, allowed_extension_ids=allowed_extension_ids, **config_overrides
        ),
        manager=manager,
        verify_token=verify_token or StaticTokenVerifier(token),
    )
    with TestClient(app, base_url=BASE_URL, raise_server_exceptions=False) as client:
        if wait_ready:
            assert manager.wait_until_settled(5)
        yield Harness(client=client, manager=manager, transcriber=transcriber, token=token)


@pytest.fixture
def harness() -> Iterator[Harness]:
    with running_app() as h:
        yield h


# ---- ASGI 直调（可精确控制 receive：伪造 Content-Length、慢速上传、上传中断开） ----


@dataclass
class AsgiResult:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> dict:
        return json.loads(self.body)


async def asgi_call(
    app,
    receive: Callable[[], Awaitable[dict]],
    *,
    method: str = "POST",
    path: str = "/v1/transcribe",
    headers: list[tuple[str, str]] | None = None,
    token: str | None = None,
    query: bytes = b"",
) -> AsgiResult:
    raw_headers = [(b"host", f"127.0.0.1:{PORT}".encode())]
    if token is not None:
        raw_headers.append((b"authorization", f"Bearer {token}".encode()))
    raw_headers += [(k.lower().encode(), v.encode()) for k, v in (headers or [])]
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": query,
        "root_path": "",
        "headers": raw_headers,
        "client": ("127.0.0.1", 50000),
        "server": ("127.0.0.1", PORT),
        "state": {},
    }
    messages: list[dict] = []

    async def send(message: dict) -> None:
        messages.append(message)

    await app(scope, receive, send)
    start = next(m for m in messages if m["type"] == "http.response.start")
    return AsgiResult(
        status=start["status"],
        headers={k.decode().lower(): v.decode() for k, v in start.get("headers", [])},
        body=b"".join(m.get("body", b"") for m in messages if m["type"] == "http.response.body"),
    )


def make_plain_app(*, transcriber: FakeTranscriber | None = None, token: str = "t" * 43, **config_overrides):
    """不经过 lifespan 的应用（模型未加载），用于请求体读取阶段的测试。"""
    transcriber = transcriber or FakeTranscriber()
    manager = ModelManager(instant_factory(transcriber), model_name="fake-small", device="cpu", compute_type="int8")
    app = create_app(
        config=ServiceConfig(port=PORT, **config_overrides),
        manager=manager,
        verify_token=StaticTokenVerifier(token),
    )
    return app, manager, token


# ---- 真实 uvicorn 服务（连接超时、洪泛、停止流程） ----


@dataclass
class HttpResult:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> dict:
        return json.loads(self.body)


@dataclass
class LiveServer:
    port: int
    token: str
    server: TongtingServer
    thread: threading.Thread
    app: object
    manager: ModelManager
    transcriber: FakeTranscriber

    def request(
        self,
        method: str,
        path: str,
        *,
        body: bytes | None = None,
        headers: dict[str, str] | None = None,
        timeout: float = 10.0,
    ) -> HttpResult:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=timeout)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            response = conn.getresponse()
            data = response.read()
            return HttpResult(response.status, {k.lower(): v for k, v in response.getheaders()}, data)
        finally:
            conn.close()

    def post_wav(self, body: bytes, *, timeout: float = 10.0) -> HttpResult:
        return self.request(
            "POST",
            "/v1/transcribe",
            body=body,
            headers={"Content-Type": "audio/wav", "Authorization": f"Bearer {self.token}"},
            timeout=timeout,
        )

    def connect(self) -> socket.socket:
        sock = socket.create_connection(("127.0.0.1", self.port), timeout=10)
        return sock


def read_http_response(sock: socket.socket) -> HttpResult:
    """从原始 socket 读取一个完整 HTTP/1.1 响应（依据 Content-Length）。"""
    buffer = b""
    while b"\r\n\r\n" not in buffer:
        chunk = sock.recv(4096)
        if not chunk:
            raise AssertionError(f"响应头未读完连接就关闭了：{buffer!r}")
        buffer += chunk
    head, _, rest = buffer.partition(b"\r\n\r\n")
    lines = head.decode("latin-1").split("\r\n")
    status = int(lines[0].split()[1])
    headers = {}
    for line in lines[1:]:
        name, _, value = line.partition(":")
        headers[name.strip().lower()] = value.strip()
    length = int(headers.get("content-length", "0"))
    while len(rest) < length:
        chunk = sock.recv(4096)
        if not chunk:
            break
        rest += chunk
    return HttpResult(status, headers, rest[:length])


def wait_closed(sock: socket.socket, timeout: float) -> float:
    """等待对端关闭连接，返回耗时；超时则断言失败。"""
    started = time.monotonic()
    sock.settimeout(timeout)
    try:
        while True:
            data = sock.recv(4096)
            if not data:
                return time.monotonic() - started
    except TimeoutError:
        raise AssertionError(f"{timeout} 秒内连接没有被服务端关闭") from None
    except ConnectionResetError:
        return time.monotonic() - started


@contextmanager
def live_server(
    *,
    transcriber: FakeTranscriber | None = None,
    **config_overrides,
) -> Iterator[LiveServer]:
    transcriber = transcriber or FakeTranscriber()
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    config = ServiceConfig(port=port, **config_overrides)
    manager = ModelManager(instant_factory(transcriber), model_name="fake-small", device="cpu", compute_type="int8")
    app = create_app(config=config, manager=manager, verify_token=StaticTokenVerifier(token))
    server = build_server(app, host="127.0.0.1", port=port, log_level="warning", config=config)
    thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, name="live-uvicorn", daemon=True)
    thread.start()
    try:
        wait_for(lambda: server.started, timeout=10)
        assert manager.wait_until_settled(5)
        yield LiveServer(port, token, server, thread, app, manager, transcriber)
    finally:
        server.should_exit = True
        if transcriber.block is not None:
            transcriber.block.set()
        thread.join(30)
        listener.close()
        assert not thread.is_alive(), "测试服务未能停止"

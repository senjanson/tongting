"""真实 uvicorn 服务上的连接保护与停止流程（假转写器，不下载模型）。

时间相关断言只等待「连接被关闭 / 请求返回」这类明确事件，时限取测试专用的小值并留足余量。
"""

from __future__ import annotations

import logging
import threading

from conftest import (
    FakeTranscriber,
    HttpResult,
    live_server,
    make_wav,
    read_http_response,
    wait_closed,
    wait_for,
)

HEADER_TIMEOUT = 0.5
BODY_TIMEOUT = 0.6


def _no_error_records(caplog) -> list[str]:
    return [f"{r.name}: {r.getMessage()}" for r in caplog.records if r.levelno >= logging.ERROR]


# ---- 请求头 / 请求体时限 ----


def test_idle_connection_is_closed_after_header_timeout():
    with live_server(header_timeout_s=HEADER_TIMEOUT) as srv:
        sock = srv.connect()
        try:
            elapsed = wait_closed(sock, timeout=5)
        finally:
            sock.close()
        assert elapsed >= HEADER_TIMEOUT * 0.8


def test_partial_header_connection_is_closed_after_header_timeout():
    with live_server(header_timeout_s=HEADER_TIMEOUT) as srv:
        sock = srv.connect()
        try:
            sock.sendall(f"GET /health HTTP/1.1\r\nHost: 127.0.0.1:{srv.port}\r\nX-Slow: ".encode())
            elapsed = wait_closed(sock, timeout=5)
        finally:
            sock.close()
        assert elapsed >= HEADER_TIMEOUT * 0.8


def test_keep_alive_connection_trickling_next_request_is_closed():
    with live_server(header_timeout_s=HEADER_TIMEOUT) as srv:
        sock = srv.connect()
        try:
            sock.sendall(f"GET /health HTTP/1.1\r\nHost: 127.0.0.1:{srv.port}\r\n\r\n".encode())
            assert read_http_response(sock).status == 200
            # 上一个响应结束后只发半个请求行：uvicorn 的 keep-alive 计时器会被数据取消，需要请求头时限兜底。
            sock.sendall(b"GE")
            wait_closed(sock, timeout=5)
        finally:
            sock.close()


def test_slow_request_body_gets_408_and_connection_is_closed():
    with live_server(header_timeout_s=5, body_timeout_s=BODY_TIMEOUT) as srv:
        sock = srv.connect()
        try:
            head = (
                f"POST /v1/transcribe HTTP/1.1\r\nHost: 127.0.0.1:{srv.port}\r\n"
                f"Authorization: Bearer {srv.token}\r\nContent-Type: audio/wav\r\nContent-Length: 50000\r\n\r\n"
            )
            sock.sendall(head.encode() + make_wav(0.1)[:1000])
            response = read_http_response(sock)
            assert response.status == 408
            assert response.json()["error"]["code"] == "request_timeout"
            assert response.headers["connection"] == "close"
            wait_closed(sock, timeout=5)
        finally:
            sock.close()
        assert srv.transcriber.calls == []


# ---- 连接数上限 ----


def test_connection_flood_evicts_idle_connections_and_health_stays_available():
    with live_server(header_timeout_s=30, max_connections=4) as srv:
        flood = [srv.connect() for _ in range(20)]
        try:
            response = srv.request("GET", "/health", timeout=5)
            assert response.status == 200
            closed = 0
            for sock in flood:
                try:
                    wait_closed(sock, timeout=2)
                    closed += 1
                except AssertionError:
                    pass
            # 上限 4：新连接不断挤掉最早的空闲连接，最多剩下 4 个仍保持打开。
            assert closed >= len(flood) - 4
        finally:
            for sock in flood:
                sock.close()
        # 洪泛结束后服务仍正常。
        assert srv.request("GET", "/health").status == 200
        assert srv.post_wav(make_wav()).status == 200


def test_flood_of_idle_connections_is_cleared_by_header_timeout():
    with live_server(header_timeout_s=HEADER_TIMEOUT, max_connections=4) as srv:
        flood = [srv.connect() for _ in range(4)]
        try:
            for sock in flood:
                wait_closed(sock, timeout=5)
        finally:
            for sock in flood:
                sock.close()
        wait_for(lambda: len(srv.server.server_state.connections) == 0, timeout=5)
        assert srv.request("GET", "/health").status == 200


# ---- 停止流程 ----


def _post_in_thread(srv, results: dict, key: str) -> threading.Thread:
    def run() -> None:
        results[key] = srv.post_wav(make_wav(), timeout=20)

    thread = threading.Thread(target=run, name=f"client-{key}")
    thread.start()
    return thread


def test_stop_rejects_queued_request_and_waits_for_running_inference(caplog):
    caplog.set_level(logging.INFO)
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    results: dict[str, HttpResult] = {}
    with live_server(transcriber=transcriber, queue_size=2, shutdown_grace_s=10) as srv:
        running = _post_in_thread(srv, results, "running")
        assert transcriber.started.acquire(timeout=5)
        queued = _post_in_thread(srv, results, "queued")
        gate = srv.app.state.gate
        wait_for(lambda: gate.pending == 2)

        srv.server.should_exit = True  # 等同于收到 Ctrl+C
        queued.join(5)
        assert not queued.is_alive(), "排队中的请求应在停止开始后立即返回"
        assert results["queued"].status == 503
        assert results["queued"].json()["error"]["code"] == "model_unavailable"
        assert running.is_alive(), "正在进行的推理应继续等待"
        assert len(transcriber.calls) == 1, "停止开始后不应再开始新的推理"

        release.set()
        running.join(10)
        assert results["running"].status == 200
    assert transcriber.closed
    assert _no_error_records(caplog) == []


def test_stop_grace_exceeded_returns_json_503_without_error_stack(caplog):
    caplog.set_level(logging.INFO)
    release = threading.Event()
    transcriber = FakeTranscriber(block=release)
    results: dict[str, HttpResult] = {}
    with live_server(transcriber=transcriber, shutdown_grace_s=0.5) as srv:
        running = _post_in_thread(srv, results, "running")
        assert transcriber.started.acquire(timeout=5)
        srv.server.should_exit = True
        running.join(10)
        assert not running.is_alive()
        response = results["running"]
        assert response.status == 503
        assert response.headers["content-type"].startswith("application/json")
        assert response.json()["error"]["code"] == "model_unavailable"
        # 推理线程仍被阻塞：释放后服务线程才能结束（live_server 退出时会等待）。
        release.set()
    assert _no_error_records(caplog) == []
    assert any("放弃等待" in r.getMessage() for r in caplog.records)

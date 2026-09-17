"""监听 socket、连接保护与 uvicorn 启动/停止。

- 自行创建监听 socket，以便在端口冲突时给出明确中文错误。
- 连接保护（防止本机进程不带令牌就用连接耗尽文件描述符）：
  * 请求头时限：连接建立或上一响应结束后，必须在 header_timeout_s 内收完下一个请求头，否则关闭；
  * 请求体时限：由应用层 read_body_limited 负责（超时 408 并断开）；
  * 连接数上限：超过 max_connections 时先关闭最早的空闲连接（没有正在处理的请求），
    若全部连接都在处理请求，则直接关闭新连接；
  * 启动时适度提高 RLIMIT_NOFILE 软上限；accept 遇到 EMFILE 等资源错误时日志限速。
- 停止：收到信号后先让应用进入「停止中」（排队与新请求立即 503），再交给 uvicorn 优雅停止。
"""

from __future__ import annotations

import asyncio
import errno
import itertools
import json
import logging
import math
import socket
import urllib.request
from collections.abc import Callable
from typing import Any

import uvicorn
from starlette.types import ASGIApp
from uvicorn.protocols.http.h11_impl import H11Protocol

from .config import ServiceConfig, validate_bind_host, validate_port
from .log import LogThrottle, get_logger

logger = get_logger("server")

_NOFILE_TARGET = 4096
_RESOURCE_ERRNOS = frozenset({errno.EMFILE, errno.ENFILE, errno.ENOBUFS, errno.ENOMEM})


class PortInUseError(RuntimeError):
    pass


def _probe_existing_service(host: str, port: int) -> str | None:
    """端口已被占用时，看看是不是另一个 tongting-asr（只读 /health，不带令牌）。"""
    try:
        request = urllib.request.Request(f"http://{host}:{port}/health", headers={"Host": f"{host}:{port}"})
        # 不经过环境变量里的 HTTP 代理，只访问本机。
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(request, timeout=1.0) as response:
            payload = json.loads(response.read(4096).decode("utf-8"))
    except Exception:  # noqa: BLE001
        return None
    if isinstance(payload, dict) and {"status", "ready", "model", "version"} <= payload.keys():
        return f"该端口上已经有 tongting-asr {payload.get('version')} 在运行（状态 {payload.get('status')}）。"
    return None


def port_in_use_message(host: str, port: int) -> str:
    hint = _probe_existing_service(host, port)
    lines = [f"端口 {port} 已被占用，无法在 {host}:{port} 启动本地识别服务。"]
    if hint:
        lines.append(hint + "无需重复启动；如需重启，请先在原终端按 Ctrl+C 停止。")
    else:
        lines.append(f"可运行 `lsof -nP -iTCP:{port} -sTCP:LISTEN` 查看占用进程，")
        lines.append("或使用 `tongting-asr serve --port <其他端口>`，并在扩展设置页同步修改服务地址。")
    return "\n".join(lines)


def create_listen_socket(host: str, port: int) -> socket.socket:
    host = validate_bind_host(host)
    port = validate_port(port)

    # macOS 上 SO_REUSEADDR 允许在已有 0.0.0.0 监听者时再绑定具体地址，
    # 因此先主动探测一次，避免「悄悄遮挡」另一个服务。
    try:
        with socket.create_connection((host, port), timeout=0.5):
            pass
    except OSError:
        pass
    else:
        raise PortInUseError(port_in_use_message(host, port))

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.bind((host, port))
        sock.listen(64)
    except OSError as exc:
        sock.close()
        if exc.errno == errno.EADDRINUSE:
            raise PortInUseError(port_in_use_message(host, port)) from None
        if exc.errno == errno.EACCES:
            raise PortInUseError(f"没有权限监听 {host}:{port}：{exc.strerror}") from None
        raise
    return sock


def raise_nofile_limit(target: int = _NOFILE_TARGET) -> tuple[int, int] | None:
    """把 RLIMIT_NOFILE 软上限提高到 target（不超过硬上限）。返回 (原软上限, 现软上限)。"""
    try:
        import resource
    except ImportError:  # 非 POSIX
        return None
    soft, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    if soft == resource.RLIM_INFINITY or soft >= target:
        return soft, soft
    new_soft = target if hard == resource.RLIM_INFINITY else min(target, hard)
    if new_soft <= soft:
        return soft, soft
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (new_soft, hard))
    except (ValueError, OSError):
        return soft, soft
    return soft, new_soft


def make_loop_exception_handler(throttle: LogThrottle) -> Callable[[asyncio.AbstractEventLoop, dict[str, Any]], None]:
    """accept 因文件描述符等资源不足失败时，只记一行并限速；其他异常交回默认处理。"""

    def handler(loop: asyncio.AbstractEventLoop, context: dict[str, Any]) -> None:
        exc = context.get("exception")
        if isinstance(exc, OSError) and exc.errno in _RESOURCE_ERRNOS:
            throttle.log(
                ("accept_resource", exc.errno),
                logging.ERROR,
                f"系统资源不足，暂时无法接受新连接（{errno.errorcode.get(exc.errno, exc.errno)}）",
                "系统资源不足，暂时无法接受新连接（%s：%s）。asyncio 会稍后重试；60 秒内只记录首条。",
                errno.errorcode.get(exc.errno, exc.errno),
                exc.strerror,
            )
            return
        loop.default_exception_handler(context)

    return handler


def make_protocol_class(config: ServiceConfig, throttle: LogThrottle) -> type[H11Protocol]:
    header_timeout_s = config.header_timeout_s
    max_connections = config.max_connections
    sequence = itertools.count()

    class GuardedH11Protocol(H11Protocol):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            self._opened_seq = next(sequence)
            self._header_timer: asyncio.TimerHandle | None = None
            self._timer_cycle: object | None = None

        # ---- 连接数上限 ----

        def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
            super().connection_made(transport)
            open_connections = sum(
                1 for conn in self.connections if conn.transport is not None and not conn.transport.is_closing()
            )
            if open_connections > max_connections:
                victim = self._oldest_idle_peer()
                if victim is None:
                    throttle.log(
                        ("connection_limit_refused",),
                        logging.WARNING,
                        "连接数已达上限且全部在处理请求，拒绝新连接",
                        "连接数已达上限（%d）且全部在处理请求，已关闭新连接；60 秒内只记录首条。",
                        max_connections,
                    )
                    transport.close()
                    return
                throttle.log(
                    ("connection_limit_evicted",),
                    logging.WARNING,
                    "连接数已达上限，关闭最早的空闲连接",
                    "连接数已达上限（%d），已关闭最早的空闲连接；60 秒内只记录首条。",
                    max_connections,
                )
                victim._close_quietly()
            self._arm_header_timer()

        def _is_idle(self) -> bool:
            return self.cycle is None or self.cycle.response_complete

        def _oldest_idle_peer(self) -> GuardedH11Protocol | None:
            candidates = [
                conn
                for conn in self.connections
                if conn is not self
                and isinstance(conn, GuardedH11Protocol)
                and conn.transport is not None
                and not conn.transport.is_closing()
                and conn._is_idle()
            ]
            return min(candidates, key=lambda conn: conn._opened_seq, default=None)

        def _close_quietly(self) -> None:
            self._cancel_header_timer()
            if self.transport is not None and not self.transport.is_closing():
                # connection_lost 会负责 h11 状态与请求周期的收尾。
                self.transport.close()

        # ---- 请求头时限 ----

        def _arm_header_timer(self) -> None:
            self._cancel_header_timer()
            self._timer_cycle = self.cycle
            self._header_timer = self.loop.call_later(header_timeout_s, self._on_header_timeout)

        def _cancel_header_timer(self) -> None:
            if self._header_timer is not None:
                self._header_timer.cancel()
                self._header_timer = None

        def _on_header_timeout(self) -> None:
            self._header_timer = None
            if self.cycle is not self._timer_cycle:
                return  # 已经开始处理新的请求
            throttle.log(
                ("header_timeout",),
                logging.INFO,
                "请求头读取超时，关闭连接",
                "连接在 %.0f 秒内没有发来完整请求头，已关闭；60 秒内只记录首条。",
                header_timeout_s,
            )
            self._close_quietly()

        def data_received(self, data: bytes) -> None:
            super().data_received(data)
            if self._header_timer is not None and self.cycle is not self._timer_cycle:
                # 新请求的请求头已完整：交给应用层的请求体时限与推理流程。
                self._cancel_header_timer()

        def on_response_complete(self) -> None:
            super().on_response_complete()
            if self.transport is not None and not self.transport.is_closing() and self._is_idle():
                self._arm_header_timer()

        def connection_lost(self, exc: Exception | None) -> None:
            self._cancel_header_timer()
            super().connection_lost(exc)

    return GuardedH11Protocol


class TongtingServer(uvicorn.Server):
    def __init__(
        self,
        config: uvicorn.Config,
        *,
        throttle: LogThrottle,
        on_stopping: Callable[[], None] | None = None,
    ) -> None:
        super().__init__(config)
        self._throttle = throttle
        self._on_stopping = on_stopping

    async def startup(self, sockets: list[socket.socket] | None = None) -> None:
        asyncio.get_running_loop().set_exception_handler(make_loop_exception_handler(self._throttle))
        await super().startup(sockets=sockets)

    async def on_tick(self, counter: int) -> bool:
        if counter % 50 == 0:  # 约每 5 秒输出到期的限速汇总
            self._throttle.flush_expired()
        return await super().on_tick(counter)

    async def shutdown(self, sockets: list[socket.socket] | None = None) -> None:
        if self._on_stopping is not None:
            try:
                self._on_stopping()
            except Exception as exc:  # noqa: BLE001 - 不能因此跳过后续的资源释放
                logger.warning("进入停止状态时出错：%s", type(exc).__name__)
        await super().shutdown(sockets=sockets)


def build_server(app: ASGIApp, *, host: str, port: int, log_level: str, config: ServiceConfig) -> TongtingServer:
    state = getattr(app, "state", None)
    throttle = getattr(state, "log_throttle", None) or LogThrottle(logger)
    on_stopping = getattr(state, "begin_shutdown", None)
    uv_config = uvicorn.Config(
        app,
        host=host,
        port=port,
        http=make_protocol_class(config, throttle),
        log_config=None,  # 使用 log.setup_logging 的处理器与脱敏过滤器
        log_level=log_level,
        access_log=False,  # 访问日志不需要；转写结果由应用记录不含正文的摘要
        server_header=False,
        proxy_headers=False,  # 不信任 X-Forwarded-*
        ws="none",
        lifespan="on",
        timeout_keep_alive=5,
        # 应用在 shutdown_grace_s 到期时会自行给进行中的请求返回 503；uvicorn 的上限只作兜底，
        # 留出余量，避免它先取消请求任务而输出纯文本 500 与异常堆栈。
        timeout_graceful_shutdown=math.ceil(config.shutdown_grace_s) + 5,
        h11_max_incomplete_event_size=16 * 1024,
    )
    return TongtingServer(uv_config, throttle=throttle, on_stopping=on_stopping)


def run_server(app: ASGIApp, sock: socket.socket, *, host: str, port: int, log_level: str, config: ServiceConfig) -> None:
    build_server(app, host=host, port=port, log_level=log_level, config=config).run(sockets=[sock])

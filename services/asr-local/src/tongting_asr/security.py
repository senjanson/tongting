"""请求级安全检查（纯 ASGI 中间件，在路由之前执行）。

顺序：Host 头（防 DNS rebinding）→ Origin（只放行 chrome-extension://）→
浏览器取数上下文（Fetch Metadata）→ 配对令牌（除 /health 外所有路径）。
不设置任何 CORS 响应头。
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterable

from starlette.datastructures import Headers
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from .errors import SECURITY_HEADERS, error_response
from .log import LogThrottle, get_logger, sanitize_text

logger = get_logger("security")

TokenVerifier = Callable[[str], bool]

PUBLIC_PATHS = frozenset({"/health"})
_EXTENSION_ORIGIN_RE = re.compile(r"^chrome-extension://([a-p]{32})$")
# 浏览器在这些模式下不会附带 Origin（图片、脚本、页面跳转等）。本机 curl 不发送 Sec-Fetch-*。
_NO_ORIGIN_BROWSER_MODES = frozenset({"no-cors", "navigate", "nested-navigate", "websocket"})
_CROSS_SITES = frozenset({"cross-site", "same-site"})


class SecurityMiddleware:
    def __init__(
        self,
        app: ASGIApp,
        *,
        port: int,
        verify_token: TokenVerifier,
        allowed_extension_ids: Iterable[str] = (),
        log_throttle: LogThrottle | None = None,
    ) -> None:
        self.app = app
        self._allowed_hosts = frozenset({f"127.0.0.1:{port}", f"localhost:{port}"})
        self._verify_token = verify_token
        self._allowed_extension_ids = frozenset(allowed_extension_ids)
        self._throttle = log_throttle or LogThrottle(logger)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self.app(scope, receive, send)
            return
        if scope["type"] != "http":
            # 不提供 WebSocket。
            if scope["type"] == "websocket":
                await send({"type": "websocket.close", "code": 1008})
            return

        headers = Headers(scope=scope)
        rejection = self._check(scope, headers)
        if rejection is not None:
            status, code, message, extra = rejection
            response = error_response(status, code, message, extra)
            await response(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                raw = [
                    (k, v)
                    for k, v in message.get("headers", [])
                    if k.lower() not in {h.encode() for h in SECURITY_HEADERS}
                ]
                raw.extend((k.encode(), v.encode()) for k, v in SECURITY_HEADERS.items())
                message = {**message, "headers": raw}
            await send(message)

        await self.app(scope, receive, send_with_headers)

    def _check(self, scope: Scope, headers: Headers) -> tuple[int, str, str, dict[str, str]] | None:
        method = scope.get("method", "")
        path = scope.get("path", "")

        hosts = headers.getlist("host")
        if len(hosts) != 1 or hosts[0].strip().lower() not in self._allowed_hosts:
            self._log_reject("host_not_allowed", method, path, hosts[0] if hosts else "<缺失>")
            return (403, "host_not_allowed", "Host 头必须是 127.0.0.1 或 localhost 加服务端口。", {})

        origins = headers.getlist("origin")
        if len(origins) > 1:
            self._log_reject("origin_not_allowed", method, path, "<多个 Origin>")
            return (403, "origin_not_allowed", "请求来源不被允许。", {})
        if origins:
            origin = origins[0].strip()
            if not self._origin_allowed(origin):
                self._log_reject("origin_not_allowed", method, path, origin)
                return (403, "origin_not_allowed", "请求来源不被允许：只接受译听扩展发起的请求。", {})
        else:
            mode = headers.get("sec-fetch-mode", "").lower()
            site = headers.get("sec-fetch-site", "").lower()
            if mode in _NO_ORIGIN_BROWSER_MODES and site in _CROSS_SITES:
                self._log_reject("origin_not_allowed", method, path, f"sec-fetch {site}/{mode}")
                return (403, "origin_not_allowed", "请求来源不被允许：只接受译听扩展发起的请求。", {})

        if path not in PUBLIC_PATHS:
            authorizations = headers.getlist("authorization")
            token = _parse_bearer(authorizations[0]) if len(authorizations) == 1 else None
            if token is None or not self._verify_token(token):
                self._log_reject("unauthorized", method, path, "令牌缺失" if token is None else "令牌错误")
                return (
                    401,
                    "unauthorized",
                    "缺少或错误的配对令牌。",
                    {"www-authenticate": 'Bearer realm="tongting-asr"'},
                )
        return None

    def _origin_allowed(self, origin: str) -> bool:
        match = _EXTENSION_ORIGIN_RE.fullmatch(origin)
        if match is None:
            return False
        if self._allowed_extension_ids:
            return match.group(1) in self._allowed_extension_ids
        return True

    def _log_reject(self, code: str, method: str, path: str, detail: str) -> None:
        # 按（原因, 来源）聚合：首条记录详情，之后 60 秒窗口内只计数，窗口结束时汇总一条。
        source = sanitize_text(detail, max_length=120)
        self._throttle.log(
            ("reject", code, source),
            logging.WARNING,
            f"拒绝请求 {code}（{source}）",
            "拒绝请求 %s %s：%s（%s）。同一原因与来源 60 秒内只记录首条，之后汇总计数。",
            sanitize_text(method, max_length=16),
            sanitize_text(path, max_length=80),
            code,
            source,
        )


def _parse_bearer(value: str) -> str | None:
    scheme, _, credentials = value.strip().partition(" ")
    if scheme.lower() != "bearer":
        return None
    credentials = credentials.strip()
    return credentials or None

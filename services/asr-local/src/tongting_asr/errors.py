"""统一错误体：{ "error": { "code": str, "message": str } }。

消息为固定中文说明，不回显请求体、令牌或内部异常细节。
"""

from __future__ import annotations

from collections.abc import Mapping

from starlette.responses import JSONResponse

SECURITY_HEADERS = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
}


class ApiError(Exception):
    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(f"{status} {code}")
        self.status = status
        self.code = code
        self.message = message
        self.headers = dict(headers or {})


def error_payload(code: str, message: str) -> dict[str, dict[str, str]]:
    return {"error": {"code": code, "message": message}}


def error_response(
    status: int,
    code: str,
    message: str,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    merged = dict(SECURITY_HEADERS)
    merged.update(headers or {})
    return JSONResponse(error_payload(code, message), status_code=status, headers=merged)


def api_error_response(exc: ApiError) -> JSONResponse:
    return error_response(exc.status, exc.code, exc.message, exc.headers)

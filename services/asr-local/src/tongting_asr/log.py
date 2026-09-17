"""日志设置、脱敏与限速。

原则：本服务自己的日志不写令牌、不写转写全文、不写音频内容；异常消息里的 URL 去掉查询串
（下载失败时上游可能返回带签名参数的地址）。

兜底过滤器挂在输出处理器上，对经过它的全部记录（包括 uvicorn 与第三方库传播到根 logger 的记录）
替换「已登记的令牌」与 `Bearer xxx` 形式的凭证，覆盖消息、异常堆栈与 stack_info。
它只认识这两类字符串，不能识别第三方库日志里的其他敏感内容。
"""

from __future__ import annotations

import logging
import re
import sys
import threading
import time
from collections.abc import Callable, Hashable

_BEARER_RE = re.compile(r"(?i)(bearer\s+)[^\s,;\"']+")
_URL_QUERY_RE = re.compile(r"(https?://[^\s?#\"'<>]+)[?#][^\s\"'<>]*")
_URL_USERINFO_RE = re.compile(r"(https?://)[^\s/@\"'<>]+@")

LOGGER_NAME = "tongting_asr"


def get_logger(name: str | None = None) -> logging.Logger:
    return logging.getLogger(LOGGER_NAME if name is None else f"{LOGGER_NAME}.{name}")


def sanitize_text(text: str, *, max_length: int = 300) -> str:
    """去掉 Bearer 凭证、URL 查询串与 userinfo，并截断过长内容。"""
    cleaned = _BEARER_RE.sub(r"\1<已隐藏>", text)
    cleaned = _URL_QUERY_RE.sub(r"\1?<已省略>", cleaned)
    cleaned = _URL_USERINFO_RE.sub(r"\1<已隐藏>@", cleaned)
    cleaned = "".join(ch if ch.isprintable() else " " for ch in cleaned)
    if len(cleaned) > max_length:
        cleaned = cleaned[:max_length] + "…"
    return cleaned


def describe_exception(exc: BaseException) -> str:
    message = sanitize_text(str(exc))
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


class RedactingFilter(logging.Filter):
    """兜底过滤：替换已登记的令牌与 Bearer 凭证（消息、异常堆栈、stack_info）。"""

    _formatter = logging.Formatter()

    def __init__(self) -> None:
        super().__init__()
        self._secrets: set[str] = set()

    def add_secret(self, secret: str) -> None:
        if secret:
            self._secrets.add(secret)

    def _redact(self, text: str) -> str:
        redacted = _BEARER_RE.sub(r"\1<已隐藏>", text)
        for secret in self._secrets:
            redacted = redacted.replace(secret, "<已隐藏>")
        return redacted

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # noqa: BLE001 - 格式化失败时保持原记录
            message = None
        if message is not None:
            redacted = self._redact(message)
            if redacted != message:
                record.msg = redacted
                record.args = None
        if record.exc_info and not record.exc_text:
            # 预先格式化异常堆栈；Formatter 发现 exc_text 已存在时会直接使用它。
            record.exc_text = self._formatter.formatException(record.exc_info)
        if record.exc_text:
            record.exc_text = self._redact(record.exc_text)
        if record.stack_info:
            record.stack_info = self._redact(record.stack_info)
        return True


_redacting_filter = RedactingFilter()


def register_secret(secret: str) -> None:
    _redacting_filter.add_secret(secret)


def redacting_filter() -> RedactingFilter:
    return _redacting_filter


class LogThrottle:
    """按 key 聚合限速：每个 key 首次出现记录详情，之后在时间窗内只计数，窗口结束时汇总一条。

    用于被拒绝请求、连接超限、文件描述符不足等可能被本机进程刷屏的日志。
    key 数量有上限，超出后归入同一个「其他来源」桶，避免攻击者用随机来源撑爆内存。
    """

    def __init__(
        self,
        logger: logging.Logger,
        *,
        interval_s: float = 60.0,
        max_keys: int = 128,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._logger = logger
        self._interval_s = interval_s
        self._max_keys = max_keys
        self._clock = clock
        self._lock = threading.Lock()
        # key -> [窗口开始时间, 被抑制次数, 日志级别, 汇总标签]
        self._entries: dict[Hashable, list] = {}

    def log(self, key: Hashable, level: int, label: str, message: str, *args: object) -> bool:
        """返回 True 表示本次输出了详情。"""
        now = self._clock()
        pending: list[tuple[int, str, tuple]] = []
        with self._lock:
            self._collect_expired(now, pending)
            entry = self._entries.get(key)
            if entry is None and len(self._entries) >= self._max_keys:
                key = ("<其他来源>", label.split("（", 1)[0])
                label = key[1] + "（其他来源）"
                entry = self._entries.get(key)
            if entry is None:
                self._entries[key] = [now, 0, level, label]
                emit = True
            else:
                entry[1] += 1
                emit = False
        self._emit(pending)
        if emit:
            self._logger.log(level, message, *args)
        return emit

    def flush_expired(self) -> None:
        pending: list[tuple[int, str, tuple]] = []
        with self._lock:
            self._collect_expired(self._clock(), pending)
        self._emit(pending)

    def flush(self) -> None:
        now = self._clock()
        pending: list[tuple[int, str, tuple]] = []
        with self._lock:
            for key, (started, suppressed, level, label) in list(self._entries.items()):
                if suppressed:
                    pending.append((level, "%s：过去 %.0f 秒内另有 %d 次（已合并）。", (label, now - started, suppressed)))
                del self._entries[key]
        self._emit(pending)

    def _collect_expired(self, now: float, pending: list[tuple[int, str, tuple]]) -> None:
        for key, (started, suppressed, level, label) in list(self._entries.items()):
            if now - started >= self._interval_s:
                if suppressed:
                    pending.append((level, "%s：过去 %.0f 秒内另有 %d 次（已合并）。", (label, now - started, suppressed)))
                del self._entries[key]

    def _emit(self, pending: list[tuple[int, str, tuple]]) -> None:
        for level, message, args in pending:
            self._logger.log(level, message, *args)


def setup_logging(level: str = "info") -> None:
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s", "%H:%M:%S"))
    handler.addFilter(_redacting_filter)
    root = logging.getLogger()
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(handler)
    root.setLevel(level.upper())
    # 第三方库的 INFO 日志量大且对用户无用；访问日志默认关闭（见 server.py）。
    for noisy in ("faster_whisper", "huggingface_hub", "httpx", "httpcore", "filelock"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

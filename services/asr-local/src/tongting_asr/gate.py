"""推理并发闸门：同一时刻 1 个推理 + 有界等待队列，超出立即返回繁忙。

- 排队中的请求会轮询客户端是否已断开（例如扩展因跳转而 abort），断开即让出队列位置，
  不为已经没人等待的音频做推理。
- 服务开始停止时调用 close()：排队中的请求立即被唤醒并得到 GateClosed，新请求直接被拒绝，
  只有已经拿到许可、正在推理的那一个继续完成。
"""

from __future__ import annotations

import asyncio
import math
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

_DISCONNECT_POLL_S = 0.2
_INITIAL_ESTIMATE_MS = 2000.0
_EMA_ALPHA = 0.3


class BusyError(Exception):
    def __init__(self, retry_after_s: int) -> None:
        super().__init__("busy")
        self.retry_after_s = retry_after_s


class ClientDisconnected(Exception):
    pass


class GateClosed(Exception):
    """服务正在停止，不再开始新的推理。"""


class InferenceGate:
    def __init__(self, queue_size: int, *, disconnect_poll_s: float = _DISCONNECT_POLL_S) -> None:
        self._capacity = 1 + max(queue_size, 0)
        self._pending = 0
        self._running = 0
        self._semaphore = asyncio.Semaphore(1)
        self._estimate_ms = _INITIAL_ESTIMATE_MS
        self._poll_s = disconnect_poll_s
        self._closed = False
        self._closed_event = asyncio.Event()

    @property
    def pending(self) -> int:
        """正在推理 + 排队中的请求数。"""
        return self._pending

    @property
    def running(self) -> int:
        return self._running

    @property
    def capacity(self) -> int:
        return self._capacity

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        """必须在事件循环线程中调用。"""
        self._closed = True
        self._closed_event.set()

    def retry_after_seconds(self) -> int:
        seconds = math.ceil(self._estimate_ms * max(self._pending, 1) / 1000)
        return min(max(seconds, 1), 60)

    def record_processing_ms(self, processing_ms: float) -> None:
        self._estimate_ms = (1 - _EMA_ALPHA) * self._estimate_ms + _EMA_ALPHA * processing_ms

    @asynccontextmanager
    async def slot(self, is_disconnected: Callable[[], Awaitable[bool]]) -> AsyncIterator[None]:
        if self._closed:
            raise GateClosed()
        if self._pending >= self._capacity:
            raise BusyError(self.retry_after_seconds())
        self._pending += 1
        try:
            await self._acquire(is_disconnected)
            self._running += 1
            try:
                yield
            finally:
                self._running -= 1
                self._semaphore.release()
        finally:
            self._pending -= 1

    async def _acquire(self, is_disconnected: Callable[[], Awaitable[bool]]) -> None:
        if not self._semaphore.locked():
            await self._semaphore.acquire()
            return
        waiter = asyncio.ensure_future(self._semaphore.acquire())
        closed_waiter = asyncio.ensure_future(self._closed_event.wait())
        try:
            while True:
                done, _ = await asyncio.wait(
                    {waiter, closed_waiter}, timeout=self._poll_s, return_when=asyncio.FIRST_COMPLETED
                )
                if self._closed:
                    raise GateClosed()
                if waiter in done:
                    waiter.result()
                    return
                if await is_disconnected():
                    raise ClientDisconnected()
        except BaseException:
            if waiter.done():
                # 已经拿到许可但调用方不再需要（断开、停止或被取消）：归还，避免泄漏。
                if not waiter.cancelled() and waiter.exception() is None:
                    self._semaphore.release()
            else:
                # 尚未拿到许可：取消等待。若许可「刚被转交又被取消」，
                # asyncio.Semaphore.acquire 会在处理 CancelledError 时把许可还回并唤醒下一个。
                waiter.cancel()
            raise
        finally:
            closed_waiter.cancel()

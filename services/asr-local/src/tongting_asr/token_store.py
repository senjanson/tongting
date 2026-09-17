"""配对令牌：生成、保存（0600）、轮换与常量时间校验。

令牌文件默认位于 ~/.tongting-asr/token。服务运行期间每次校验前会用 stat 检查文件是否变化，
因此 `tongting-asr rotate-token` 后旧令牌立即失效，无需重启服务。
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import stat
import threading
from pathlib import Path

from .log import get_logger, register_secret

TOKEN_FILENAME = "token"
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")

logger = get_logger("token")


class TokenError(RuntimeError):
    """令牌文件缺失、不可读或内容损坏。消息不含令牌本身。"""


def generate_token() -> str:
    # 32 字节随机数 → 43 个 URL 安全字符。
    return secrets.token_urlsafe(32)


class TokenStore:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = Path(data_dir)
        self.path = self.data_dir / TOKEN_FILENAME

    # ---- 文件操作 ----

    def _check_dir(self) -> None:
        """数据目录必须属于当前用户，且不能对组或其他用户可写（否则他人可替换令牌文件）。"""
        try:
            st = os.stat(self.data_dir)
        except OSError as exc:
            raise TokenError(f"无法访问数据目录：{self.data_dir}") from exc
        if not stat.S_ISDIR(st.st_mode):
            raise TokenError(f"数据目录不是目录：{self.data_dir}")
        if st.st_uid != os.getuid():
            raise TokenError(f"数据目录 {self.data_dir} 的属主不是当前用户，拒绝使用。")
        mode = stat.S_IMODE(st.st_mode)
        if mode & 0o022:
            raise TokenError(
                f"数据目录 {self.data_dir} 对组或其他用户可写（权限 {mode:o}），拒绝使用；"
                f"请执行 `chmod 700 {self.data_dir}` 或换用私有目录。"
            )
        if mode & 0o055:
            logger.warning("数据目录 %s 对其他用户可读（权限 %o）；令牌文件本身仍为 0600。", self.data_dir, mode)

    def _ensure_dir(self) -> None:
        existed = self.data_dir.exists()
        self.data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        if not existed:
            os.chmod(self.data_dir, 0o700)
        self._check_dir()

    def _write_temp(self, token: str) -> Path:
        tmp = self.data_dir / f".{TOKEN_FILENAME}.{secrets.token_hex(8)}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            os.fchmod(fd, 0o600)
            os.write(fd, (token + "\n").encode("ascii"))
            os.fsync(fd)
        finally:
            os.close(fd)
        return tmp

    def read(self) -> str:
        try:
            st = os.lstat(self.path)
        except FileNotFoundError as exc:
            raise TokenError(f"令牌文件不存在：{self.path}") from exc
        self._check_dir()
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            raise TokenError(f"令牌文件必须是普通文件（不能是符号链接）：{self.path}")
        if st.st_uid != os.getuid():
            raise TokenError(f"令牌文件 {self.path} 的属主不是当前用户，拒绝使用。")
        mode = stat.S_IMODE(st.st_mode)
        if mode & 0o077:
            try:
                os.chmod(self.path, 0o600)
                logger.warning("令牌文件权限过宽（%o），已改为 0600。", mode)
            except OSError as exc:
                raise TokenError(f"令牌文件权限过宽且无法修正：{self.path}") from exc
        try:
            token = self.path.read_text(encoding="ascii").strip()
        except (OSError, UnicodeDecodeError) as exc:
            raise TokenError(f"无法读取令牌文件：{self.path}") from exc
        if not _TOKEN_RE.fullmatch(token):
            raise TokenError(
                f"令牌文件内容无效：{self.path}。可运行 `tongting-asr rotate-token` 重新生成。"
            )
        register_secret(token)
        return token

    def ensure(self) -> tuple[str, bool]:
        """读取已有令牌；不存在时原子地创建。返回 (令牌, 是否本次新生成)。"""
        if os.path.lexists(self.path):
            return self.read(), False
        self._ensure_dir()
        token = generate_token()
        tmp = self._write_temp(token)
        try:
            # link 不会覆盖已有文件：并发启动时以先写入者为准。
            os.link(tmp, self.path)
            created = True
        except FileExistsError:
            created = False
        finally:
            tmp.unlink(missing_ok=True)
        if not created:
            return self.read(), False
        register_secret(token)
        return token, True

    def rotate(self) -> str:
        self._ensure_dir()
        token = generate_token()
        tmp = self._write_temp(token)
        try:
            os.replace(tmp, self.path)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        register_secret(token)
        return token


def _digest(value: str) -> bytes:
    return hashlib.sha256(value.encode("utf-8", "surrogateescape")).digest()


class FileTokenVerifier:
    """每次校验前检查令牌文件是否变化；读取失败时拒绝全部请求（fail closed）。"""

    def __init__(self, store: TokenStore) -> None:
        self._store = store
        self._lock = threading.Lock()
        self._signature: tuple[int, int, int] | None = None
        self._digest: bytes | None = None
        self._last_error: str | None = None

    def _current_digest(self) -> bytes | None:
        try:
            st = os.stat(self._store.path)
        except OSError:
            self._report_error("令牌文件不存在或不可访问，所有 /v1 请求将被拒绝。")
            with self._lock:
                self._signature = None
                self._digest = None
            return None
        signature = (st.st_ino, st.st_mtime_ns, st.st_size)
        with self._lock:
            if signature == self._signature:
                return self._digest
        try:
            token = self._store.read()
        except TokenError as exc:
            self._report_error(f"{exc}；所有 /v1 请求将被拒绝。")
            with self._lock:
                self._signature = None
                self._digest = None
            return None
        with self._lock:
            reloaded = self._signature is not None
            self._signature = signature
            self._digest = _digest(token)
            self._last_error = None
        if reloaded:
            logger.info("检测到令牌文件变化，已加载新令牌。")
        return self._digest

    def _report_error(self, message: str) -> None:
        if self._last_error != message:
            self._last_error = message
            logger.error(message)

    def __call__(self, presented: str) -> bool:
        expected = self._current_digest()
        # 始终做一次摘要比较，避免因提前返回产生明显的时间差。
        candidate = _digest(presented)
        if expected is None:
            hmac.compare_digest(candidate, candidate)
            return False
        return hmac.compare_digest(candidate, expected)


class StaticTokenVerifier:
    """固定令牌校验（测试与 bench 使用）。"""

    def __init__(self, token: str) -> None:
        self._digest = _digest(token)

    def __call__(self, presented: str) -> bool:
        return hmac.compare_digest(_digest(presented), self._digest)

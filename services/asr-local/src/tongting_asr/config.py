"""服务配置与校验。

安全相关的硬性约束集中在这里：只允许绑定 127.0.0.1、端口范围、扩展 ID 格式。
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_MODEL = "small"
DEFAULT_DEVICE = "cpu"
DEFAULT_COMPUTE_TYPE = "int8"
DEFAULT_BEAM_SIZE = 5
DEFAULT_QUEUE_SIZE = 2

# 契约：请求体 ≤ 2 MB，音频 ≤ 30 秒，16 kHz 单声道 16-bit PCM。
MAX_BODY_BYTES = 2 * 1024 * 1024
MAX_AUDIO_MS = 30_000
SAMPLE_RATE = 16_000

# 连接与停止相关的时限（防止本机进程用空闲/半截/慢速连接耗尽文件描述符）。
DEFAULT_HEADER_TIMEOUT_S = 10.0  # 连接建立或上一响应结束后，必须在此时间内收完下一个请求头
DEFAULT_BODY_TIMEOUT_S = 15.0  # 请求体必须在此时间内收完，否则 408 并断开
DEFAULT_MAX_CONNECTIONS = 32  # 同时保持的连接数上限，超出时先关闭最早的空闲连接
DEFAULT_SHUTDOWN_GRACE_S = 30.0  # 停止时等待「正在进行的那一段识别」的上限

ENV_HOME = "TONGTING_ASR_HOME"
ENV_MODEL_DIR = "TONGTING_ASR_MODEL_DIR"

_EXTENSION_ID_RE = re.compile(r"^[a-p]{32}$")
_ALLOWED_DEVICES = ("cpu", "cuda", "auto")


class ConfigError(ValueError):
    """配置不合法；消息面向用户，可直接打印。"""


def default_data_dir() -> Path:
    env = os.environ.get(ENV_HOME)
    if env:
        return Path(env).expanduser()
    return Path.home() / ".tongting-asr"


# 从源码目录运行（uv run，可编辑安装）时的服务根目录：services/asr-local。
SERVICE_ROOT = Path(__file__).resolve().parents[2]


def default_model_dir(data_dir: Path) -> Path:
    """模型缓存目录：环境变量 > services/asr-local/models（已被 .gitignore 忽略）> <data-dir>/models。"""
    env = os.environ.get(ENV_MODEL_DIR)
    if env:
        return Path(env).expanduser()
    if (SERVICE_ROOT / "pyproject.toml").is_file() and (SERVICE_ROOT / "src" / "tongting_asr").is_dir():
        return SERVICE_ROOT / "models"
    return data_dir / "models"


def validate_bind_host(host: str) -> str:
    """只接受 127.0.0.1（localhost 视为 127.0.0.1）。

    0.0.0.0、::、::1、局域网地址与任意主机名一律拒绝：本服务不向局域网开放，
    Host 头校验也只认 127.0.0.1 与 localhost。
    """
    normalized = host.strip().lower()
    if normalized in ("127.0.0.1", "localhost"):
        return DEFAULT_HOST
    raise ConfigError(
        f"拒绝绑定地址 {host!r}：本服务只允许绑定 127.0.0.1（loopback），"
        "不支持 0.0.0.0、IPv6 或局域网地址。"
    )


def validate_port(port: int) -> int:
    if not 1024 <= port <= 65535:
        raise ConfigError(f"端口 {port} 不合法：请使用 1024–65535 之间的端口。")
    return port


def validate_extension_id(extension_id: str) -> str:
    value = extension_id.strip()
    if value.startswith("chrome-extension://"):
        value = value[len("chrome-extension://") :].rstrip("/")
    if not _EXTENSION_ID_RE.fullmatch(value):
        raise ConfigError(
            f"扩展 ID {extension_id!r} 格式不正确：应为 32 位 a–p 小写字母"
            "（可在 chrome://extensions 查看）。"
        )
    return value


_PATH_SEPARATORS_RE = re.compile(r"[\\/]+")


def display_model_name(model: str) -> str:
    """健康检查中展示的模型名。

    看起来像路径的值（绝对路径、含路径分隔符、以 ~ 或 . 开头）只展示最后一段名称，
    无论该路径是否存在，避免把用户目录结构回显给任何能访问 /health 的进程。
    """
    value = model.strip()
    looks_like_path = (
        os.path.isabs(value) or value.startswith(("~", ".")) or "/" in value or "\\" in value or os.sep in value
    )
    if not looks_like_path:
        return value
    name = _PATH_SEPARATORS_RE.split(value.rstrip("/\\"))[-1]
    if not name or name in (".", "..") or name.startswith("~"):
        return "local-model"
    return name


@dataclass(frozen=True)
class ModelConfig:
    model: str = DEFAULT_MODEL
    device: str = DEFAULT_DEVICE
    compute_type: str = DEFAULT_COMPUTE_TYPE
    cpu_threads: int = 0
    beam_size: int = DEFAULT_BEAM_SIZE
    model_dir: Path | None = None
    local_files_only: bool = False

    def __post_init__(self) -> None:
        if not self.model.strip():
            raise ConfigError("模型名称不能为空。")
        if self.device not in _ALLOWED_DEVICES:
            raise ConfigError(f"device 只能是 {', '.join(_ALLOWED_DEVICES)}。")
        if not 0 <= self.cpu_threads <= 64:
            raise ConfigError("cpu-threads 需在 0–64 之间（0 表示使用 CTranslate2 默认值）。")
        if not 1 <= self.beam_size <= 10:
            raise ConfigError("beam-size 需在 1–10 之间。")


@dataclass(frozen=True)
class ServiceConfig:
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    queue_size: int = DEFAULT_QUEUE_SIZE
    allowed_extension_ids: frozenset[str] = field(default_factory=frozenset)
    max_body_bytes: int = MAX_BODY_BYTES
    max_audio_ms: int = MAX_AUDIO_MS
    header_timeout_s: float = DEFAULT_HEADER_TIMEOUT_S
    body_timeout_s: float = DEFAULT_BODY_TIMEOUT_S
    max_connections: int = DEFAULT_MAX_CONNECTIONS
    shutdown_grace_s: float = DEFAULT_SHUTDOWN_GRACE_S
    youtube_preload: bool = False

    def __post_init__(self) -> None:
        # 即使绕过 CLI 直接构造，也不能得到非 loopback 的配置。
        object.__setattr__(self, "host", validate_bind_host(self.host))
        validate_port(self.port)
        if not 0 <= self.queue_size <= 16:
            raise ConfigError("queue-size 需在 0–16 之间。")
        for name in ("header_timeout_s", "body_timeout_s", "shutdown_grace_s"):
            if not 0 < getattr(self, name) <= 600:
                raise ConfigError(f"{name} 需在 (0, 600] 秒之间。")
        if not 2 <= self.max_connections <= 1024:
            raise ConfigError("max_connections 需在 2–1024 之间。")
        object.__setattr__(
            self,
            "allowed_extension_ids",
            frozenset(validate_extension_id(i) for i in self.allowed_extension_ids),
        )

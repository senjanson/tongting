"""命令行入口：tongting-asr serve | print-token | rotate-token | bench。"""

from __future__ import annotations

import argparse
import sys
from functools import partial
from pathlib import Path

from . import __version__
from .config import (
    DEFAULT_BEAM_SIZE,
    DEFAULT_COMPUTE_TYPE,
    DEFAULT_DEVICE,
    DEFAULT_HOST,
    DEFAULT_MODEL,
    DEFAULT_PORT,
    DEFAULT_QUEUE_SIZE,
    SERVICE_ROOT,
    ConfigError,
    ModelConfig,
    ServiceConfig,
    default_data_dir,
    default_model_dir,
    display_model_name,
)
from .log import get_logger, setup_logging
from .token_store import FileTokenVerifier, TokenError, TokenStore

logger = get_logger("cli")

EXIT_CONFIG = 2
EXIT_PORT_IN_USE = 3

_FIXTURES_DIR = SERVICE_ROOT / "tests" / "fixtures"


def _add_data_dir(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=None,
        help="令牌所在目录（默认 ~/.tongting-asr，可用环境变量 TONGTING_ASR_HOME 覆盖）",
    )


def _add_model_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--model", default=DEFAULT_MODEL, help="模型名称或本地 CTranslate2 模型目录（默认 small）")
    parser.add_argument("--device", default=DEFAULT_DEVICE, help="cpu / cuda / auto（默认 cpu；macOS 只能用 cpu）")
    parser.add_argument("--compute-type", default=DEFAULT_COMPUTE_TYPE, help="量化类型（默认 int8）")
    parser.add_argument("--cpu-threads", type=int, default=0, help="CPU 线程数，0 表示 CTranslate2 默认值")
    parser.add_argument("--beam-size", type=int, default=DEFAULT_BEAM_SIZE, help="解码 beam 大小（默认 5）")
    parser.add_argument(
        "--model-dir",
        type=Path,
        default=None,
        help="模型缓存目录（默认 services/asr-local/models，可用环境变量 TONGTING_ASR_MODEL_DIR 覆盖）",
    )
    parser.add_argument("--offline", action="store_true", help="只使用本地已缓存的模型，不联网下载")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tongting-asr",
        description="同听 Tongting 本地语音识别补充服务（只监听 127.0.0.1）。",
    )
    parser.add_argument("--version", action="version", version=f"tongting-asr {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="启动本地识别服务")
    serve.add_argument("--host", default=DEFAULT_HOST, help="只允许 127.0.0.1（默认）")
    serve.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口（默认 {DEFAULT_PORT}）")
    serve.add_argument(
        "--queue-size",
        type=int,
        default=DEFAULT_QUEUE_SIZE,
        help=f"推理进行时允许排队的请求数，超出返回 429（默认 {DEFAULT_QUEUE_SIZE}）",
    )
    serve.add_argument(
        "--allow-extension-id",
        action="append",
        default=[],
        metavar="ID",
        help="只接受该扩展 ID 的 Origin（可重复；默认接受任意 chrome-extension:// 来源，但仍需令牌）",
    )
    serve.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    _add_model_options(serve)
    _add_data_dir(serve)
    serve.set_defaults(handler=cmd_serve)

    print_token = sub.add_parser("print-token", help="打印配对令牌（不存在时生成）")
    _add_data_dir(print_token)
    print_token.set_defaults(handler=cmd_print_token)

    rotate = sub.add_parser("rotate-token", help="生成新令牌，旧令牌立即失效")
    _add_data_dir(rotate)
    rotate.set_defaults(handler=cmd_rotate_token)

    bench = sub.add_parser("bench", help="测量模型加载时间、处理耗时与实时率")
    bench.add_argument("audio", nargs="*", type=Path, help="16 kHz 单声道 16-bit WAV；默认使用 tests/fixtures/*.wav")
    bench.add_argument("--language", default="auto", help="auto 或语言代码（默认 auto）")
    bench.add_argument("--repeat", type=int, default=3, help="每个样本重复次数（默认 3）")
    bench.add_argument("--silence", action="store_true", help="额外测试 5 秒全零静音（观察幻觉）")
    bench.add_argument("--json", action="store_true", help="以 JSON 输出")
    bench.add_argument("--log-level", default="warning", choices=["debug", "info", "warning", "error"])
    _add_model_options(bench)
    _add_data_dir(bench)
    bench.set_defaults(handler=cmd_bench)
    return parser


def _data_dir(args: argparse.Namespace) -> Path:
    return (args.data_dir or default_data_dir()).expanduser()


def _model_config(args: argparse.Namespace) -> ModelConfig:
    data_dir = _data_dir(args)
    return ModelConfig(
        model=args.model,
        device=args.device,
        compute_type=args.compute_type,
        cpu_threads=args.cpu_threads,
        beam_size=args.beam_size,
        model_dir=(args.model_dir.expanduser() if args.model_dir else default_model_dir(data_dir)),
        local_files_only=args.offline,
    )


def _announce_token(store: TokenStore, token: str, created: bool) -> None:
    if created and _stdout_is_terminal():
        print(
            f"\n首次启动，已生成配对令牌（保存在 {store.path}，权限 0600）：\n\n    {token}\n\n"
            "请把它填入同听扩展设置页的「本地识别服务 → 配对令牌」。之后可随时运行 "
            "`tongting-asr print-token` 再次查看。\n",
            flush=True,
        )
    elif created:
        # 输出被重定向（例如写入日志文件）时不打印令牌，避免令牌落盘到日志里。
        logger.info(
            "首次启动，已生成配对令牌并保存到 %s（权限 0600）。标准输出不是终端，未打印令牌；"
            "请在终端运行 `uv run tongting-asr print-token` 查看。",
            store.path,
        )
    else:
        logger.info("已加载配对令牌文件 %s（运行 `tongting-asr print-token` 查看令牌）。", store.path)


def cmd_serve(args: argparse.Namespace) -> int:
    # 先校验配置（含 loopback 限制），失败时不创建令牌、不加载模型。
    service_config = ServiceConfig(
        host=args.host,
        port=args.port,
        queue_size=args.queue_size,
        allowed_extension_ids=frozenset(args.allow_extension_id),
    )
    model_config = _model_config(args)
    setup_logging(args.log_level)

    from .server import PortInUseError, create_listen_socket, raise_nofile_limit, run_server

    limits = raise_nofile_limit()
    if limits is not None and limits[1] != limits[0]:
        logger.info("已把可打开文件数软上限从 %s 提高到 %s。", limits[0], limits[1])

    try:
        sock = create_listen_socket(service_config.host, service_config.port)
    except PortInUseError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_PORT_IN_USE

    try:
        store = TokenStore(_data_dir(args))
        try:
            token, created = store.ensure()
        except (TokenError, OSError) as exc:
            print(f"错误：无法准备配对令牌：{exc}", file=sys.stderr)
            return EXIT_CONFIG
        _announce_token(store, token, created)
        del token

        from .app import create_app
        from .model_manager import ModelManager
        from .transcriber import load_faster_whisper

        manager = ModelManager(
            partial(load_faster_whisper, model_config),
            model_name=display_model_name(model_config.model),
            device=model_config.device,
            compute_type=model_config.compute_type,
        )
        app = create_app(config=service_config, manager=manager, verify_token=FileTokenVerifier(store))
        logger.info(
            "tongting-asr %s 监听 http://127.0.0.1:%d（仅本机）。模型在后台准备，按 Ctrl+C 停止。",
            __version__,
            service_config.port,
        )
        if service_config.allowed_extension_ids:
            logger.info("只接受以下扩展 ID 的 Origin：%s", ", ".join(sorted(service_config.allowed_extension_ids)))
        else:
            logger.info("未限制扩展 ID：chrome-extension:// 来源仍需持有令牌；可用 --allow-extension-id 精确限制。")
        try:
            run_server(
                app,
                sock,
                host=service_config.host,
                port=service_config.port,
                log_level=args.log_level,
                config=service_config,
            )
        except KeyboardInterrupt:
            # uvicorn 在完成优雅停止（含模型释放）后会重新抛出捕获到的 SIGINT。
            pass
    finally:
        sock.close()
    logger.info("服务已停止。")
    return 0


def _stdout_is_terminal() -> bool:
    try:
        return sys.stdout.isatty()
    except (AttributeError, ValueError):
        return False


def cmd_print_token(args: argparse.Namespace) -> int:
    store = TokenStore(_data_dir(args))
    token, created = store.ensure()
    if created:
        print(f"（首次生成，已保存到 {store.path}，权限 0600）", file=sys.stderr)
    print(token)
    return 0


def cmd_rotate_token(args: argparse.Namespace) -> int:
    store = TokenStore(_data_dir(args))
    token = store.rotate()
    print(
        f"已生成新令牌并保存到 {store.path}。旧令牌立即失效（运行中的服务会在下一次请求时读取新令牌），"
        "请同步更新扩展设置页。",
        file=sys.stderr,
    )
    print(token)
    return 0


def cmd_bench(args: argparse.Namespace) -> int:
    from .app import parse_language
    from .bench import format_report, report_to_json, run_bench
    from .errors import ApiError

    setup_logging(args.log_level)
    if args.repeat < 1:
        raise ConfigError("--repeat 至少为 1。")
    try:
        language = parse_language([args.language])
    except ApiError as exc:
        raise ConfigError(exc.message) from None
    paths = list(args.audio) or sorted(_FIXTURES_DIR.glob("*.wav"))
    report = run_bench(
        _model_config(args),
        paths,
        repeat=args.repeat,
        language=language,
        include_silence=args.silence,
    )
    print(report_to_json(report) if args.json else format_report(report))
    return 0


def _platform_unsupported() -> bool:
    return sys.platform.startswith("win")


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if _platform_unsupported():
        print(
            "错误：tongting-asr 目前只支持 macOS 与 Linux（令牌文件权限、端口独占等安全措施依赖 POSIX 行为），"
            "不支持 Windows。",
            file=sys.stderr,
        )
        return EXIT_CONFIG
    try:
        return int(args.handler(args))
    except ConfigError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_CONFIG
    except TokenError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return EXIT_CONFIG
    except KeyboardInterrupt:
        print("已取消。", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())

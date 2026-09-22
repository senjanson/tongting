# 同听本地识别服务

服务仅监听 `127.0.0.1`，使用配对令牌鉴权。常规标签页音频识别使用 `POST /v1/transcribe`；YouTube 录播预读是可选功能。

## 启用 YouTube 预读

在本目录执行：

```sh
uv sync --extra youtube
uv run --extra youtube tongting-asr serve --youtube-preload --allow-extension-id YOUR_EXTENSION_ID
```

另需安装 `ffmpeg` 和 Node.js 20 或更高版本，并使它们在启动服务的 `PATH` 中可见。macOS 可使用 `brew install ffmpeg node`。模型已缓存时可加 `--offline`，该参数仅禁止下载模型，视频预读仍会联网。

使用多版本 Node 管理器时，可设置环境变量 `TONGTING_ASR_NODE_PATH` 指定可执行文件的绝对路径。视频下载会使用 Python 可发现的环境变量或 macOS 系统 HTTP/HTTPS 代理；FFmpeg 通过仅限本机的临时音频桥读取。

默认不启用预读。`GET /health` 的 `youtubePreload` 只有在启用开关且 `yt-dlp`、`ffmpeg`、Node.js 均可发现时才为 `true`；这不是某个视频一定可下载或网络已经连通的保证。模型是否可用仍由 `ready` 表示。

服务启动后，用 `tongting-asr print-token` 查看配对令牌，再填入扩展的本地识别配置。不要将令牌、音频、识别全文或带签名的媒体地址写入日志、报告或代码。

## 请求与时序

`POST /v1/youtube/transcribe` 使用 `Authorization: Bearer <配对令牌>`，`Content-Type: application/json`，同样接受已有的扩展来源、Host 与令牌检查。

```json
{ "videoId": "ZA-tUyM_y7s", "startMs": 300000, "durationMs": 20000, "language": "en" }
```

- `videoId`：11 位 YouTube 视频 ID，不接受任意网址。
- `startMs`：非负整数，最多 86400000（24 小时）。
- `durationMs`：1–30000 的整数，默认 20000。接近视频结尾时自动缩短，允许不足一秒的窗口填补跳转后的时间空隙。
- `language`：`auto` 或语言代码，可省略。支持 `en-US` 等形式，与原识别接口一致。

响应包含原接口的 `text`、`language`、`languageProbability`、`durationMs`、`processingMs`、`segments`，另加 `startMs`。其中 `durationMs` 是实际取到的音频时长；每个字幕片段的 `startMs` / `endMs` 相对于该段音频起点，客户端须加上响应顶层 `startMs` 才能定位到视频时间线。`processingMs` 只包含模型推理耗时，不含网络预读。

预读与常规识别共用单次推理和有界队列，超额请求返回 `429` 和 `Retry-After`。客户端跳转或停止时应取消请求；排队请求会被移除，尚在取段的子进程会被终止。Whisper 开始后的单次本地推理无法中途安全打断，会完成本段后释放资源；客户端必须丢弃已取消会话的迟到结果。

## 支持范围与资源

仅支持可匿名读取的普通公开录播。直播、直播回放、私有或需登录的视频，以及受 DRM 保护的视频不支持此预读方式。不读取浏览器 Cookies，也不使用用户的 YouTube 登录态。部分公开视频仍可能受到地区、反机器人检查或网络限制，客户端应展示实际失败原因并允许改用标签页录音。

仅解析 `https://www.youtube.com/watch?v=<ID>`，媒体来源及重定向仅接受 HTTPS 的 `*.googlevideo.com` 音轨。优先选择有索引的 M4A 音轨。单独子进程通过 256 KiB 的有界 HTTP Range 请求读取媒体，并在随机回环端口提供随机入口，供 FFmpeg 按请求时间精确截取为 16 kHz、单声道、16-bit PCM；每个片段网络读取最多 16 MiB。这避免旧版 FFmpeg 的无界请求被限速。音频使用内存管道，不写临时音频文件。最多缓存 8 个媒体地址、每个 120 秒，失败、取消与停止时清理相关地址，不缓存识别全文。取段整体最多等待 60 秒；超时、客户端断开或服务停止会杀死独立进程组及其 JavaScript/FFmpeg 子进程，并等待退出。下载器和 FFmpeg 的原始诊断不会回显到 API 或日志。

可预读音频意味着扩展能够暂停视频并准备后面的字幕，不代表零延迟。首段等待时间取决于网络、模型速度和翻译服务；播放速度超过处理速度时仍须重新缓冲。

## 开发验证

```sh
uv run --extra youtube pytest
```

默认测试不会访问 YouTube 或下载模型。`tests/test_youtube.py` 覆盖参数、鉴权、范围、媒体来源、缓存、异常、取段取消、进程创建竞态与停止；真实模型测试依旧需显式启用。测试服务使用随机回环端口，不需要停止正在使用的 8765 服务。

2026-09-17 验证：Python 回归 216 项通过、4 项真实模型测试按开关跳过；Ruff 检查通过。另用已缓存 `small/cpu/int8` 实测公开 MIT 视频 `ZA-tUyM_y7s` 的两个连续 20 秒窗口：300 秒位置首段请求 8.06 秒（模型识别 2.341 秒），320 秒位置请求 6.25 秒（模型识别 3.311 秒），均返回 HTTP 200、完整 20000ms 覆盖和实际字幕片段。单独取音频首段 6.50 秒、后续 3.00 秒。结果是该机器与当时网络的短段测量，不代表所有视频或长期连续播放性能；文本翻译与配音耗时不包含在内。

# 本地语音识别补充服务（tongting-asr）

代码位置：`services/asr-local/`。实测日期：2026-09-16。

## 1. 用途与边界

- **用途**：没有可用的云端语音识别接口（sub2api 未开放或未验证 `/v1/audio/transcriptions`）时，在本机运行的补充识别服务。它为无字幕视频提供「音频 → 原文 + 时间轴」，之后仍用 sub2api 翻译。
- **它不是**「只填 sub2api Key 就能翻译无字幕视频」。你需要自行安装 Python 依赖、下载模型（small 实测 464 MB）、并**在使用前手动启动服务**。
- **扩展不能自动启动它**。Chrome 扩展没有启动本机进程的常规权限，本项目也没有实现 native messaging。服务没启动时，扩展只会显示「无法连接本地识别服务」。
- 服务只做语音识别（转写），不做翻译、不做配音。默认接受请求体里的 WAV 音频；启用 `--youtube-preload` 后还接受 YouTube 视频 ID 与时间范围，由服务获取公开音轨。不接受任意 URL、文件路径或浏览器登录凭证。
- 识别质量和速度取决于硬件、模型与音频内容。第 9 节的数字**只代表那台机器上的合成语音样本**，不能外推为「所有视频实时」。

## 2. 硬件与依赖要求

| 项目     | 要求 / 实测情况                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统     | **只支持 macOS 与 Linux**（Linux 未实测）；已实测 macOS 15.5（Apple M4 Pro，arm64，24 GB）。**不支持 Windows**：启动时直接提示并退出。                                             |
| Python   | 3.12（`.python-version` 固定；`uv` 会自动下载）。依赖范围允许 3.12–3.13。                                                                                                          |
| 包管理   | [uv](https://docs.astral.sh/uv/) **≥ 0.11.7**（本机 0.11.7 已验证；`pyproject.toml` 使用 `required-version`、`uv_build>=0.11.7,<0.13` 与 `default-groups`），依赖由 `uv.lock` 锁定 |
| 主要依赖 | faster-whisper 1.2.1、ctranslate2 4.8.2、onnxruntime 1.30.0（Silero VAD）、FastAPI 0.141.1、uvicorn 0.53.0                                                                         |
| 加速     | **macOS 上 CTranslate2 只能用 CPU，没有 Metal/GPU 加速**。`--device cuda` 仅在有 NVIDIA GPU 的机器上可能可用，未实测。                                                             |
| 内存     | small 实测进程峰值约 1.0–1.2 GB（5 秒分段），处理 30 秒分段时约 1.5 GB；base 约 0.65–0.72 GB                                                                                       |
| 磁盘     | small 464 MB，base 153 MB（模型缓存）                                                                                                                                              |
| ffmpeg   | WAV 识别不需要；YouTube 预读和重新生成测试样本需要。预读另需 Node.js 与 yt-dlp，见下文                                                                                             |

## 3. 安装

```sh
cd services/asr-local
uv --version       # 需要 ≥ 0.11.7
uv sync            # 按 uv.lock 创建 .venv 并安装依赖（含测试依赖 pytest/httpx）
uv run tongting-asr --help
```

`.venv/`、`models/`、`.pytest_cache/` 等都不入库（仓库根 `.gitignore` 与 `services/asr-local/.gitignore`）。

### YouTube 同步优先模式

无完整字幕的视频要在画面暂停时准备后续内容，需要额外安装预读依赖并启用服务：

```sh
cd services/asr-local
uv sync --extra youtube
uv run --extra youtube tongting-asr serve --offline --youtube-preload --allow-extension-id YOUR_EXTENSION_ID
```

`YOUR_EXTENSION_ID` 替换成 Chrome 扩展管理页显示的译听 ID。`ffmpeg` 和 Node.js 需在服务进程的 PATH 中；多版本 Node 可用 `TONGTING_ASR_NODE_PATH` 指定绝对路径。保留原来的 `--data-dir` 可沿用配对令牌。首次下载模型时去掉 `--offline`。

`GET /health` 的 `youtubePreload: true` 表示预读依赖和开关就绪；真实网络是否可达仍以预读结果为准。`--offline` 仅禁止模型下载，视频预读仍需网络。接口、安全边界与依赖详情见 [服务说明](../services/asr-local/README.md)。

## 4. 模型下载与镜像

- 默认模型：多语种 `small`，CPU 量化 `int8`。
- 首次启动时，服务会在**后台**下载并加载模型，期间 `/health` 返回 `"status": "loading"`，识别请求返回 503。日志每 15 秒打印一次「模型仍在下载中」。
- 默认缓存目录：`services/asr-local/models/`（已被 git 忽略）。可用 `--model-dir` 或环境变量 `TONGTING_ASR_MODEL_DIR` 修改。
- 默认下载源是 `https://huggingface.co`。**服务不硬编码任何镜像**；访问不了时由你自己决定是否使用镜像，通过环境变量指定：

```sh
# 本机实测：huggingface.co 不可达，hf-mirror.com 可达。
HF_ENDPOINT=https://hf-mirror.com HF_HUB_DISABLE_XET=1 uv run tongting-asr serve
```

实测记录（2026-09-16，本机网络）：

| 设置                                                         | 结果                                                                                                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 只设 `HF_ENDPOINT=https://hf-mirror.com`                     | **失败**。约 2 秒后报错：`CAS Client Error ... 401 Unauthorized, domain: https://cas-server.xethub.hf.co/...`。原因是大文件走 Xet 存储通道，经镜像拿到的凭证被拒。 |
| `HF_ENDPOINT=https://hf-mirror.com` + `HF_HUB_DISABLE_XET=1` | 成功。small 下载 38.6 秒，base 下载 12.7 秒                                                                                                                        |

- 下载失败时 `/health` 为 `"status": "error"`，日志说明原因与建议。修正环境变量后需要**重启服务**才会重试。
- 模型下载完成后，可以加 `--offline` 启动，只从本地缓存加载模型。启用视频预读时仍会联网读取音轨。离线且缓存里没有该模型时，状态为 error，日志提示「离线模式下本地缓存没有模型」（已实测）。

## 5. 启动与停止

```sh
cd services/asr-local
uv run tongting-asr serve                 # 默认 127.0.0.1:8765，模型 small
uv run tongting-asr serve --offline       # 模型已下载后推荐
```

常用选项：

| 选项                      | 默认                  | 说明                                                                                                  |
| ------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `--port`                  | 8765                  | 修改后要同步修改扩展设置里的服务地址                                                                  |
| `--host`                  | 127.0.0.1             | **只接受 127.0.0.1 或 localhost**。`0.0.0.0`、`::`、`::1`、局域网 IP 与其他主机名都会被拒绝，退出码 2 |
| `--model`                 | small                 | 也可用 `base` 等 faster-whisper 模型名或本地 CTranslate2 模型目录                                     |
| `--compute-type`          | int8                  | CPU 上 CTranslate2 实际报告为 `int8_float32`                                                          |
| `--beam-size`             | 5                     | 机器慢时可用 1（本机约快 15%，样本文本一致，见第 9 节）                                               |
| `--cpu-threads`           | 0（CTranslate2 默认） | 本机实测 8 线程反而更慢                                                                               |
| `--queue-size`            | 2                     | 推理进行时允许排队的请求数，超出返回 429                                                              |
| `--allow-extension-id ID` | 不限制                | 只接受指定扩展 ID 的 Origin，可重复                                                                   |
| `--offline`               | 关                    | 只用本地模型缓存                                                                                      |
| `--data-dir`              | `~/.tongting-asr`     | 令牌所在目录，也可用 `TONGTING_ASR_HOME`                                                              |
| `--log-level`             | info                  | debug / info / warning / error                                                                        |

**停止**：在运行服务的终端按 `Ctrl+C`：

1. 立即进入「停止中」：不再接受新连接；排队中的请求和之后到达的请求立即返回 503 `model_unavailable`（JSON），`/health` 变为 `error`，不会再开始新的识别。
2. 只等待**正在进行的那一段**识别，最多 30 秒。完成则正常返回 200；超过 30 秒则该请求返回 503 `model_unavailable`（JSON），不输出异常堆栈。
3. 释放模型并退出。若第 2 步超时，推理线程无法被中断，模型不会被强行卸载，**进程会在该段推理结束后才真正退出**。再按一次 `Ctrl+C` 可强制退出。

实测（2026-09-16，small）：推理中发送 SIGINT，该请求返回 200，随后日志打印「模型已释放」「服务已停止」，端口释放。停止中排队请求 503、超过等待上限返回 JSON 503 的行为由自动化测试覆盖（第 12 节）。
如果放到了后台运行：`lsof -nP -iTCP:8765 -sTCP:LISTEN` 找到 PID，再执行 `kill -INT <PID>`。

## 6. 配对令牌与扩展设置

1. 首次运行 `serve` 时会生成随机令牌（32 字节随机数，43 个字符），保存到 `~/.tongting-asr/token`（文件权限 0600，新建目录权限 0700）。**只有标准输出是终端时才打印一次**；输出被重定向（例如写入日志文件）时不打印令牌，只提示运行 `print-token`。
   数据目录或令牌文件的属主不是当前用户、数据目录对组或其他用户可写、令牌文件是符号链接时，服务**拒绝启动**并提示原因（退出码 2）。
2. 之后查看：`uv run tongting-asr print-token`（令牌不存在时会生成）。
3. 在扩展设置页「识别与播放」→「语音识别服务」选择「本地识别服务」，然后填写：
   - 本地服务地址：**必须**写 `http://127.0.0.1:8765`（端口改了就一起改），然后点击「保存地址」。扩展只接受 `127.0.0.1`，不接受 `localhost`。原因：本服务只监听 IPv4 的 127.0.0.1；`localhost` 可能被解析到 IPv6 的 `::1`，而 `::1` 上的同一端口可能被其他进程占用，请求会发给错误的程序。
   - 配对令牌：粘贴上一步的输出，点击「保存令牌」。**不要把令牌贴到对话、文档或 issue 里。**
   - 保存地址后点击「授予本机服务访问权限」，允许扩展访问 `http://127.0.0.1:<端口>`（只申请你填写的端口）。本服务**不返回任何 CORS 响应头**，扩展必须先拿到这个主机权限，才能从 offscreen 页面调用；否则浏览器会以跨域错误拦截请求。
4. 轮换令牌：`uv run tongting-asr rotate-token`。**旧令牌立即失效**：服务在每次校验前检查令牌文件是否变化，无需重启。之后要在扩展设置里更新令牌（已实测：旧令牌 401，新令牌 200）。
5. 令牌文件被删除或损坏时，服务拒绝所有 `/v1/*` 请求（401），并在日志中说明原因。

## 7. 健康检查与接口

权威契约写在 `src/providers/asr/types.ts` 顶部注释中，这里是摘要。

```sh
curl -s http://127.0.0.1:8765/health
# {"status":"ok","ready":true,"model":"small","device":"cpu","computeType":"int8_float32","version":"0.1.0"}

curl -s -X POST "http://127.0.0.1:8765/v1/transcribe?language=auto" \
  -H @<(printf 'Authorization: Bearer %s' "$(uv run tongting-asr print-token)") \
  -H "Content-Type: audio/wav" \
  --data-binary @tests/fixtures/zh_5s.wav
```

- `GET /health`：不需要令牌。`status` 取值为 `loading`（下载或加载中）、`ok`、`error`（加载失败或服务正在停止）。
- `POST /v1/transcribe?language=<auto|代码>`：
  - 请求体必须是 16 kHz、单声道、16-bit PCM WAV，时长 ≤ 30 秒，请求体 ≤ 2 MB。
  - `language` 缺省为 `auto`。BCP 47 形式只取主语言子标签，例如 `zh-CN` 按 `zh`、`en-US` 按 `en` 处理。
  - 返回 `text`、`language`、`languageProbability`、`durationMs`、`processingMs`、`segments[]`（`startMs`、`endMs`、`text`、`avgLogprob`、`noSpeechProb`）。时间单位都是毫秒整数，相对本段音频开头，并限制在 `[0, durationMs]` 内。
  - `processingMs` 只统计模型推理耗时，不含排队等待。
  - **静音分段**：返回空 `text` 与空 `segments`，此时 `language` 没有意义（实测为 `en`，概率约 0.39）。客户端应忽略这种情况下的语言字段。

错误体固定为 `{"error": {"code": "...", "message": "..."}}`：

| HTTP      | code                                                                                | 含义                                                                                          |
| --------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 400       | `invalid_language` / `unsupported_language` / `invalid_request`                     | 语言参数格式错误、模型不支持该语言、Content-Length 非法                                       |
| 401       | `unauthorized`                                                                      | 缺少令牌或令牌错误（带 `WWW-Authenticate: Bearer`）                                           |
| 403       | `origin_not_allowed`                                                                | Origin 不是允许的 `chrome-extension://`，或是网页发起的无 Origin 请求（见第 8 节）            |
| 403       | `host_not_allowed`                                                                  | Host 头不是 `127.0.0.1:<端口>` 或 `localhost:<端口>`                                          |
| 404 / 405 | `not_found` / `method_not_allowed`                                                  | 路径或方法不存在（先要通过令牌校验）                                                          |
| 408       | `request_timeout`                                                                   | 15 秒内没有收完请求体（慢速上传），响应后断开连接                                             |
| 413       | `payload_too_large` / `audio_too_long`                                              | 请求体 > 2 MB（先按 Content-Length 预检，再流式计数）/ 音频 > 30 秒                           |
| 415       | `unsupported_media_type` / `invalid_wav` / `unsupported_wav_format` / `empty_audio` | Content-Type 不是 audio/wav、不是合法 WAV、采样率/声道/位深/编码不符、没有样本                |
| 429       | `busy`                                                                              | 1 个推理 + 队列已满，带 `Retry-After`（秒）                                                   |
| 499       | `client_closed_request`                                                             | 客户端在上传请求体或排队时断开，服务跳过该段（客户端通常收不到），只记一行 INFO               |
| 500       | `transcription_failed` / `internal_error`                                           | 推理异常，详情只写服务日志                                                                    |
| 503       | `model_loading`（带 `Retry-After: 5`）/ `model_unavailable`                         | 模型下载或加载中 / 加载失败，或服务正在停止（排队与新请求、以及超过停止等待上限的进行中请求） |

检查顺序：Host → Origin → 令牌 → 是否停止中 → Content-Type → language 格式 → 请求体大小与读取时限 → WAV 校验 → 模型状态 → 语言是否受支持 → 并发队列。因此模型加载期间，格式错误的请求仍先返回 415。408、413、499 与停止中的 503 响应带 `Connection: close`。

## 8. 安全说明

- **只监听 loopback**：绑定地址在配置层强制为 127.0.0.1，局域网无法访问。
- **令牌**：除 `/health` 外所有路径都需要 `Authorization: Bearer`，包括不存在的路径和 OPTIONS 预检。比较时先对两边做 SHA-256，再用 `hmac.compare_digest` 做常量时间比较。令牌文件为 0600，只防其他系统用户，**同一用户下的其他本机程序仍能读取它**。数据目录必须属于当前用户且不能对组或其他用户可写，令牌文件必须属于当前用户且不是符号链接，否则拒绝启动。
- **Origin**：
  - 带 Origin 头时，只接受 `chrome-extension://<32 位 a–p>`，其余一律 403，包括 `https://www.youtube.com`、`null`、`moz-extension://` 和多个 Origin 头。
  - `--allow-extension-id` 可进一步精确到某个扩展。注意：未打包扩展换了加载目录后，ID 可能变化。
  - 不带 Origin 的请求（本机 curl）允许，但仍需令牌。
- **Fetch Metadata**（在契约基础上额外加的防护）：请求没有 Origin，但带 `Sec-Fetch-Mode: no-cors/navigate` 与 `Sec-Fetch-Site: cross-site/same-site` 时，返回 403。这类请求来自网页用 `<img>`、`<script>` 或链接探测本机服务。curl 不发送这些头；扩展的 `fetch` 使用 cors 模式，不受影响；在地址栏直接打开 `/health`（`Sec-Fetch-Site: none`）仍允许。
- **Host 校验**：只接受 `127.0.0.1:<端口>` 或 `localhost:<端口>`，防 DNS rebinding。
- **不设置 CORS**：任何响应都没有 `Access-Control-*` 头。扩展依靠主机权限访问（见第 6 节）。
- **资源限制**：
  - 请求体 ≤ 2 MB：先检查 Content-Length，流式读取时再计数，分块传输也会截断。
  - WAV 严格校验，时长 ≤ 30 秒。
  - 同一时刻 1 个推理，排队 ≤ 2，超出返回 429。
  - 排队中的客户端断开后约 0.2 秒内让出位置。
- **连接保护**（防止本机进程不带令牌就耗尽文件描述符）：
  - 连接建立或上一响应结束后，10 秒内必须收完下一个请求头，否则关闭（空闲连接、半截请求头、keep-alive 后慢速发送都适用）。
  - 请求体必须在 15 秒内收完，否则 408 并断开。
  - 最多同时保持 32 个连接；超出时先关闭最早的空闲连接，全部都在处理请求时直接关闭新连接。因此空闲连接洪泛期间 `/health` 仍可用（有自动化测试）。
  - 启动时把可打开文件数软上限提高到 4096（不超过硬上限）；accept 遇到 EMFILE 等资源错误时，日志 60 秒只记一行。
  - 这些措施只能减轻、不能消除本机进程的拒绝服务：同一台机器上的恶意程序仍可以持续占满连接或 CPU。
- **只在内存中处理**：WAV 在内存中解析为 float32 样本后直接送入模型，不写临时文件，不留档，不接受 URL 或文件路径。
- **日志**：本服务自己的日志不写令牌、转写文本和音频。每次转写只记录时长、处理耗时、语言、片段数与字符数。被拒绝的请求记录方法、路径、拒绝原因和请求方的 Origin/Host 值，并按「原因 + 来源」限速：首条记录详情，之后 60 秒内只计数，窗口结束时汇总一条。输出处理器上有兜底过滤器，对经过它的全部记录（包括 uvicorn 与第三方库的消息和异常堆栈）替换**已登记的令牌**与 `Bearer xxx` 形式的字符串；它不认识其他敏感内容，**不能保证第三方库自己的日志或堆栈里不含其他信息**。下载错误里的 URL 查询串会被去掉。
- **其他**：关闭 `/docs`、`/openapi.json`、WebSocket、`Server` 响应头与代理头信任；所有响应带 `Cache-Control: no-store` 与 `X-Content-Type-Options: nosniff`。

## 9. 性能实测（2026-09-16）

机器：Apple M4 Pro（12 核：8 性能核 + 4 能效核），24 GB，macOS 15.5，Python 3.12.13，faster-whisper 1.2.1，ctranslate2 4.8.2，CPU，`int8`（运行时报告 `int8_float32`）。
样本：`services/asr-local/tests/fixtures/` 下的本机 `say` **合成语音**，均为 5 秒（详见其中的 `SOURCES.txt`）。
每项先预热 1 次，再重复 5 次取中位数。**RTF = 处理耗时 / 音频时长**，小于 1 表示快于实时。
测试时机器上还有其他负载（Java、IDE 等），表中各组合运行期间 1 分钟系统负载约 8–14（12 核）；30 秒分段那次约 3.5–7。

### 9.1 加载

| 项目                                  | 结果                                               |
| ------------------------------------- | -------------------------------------------------- |
| small 首次下载（hf-mirror，禁用 Xet） | 38.6 秒（464 MB）                                  |
| base 首次下载（同上）                 | 12.7 秒（153 MB）                                  |
| small 从缓存加载                      | 0.33–0.95 秒；服务启动到 `/health` 为 ok 约 0.7 秒 |
| base 从缓存加载                       | 0.16 秒                                            |
| small 首次推理（预热，5 秒样本）      | 约 2.0–2.9 秒                                      |

### 9.2 5 秒分段处理耗时（中位数）

| 模型  | beam | 线程 | 英文                | 日文            | 中文            | 5 秒静音       | 峰值内存 |
| ----- | ---- | ---- | ------------------- | --------------- | --------------- | -------------- | -------- |
| small | 5    | 默认 | 2178 ms（RTF 0.44） | 2275 ms（0.46） | 2218 ms（0.44） | 900 ms（0.18） | 1044 MB  |
| small | 5    | 4    | 2048 ms（0.41）     | 2167 ms（0.43） | 2194 ms（0.44） | —              | 1142 MB  |
| small | 5    | 8    | 2371 ms（0.47）     | 2743 ms（0.55） | 2761 ms（0.55） | —              | 1184 MB  |
| small | 1    | 默认 | 1868 ms（0.37）     | 1927 ms（0.39） | 1922 ms（0.38） | —              | 1183 MB  |
| base  | 5    | 默认 | 852 ms（0.17）      | 794 ms（0.16）  | 719 ms（0.14）  | 259 ms（0.05） | 651 MB   |
| base  | 1    | 默认 | 562 ms（0.11）      | 593 ms（0.12）  | 607 ms（0.12）  | —              | 717 MB   |

补充：

- **负载影响明显**。第一次 small/beam 5 基准在系统负载约 28 时运行，5 秒样本耗时 2.8–5.6 秒，中位 RTF 0.67–0.98。负载约 3.5 时，中文 5 秒样本仍为 2225 ms，说明约 2.2 秒是这台机器上的稳定值。
- **30 秒分段**（英文样本拼接 6 次，small/beam 5）：13.1–13.8 秒，RTF 0.46，6 个片段，文本完整，峰值内存 1.5 GB。
- **通过 HTTP 服务**（small/beam 5，curl）：单次 `processingMs` 2258–2313 ms。连续 75 个请求（约 3 分钟，三种语言轮换）全部 200，平均 2166 ms，最大 2686 ms；服务进程 RSS（每次请求后采样）在 458–1011 MB 之间波动（macOS 内存压缩会让 RSS 忽高忽低），开始 909 MB，结束 949 MB，这 3 分钟内未见单调增长。
- **并发**（queue-size 2）：同时发 6 个请求，3 个立即返回 429（`Retry-After: 7`），另 3 个依次在 2.5 秒、4.9 秒、8.0 秒完成。

### 9.3 识别结果（语言检测均为 auto）

| 模型 / beam  | 英文                                                                                                                          | 日文                                                                                                 | 中文                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| small / 5    | en 0.994：`The meeting starts at 9.30 tomorrow morning. Please bring the quarterly report.`（正确，「nine thirty」写成 9.30） | ja 0.995：`明日の会議は午前9時半から始まります 資料を忘れないでください`（正确，第一个句号成了空格） | zh 0.999：`今天下午三点,我们在会议室讨论新的翻译功能。`（正确，简体，逗号为半角）           |
| small / 1    | 同上                                                                                                                          | 同上，句号保留                                                                                       | 同上                                                                                        |
| base / 5     | 与 small 相同                                                                                                                 | 正确                                                                                                 | **有错**：`今天下午三點,我們在會議是討論新的翻譯功能。`（繁体，「会议室」识别为「會議是」） |
| base / 1     | 与 small 相同                                                                                                                 | 正确                                                                                                 | **有错**：`今天下午3點,我們再會議是討論新的翻譯功能。`                                      |
| 5 秒全零静音 | small 与 base 均无片段、文本为空（VAD 过滤），没有产生幻觉文本                                                                |                                                                                                      |                                                                                             |

**结论**：本机默认使用 small + beam 5，5 秒分段 RTF 约 0.44，能跟上实时播放，但每段会增加约 2 秒识别延迟。base 快约 3 倍，但本次中文样本出现错字与繁体输出，不建议作为中文默认。更慢的机器可以先试 `--beam-size 1`。

## 10. 端口冲突

启动时服务会先探测端口，再绑定：

```text
错误：端口 8765 已被占用，无法在 127.0.0.1:8765 启动本地识别服务。
该端口上已经有 tongting-asr 0.1.0 在运行（状态 ok）。无需重复启动；如需重启，请先在原终端按 Ctrl+C 停止。
```

占用者是其他程序时，会提示用 `lsof -nP -iTCP:8765 -sTCP:LISTEN` 查看，或改用 `--port <其他端口>`，并在扩展设置里同步修改服务地址。端口冲突时退出码为 3，配置错误时为 2。macOS 上即使别的程序监听 `0.0.0.0:8765`，也会判定为冲突，不会悄悄与它并存。

## 11. 故障排查

| 现象                                          | 处理                                                                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展显示无法连接                              | 确认终端里服务正在运行；`curl http://127.0.0.1:8765/health` 能返回 JSON；扩展设置里的地址与端口一致                                                                                 |
| 扩展请求被跨域拦截 / 权限错误                 | 在设置页「识别与播放」点击「授予本机服务访问权限」，允许 `http://127.0.0.1:<端口>`。本服务不返回 CORS 头                                                                            |
| `/health` 一直是 loading                      | 正在首次下载模型，查看日志「模型仍在下载中」                                                                                                                                        |
| `/health` 为 error                            | 查看服务日志 ERROR 行。常见原因：无法访问 huggingface.co（设 `HF_ENDPOINT`）；使用镜像时出现 xet/CAS 401（再加 `HF_HUB_DISABLE_XET=1`）；`--offline` 但本地没有模型。改完需重启服务 |
| 401                                           | 令牌不一致：运行 `print-token` 重新复制；执行过 `rotate-token` 后要更新扩展设置                                                                                                     |
| 403 `origin_not_allowed`                      | 用了 `--allow-extension-id`，但扩展 ID 已变化（未打包扩展换了目录会变），去 chrome://extensions 核对                                                                                |
| 403 `host_not_allowed`                        | 服务地址必须写 `127.0.0.1` 或 `localhost` 加端口，不能用其他主机名或局域网 IP                                                                                                       |
| 415                                           | 音频必须是 16 kHz 单声道 16-bit PCM WAV；把 44.1/48 kHz 或立体声直接发过来会被拒绝                                                                                                  |
| 413                                           | 单段超过 30 秒或 2 MB；把分段缩短（计划建议 3–6 秒）                                                                                                                                |
| 408                                           | 请求体 15 秒内没收完：检查客户端是否一次性发送完整 WAV、网络代理是否拦截了本机请求                                                                                                  |
| 启动报「数据目录…可写」或「属主不是当前用户」 | 执行 `chmod 700 ~/.tongting-asr`，或用 `--data-dir` 指向属于自己的私有目录                                                                                                          |
| Windows 上提示不支持                          | 目前只支持 macOS 与 Linux                                                                                                                                                           |
| 频繁 429                                      | 识别速度跟不上：减少并发、缩短分段，或改用 `--beam-size 1` / 更小的模型，并关闭其他占 CPU 的程序                                                                                    |
| 很慢                                          | macOS 只能用 CPU；系统负载高时耗时可能翻倍（见第 9 节）                                                                                                                             |
| 中文输出为繁体或错字                          | 改用 small 或更大的模型；base 实测中文较差                                                                                                                                          |

## 12. 测试与复现

```sh
cd services/asr-local
uv run pytest                                            # 假转写器与本机 uvicorn，不下载模型：155 passed，4 skipped（约 15 秒）
TONGTING_ASR_REAL_MODEL=1 uv run pytest tests/test_real_model.py   # 真实 small 模型，离线加载：4 passed
uv run tongting-asr bench --offline --repeat 5 --silence            # 第 9 节数据；--json 输出 JSON
uv run tongting-asr bench --offline --model base --beam-size 1
```

自动化测试覆盖：

- 令牌缺失或错误、网页 Origin 拒绝、chrome-extension Origin 放行、扩展 ID 白名单、Fetch Metadata、Host 头
- 非 loopback 绑定被拒（CLI 退出码 2 且不生成令牌）、端口冲突（退出码 3）
- 请求体过大（含分块传输）、非 WAV、错误采样率/声道/位深/浮点格式、空音频、超过 30 秒
- 繁忙 429 与串行推理、加载中 503、加载失败 503、推理异常 500
- 响应结构与毫秒字段、语言参数规范化
- 令牌 0600 权限与在线轮换、日志脱敏
- 排队中断开释放队列位置、关闭时等待推理结束再卸载、加载完成晚于关闭时立即释放
- 空闲连接、半截请求头、keep-alive 后慢速发送在时限后关闭；慢速请求体 408；连接洪泛时淘汰空闲连接且 `/health` 可用
- Content-Length 预检与流式计数分开验证、伪造 Content-Length、上传中断开 499（无 ERROR 日志）、排队中断开 499
- 停止时排队请求立即 503、只等正在进行的推理、超过等待上限返回 JSON 503 且无 ERROR 日志
- 闸门「刚被唤醒又被取消」归还许可、令牌轮换的 HTTP 层验证、日志（含异常堆栈）不含令牌与转写文本、拒绝日志限速
- 数据目录/令牌文件属主与权限校验、`/health` 不回显模型路径、重定向输出时不打印令牌、Windows 拒绝启动

## 13. 未验证项与已知限制

- **扩展与服务的真实联调未做**：offscreen 页在已授予主机权限时，Chrome 实际发送的 Origin 与 Sec-Fetch 头未抓包确认；Chrome 本地网络访问限制对扩展访问 127.0.0.1 是否弹出提示也未验证。
- **长时间运行**：只做了约 3 分钟、75 次请求的连续测试，计划要求的 20 分钟连续识别与换视频测试未做。
- **真实视频音频**：只用了发音清晰、无噪声的合成语音；背景音乐、多人对话、口音、专有名词和语速变化下的质量未知。
- **语言范围**：只测了英、日、中三种；韩、西、法等语言未测。模型支持某个语言代码，不等于识别质量可用。
- **其他硬件**：只测了这一台 M4 Pro。Intel Mac、Windows、Linux 与 CUDA 均未测，性能不能外推。
- **平台**：只支持 macOS 与 Linux，且 Linux 未实测；Windows 启动时直接拒绝。
- **uvicorn 版本**：连接保护继承了 uvicorn 0.53 的 `H11Protocol` 内部实现，依赖已锁定为 `uvicorn>=0.53,<0.54`；升级前需重新运行 `tests/test_server.py` 验证。
- 连接时限与停止流程由本机 uvicorn 的自动化测试覆盖（测试中使用缩短的时限）；默认 10/15/30 秒的实际取值没有在真实扩展使用场景下调优。
- 推理一旦开始无法中途取消，断开的客户端最多浪费一个分段（约 2 秒）的计算。
- `/health` 按契约不携带错误详情，加载失败的原因只在服务日志中。

# 能力矩阵

状态含义：`unknown` 未验证；`verified` 已实际调用验证；`unsupported` 实测不支持；`failed` 实测失败；`mock-only` 仅在模拟环境验证，真实服务待验收。

最后更新：2026-09-16（P0 初版，随阶段推进更新）。

## 1. sub2api 服务（用户实例）

尚未提供 Base URL 与 Key，以下全部为 `unknown`。不因模型名称存在而推断支持。

| 能力                                | 状态    | 验证方式                                                                                         | 备注                                                                |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| 服务可达 / host 权限                | unknown | 设置页「检查连接」或 `pnpm smoke:sub2api`                                                        |                                                                     |
| Key 有效                            | unknown | 对选定模型的小规模调用                                                                           | `/models` 成功不代表模型有权限                                      |
| 模型列表 `/v1/models`               | unknown | 同上                                                                                             | 失败时仍允许手动模型 ID                                             |
| Responses 文本翻译                  | unknown | 冒烟测试                                                                                         | 首选评测 gpt-5.6-terra                                              |
| Chat Completions 文本翻译           | unknown | 冒烟测试                                                                                         |                                                                     |
| 结构化输出（json_schema）           | unknown | 冒烟测试                                                                                         | 不支持时降级为 JSON 提示词 + 严格校验                               |
| 流式返回（SSE）                     | unknown | 冒烟测试                                                                                         |                                                                     |
| reasoning 参数（none/low）          | unknown | 冒烟测试                                                                                         | 默认不发送                                                          |
| 语音识别 `/v1/audio/transcriptions` | unknown | 设置页勾选「允许实际调用」后检查；或 `.env.local` 配置 SUB2API_ASR_MODEL 后 `pnpm smoke:sub2api` | 设置页检查用 1 秒测试音，只验证接口与认证；冒烟测试识别英文语音样本 |
| 语音合成 `/v1/audio/speech`         | unknown | 同上（SUB2API_TTS_MODEL / SUB2API_TTS_VOICE）                                                    | 通过只说明返回了音频，音质需人耳确认                                |
| 专用实时翻译 gpt-realtime-translate | unknown | 未实现探测                                                                                       | 可选增强，不阻塞默认链路                                            |

## 2. 浏览器 / 系统

| 能力                                | 状态     | 证据                           | 备注                                                |
| ----------------------------------- | -------- | ------------------------------ | --------------------------------------------------- |
| MV3 扩展加载（Playwright Chromium） | verified | tests/e2e/load.spec.ts         | 四个扩展页面可打开                                  |
| 真实 Chrome 152 加载 unpacked       | unknown  | 待人工                         |                                                     |
| tabCapture → offscreen → 原声回放   | unknown  | 见 docs/validation/p0-audio.md | P0 实验进行中                                       |
| popup / 侧栏点击的用户手势链路      | unknown  | 待人工                         | 自动化无法模拟工具栏点击                            |
| chrome.tts 中文声音                 | unknown  | 见 docs/validation/p0-audio.md | macOS 系统有 zh_CN 声音（say -v '?'），扩展内待验证 |
| AudioWorklet 在扩展 CSP 下可用      | unknown  | 同上                           |                                                     |

## 3. YouTube

本机当前无法访问 youtube.com，以下均无法实测。

| 能力                          | 状态    | 备注                               |
| ----------------------------- | ------- | ---------------------------------- |
| 播放器时间/暂停/跳转读取      | unknown | 本地夹具页验证中（非真实 YouTube） |
| SPA 视频身份变化              | unknown | 同上                               |
| 完整字幕轨道读取（timedtext） | unknown | 可能需要播放器自身生成的请求参数   |
| 仅当前显示字幕（增量）        | unknown |                                    |
| 广告识别                      | unknown |                                    |
| 直播 / Shorts / 画中画        | unknown | 未验证前显示「未验证」             |

## 4. 语音识别后端

| 后端                                     | 状态                         | 备注                                                                                                                                                                |
| ---------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 本地 faster-whisper 服务（独立运行）     | verified（2026-09-16，本机） | small 模型 CPU int8（实际 int8_float32）；英/日/中合成语音 5 秒段约 2.2 s（RTF≈0.44）、识别文本与语言检测正确；连续 75 次请求无内存单调增长；详见 docs/ASR_LOCAL.md |
| 本地识别服务 ↔ 扩展 offscreen 联调       | unknown                      | 尚未验证 Chrome 实际发出的 Origin / Sec-Fetch 头与主机权限访问                                                                                                      |
| 真实视频音频（音乐、噪声、多人）识别质量 | unknown                      | 仅测试了 macOS `say` 合成语音                                                                                                                                       |
| sub2api 语音识别                         | unknown                      | 见第 1 节                                                                                                                                                           |

## 5. 权限

| 权限                                                          | 用途                                                                                                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| storage                                                       | 设置、会话凭证（session 区域）、恢复快照                                                                                                  |
| sidePanel                                                     | A 轻巧侧栏                                                                                                                                |
| activeTab                                                     | 用户在工具栏/快捷键调用扩展后，对当前标签页捕获音频所需                                                                                   |
| tabCapture                                                    | 无字幕视频的语音识别与字幕+配音模式的原声混音                                                                                             |
| offscreen                                                     | 在扩展文档中处理捕获音频、播放云端合成音频                                                                                                |
| tts                                                           | 系统语音配音                                                                                                                              |
| optional_host_permissions `https://*/*`、`http://127.0.0.1/*` | 只在用户点击「授予访问权限」时申请**单一**已配置的 sub2api origin 或本地识别服务地址；manifest 必须声明较宽的可选范围才能支持任意用户域名 |
| content_scripts `https://www.youtube.com/*`                   | 仅 YouTube 桌面站点                                                                                                                       |

不申请：downloads（导出用扩展页 Blob 下载）、cookies、history、麦克风。

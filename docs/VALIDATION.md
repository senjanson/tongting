# 验收与实测记录

本文件按 [EXECUTION_PLAN.md](../EXECUTION_PLAN.md) §12 记录自动化测试结果、T01–T40 必测组合的覆盖情况，以及真实链路的实测数据。

**当前结论（2026-09-17）：真实用户 sub2api 的 Luna 翻译、结构化输出、流式返回已验证；本地测试视频经真实识别、翻译到系统中文配音的两项测试通过。** 代理开启后已进入真实 YouTube 并产生中文译文，但隔离浏览器播放约 40～50 秒后报错，无扩展对照同样失败；长时观看尚未通过。最新模型功能、真实服务与 YouTube 结果见 [LIVE_TEST.md](reviews/2026-09-17/LIVE_TEST.md)。此前 17 项修复与 UI 对照见 [FIXES.md](reviews/2026-09-17/FIXES.md)。下表保留各阶段历史覆盖口径，不能把模拟依赖的测试解释为真实服务通过。

## 1. 状态口径

新增的同步优先缓冲、无字幕音频预读、真实取段识别与 Luna 翻译，以及本轮全部回归结果单独记录在 [BUFFERED_PLAYBACK.md](reviews/2026-09-17/BUFFERED_PLAYBACK.md)。原有历史用例的未验收状态不会因新功能单测通过而自动变为已验收。

| 状态                           | 含义                                                                                         |
| ------------------------------ | -------------------------------------------------------------------------------------------- |
| 未验证                         | 尚无运行证据（可能已有测试代码，但未经负责人确认运行结果）                                   |
| 单元测试通过                   | 纯逻辑测试通过，依赖全部为替身                                                               |
| 集成测试（模拟依赖）通过       | 多模块协同测试通过，外部服务、浏览器 API、播放器或音频资源为模拟实现；**不等于真实链路通过** |
| E2E（Playwright Chromium）通过 | 在 Playwright 自带 Chromium 中加载构建产物通过；YouTube 为本地夹具页面，不是真实站点         |
| 冒烟测试通过                   | 对真实 sub2api 的显式调用通过（记录模型、日期、配置版本）                                    |
| 人工实测通过                   | 在真实 Chrome、真实 YouTube 页面、真实服务中人工验证通过，并在第 5 节有对应记录              |
| 实测失败                       | 真实环境中验证失败，备注写明现象与原因                                                       |

一项组合只有在其「期望结果」的全部要点都被覆盖时才能标为最终通过；只覆盖部分要点时，在状态中写明范围（例如「仅协调器部分」）。

## 2. 环境

以下数据引用自 [ENVIRONMENT.md](ENVIRONMENT.md)（记录日期 2026-09-16）。真实链路实测时如环境不同，在第 5 节的每条记录中单独填写。

| 项目                 | 值                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 操作系统             | macOS 15.5（24F74），arm64                                                                                                             |
| CPU / 内存           | Apple M4 Pro / 24 GB                                                                                                                   |
| GPU                  | 未单独记录                                                                                                                             |
| 日常 Chrome          | Google Chrome 152.0.7977.84                                                                                                            |
| 自动化浏览器         | Playwright 1.63.0 自带 Chromium（chromium-1243）                                                                                       |
| 扩展版本             | 0.1.0（`package.json`）                                                                                                                |
| 扩展最低 Chrome 版本 | 116（manifest `minimum_chrome_version`）                                                                                               |
| Node / pnpm          | 24.15.0 / 10.33.0                                                                                                                      |
| 主要依赖             | WXT 0.21.4、React 19.3.0、TypeScript 6.0.3、zod 4.6.5、Vitest 5.0.1                                                                    |
| 本地识别服务         | Python 由 uv 管理（`requires-python` 3.12–3.13），faster-whisper，见 [ASR_LOCAL.md](ASR_LOCAL.md)                                      |
| 其他工具             | uv、ffmpeg、macOS `say`                                                                                                                |
| 网络                 | registry.npmjs.org / pypi.org / github.com / hf-mirror.com 可达；**www.youtube.com、huggingface.co 不可达**（经本机代理 TLS 握手失败） |
| sub2api              | 未提供 Base URL 与 Key                                                                                                                 |

## 3. 自动化测试结果

由负责人在集成后运行并填写实际数字。未运行的一律保持「待运行」，不预填。以下为 2026-09-17 全部修复完成后的最终检查。

| 检查             | 命令                                          | 运行日期   | 结果   | 通过 / 失败 / 跳过       | 备注                                                                                                                 |
| ---------------- | --------------------------------------------- | ---------- | ------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 格式             | `pnpm format:check`                           | 2026-09-17 | 通过   | —                        | 全部文件符合 Prettier                                                                                                |
| 静态检查         | `pnpm lint`                                   | 2026-09-17 | 通过   | 0 错误                   |                                                                                                                      |
| 类型检查         | `pnpm typecheck`                              | 2026-09-17 | 通过   | 0 错误                   | TS 严格模式                                                                                                          |
| 单元测试         | `pnpm test`                                   | 2026-09-17 | 通过   | 625 / 0 / 0（53 个文件） |                                                                                                                      |
| 集成测试         | `pnpm test:integration`                       | 2026-09-17 | 通过   | 99 / 0 / 0（5 个文件）   | 模拟依赖                                                                                                             |
| 生产构建         | `pnpm build`                                  | 2026-09-17 | 通过   | —                        | `.output/chrome-mv3`；manifest 无 host_permissions，optional_host_permissions 为 `https://*/*`、`http://127.0.0.1/*` |
| 扩展 E2E         | `pnpm test:e2e`                               | 2026-09-17 | 通过   | 未开门控：33 / 0 / 10    | 最终检查时运行；10 条跳过均为门控用例（识别、配音、P0 音频）。门控用例结果见 3.1                                     |
| 打包             | `pnpm zip`                                    | 2026-09-17 | 通过   | —                        | `.output/tongting-0.1.0-chrome.zip`（约 312 kB），仅本地分发                                                         |
| 本地识别服务测试 | `uv run pytest`（在 `services/asr-local` 中） | 2026-09-17 | 通过   | 155 / 0 / 4              | 4 条跳过为真实模型测试，需 `TONGTING_ASR_REAL_MODEL=1`                                                               |
| sub2api 冒烟测试 | `pnpm smoke:sub2api`                          | —          | 未运行 | —                        | 阻塞：未提供 sub2api 凭证；会产生真实调用                                                                            |

### 3.1 自动化 E2E（Playwright Chromium，2026-09-17，e2e-agent 第二轮）

详细数据见 [validation/e2e-full-chain.md](validation/e2e-full-chain.md) 第 5–13 节，P0 音频见 [validation/p0-audio.md](validation/p0-audio.md)。
YouTube 均为本地夹具页（推断模拟，未与真实页面核对），sub2api 均为本地 mock。标记含义：**实测**＝本机真实服务或平台能力参与；**mock**＝替身。

构建与运行：`TONGTING_E2E=1 pnpm exec wxt build`，然后 `pnpm exec playwright test`。会发声或占用资源的用例需要门控变量：

- `TONGTING_E2E_ASR=1`：真实本地识别，占用 8765 端口，需要 services/asr-local 已执行 uv sync 并缓存 small 模型；
- `TONGTING_E2E_TTS=1`：系统语音配音；
- `TONGTING_P0_AUDIO=1`：P0 实验。

| spec                                                     | 条数          | 门控                    | 最近结果                                      | 验证方式                                                       |
| -------------------------------------------------------- | ------------- | ----------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| youtube-content                                          | 6             | 无                      | 6 通过                                        | mock（真实协调器 + 只读端口观察器）                            |
| youtube-captions-player                                  | 9             | 无                      | 9 通过                                        | mock（夹具播放器行为为推断）                                   |
| full-chain-captions / faults / security / worker-restart | 4 / 4 / 1 / 1 | 无（需 ffmpeg）         | 10 通过                                       | mock                                                           |
| full-chain-export（T35）                                 | 1             | 无（需 ffmpeg/ffprobe） | 1 通过                                        | mock 翻译；严格解析器 + ffprobe/ffmpeg 校验真实下载文件        |
| load / ui-pages                                          | 1 / 6         | 无                      | 7 通过                                        | 页面渲染                                                       |
| full-chain-asr（T03、T32、T21、T22）                     | 5             | TONGTING_E2E_ASR        | 5 通过（生命周期在缺陷 #5(b) 修复后重跑通过） | **实测**本地识别 + tabCapture（allowlist 替代手势）+ mock 翻译 |
| full-chain-dubbing（P5、T15/T16、T17、T31）              | 3             | TONGTING_E2E_TTS        | 3 通过                                        | **实测**系统语音；T31 为 mock（过滤 getVoices）                |
| audio-p0                                                 | 2             | TONGTING_P0_AUDIO       | 2 通过                                        | 实测 offscreen/tabCapture/chrome.tts，识别与云端配音为替身     |

不设门控时，识别、配音和 P0 共 10 条自动跳过。全量（所有门控打开）一次运行结果为 39 通过、1 失败（#5(b)，已修复并单独重跑通过）、3 条串行跳过（已改为非串行后重跑通过）。

关键实测数据：

- T03 真实识别：8/8 句识别正确并翻译；「语句结束 → 译文 done」n=7，p50 2635 ms，最大值 2812 ms（本机、small、合成语音、mock 翻译）。
- T21：识别捕获中重启 worker，接管同一租约，约 0.6 s 恢复，始终只有一套捕获。
- T22：offscreen 被销毁 111 ms 后报 offscreen-lost，捕获为 stopped，可以重新开始。
- P5：speak 调用时间比字幕起点早 21–149 ms。
- P0 时间映射误差（Date.now() 时钟）：+33～+81 ms。

本轮发现并由主会话修复的缺陷：

- #1：侧栏唤醒新标签页；
- #2：播放器晚初始化误判无字幕；
- #3：识别模式实时覆盖层空白；
- #5：快照资源字段失真。
  #4 是测试归因错误，已修正用例。

仍未覆盖或只能人工完成：

- 真实 YouTube、真实 sub2api；
- 真实用户手势下的 tabCapture、品牌 Chrome 声音、耳听质量；
- T32 积压提示与丢弃（本机没有触发）；≥20 分钟识别与 ≥30 分钟配音；
- T15 迟到 TTS 回调的精确竞态；真实无声音语言（T31）；
- 导出的 BOM、未译标记、临时识别结果，以及用真实播放器加载导出文件；
- 非英语识别。

生产构建检查项（负责人填写）：

- [ ] manifest 权限与 [CAPABILITIES.md](CAPABILITIES.md)「权限」一致，无 `host_permissions`，内容脚本只匹配 `https://www.youtube.com/*`
- [ ] 构建产物中没有远端脚本、原型宿主依赖、真实 Key、测试夹具或演示数据误入真实模式
- [ ] 资源路径（图标、offscreen、worklet）在加载后的扩展中可访问

## 4. 必测组合 T01–T40

「覆盖方式」列写的是计划中的覆盖手段；「证据/备注」中列出的相关测试文件仅表示测试代码存在，运行结果以「状态」列为准。

| 编号 | 场景                                                                 | 覆盖方式           | 状态                                                   | 证据 / 备注                                                                                                                                                                                                                                                                                                  |
| ---- | -------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T01  | 有人工字幕，正常播放：中文/双语字幕与视频时间相符                    | 单元 + 集成 + 人工 | 未验证                                                 | 需真实 YouTube 与 sub2api。相关测试：`tests/unit/captions/parse.test.ts`（人工构造夹具）                                                                                                                                                                                                                     |
| T02  | 有自动字幕，逐词更新：无重复段、断句可读、时间单调                   | 单元 + 人工        | 未验证                                                 | 需真实 YouTube。相关测试：`tests/unit/captions/incremental.test.ts`、`build-units.test.ts`                                                                                                                                                                                                                   |
| T03  | 无字幕，ASR 已配置：实际识别进入同一翻译管线                         | 集成 + 人工        | 未验证                                                 | 需真实工具栏手势、tabCapture、本地识别服务与 sub2api                                                                                                                                                                                                                                                         |
| T04  | 无字幕，ASR 未配置：明确告知缺少识别服务，原视频继续可播放           | 集成 + 人工        | 集成测试（模拟依赖）通过                               | `tests/integration/background/coordinator.test.ts`：「reports a clear next step when captions are missing and ASR is not configured (T04)」。模拟依赖，未在真实浏览器/服务验证；「原视频继续可播放」需人工确认                                                                                               |
| T05  | Key 无效或模型 403：不无限重试，不显示连接成功                       | 集成 + 冒烟        | 未验证                                                 | 相关测试：`tests/integration/translation/connection-check.test.ts`、`provider-mock-server.test.ts`、`tests/unit/translation/scheduler.test.ts`；结果待负责人确认。真实 sub2api 未验证                                                                                                                        |
| T06  | 模型发现失败、手动模型有效：可手动调用并验证                         | 集成 + 冒烟        | 未验证                                                 | 相关测试：`tests/integration/translation/connection-check.test.ts`；结果待确认                                                                                                                                                                                                                               |
| T07  | 429、Retry-After、多个并发任务：有界退避，无重试风暴                 | 单元 + 集成        | 未验证                                                 | 相关测试：`tests/unit/translation/scheduler.test.ts`、`tests/integration/translation/scheduler-mock-server.test.ts`；结果待确认                                                                                                                                                                              |
| T08  | 网络中断、SSE 半截、无结束事件：失败清楚，半截译文不缓存             | 单元 + 集成        | 未验证                                                 | 相关测试：`provider-mock-server.test.ts`、`scheduler-mock-server.test.ts`、`scheduler.test.ts`；结果待确认                                                                                                                                                                                                   |
| T09  | 返回缺 cue、重复 cue、错误 JSON：有限修复，不错配                    | 单元 + 集成        | 未验证                                                 | 相关测试：`provider-mock-server.test.ts`、`scheduler-mock-server.test.ts`、`scheduler.test.ts`；结果待确认                                                                                                                                                                                                   |
| T10  | 请求中暂停翻译再立即继续：服从最后意图，不丢开始操作，不重复捕获     | 集成 + 人工        | 集成测试（模拟依赖）通过                               | `tests/integration/background/coordinator.test.ts`：「T10: stop then start during an in-flight start keeps the last intent with a single live session」。模拟依赖，未在真实浏览器/服务验证；真实捕获是否重复未验证                                                                                           |
| T11  | 请求中跳转到远处：当前字幕来自新位置，旧回调不覆盖                   | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过（仅协调器 epoch 部分）        | `coordinator.test.ts`：「T11: a seek bumps the epoch for scheduler and dubbing」。模拟依赖，未在真实浏览器/服务验证。调度器淘汰旧请求（`scheduler.test.ts`、`scheduler-mock-server.test.ts`）结果待确认；真实页面跳转未验证                                                                                  |
| T12  | 视频 A→B→A，旧 A 后返回：会话隔离，旧 A 不写入新 A                   | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过                               | `coordinator.test.ts`：「T12: A→B→A creates distinct sessions and ignores late track data from the old navigation」。模拟依赖，未在真实浏览器/服务验证；真实 YouTube SPA 导航未验证                                                                                                                          |
| T13  | 翻译/合成中切换语言或模型：新配置生效，旧译文/音频不混入             | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过（仅协调器部分）               | `coordinator.test.ts`：「T13: changing target language bumps config revision, clears old translations and invalidates dubbing」。模拟依赖，未在真实浏览器/服务验证。模型切换、调度器与配音控制器侧（`scheduler.test.ts`、`dubbing-controller.test.ts`）结果待确认；真实音频是否停止未验证                    |
| T14  | 捕获授权/创建 await 中点停止：迟到的流立即 stop，无持续录音          | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过（仅 worker 侧迟到停止）       | `coordinator.test.ts`：「uses tab capture when no captions exist and stops a capture whose start is still in flight (T14)」。模拟依赖，未在真实浏览器/服务验证。offscreen 侧迟到 `getUserMedia` 流停止 tracks（`tests/unit/audio/capture-session.test.ts`、`host.test.ts`）结果待确认；真实 tracks 未验证    |
| T15  | TTS 完成回调晚于 seek/stop：不开始旧音频，临时资源释放               | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/audio/tts-player.test.ts`、`tests/unit/providers-tts/dubbing-controller.test.ts`、`engines.test.ts`；结果待确认。需耳听验证                                                                                                                                                            |
| T16  | 配音期间暂停/恢复视频：无旧队列连播，重新同步                        | 单元 + 人工        | 未验证                                                 | 相关测试：`dubbing-controller.test.ts`；需真实 YouTube 与耳听验证                                                                                                                                                                                                                                            |
| T17  | 用户调原声音量同时 ducking 结束：保留最新用户音量                    | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/youtube/ducking.test.ts`；需真实播放器验证                                                                                                                                                                                                                                             |
| T18  | 广告插入、缓冲、跳过广告：广告不进入正文缓存，时间映射正确           | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/audio/timeline.test.ts`、`dubbing-controller.test.ts`；广告识别依赖真实 YouTube 页面结构，本机不可达                                                                                                                                                                                   |
| T19  | 0.75/1/1.5/2 倍速切换：字幕时间正确，ASR 映射有断点，配音不无限追赶  | 单元 + 人工        | 未验证                                                 | 相关测试：`timeline.test.ts`、`dubbing-controller.test.ts`；需真实播放器                                                                                                                                                                                                                                     |
| T20  | popup 关闭、侧栏关闭再打开：会话不重复，UI 从快照恢复                | E2E + 人工         | 未验证                                                 | 工具栏弹窗与原生侧栏开合无法由 Playwright 完整模拟，需人工                                                                                                                                                                                                                                                   |
| T21  | worker 重启而 offscreen 有资源：握手核对，失配资源终止               | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过（仅孤立租约停止）             | `coordinator.test.ts`：「T21: an orphaned offscreen lease without a recovery record is stopped」。模拟依赖，未在真实浏览器/服务验证。offscreen 侧租约（`tests/unit/audio/host.test.ts`）结果待确认；真实 worker 强制重启与握手未验证                                                                         |
| T22  | offscreen 意外销毁/创建失败：错误可见，无永久 busy                   | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/audio/offscreen-client.test.ts`；结果待确认                                                                                                                                                                                                                                            |
| T23  | 源标签页关闭或导航离开 YouTube：音频、请求、监听器被释放             | 集成 + 人工        | 集成测试（模拟依赖）通过                               | `coordinator.test.ts`：「T23: content port disconnect releases the session」。模拟依赖，未在真实浏览器/服务验证；以内容脚本端口断开模拟页面离开，真实 tracks/请求释放未验证                                                                                                                                  |
| T24  | 另一个标签页启动翻译：切换 owner，旧资源释放后新会话启动             | 集成 + 人工        | 集成测试（模拟依赖）通过                               | `coordinator.test.ts`：「T24: starting on another tab releases the first session before the second starts」。模拟依赖，未在真实浏览器/服务验证                                                                                                                                                               |
| T25  | capture track ended 或权限撤回：停止识别并说明恢复动作               | 单元 + 集成 + 人工 | 集成测试（模拟依赖）通过                               | `coordinator.test.ts`：「T25: capture ended unexpectedly moves the session to an error state and releases resources」。模拟依赖，未在真实浏览器/服务验证；offscreen 侧（`capture-session.test.ts`）结果待确认；真实权限撤回未验证                                                                            |
| T26  | 清理某个音频资源抛错：继续其余清理                                   | 单元               | 未验证                                                 | 相关测试：`tests/unit/audio/cleanup.test.ts`、`capture-session.test.ts`；结果待确认                                                                                                                                                                                                                          |
| T27  | 缓存写入/配置保存失败：不声称已保存，可继续内存运行并提示            | 单元 + 集成        | 集成测试（模拟依赖）通过                               | `coordinator.test.ts`：「T27: settings persistence failure is reported as not persisted but applied in memory」。模拟依赖，未在真实浏览器/服务验证；缓存写入失败（`scheduler.test.ts`、`scheduler-mock-server.test.ts`）与笔记保存失败（`tests/unit/storage/notes-failure.test.ts`）结果待确认               |
| T28  | 修改 Key/Base URL 时请求正在进行：旧请求失效，新 Key 不发往旧 origin | 单元 + 集成        | 集成测试（模拟依赖）通过（仅删除 Key 停止会话）        | `coordinator.test.ts`：「T28: clearing the key while running stops the session with an actionable error」。模拟依赖，未在真实浏览器/服务验证。修改 Key/Base URL 时在途请求取消（`scheduler.test.ts`、`scheduler-mock-server.test.ts`）结果待确认                                                             |
| T29  | 页面伪造扩展消息/字幕含 HTML：拒绝越权，文本不执行脚本               | 单元 + 集成 + E2E  | 集成测试（模拟依赖）通过（仅发送方与消息 schema 校验） | `coordinator.test.ts`「Coordinator – 发送方与命令校验（T29）」：拒绝非 YouTube 来源的内容端口与网页来源的 UI 端口、畸形命令明确拒绝、schema 不合法的内容消息被忽略。模拟依赖，未在真实浏览器/服务验证；字幕含 HTML 的覆盖层渲染、MAIN world 伪造消息（`tests/unit/youtube/bridge-schema.test.ts`）结果待确认 |
| T30  | sub2api 重定向到不同站点：不泄露认证头，明确失败                     | 集成 + 冒烟        | 未验证                                                 | 相关测试：`provider-mock-server.test.ts`（跨源重定向）；结果待确认。真实 sub2api 未验证                                                                                                                                                                                                                      |
| T31  | 目标语言没有 TTS 声音：字幕可用，配音显示不可用和原因                | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/ui/derive.test.ts`、`dubbing-controller.test.ts`；真实系统声音列表未验证                                                                                                                                                                                                               |
| T32  | ASR 速度长期低于播放速度：队列有界，显示积压与降级                   | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/audio/recognition-queue.test.ts`；需真实本地识别服务长时运行                                                                                                                                                                                                                           |
| T33  | 临时 ASR 文本多次修订：字幕合理更新，稳定后仅朗读一次                | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/captions/asr-assembler.test.ts`、`dubbing-controller.test.ts`；需耳听验证                                                                                                                                                                                                              |
| T34  | 切换字幕来源/字幕轨道：旧来源失效，无双重翻译/朗读                   | 集成 + 人工        | 未验证                                                 | 需真实 YouTube                                                                                                                                                                                                                                                                                               |
| T35  | 部分字幕、收藏过滤、导出双语：范围准确、编号与时间合法               | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/export/format.test.ts`；需用实际播放器或可靠解析器读取真实导出文件                                                                                                                                                                                                                     |
| T36  | 全屏、剧场、面板宽度改变：字幕可见，不遮挡关键控件                   | 人工               | 未验证                                                 | 需真实 YouTube 页面                                                                                                                                                                                                                                                                                          |
| T37  | 页面重复挂载/视频元素替换：旧监听器卸载，无多层字幕                  | 单元 + E2E + 人工  | 未验证                                                 | 相关测试：`tests/unit/youtube/player-dom.test.ts`；真实页面未验证                                                                                                                                                                                                                                            |
| T38  | 缓存命中但术语/模型/原文已改：不命中错误版本                         | 单元 + 集成        | 未验证                                                 | 相关测试：`tests/unit/translation/translation-cache.test.ts`、`scheduler.test.ts`、`scheduler-mock-server.test.ts`；结果待确认                                                                                                                                                                               |
| T39  | 专用实时模式中源语言等于目标语言：保留原声，不静音                   | 集成 + 人工        | 未验证                                                 | 专用实时翻译模式（gpt-realtime-translate）尚未实现，服务能力未探测；实现前本项不适用                                                                                                                                                                                                                         |
| T40  | 页面关闭后旧 callback 修改音量：不影响新页面，不抛未处理错误         | 单元 + 人工        | 未验证                                                 | 相关测试：`tests/unit/youtube/ducking.test.ts`；真实页面未验证                                                                                                                                                                                                                                               |

汇总（负责人更新）：

| 状态                                   | 数量 | 编号                                                                  |
| -------------------------------------- | ---- | --------------------------------------------------------------------- |
| 集成测试（模拟依赖）通过（含部分范围） | 13   | T04、T10、T11*、T12、T13*、T14*、T21*、T23、T24、T25、T27、T28*、T29* |
| 人工实测通过                           | 0    | —                                                                     |
| 未验证                                 | 27   | 其余                                                                  |

带 * 的项目只覆盖了部分期望结果，最终验收前仍需补齐。

## 5. 真实链路实测记录

**当前没有记录。** 每次真实实测复制下方模板追加一条，不删除失败记录。不知道费率时写「未知」，不换算假定费用；没有测量的延迟写「未测」，不填估计值。

### 5.1 记录模板

```text
### R-YYYYMMDD-NN：<一句话场景>

- 日期：
- 执行人：
- 浏览器 / 版本：                         （例如 Google Chrome 152.0.7977.84）
- 操作系统：
- CPU / GPU / 内存：
- 扩展版本 / 构建：                       （package.json 版本 + 构建时间或提交）
- 布局：                                   （A 轻巧侧栏 / 其他）

服务配置
- 文本 provider：                          （sub2api，协议 Responses / Chat Completions，是否流式）
- 实际模型：                               （以请求实际使用的模型 ID 为准，不写预设名）
- 推理参数：
- 配置版本（configRevision）：
- 语音识别：                               （无 / 本地识别服务：模型、设备、量化 / sub2api：模型）
- 语音合成：                               （系统语音：声音名称与语言 / sub2api：模型、声音 / 无）

样本
- 视频：                                   （可公开访问的视频链接；不得包含登录态或授权参数）
- 视频类型：                               （普通录播 / 直播 / Shorts / 其他）
- 字幕来源：                               （人工字幕 / 自动字幕 / 无字幕）
- 实际字幕读取方式：                       （完整字幕轨道 / 增量字幕 / 语音识别）
- 源语言 → 目标语言：
- 输出方式：                               （仅字幕 / 字幕 + 配音）
- 播放速度：
- 测试时长：
- 期间操作：                               （暂停/恢复、跳转、换视频、改语言、倍速、关闭面板等，按时间列出）

延迟（分别记录 p50 / p95，并注明样本数与测量方法）
- 翻译请求往返：                p50 = ___ ms，p95 = ___ ms，n = ___
- 语句结束 → 可读译文：         p50 = ___ ms，p95 = ___ ms，n = ___
- 语句结束 → 可听译音：         p50 = ___ ms，p95 = ___ ms，n = ___
- 识别实时率（处理耗时 / 音频时长）：
- 缓存字幕切换显示耗时：                    （初始目标约 250 ms；不能用预缓存结果代表实时链路延迟）

质量与同步
- 配音积压最大值：                          （句数 / 秒）
- 丢段 / 跳过：                             （数量、原因）
- 重复段 / 重复朗读：
- 误译实例：                                （人名 / 数字 / 否定 / 术语，逐条列出原文、译文、正确译法）
- 字幕与画面时间偏差观察：

资源与清理（测试结束并停止后检查）
- 活跃媒体 tracks：
- 未完成请求：
- offscreen 文档是否仍存在：
- 事件监听器 / 定时器是否残留：
- 队列长度、缓存条目是否有界：
- 原声音量是否恢复为用户最后设定值：

用量与费用
- sub2api usage / 账单证据：                （截图或后台记录位置；不得包含 Key）
- 费率：                                    （已知则填写，未知写「未知」）

覆盖情况
- 自动化覆盖：                              （对应的测试命令与结果）
- 人工实测：                                （本次实际验证了哪些 T 编号与哪些要点）
- 未覆盖：                                  （以及原因）

结论：通过 / 部分通过 / 失败
问题与后续：
```

### 5.2 记录

暂无。

## 6. 阻塞与待人工验收

### 6.1 外部阻塞

| 阻塞项                         | 影响                                                                                                                         | 解除条件                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 本机无法访问 www.youtube.com   | 真实页面结构、字幕轨道读取、增量字幕、广告、全屏/剧场、SPA 导航全部无法实测（T01、T02、T11、T12、T16–T19、T34、T36、T37 等） | 提供可访问 YouTube 的网络环境                                    |
| sub2api Base URL 与 Key 未提供 | 文本协议、模型权限、结构化输出、流式、重定向、限流等真实行为无法验证（T05–T09、T30），冒烟测试无法运行                       | 用户在扩展设置页或本地 `.env.local` 中配置（不粘贴到对话或文档） |
| sub2api 语音识别/合成能力未知  | sub2api 语音路线无法评估；且实测会产生计费调用                                                                               | 用户确认服务是否提供语音接口，并同意产生计费调用                 |
| huggingface.co 不可达          | 本地识别模型需经镜像下载                                                                                                     | 见 [ASR_LOCAL.md](ASR_LOCAL.md)                                  |
| 三个验收视频未提供             | 缺少人工字幕、自动字幕、无字幕三类固定样本                                                                                   | 用户提供可公开访问的视频                                         |

### 6.2 只能人工验收的项目

以下项目浏览器自动化无法可靠覆盖，必须在真实 Chrome 中人工完成并在第 5 节记录：

- [ ] 真实 Chrome 152 通过「加载已解压的扩展程序」加载 `.output/chrome-mv3`，弹窗、侧栏、设置页、工作台均可打开。
- [ ] 真实用户手势链路：点击工具栏图标 → 弹窗「开始翻译」→ tabCapture → offscreen 捕获；按 Alt+T 启动；只从侧栏点击时的实际行为与提示。
- [ ] 捕获期间原声由扩展回放，听感正常；停止后标签页原声恢复。
- [ ] 耳听验证：中文配音可听、暂停/跳转/停止后不再朗读旧句、无回声循环、无多句重叠（T15、T16、T33）。
- [ ] ducking：配音时原声降低、结束后恢复为用户最新音量（T17）。
- [ ] 系统声音列表：目标语言有/无声音时的界面表现（T31）；系统语音是否联网。
- [ ] 关闭/重开弹窗和侧栏后会话不重复（T20）。
- [ ] 在 `chrome://serviceworker-internals` 或扩展详情页强制停止 service worker 后的恢复行为（T21），以及需要重新点击工具栏图标的提示。
- [ ] 真实 YouTube 普通录播：有人工字幕、有自动字幕、无字幕各一条（T01–T03）。
- [ ] 广告插入与跳过、全屏/剧场模式、面板宽度变化（T18、T36）。
- [ ] 导出的 SRT/VTT 文件被实际播放器或可靠解析器读取（T35）。
- [ ] 至少 30 分钟有字幕 + 配音连续运行，20 分钟无字幕识别连续运行与换视频，记录队列与资源是否持续增长（EXECUTION_PLAN P6/P8）。
- [ ] 直播、Shorts、画中画的实际表现（未验证前界面应显示不支持或未验证）。
- [ ] 按 [USER_GUIDE.md](USER_GUIDE.md) 从零操作一遍，确认另一个人仅按文档即可完成加载与配置。

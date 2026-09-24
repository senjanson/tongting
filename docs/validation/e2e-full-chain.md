# 全链路 E2E 实测记录（夹具环境）

记录日期：2026-09-17。结论只适用于下列环境。**真实 YouTube、真实 sub2api 未参与；YouTube 与 sub2api 均为本地替身。**

## 1. 环境与复现

| 项目     | 值                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 系统     | macOS 15.5，Apple M4 Pro                                                                                                              |
| 浏览器   | Playwright 1.63.0 自带 Chromium（headless，版本见 p0-audio.md：153.0.8010.12）                                                        |
| 扩展     | `TONGTING_E2E=1 pnpm exec wxt build` 的 `.output-e2e/chrome-mv3`，测试开始时复制到 `$TMPDIR/tongting-e2e-full-chain-extension` 后加载 |
| YouTube  | `context.route` 提供 `fixtures/youtube` 的观看页与假播放器（视频表替换为多视频），ffmpeg 生成 150 s 黑屏静音视频，字幕为人工 json3    |
| sub2api  | `tests/e2e/fixtures/full-chain/mock-sub2api.ts`（127.0.0.1 随机端口，译文 `译[<目标语言>] <原文>`，假 Key）                           |
| 驱动方式 | 在 `chrome-extension://<id>/sidepanel.html` 中 `chrome.runtime.connect({name:'tongting:ui'})` 发送 UiCommand、读快照与 cues           |

```sh
export PATH=$HOME/.volta/tools/image/node/24.15.0/bin:$PATH
TONGTING_E2E=1 pnpm exec wxt build
pnpm exec playwright test tests/e2e/full-chain-captions.spec.ts tests/e2e/full-chain-faults.spec.ts \
  tests/e2e/full-chain-security.spec.ts tests/e2e/full-chain-worker-restart.spec.ts
```

最近一次（第一轮，只有上表 4 个 spec）：`10 passed (1.6m)`，连续两次全部通过。第二轮（2026-09-17 晚）的全量结果见第 5 节。

## 2. 结果

| 用例                         | 结果 | 关键数据                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 字幕全链路               | 通过 | 连接检查 6 项 verified；start→running 约 120 ms；请求只含 `{id,text}`，Authorization 只发往 mock；覆盖层双语、HTML 不执行；IndexedDB recordId `AAAAAAAAAAA\|zh-CN\|track:.en` 与快照一致                                                                                                                                                                                   |
| T16（字幕部分）视频暂停/继续 | 通过 | 快照 player.paused 跟随，会话保持 running，覆盖层显示暂停位置译文                                                                                                                                                                                                                                                                                                          |
| 暂停翻译 / 继续              | 通过 | 暂停时在途请求 1 个被中止；暂停 6 s 内（含跳到未翻译区间）新请求 0；继续后恢复请求                                                                                                                                                                                                                                                                                         |
| T11 请求在途时跳转到远处     | 通过 | 在途 2 个请求被中止（约 130 ms）；新位置先显示原文 + pending，再显示译文；epoch 递增；无错配译文                                                                                                                                                                                                                                                                           |
| T20 关闭侧栏页后重开         | 通过 | 快照仍 1 个会话、同 sessionId、running，audioOwner 不变                                                                                                                                                                                                                                                                                                                    |
| 停止                         | 通过 | 覆盖层移除、`data-tongting-hide-native` 移除、夹具原生字幕恢复为关闭（setOption 空轨道 + unloadModule）；停止后 3 s 无请求                                                                                                                                                                                                                                                 |
| T23 关闭 YouTube 标签页      | 通过 | 关闭时在途 2 个请求均被中止；会话与页面从快照消失，audioOwner null；之后 3 s 无请求                                                                                                                                                                                                                                                                                        |
| T12 A→B→A                    | 通过 | 三个不同 sessionId；导航时 A 的在途 2 个请求被中止；B 的字幕/覆盖层无 A 文本；回到 A 后无 B 文本；每步快照只有 1 个会话                                                                                                                                                                                                                                                    |
| T13 运行中改目标语言         | 通过 | 覆盖层序列：原文（旧译文已清除）→ `译[ja]`，约 1.6 s（mock 延迟 1.5 s）；新请求全部 target_language=ja；recordId 变为 `\|ja\|`                                                                                                                                                                                                                                             |
| T05 Key 无效（401）          | 通过 | 连接检查 auth failed、translation unknown；会话 error auth-invalid；共 2 个请求（并发 2）后阻塞，8 s 内不再请求；更换正确 Key 后同一会话恢复                                                                                                                                                                                                                               |
| T07 429 + Retry-After: 2     | 通过 | 15 s 内 8 个请求，间隔约 2.0–2.9 s，最大并发 1；快照 rateLimitedUntil 有值；解除后恢复                                                                                                                                                                                                                                                                                     |
| T30 跨 origin 302            | 通过 | 连接检查 reachability failed（redirect-blocked）；重定向目标收到 0 个请求；会话失败 cue 带 redirect-blocked 原因，无 done                                                                                                                                                                                                                                                  |
| T08 SSE 半截断开             | 通过 | 前 2 次半截流后第 3 次成功，UI cues 事件中从未出现半截文本；持续半截时 15 s 内 6 个请求后停止（failed 计数）                                                                                                                                                                                                                                                               |
| T29 安全抽查                 | 通过 | 页面 `chrome.runtime` 不存在；伪造桥消息（非法形状、其他视频字幕、命令结果、端口形状命令）与 20 次导航事件后：会话/设置/凭证/标题不变，注入文本未进入 cues 与请求；页面 DOM、window、Web Storage、cookie、资源条目无 Key；内容脚本 ISOLATED world 读取 `storage.session` 与 `storage.local`（含「记住在本机」后）均为 `Access to storage is not allowed from this context` |
| T21（字幕模式）worker 重启   | 通过 | CDP `ServiceWorker.stopAllWorkers` 终止 worker（全局变量丢失、workerInstanceId 变化）；约 1.0 s 后同一 sessionId 恢复 running，快照 1 个会话，覆盖层继续显示译文                                                                                                                                                                                                           |

## 3. 第二轮新增覆盖（2026-09-17 晚）

第一轮列为「未覆盖」的项目（T03、P5 配音、识别捕获中的 T21、T22、youtube-content 与真实协调器共存），本轮都已编写用例并运行，结果见第 5–11 节。仍未覆盖的项目见第 12 节。

## 4. 第一轮观察到的产品问题（均已由主会话修复）

1. **覆盖层徽标重复前缀（低）**：`session.ts statusText()` 返回「译听 · 翻译中」，`overlay.ts render()` 又加「译听 · 」，实测徽标为「译听 · 译听 · 翻译中」/「译听 · 译听 · API Key 无效…」。
2. **非认证类阻塞错误无会话级提示（低–中）**：重定向（redirect-blocked，category network）、持续 429、持续半截流时，会话 `error`/`notice` 为空，覆盖层徽标仍为「翻译中」；原因只在失败计数与逐条 cue 的 translationError 中可见（`session.ts applyTranslationUpdates` 只对 auth/permission/quota/config 设置会话 error）。

## 5. 第二轮环境、复现与总结果

| 项目       | 值                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 浏览器     | Playwright 1.63 自带 Chromium 153.0.8010.12（headless），macOS 15.5，Apple M4 Pro                                                                                                           |
| 扩展       | `TONGTING_E2E=1 pnpm exec wxt build`（每次主会话修复后重新构建）                                                                                                                            |
| YouTube    | 本地夹具页；`fake-player.js` 本轮改进（见第 7 节）。均为推断模拟，**未与真实 YouTube 核对**                                                                                                 |
| sub2api    | 本地 mock，假 Key                                                                                                                                                                           |
| 本地识别   | **真实** `services/asr-local`（faster-whisper small，int8_float32，CPU，`--offline`，127.0.0.1:8765，`--allow-extension-id`）。令牌在运行时生成于临时目录，只在内存中传给扩展，测试结束删除 |
| 系统语音   | **真实** `chrome.tts`（Playwright Chromium 在 macOS 上的系统声音：191 个，remote 0 个；zh-CN 11、zh-TW 9、en 47、ja 11、ko 9、es 18、fr 20、de 11）                                         |
| tabCapture | `--allowlisted-extension-id` 自动化替代，**不等同于真实用户手势**                                                                                                                           |
| 发声       | 识别用例去掉 `--mute-audio`，测试页从扬声器播放合成语音；配音用例经系统语音朗读（音量 0.2）                                                                                                 |

```sh
export PATH=$HOME/.volta/tools/image/node/24.15.0/bin:$PATH
TONGTING_E2E=1 pnpm exec wxt build
pnpm exec playwright test                                   # 不发声的用例；识别/配音/P0 自动跳过
TONGTING_E2E_ASR=1 TONGTING_E2E_TTS=1 TONGTING_P0_AUDIO=1 pnpm exec playwright test   # 全部
# 证据：test-results/full-chain-asr-evidence.json、full-chain-dubbing-evidence.json、audio-p0-evidence.json（每次运行开头会清空 test-results）
```

全量运行（所有门控打开）：43 条中 **39 通过、1 失败、3 条因串行模式被跳过**，用时 6.8 分钟。失败项是缺陷 #5(b) 的复测断言。之后识别 spec 改为非串行并单独重跑，结果 4 通过、1 失败（同一断言）。主会话修复 #5(b) 并重新构建后，「生命周期」用例单独重跑**通过**。至此 43 条用例在各自最近一次运行中全部通过；修复后没有再跑全量，最终全量检查由主会话执行。

验证方式标记：**实测**＝本机真实服务或平台能力参与（本地识别服务、系统语音、Chromium tabCapture/offscreen）；**mock**＝替身服务或替身 API；夹具页始终是替身。

## 6. youtube-content.spec.ts（真实协调器，6 条通过）

重写后不再注入假 worker。观察方式有三种：

- UI 端口快照；
- worker 中的只读端口观察器（`helpers/content-tap.ts`）：只给 `tongting:content` 端口追加监听，不回复、不替换协调器；
- worker 重启后，经 `--remote-debugging-port` 的 CDP 在新 worker 中求值（`helpers/cdp.ts`；Playwright 不为重启后的 worker 提供新句柄）。

| 用例                                                   | 结果         | 要点                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 空闲不连接 → 唤醒 → hello + 完整状态 → 事件 → 完整轨道 | 通过（mock） | 驱动页为 options.html，不会唤醒。页面加载后 3 s 内，以及空闲时发生 seek，connects 都是 0，快照无该页。worker 发送 `tongting:content-wake` 后顺序为 hello → page/video → captions/tracks → player/state（frameId 0）。play/seeked/ratechange 都有上报，快照中 playbackRate=1.5。session/start 后由播放器请求 timedtext（带 pot 1 次、无 pot 0 次），track-data 为完整轨道、json3、rejectedCount 0。停止后再开始由桥缓存重放：timedtext 仍为 1 次，setOption 调用数不变。内容脚本发给 worker 的消息中没有 FIXTURESIG/FIXTUREPOT//api/timedtext |
| 覆盖层                                                 | 通过（mock） | 只挂载一个 host。含 `<img onerror>` 的原文和译文按纯文本显示，没有执行，shadow 中 img/script 为 0，pointer-events 为 none。徽标含「翻译中」，前缀不重复。全屏后覆盖层仍在全屏子树中，fullscreen 事件有上报。广告期间隐藏，之后恢复。停止后覆盖层和 hide-native 都被移除                                                                                                                                                                                                                                                                      |
| SPA A→B→A、video 替换                                  | 通过（mock） | 3 个 navigationId 不同且递增，每条 page/video 与 tracks 的 videoId 都和其 navigationId 一致（同一导航内 page/video 可能发两次：导航时一次、元数据就绪后一次）。替换 video 元素时上报 video-replaced；旧元素改倍速不再上报，新元素 0.75 有上报                                                                                                                                                                                                                                                                                                |
| worker 重启后空闲不重连                                | 通过（mock） | 用 CDP `ServiceWorker.stopAllWorkers` 停掉 worker 后，新 worker 在 3 s 内 connects=0。唤醒后按 hello → 完整状态重新登记，documentId 不变，currentTime ≥ 6.9 s                                                                                                                                                                                                                                                                                                                                                                                |
| observe-visible                                        | 通过（mock） | timedtext 对该视频总返回空正文，约 6 s 后退回 incremental-captions，notice 为 incremental-captions，原生字幕层为 visibility:hidden。captions/visible 读到 XSS 行，时间 ≥ 3 s，译文出现在覆盖层。停止后调用 unloadModule，getOption 为 `{}`，原生字幕层 visible，之后不再有 captions/visible                                                                                                                                                                                                                                                  |
| 缺陷 #1 回归                                           | 通过（mock） | 侧栏打开时新开 YouTube 标签页，1.1 s 内登记（修复前 12 s 内 connects=0）                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

旧 spec 中「注入过期 session/cues 被丢弃」和「过期视频请求返回 stale-video」需要伪造 worker 消息，在真实协调器下无法注入，**本 E2E 不再覆盖**，只由单元测试覆盖。

## 7. 夹具改进与 youtube-captions-player.spec.ts（9 条通过，mock）

`fake-player.js` 新增以下模拟行为（推断，未核对真实页面）：

- 同一轨道重复 setOption 不重新请求；
- 带 translationLanguage 时请求 `&tlang=`，服务端返回 `[auto-xx]` 译文；
- `captionsDefault` 让页面加载后立即请求正文；
- `initDelayMs` 让播放器 API 延迟出现；
- getOption 反映真实开关，tracklist 在模块未加载时为空；
- 字幕开关与语言跨 SPA 导航保留；
- `nativeCues` / `timedtextBlocked` / `timedtextFailFirst` 三个服务端开关。

| 用例                           | 结果                       | 数据                                                                                                                                                                                                               |
| ------------------------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 轨道已激活但正文未缓存         | 通过                       | 夹具自检：重复设置同一轨道是 noop，不发请求。开始翻译后桥依次发送 `{}` 和 `en`，播放器重新请求（带 pot 共 2 次），拿到完整 6 条。停止后恢复为 en 开启                                                              |
| tlang 自动翻译                 | 通过                       | 请求序列 tlang=[zh-Hans, null]，track-data 为原文且不含 `[auto-`。停止后 getOption 恢复 translationLanguage，第三次请求带 zh-Hans，原生字幕显示 `[auto-zh-Hans] …`                                                 |
| 正文早于内容脚本连接           | 通过                       | 首次 timedtext 早于首条端口消息。开始后用缓存重放，timedtext 仍 1 次，setOption 0 次                                                                                                                               |
| 延迟 14 s，就绪后开始          | 通过                       | 先报 captions-bridge-unavailable（availability 保持 unknown），就绪后开始，得到 full-track                                                                                                                         |
| 延迟 11 s / 12.5 s，就绪前开始 | 通过（缺陷 #2 两次修复后） | 11 s：tracks 在加载后 11 292 ms 到达，full-track，未开启捕获                                                                                                                                                       |
| 延迟 16 s，就绪前开始          | 通过                       | 超过 14 s 等待上限，报 captions-not-ready（文案不再说「没有可读取的字幕」），capture=none                                                                                                                          |
| 字幕开关跨视频保留             | 通过                       | 用户在 A 打开 en 后导航到 D：D 的正文被自动请求，会话用缓存，D 共 1 次请求。用户关闭字幕后，在 E 开始（桥打开 en）、会话中导航到 D：导航后恢复为用户原来的关闭（getOption `{}`，无原生字幕），D 上的新会话继续运行 |
| 字幕轨道来源句间空隙           | 通过                       | 空隙（2.5–6 s）内覆盖层不显示上一句，连续播放采样中空隙期间可见条目为 0（验证缺陷 #3 的识别模式延迟显示没有影响字幕轨道来源）                                                                                      |

## 8. T03 无字幕视频 + 真实本地识别（full-chain-asr.spec.ts）

音频为 `say` 合成的 8 句英文，句间 1.2 s，前置 2 s 静音（`media.ts speechVideo`），segmentMs 5000，sourceLanguage auto，mock 翻译。

| 用例                        | 结果                                      | 数据                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 捕获 → 识别 → 翻译 → 覆盖层 | **通过（实测识别 + mock 翻译）**          | 连接检查 localAsr 为 verified（7 ms）。运行中 offscreen lease 属于该会话，track 为 live，getCapturedTabs 为 active，快照 activeTracks=1。8 句全部识别为 final，翻译 done 8/8。文本逐句与音频一致：`16 kHz`、`42 and 3.14`、`WAV`、`Real-time` 属于写法差异；按单词召回率计为 1、1、0.82、0.91、1、1、0.5、1，数字写法拉低了召回率。cue 起点比实际起音早 158–324 ms，终点偏差 −44～+174 ms                                                                    |
| 语句结束 → 可读译文延迟     | 实测                                      | n=7（第 3 句末词 kilohertz 被识别为 kHz，无法按末词匹配）：2812、2538、2641、2635、2562、2530、2691 ms。**p50 2635 ms，p95（n=7 取最大值）2812 ms**。前一轮为 p50 2665 / 2572 ms、最大 2874 / 2736 ms。媒体钟与墙钟漂移 84 ms。只代表本机、small、合成语音、mock 翻译（翻译延迟约 2–5 ms）                                                                                                                                                                   |
| 实时显示（缺陷 #3 修复后）  | 通过                                      | 播放期间覆盖层依次显示第 0–6 句译文（第 7 句在采样结束后到达），第一条译文出现后没有空白采样。修复前整段播放期间 main 一直为空串。回看暂停在第 2 句时显示该句译文、原文与徽标「语音识别翻译中」                                                                                                                                                                                                                                                              |
| 生命周期                    | **通过（实测）**（缺陷 #5(b) 修复后重跑） | 暂停翻译：视频继续播放，getCapturedTabs 为 stopped，没有在途请求，快照 activeTracks 为 0（修复前 6 s 后仍为 1）。继续：新 track live，出现新识别结果。视频暂停：11 s 内 segmentsQueued 不变，pendingRequests 0。跳转到第 6 句前：epoch 递增，新位置出现识别字幕。停止：lease null，capture none，activeTracks 0，pendingRequests 0，lastEnded 的 track 全部 ended（或 offscreen 已关闭、OFFSCREEN 上下文为 0），getCapturedTabs 为 stopped，6 s 后分段数不变 |
| T32 积压（2×→4×）           | 通过（有界），**积压提示未触发**          | 本机 small 模型跟得上：40 s 内 asrBacklogMs 最大 4740 ms，在途请求最大 1，没有 asr-backlog notice。4× 后若干采样的 asr 状态为 idle（原因未分析；Chromium 在高倍速下可能不输出音频）。**积压提示与 30 s 上限丢弃在真实服务上未触发，仍只有单测覆盖**                                                                                                                                                                                                          |

识别服务日志中没有令牌或 Authorization 内容。

## 9. T21 / T22（识别捕获中）

| 用例                   | 结果             | 数据                                                                                                                                                                                                                                                                                         |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T21 捕获中终止 worker  | **通过（实测）** | CDP stopAllWorkers 后重开 UI：新 worker 与 offscreen 握手并**接管同一租约**（leaseId 前后相同），同一 sessionId 约 0.6 s 内恢复为 running/capture active。25 s 采样中 offscreen 捕获会话数始终 ≤1，getCapturedTabs 的 active 数始终 ≤1。恢复后识别继续产生结果，快照 1 个会话                |
| T22 offscreen 意外销毁 | **通过（实测）** | 经 CDP `/json/close` 关闭 offscreen 文档：111 ms 后会话 error=offscreen-lost；113 ms 内快照资源复位为 capture none、asr idle、activeTracks 0（缺陷 #5(a) 修复后）。getCapturedTabs 为 stopped，audioOwner 为 null，视频继续播放。重新开始后约 1.2 s 再次捕获（新 track live），没有永久 busy |

## 10. P5 配音（full-chain-dubbing.spec.ts，实测系统语音；T31 为 mock）

观察方式是在 worker 中给 `chrome.tts.speak/stop` 加只记录的透传（调用原实现、转发原 onEvent）；原声 ducking 通过 video.volume 采样。

| 用例                     | 结果                                       | 数据                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 朗读事件与同步           | **通过（实测）**                           | 自动选中 `Eddy (Chinese (China mainland))`，lang zh-CN。每句都有 start/end，快照出现 tts=speaking。每句只读一次，顺序递增。speak 调用时的媒体时间比字幕起点早 21–149 ms                                                                                                                                                                         |
| T17 ducking 与用户音量   | **通过（实测）**                           | 朗读中原声降到 0.3。用户改为 0.6 后立即读回 0.6；之后采样只出现 0.6 和 0.18（以新基准 duck），没有回到 1.0 或 0.3；停止会话后为 0.6                                                                                                                                                                                                             |
| T15/T16 暂停、跳转、停止 | **通过（实测）**                           | 视频暂停后 1 ms 调用 stop，4 s 内没有新朗读，isSpeaking 为 false。继续后只读当前句（媒体时间 1923 ms 读第 1 句）。跳转到 80 s：+3 ms interrupted，+857 ms 读第 21 句（81 s 开始，调用时媒体时间 80 773 ms）。停止：2 ms 内 stop，5 s 内没有朗读，音量恢复 1。**T15「TTS 完成回调晚于 seek」的精确竞态没有在系统语音上构造**，只有单测和 P0 覆盖 |
| T31 无声音降级           | 通过（**mock**：getVoices 过滤掉日语声音） | notice 为 tts-unavailable，文案「没有可用于「日本語」的配音声音，配音不可用，字幕仍可正常使用…」，tts=unavailable，没有任何 speak 调用，日语译文字幕正常显示。**本机 8 个目标语言都有真实声音，真实无声音场景无法复现**                                                                                                                         |

## 11. T35 导出（full-chain-export.spec.ts，通过，mock 翻译）

- 流程：字幕轨道 7 行，含 `<i>`、`&`、引号、`-->`、emoji、中文，以及 60 s 和 1 小时后的行 → session/backfill 全片补译 → 工作台左侧点选该视频的实时会话条目 → 按 cue id 收藏第 2、4 条 → 导出对话框 → 真实点击下载。
- 组合：SRT/VTT/TXT × 仅原文、仅译文、双语、仅收藏（双语），共 12 个文件，保存在 `test-results/export-downloads/`。
- 校验：
  - 自写严格解析器：编号从 1 连续；时间格式为 `HH:MM:SS,mmm` 或 `.mmm`，分秒 <60；块间恰好一个空行；文本行非空、不含 `-->`；无 \r，无 BOM，以换行结尾；VTT 首行 WEBVTT、NOTE 中不含 `-->`、`& < >` 已转义；TXT 条目为 `[HH:MM:SS]`。
  - **ffprobe 8.0.1**：SRT/VTT 各读出 1 条 subtitle 流，包数（全部 7 条 / 收藏 2 条）与起止时间逐条等于解析结果（含 01:00:00,500）。
  - **ffmpeg** 把 SRT 重新输出为 SRT 后，文本中包含每条期望文本。
  - 与会话 cues 逐条比对范围、顺序、时间与语言。
- 文件名：`Export Test Video 中文.en.srt`、`….zh-CN.vtt`、`….双语.zh-CN.txt`、`….收藏.双语.zh-CN.srt`。非法字符 `: < > " / ?` 已去除，标签和语言正确（原文导出为 en）。
- 产品行为记录：所有格式都把文本中的 `-->` 替换为 `→`。SRT 保留原始 `<i>` 标签（播放器可能按斜体渲染）。VTT NOTE 写入标题、内容和覆盖范围（「完整字幕轨道（视频时长 1 小时）。本次导出 7 条」）。
- **未覆盖**：带 BOM 的导出、「未完成翻译条目」标记路径（本次全部已译）、临时识别结果的导出、真实播放器加载导出文件。

## 12. 本轮发现的产品缺陷（均已发给主会话）

| #   | 严重性 | 描述                                                                                                             | 最终状态                                                                                                                                                                                                                        |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 中     | 侧栏/弹窗打开时新开 YouTube 标签页：页面加载前发出的唤醒落空后不再重试，页面一直不登记                           | 已修复，回归用例通过                                                                                                                                                                                                            |
| 2   | 中     | 播放器晚初始化时，轨道等待被 unknown 的 tracks 消息提前结束，约 2 s 就误判为无字幕（asr-not-configured）         | 修了三轮：①只在 availability 已知时结束等待 → 仍在超时时刻才拿到 tracks；②starting 期间每 1 s 轮询 → 12.5 s 仍有 8 ms 竞态；③500 ms 轮询 + 等待上限 14 s + captions-not-ready 文案。**已修复**，11、12.5、14、16 s 四条用例通过 |
| 3   | 高     | 识别模式连续播放时覆盖层始终空白（译文到达时句子时段已过）                                                       | 已修复（识别来源改为延迟显示），T03 实时显示断言通过，字幕轨道来源回归通过                                                                                                                                                      |
| 4   | —      | 「跳转后重读旧句」                                                                                               | **测试归因错误，已修正用例**（字幕文本重复导致误归因；文本改为唯一，重复时抛错），不是产品缺陷                                                                                                                                  |
| 5   | 低     | 快照资源字段失真：(a) offscreen-lost 后仍显示 capture active、asr running；(b) activeTracks 不跟随真实 live 音轨 | 已修复：(a) T22 断言通过；(b) 运行中为 1，暂停释放捕获后为 0（修了两轮，第一轮暂停后未复位），生命周期断言通过                                                                                                                  |

另外，P0 实验用例 `audio-p0.spec.ts` 的云端配音「play 后立即 stop」检查按新的回复时序修改了测试：`tts/play` 在音频取回并开始播放后才回复，所以改为同一次 worker 调用中发出 play 后立即 stop。这不是产品缺陷。

## 13. 仍未覆盖或未实测

- 真实 YouTube 页面结构、播放器行为（本轮夹具行为均为推断），以及真实 sub2api（文本、语音识别与合成）。
- 真实用户手势下的 tabCapture（本轮用 allowlist 替代）；品牌 Chrome 的声音列表与远端声音；耳听质量与 ducking 听感。
- T32 积压提示与 30 s 上限丢弃（本机 small 模型跟得上 2×/4×，没有触发）；20 分钟以上连续识别，30 分钟字幕加配音。
- T15 迟到 TTS 回调的精确竞态（系统语音上未构造）；T31 真实无声音语言；sub2api 云端配音。
- 旧 youtube-content spec 中的「过期 session/cues 注入」和「stale-video 请求」（真实协调器下无法注入，只有单测）。
- T35：BOM、未译标记、临时识别结果导出、用真实播放器加载导出文件。
- 非英语语音识别（本轮只有英文合成语音）；广告、倍速对识别时间映射的影响。

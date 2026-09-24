# P0 音频能力实验记录

记录日期：2026-09-16
范围：EXECUTION_PLAN §5.3、§8.1、§8.3–§8.5 的浏览器侧音频能力（offscreen、tabCapture、AudioWorklet、分段/WAV、时间映射、chrome.tts、清理）。
结论只适用于下表环境。**真实 YouTube、真实用户手势、耳听效果、真实识别/合成服务均未在本次实验中验证。**

## 1. 环境

| 项目        | 值                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------- |
| 系统        | macOS 15.5（24F74），Apple M4 Pro                                                                  |
| 浏览器      | Playwright 1.63 自带 Chromium 153.0.8010.12，new headless 模式（UA 为 `HeadlessChrome/153.0.0.0`） |
| 品牌 Chrome | 本机为 Chrome 152，但不能 `--load-extension`，**未参与本次实验**                                   |
| Node / pnpm | 24.15.0 / 10.33                                                                                    |
| 工具        | `/usr/bin/say`（Samantha 英文语音）、`/opt/homebrew/bin/ffmpeg`、`ffprobe`                         |
| 外部服务    | 无。页面、识别服务、语音合成均为 `127.0.0.1` 上的本地替身，不访问 YouTube、不调用付费服务          |

## 2. 复现方式

```sh
export PATH=$HOME/.volta/tools/image/node/24.15.0/bin:$PATH
TONGTING_P0_AUDIO=1 pnpm exec playwright test tests/e2e/audio-p0.spec.ts
# 证据 JSON：test-results/audio-p0-evidence.json（可用 P0_EVIDENCE_FILE 指定路径）
```

- 会短暂发声（系统语音朗读一句中文、测试页低音量播放语音），因此默认跳过，必须显式设置 `TONGTING_P0_AUDIO=1`。
- 实验扩展由 `tests/e2e/fixtures/audio/harness/build.ts` 用 WXT 构建 API 在临时目录生成：
  - offscreen 入口直接引用产品 `entrypoints/offscreen/main.ts`（同一 AudioWorklet、同一 bootstrap/host/capture/TTS 代码）；
  - worker 为 `tests/e2e/fixtures/audio/harness/worker.ts`，调用产品的 `createOffscreenClient()` 与 `createSystemTtsEngine()`，不包含会话协调器；
  - manifest 权限：`tabCapture`、`offscreen`、`tts`，并模拟用户已授予 `http://127.0.0.1/*` 主机权限（产品中为可选主机权限）。
- 测试音频：8 句 `say` 英文短句，句间插入 1200 ms 静音，44.1 kHz 立体声，总长 35.5 s；静音区间的媒体时间已知，用于核对时间映射。
- 本地识别替身遵循 `src/providers/asr/types.ts` 契约，并与真实本地服务一致：**不返回 CORS 头**，除 `/health` 外（含 OPTIONS）都要求令牌。

两个用例均通过（最近一次：`2 passed (46.1s)`，前一次同样通过，数值见下）。

## 3. 逐项结果

| 编号 | 项目                                                  | 结果                                         | 说明                                                 |
| ---- | ----------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------- |
| a    | offscreen 创建 / 并发去重 / 关闭                      | 通过（自动化）                               | 见 3.1                                               |
| b1   | 无手势调用 `tabCapture.getMediaStreamId`              | 通过（得到预期报错）                         | 见 3.2                                               |
| b2   | `--allowlisted-extension-id` 自动化替代               | 通过（仅自动化替代）                         | 真实用户手势链路 **待人工验收**                      |
| c1   | offscreen 中 `getUserMedia(chromeMediaSource: 'tab')` | 通过                                         | 实际 sampleRate 48000，启动约 53–77 ms               |
| c2   | AudioWorklet 在扩展 CSP 下加载                        | 通过                                         | `/assets/pcm-tap.worklet-*.js`，同源文件，未用 blob: |
| c3   | 捕获到非静音 PCM                                      | 通过（需去掉 `--mute-audio`）                | 见 3.3 的重要发现                                    |
| c4   | 原声回放路径                                          | 部分：代码路径已建立、AudioContext running   | 听感 **待人工验收**                                  |
| d    | 16 kHz 单声道 PCM16 WAV 独立可解码                    | 通过                                         | ffprobe 逐个校验                                     |
| —    | 时间映射（捕获 → 媒体时间）                           | 通过；旧时钟 +36～+41 ms，新时钟 +33～+81 ms | 见 3.4 与第 7 节（2026-09-17 重测）                  |
| e    | `chrome.tts.getVoices` 与 speak 事件                  | 通过（Playwright Chromium）                  | 品牌 Chrome 声音列表 **未验证**                      |
| f    | 停止后 tracks / AudioContext / 在途请求               | 通过                                         | 见 3.6                                               |
| 附加 | 租约不续期自行停止（T21 的一部分）                    | 通过                                         | TTL 5 s，5.9 s 后 `capture/ended(lease-expired)`     |
| 附加 | offscreen 云端配音播放路径（本地替身）                | 通过                                         | start/end 事件；stop 后迟到合成结果不发声            |

### 3.1 offscreen 文档（a）

- 创建前 `runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` = 0。
- 同时发起 3 次 `client.ensure()`：返回同一个 `offscreenInstanceId`，`getContexts` = 1，hello 只收到 1 次。
- 文档已存在时直接调用 `chrome.offscreen.createDocument` 两次，实际报错均为：
  `Only a single offscreen document may be created.`（客户端据此视为「已存在」）。
- `closeIfIdle()` 在无租约、无捕获、无播放时返回 `true`，之后 `getContexts` = 0；再次 `ensure()` 创建了新实例（instanceId 不同），再次 `closeIfIdle()` 为 `true`。
- 创建参数：`reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK']`，`url: '/offscreen.html'`（实测可用）。

### 3.2 tabCapture 手势（b）

- 未经用户调用扩展、未加 allowlist 时，从 worker 调用 `chrome.tabCapture.getMediaStreamId({ targetTabId })` 的实际报错：
  `Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.`
- 以 `--allowlisted-extension-id=<扩展ID>` 重新启动后同一调用成功。扩展 ID 由解包目录路径决定，实验把构建目录固定在 `os.tmpdir()/tongting-audio-p0-harness`，先启动一次读取 ID，再带参数启动。
- **这只是自动化替代手段。** 真实链路「工具栏 popup / 侧栏点击 → worker 调用 getMediaStreamId → offscreen 消费」是否被 Chrome 接受、关闭 popup 后是否继续，需要在品牌 Chrome 中人工验收（见第 5 节）。
- stream ID 为一次性凭据：第二次捕获重新调用了 `getMediaStreamId`。

### 3.3 捕获、AudioWorklet 与 PCM（c）

- 第一次运行（Playwright 默认参数）：getUserMedia 成功、worklet 正常回调（1094 个块），但**所有块均为数字静音（-120 dBFS）**，分段全部被判为静音、未发送识别。
  原因：Playwright 在 headless 模式默认追加 `--mute-audio`。去掉该默认参数（`ignoreDefaultArgs: ['--mute-audio']`）后恢复正常。
  推论（未验证）：浏览器级静音会让 tabCapture 拿到静音 PCM；用户在 YouTube 播放器内静音（`video.muted`）时同样不会有可识别音频。标签页右键「静音网站/标签页」时捕获是否有声 **待人工验收**。
- 去掉后：offscreen 诊断 `chunks=364`，`maxChunkDbfs≈-18.7`，`clockSource='output-timestamp'`，`sampleRate=48000`，5 个分段全部送识别、0 个静音丢弃。
- 原声回放：处理图为 `MediaStreamSource → 原声 GainNode → destination`，识别分支在增益之前取 PCM（单测验证连接关系）。实验中 `audio/original-gain`（gain 0、ramp 200 ms）请求成功，原声增益设为 0 以免自动化发声；识别分支不受影响（RMS 仍为 -23～-26 dBFS）。
  **能验证的程度**：AudioContext `running`、原声增益节点存在并可调节；**不能验证**：扬声器实际听到原声、捕获后标签页本地输出是否被静音、延迟感受。

### 3.4 分段、WAV 与时间映射（c/d）

参数：`segmentMs=3000`（默认 5000，实验用 3000 以加快出段），最短 1800 ms、最长 4200 ms，强制切分重叠 300 ms，静音门限自适应（绝对下限 -45 dBFS）。

最近一次上传到识别替身的分段（ffprobe）：

| #   | 时长 (ms) | RMS (dBFS) | codec / 采样率 / 声道 |
| --- | --------- | ---------- | --------------------- |
| 0   | 3150      | -23.1      | pcm_s16le / 16000 / 1 |
| 1   | 3885      | -24.1      | pcm_s16le / 16000 / 1 |
| 2   | 1800      | -24.9      | pcm_s16le / 16000 / 1 |
| 3   | 3495      | -24.2      | pcm_s16le / 16000 / 1 |
| 4   | 1800      | -26.0      | pcm_s16le / 16000 / 1 |

- 每个文件都可被 ffprobe 独立解析，时长与头部一致；分段由 `encodeWavPcm16` 独立编码，不依赖 MediaRecorder chunk。
- 识别请求实际头部：`Origin: chrome-extension://<id>`、`Sec-Fetch-Site: none`；替身不返回 CORS 头，请求仍成功——依赖主机权限（未授权时的失败行为未在实机验证，单测覆盖为网络错误）。
- 时间映射：锚点由测试页 `performance.timeOrigin + performance.now()` 与 `audio.currentTime` 每 500 ms 生成一次（模拟内容脚本 → 协调器 → `timeline/anchor`）。
  - 在静音处切开的分段，映射后的起点均落在已知静音区间内（例如 3542 ms ∈ [3464, 4664]，8932 ms ∈ [8411, 9611]）。
  - 精确误差：预测起音 = 映射起点 + 段内首个有声帧偏移；实际起音 = 静音区间结束。
    两次运行分别为 **+36/+39 ms** 与 **+38/+41 ms**（预测略晚于实际）。
    该值包含起音检测的 20 ms 帧量化与门限差（-40 dBFS 检测 vs 生成时 -50 dB 去静音），以及未补偿的标签页→offscreen 捕获传输延迟；当前实现只补偿 `baseLatency + outputLatency`。
  - 仅验证了 1× 正常播放、48 kHz 输出设备。**倍速（0.75/1.5/2）、暂停、跳转、广告在真实浏览器中的映射未验证**，目前只有单测覆盖（`tests/unit/audio/timeline.test.ts`、`capture-session.test.ts`）。
- 识别状态实测（替身固定延迟 300 ms）：`lastLatencyMs≈304`，`realtimeFactor≈0.10～0.13`，`backlogMs=0`。这是替身数值，不代表本地 faster-whisper 或 sub2api 的性能。

### 3.5 chrome.tts（e）

- `getVoices()`：共 191 个声音，**remote 全部为 false**。中文相关：
  - zh-CN：Eddy、Flo、Grandma、Grandpa、Li-Mu、Reed、Rocko、Sandy、Shelley、Tingting、Yu-shu（Eddy 等为 `xxx (Chinese (China mainland))` 名称）
  - zh-TW：Eddy/Flo/Grandma/Grandpa/Reed/Rocko/Sandy/Shelley（Taiwan）、Meijia
  - zh-HK：Sinji（粤语，控制器不会为 zh-CN 选择它）
- 在 worker 中用 Tingting（zh-CN）朗读「译听配音测试，一二三。」（volume 0.2）：`start` 约 +14～26 ms，`end` 约 +2847 ms。
- speak 后同步调用 `stop()`：3 秒内旧 listener 未收到任何事件（令牌屏蔽生效，T15 实机证据）。
- 限制：这是 Playwright Chromium 在 macOS 上的系统语音；品牌 Chrome 可能额外提供 Google 远端声音（remote=true），其可用性、网络依赖与事件行为 **未验证**。耳听质量 **待人工验收**。

### 3.6 停止与释放（f）

- 停止前识别替身在途请求 0；`capture/stop` 回复 `{ stopped: true, activeTracks: 0 }`。
- 停止后状态：`lease: null`、`capture: 'none'`、`activeTracks: 0`、`pendingRequests: 0`。
- offscreen 内记录的最近结束会话（释放后读取）：`audioContextState: 'closed'`、`activeTracks: 0`、`pendingRequests: 0`。
- **说明（审查后修正）**：实验当时的 `activeTracks` 在释放后因为丢弃了 track 引用而恒为 0，**不能单独作为释放证据**；
  本节的释放结论主要依据「AudioContext closed」与「停止后 6 秒无新上传、在途请求 0」。
  现已改为保留 track 引用并报告真实 `readyState === 'live'` 的数量，e2e 也改为经 CDP 读取 `trackReadyStates` 全部为 `ended`；
  **修改后的 e2e 尚未重新运行**（本轮约束不做发声/捕获实机实验）。
- 停止后再等 6 秒：识别替身收到的分段数不变（5 → 5）、在途请求 0，确认没有持续录音或请求。
- 收到 `capture/ended(reason: 'stopped')` 事件。
- 最后 `closeIfIdle()` 为 `true`，`getContexts` = 0。

### 3.7 附加

- **租约到期**：`leaseTtlMs=5000` 且不续租，5.9 s 后收到 `capture/ended(lease-expired)`，最近结束会话 `audioContextState: 'closed'`（当时的 `activeTracks 0` 同上，不能单独作为释放证据）。worker 重启后的握手宽限（新 worker 必须在 10 s 内续租）只有单测覆盖。
- **云端配音播放路径**（本地替身返回 0.8 s WAV）：`tts/play` → `start`，约 770 ms 后 `end`；第二句 `tts/play` 后立即 `tts/stop` → 只收到 `interrupted`，替身延迟 500 ms 返回的音频没有播放、没有 `start`。offscreen 在无用户手势的情况下可以播放（`AUDIO_PLAYBACK`）。真实 sub2api `/v1/audio/speech` **未验证**。

## 4. 实现选择与参数（据本次实验）

| 项目         | 决定                                                                     | 依据                                                 |
| ------------ | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| PCM 获取     | AudioWorklet（numberOfOutputs=0，块 2048 帧），worklet 内下混            | 实测可加载、可持续回调                               |
| worklet 打包 | Vite `?worker&url` → `/assets/pcm-tap.worklet-*.js`                      | 扩展 CSP 只允许同源脚本                              |
| 重采样       | 流式 Kaiser 窗 sinc（16 过零点、截止 0.9×输出奈奎斯特）                  | 单测：12 kHz 混叠抑制 < -50 dB；实测 48 kHz → 16 kHz |
| 时钟         | `getOutputTimestamp` + `timeOrigin`，减 `baseLatency + outputLatency`    | 实测来源为 output-timestamp，误差约 +40 ms           |
| 分段默认     | segmentMs 5000（最短 60%、最长 140%），静音中点切分，强制切分重叠 300 ms | 实验使用 3000 验证；真实识别服务上的最佳值待测       |
| 积压上限     | 30 s 音频，超出丢最旧并上报 droppedMs                                    | 单测                                                 |

## 5. 待人工验收（不能写成已通过）

1. 品牌 Chrome 中真实用户手势链路：工具栏 popup 或侧栏按钮点击 → worker `getMediaStreamId` → offscreen 捕获是否成功；侧栏点击是否被视为 activeTab 调用。
2. 关闭 popup / 侧栏后捕获与识别是否继续。
3. 捕获期间原声是否能听到、延迟与音量是否正常；配音 ducking 听感。
4. 真实 YouTube 页面（含广告、暂停、跳转、倍速、换视频）下的时间映射与字幕对齐。
5. 用户对标签页静音、或在 YouTube 播放器内静音时的捕获行为与提示。
6. 品牌 Chrome 的 `chrome.tts` 声音列表（含 Google 远端声音）与中文朗读听感。
7. 真实本地识别服务（faster-whisper）与 sub2api 识别/合成接口的端到端链路；未授予 `http://127.0.0.1/*` 主机权限时的实际报错。
8. 长时间运行（≥20 分钟）的资源与积压是否有界；worker 被浏览器真实挂起/重启后的握手恢复。
9. 44.1 kHz 等非 48 kHz 输出设备上的实机表现（单测覆盖 22.05/32/44.1/48 kHz）。

## 6. 审查后变更（未重新实机验证）

- 时钟：跨文档时间一律用 `Date.now()` 基准（`domain/clock.ts`），offscreen 用 `perfToEpochMs` 现测偏移换算输出时间戳，
  偏移突变（睡眠、设备切换）直接重置，并监听 AudioContext `statechange`。P0 的 +40 ms 误差数据来自旧实现（timeOrigin 基准），**已于 2026-09-17 重测，见第 7 节**。
- 本地识别地址只允许 `http://127.0.0.1:<port>`，不再接受 localhost。
- 识别「是否有声」改为相对门限；有信号但持续判为无语音时上报 `asr-input-quiet` 并在 `asr/status.quietInputMs` 计数。
- **不区分音乐与人声（未实现）**：背景音乐会被当作有声内容送识别，可能产生无意义文本，仅依赖识别端 noSpeechProb 过滤。

## 7. 时钟改为 Date.now() 基准后的重测（2026-09-17）

环境与第 1 节相同（Playwright Chromium 153.0.8010.12，macOS 15.5，M4 Pro，48 kHz 输出）。测试音频、参数与误差计算方法和 3.4 相同：预测起音减去实际起音，正数表示预测偏晚。命令：`TONGTING_P0_AUDIO=1 pnpm exec playwright test tests/e2e/audio-p0.spec.ts`。

| 运行 | 两个静音切分段的误差 (ms) | 用例结果                               |
| ---- | ------------------------- | -------------------------------------- |
| 1    | +36 / +42                 | 2 通过                                 |
| 2    | +76 / +81                 | 时间映射通过；云端配音检查失败（见下） |
| 3    | +33 / +38                 | 同上                                   |
| 4    | +76 / +71                 | 同上                                   |
| 5    | +59 / +66                 | 2 通过（测试修正后）                   |
| 6    | +33 / +37                 | 2 通过                                 |

之后在 e2e-agent 的全量运行中又通过 1 次（证据文件被后续运行清空，数值未保留）。

- **新旧差别**：
  - 旧实现（performance.timeOrigin 基准）两次运行都在 +36～+41 ms，比较集中。
  - 新实现（Date.now() 基准加现测偏移）6 次运行在 +33～+81 ms，中位约 +50 ms，出现两档：约 +35 ms 和约 +75 ms。
  - 同一次运行内，两段的误差相差 ≤7 ms，说明差异来自每次运行的偏移估计或捕获启动延迟，而不是段内漂移。
  - 原因未定位，推测与 `Date.now()` 毫秒精度，以及 `perfToEpochMs` 偏移在捕获启动时的取样有关。误差仍包含起音检测的 20 ms 帧量化与未补偿的捕获传输延迟。
- 在字幕与配音对齐场景下，约 80 ms 以内的偏晚通常不影响可读性，但**比旧实现离散**。如需收紧，应在 offscreen 中多次取样偏移并取中位数，并再次实测。本次没有修改产品代码。
- 其他检查项（offscreen 去重/关闭、无手势报错、tts 事件、16 kHz WAV、停止释放、租约到期）在 6 次运行中都通过。
- 云端配音检查（3.7 附加）：运行 2–4 失败，原因是 **`tts/play` 现在在合成音频取回并开始播放后才回复**，测试等回复后才发 stop，所以先收到 start 再收到 interrupted。这不是「迟到音频在 stop 后发声」。测试已改为在同一次 worker 调用中发出 play 后立即 stop（不等回复），运行 5、6 只收到 `interrupted`，没有 start，替身延迟 500 ms 返回的音频没有播放。**这是测试时序修正，不是产品缺陷。**

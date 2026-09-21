# 同听 Tongting

在 YouTube 网页上观看视频时，为视频生成目标语言（默认简体中文）的翻译字幕，并可选择播放翻译配音的 Chrome MV3 扩展。文本翻译使用你自己配置的 [sub2api](https://github.com/Wei-Shaw/sub2api) 服务；没有可读字幕的视频需要另行配置语音识别服务（例如本项目附带的本地识别服务）。

## 当前状态

**真实 sub2api 的 Luna 翻译、流式返回，以及本地测试视频的识别／中文配音链路已通过；真实 YouTube 长时间观看仍未验收。** 最新范围与证据见 [真实服务测试记录](docs/reviews/2026-09-17/LIVE_TEST.md)。默认翻译模型为 `gpt-5.6-luna`，模型列表只展示服务实际提供的 GPT-5.6 及以上文本型号。

新增默认「同步优先」：先准备 10 秒译文，再随视频播放；译文不足或跳转后会重新缓冲。可选 5 / 10 / 20 秒或切换「连续播放」。无完整字幕的公开录播通过本地服务预读后续音轨，需要安装并启用 [YouTube 预读](services/asr-local/README.md)。缓冲就绪表示译文已准备好，系统语音按视频时间朗读，不代表音频已预合成或零延迟。验证范围见 [缓冲播放记录](docs/reviews/2026-09-17/BUFFERED_PLAYBACK.md)。

- **已接入的链路**：service worker 协调器、YouTube 内容脚本（字幕轨道 / 当前显示字幕 / 无字幕时捕获音频识别）、sub2api 文本翻译适配器、系统语音与 sub2api 语音合成配音、offscreen 音频捕获与识别分段、本地识别服务、侧栏 / 弹窗 / 设置页 / 字幕工作台。构建出的扩展可以完成端到端流程。
- **验证方式**：
  - 单元与集成测试使用模拟的 sub2api、播放器与音频资源。
  - 常规 Playwright E2E 使用本地 YouTube 夹具与模拟 sub2api；显式启用的真实服务测试使用用户服务、真实 Chromium 扩展、本地识别及系统中文配音。
  - 结果与覆盖范围见 [docs/VALIDATION.md](docs/VALIDATION.md)。
- **尚未实测**：
  - 代理开启后可访问真实 YouTube；隔离浏览器中两个公开视频约 40～50 秒后报播放错误，无扩展对照也出现。原生字幕请求返回空正文，20 分钟连续观看尚未通过。
  - 云端语音识别、云端语音合成仍未验证；本轮使用本地 Whisper 和系统中文声音。
  - 以下需要人工完成：工具栏点击授权捕获、真人试听配音效果、20/30 分钟连续运行。
- 各项能力的实测状态见 [docs/CAPABILITIES.md](docs/CAPABILITIES.md)，进度与阻塞见 [docs/PROGRESS.md](docs/PROGRESS.md)。
- 2026-09-17 复查发现的 17 项问题及本次修复、回归测试、A 侧栏 UI 对照见 [修复验收记录](docs/reviews/2026-09-17/FIXES.md)。

本项目不承诺「任何语言」「任何视频」或「零延迟」。支持范围以实测记录为准。

## 功能范围

计划交付（每一项都需要实测后才算完成）：

- 有字幕视频：读取播放器提供的字幕，经 sub2api 文本模型翻译后覆盖显示在原播放器上，支持双语、字号、位置、背景透明度与时间微调。
- 无字幕视频：同步优先模式由本地服务分段预读公开录播音轨、识别并翻译；连续播放模式捕获当前标签页音频，边播放边识别。
- 翻译配音：系统语音（或经实测可用的 sub2api 语音合成），默认全程静音原声，中文停顿时也不恢复；可调声音、语速、配音音量，也可手动选择保留原声。
- 目标语言切换、暂停/继续翻译、停止并释放音频、跳转、换视频、倍速下的正确同步与清理。
- 字幕记录与工作台：搜索、收藏、带时间的笔记、复制，导出 SRT / VTT / TXT，并如实显示覆盖范围。
- 中文找视频：侧栏「搜索」输入中文，AI 生成 3 组英文搜索词与中文注释，支持编辑、复制、新标签页搜索和本机最近记录。复用当前翻译服务和模型，默认 `gpt-5.6-luna`。见 [使用说明](docs/USER_GUIDE.md#11-用中文搜索-youtube) 与 [验证记录](docs/reviews/2026-09-17/AI_SEARCH.md)。
- 设置与连接检查：Base URL、API Key（默认保存在本机，扩展重载和浏览器重启后仍保留）、按单一 origin 授权、协议自动检测、模型发现与手动模型 ID、分项连接检查。
- 演示模式：用示例数据预览界面，有持续可见的标识，不连接视频与服务。

界面默认采用「A 轻巧侧栏」布局（Chrome 原生侧栏 + 工具栏弹窗 + 设置页 + 字幕工作台页）。B 沉浸观影、C 字幕工作台作为可选布局，用户尚未选择。

### 明确不做（本轮）

- 手机、Safari、Firefox 版本。
- 音色克隆、唇形同步、视频重编码、视频下载器。
- 任意网站的通用音频捕获、多人会议、账号系统、支付平台、团队后台。
- 改写或绕过 DRM、付费墙、登录限制及其他内容访问控制。
- 发布到扩展商店、部署公共服务器、自动购买服务。
- 画面内烧录文字的 OCR。

直播、Shorts、画中画不在首批验收范围内，未验证前不宣称支持。

## 环境要求

| 项目                | 版本                         | 说明                                                                   |
| ------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| Node                | 24.15.0                      | 见 `.nvmrc` 与 `package.json` 的 `volta` 字段；WXT 0.21 要求 Node ≥ 22 |
| pnpm                | 10.33.0                      | `packageManager` 字段                                                  |
| Chrome              | ≥ 116（桌面版）              | manifest `minimum_chrome_version`；日常人工验收计划使用 Chrome 152     |
| Playwright Chromium | 随 `@playwright/test` 1.63.0 | 仅扩展 E2E 使用；品牌版 Chrome 137+ 不支持命令行加载扩展               |
| Python + uv（可选） | Python 3.12–3.13             | 仅本地识别服务需要，见 [docs/ASR_LOCAL.md](docs/ASR_LOCAL.md)          |

本机若默认 Node 版本较低（例如 nvm 的 Node 20），在运行命令前先切换到 Volta 安装的 Node 24：

```sh
export PATH=$HOME/.volta/tools/image/node/24.15.0/bin:$PATH
node -v   # 应输出 v24.15.0
```

详细环境记录见 [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)。

## 快速开始

```sh
pnpm install     # 会自动执行 wxt prepare
pnpm build       # 输出到 .output/chrome-mv3
```

然后在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点击「加载已解压的扩展程序」并选择 `.output/chrome-mv3`。配置与使用步骤见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 脚本

| 命令                    | 作用                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`              | 启动 WXT 开发构建（输出到 `.output/chrome-mv3-dev`）。已关闭自动打开浏览器，需要手动加载该目录                                                                                                                                                                                                                                                         |
| `pnpm build`            | 生产构建，输出到 `.output/chrome-mv3`                                                                                                                                                                                                                                                                                                                  |
| `pnpm zip`              | 打包构建结果为 zip（输出到 `.output/`），仅用于本地分发，不发布商店                                                                                                                                                                                                                                                                                    |
| `pnpm format`           | Prettier 格式化全部文件                                                                                                                                                                                                                                                                                                                                |
| `pnpm format:check`     | Prettier 格式检查                                                                                                                                                                                                                                                                                                                                      |
| `pnpm lint`             | ESLint                                                                                                                                                                                                                                                                                                                                                 |
| `pnpm typecheck`        | `wxt prepare` 后执行 `tsc --noEmit`（严格模式）                                                                                                                                                                                                                                                                                                        |
| `pnpm test`             | Vitest 单元测试（`tests/unit`），运行一次后退出                                                                                                                                                                                                                                                                                                        |
| `pnpm test:integration` | Vitest 集成测试（`tests/integration`），使用模拟 sub2api、模拟播放器与音频资源                                                                                                                                                                                                                                                                         |
| `pnpm test:e2e`         | Playwright 扩展 E2E（`tests/e2e`）。需先 `pnpm build` 与 `TONGTING_E2E=1 pnpm exec wxt build`；首次运行可能需要 `pnpm exec playwright install chromium`。真实本地识别、系统语音配音、P0 音频实验用例默认跳过（会发声），分别用 `TONGTING_E2E_ASR=1`、`TONGTING_E2E_TTS=1`、`TONGTING_P0_AUDIO=1` 开启，见 [docs/VALIDATION.md](docs/VALIDATION.md) 3.1 |
| `pnpm smoke:sub2api`    | 真实 sub2api 冒烟测试（`tests/smoke/**/*.smoke.ts`）。会产生真实调用与可能的费用，只在显式需要时运行                                                                                                                                                                                                                                                   |

`smoke:sub2api` 的凭证配置：复制 `.env.example` 为 `.env.local`（已被 `.gitignore` 忽略），填写 `SUB2API_BASE_URL` 与 `SUB2API_API_KEY=<你的 Key>`。不要把 Key 写进命令行参数、源码、文档或会被分享的文件。

默认只测文本接口（模型列表、Responses / Chat、流式）。如需测语音合成与识别，另外在 `.env.local` 中设置 `SUB2API_TTS_MODEL` / `SUB2API_TTS_VOICE` / `SUB2API_ASR_MODEL`，这两项会产生计费调用。

本地识别服务有独立的 Python 环境、测试与启动方式，不能通过 `pnpm install` 安装，见 [docs/ASR_LOCAL.md](docs/ASR_LOCAL.md)。

## 目录结构

```text
entrypoints/                    WXT 入口（薄封装，实现放在 src/）
  background.ts                 service worker 入口（调用 src/background/wiring.ts 装配协调器）
  youtube.content/              YouTube 主内容脚本（ISOLATED world）：播放器、字幕、覆盖层
  youtube-bridge.content.ts     YouTube MAIN world 桥：只读必要的播放器元数据，数据一律视为不可信
  popup/                        工具栏弹窗
  sidepanel/                    A 轻巧侧栏（翻译 / 字幕 / 设置）
  options/                      设置页（新标签页打开）
  workspace/                    字幕工作台页
  offscreen/                    offscreen 文档：标签页音频捕获、识别分段、合成音频播放
src/
  domain/                       领域类型与 schema：设置、会话、字幕 cue、能力状态、错误、语言
  messaging/                    跨上下文协议：UI、内容脚本、offscreen 消息 schema 与端口
  background/                   会话协调器、会话生命周期、设置/凭证存储、依赖装配
  youtube/                      PlayerAdapter、导航、字幕来源、MAIN 桥客户端、字幕覆盖层、原声 ducking
  captions/                     字幕解析（json3 / srv3 / vtt）、规范化、合句、增量与 ASR 字幕组装
  translation/                  翻译调度器、重试策略
  providers/text/               sub2api 文本适配器：Base URL、Responses / Chat、SSE、校验、连接检查
  providers/asr/                语音识别契约与客户端（本地服务、sub2api）
  providers/tts/                系统语音、sub2api 语音合成、配音控制器
  audio/                        PCM、重采样、分段、识别队列、媒体时间轴、资源清理、offscreen 客户端
  storage/                      IndexedDB：字幕记录、收藏、笔记、翻译缓存
  export/                       SRT / VTT / TXT 生成、覆盖范围说明、下载
  ui/                           共享组件、主题、状态客户端、各页面、字幕视图、演示数据
tests/
  unit/                         单元测试
  integration/                  集成测试（模拟 sub2api 服务、协调器 harness）
  e2e/                          Playwright 扩展 E2E（YouTube 路由到本地夹具页面）
  smoke/                        真实 sub2api 冒烟测试（显式运行）
  fixtures/                     人工构造的字幕与 sub2api 响应夹具
  helpers/                      模拟 sub2api 服务等测试工具
services/asr-local/             本地语音识别补充服务（Python + FastAPI + faster-whisper，仅监听 127.0.0.1）
public/icon/                    扩展图标
docs/                           文档（见下方索引）
```

## 开发约定

- **契约优先**：跨模块、跨进程的类型与 schema 集中在 `src/domain/`、`src/messaging/` 与各 `src/providers/*/types.ts`。本地识别服务的 HTTP 契约写在 `src/providers/asr/types.ts`，扩展与 `services/asr-local` 必须保持一致。修改契约时同步更新双方与测试。
- **运行时校验**：消息、存储读出的数据、模型与服务返回都经过 zod 校验；MAIN world 与页面数据一律视为不可信。
- **Service worker 是业务状态的权威来源**：UI 只发命令、只接受更新版本的快照，不各自持有翻译客户端或 Key。
- **真实模式不造假**：能力状态只来自实际调用；失败不自动切换为演示数据；没有数据时显示「未知 / 未检测」。
- **秘密不外泄**：API Key 与本地识别配对令牌不进入快照广播、内容脚本、DOM、URL、日志、错误信息、导出设置、测试夹具或文档。
- **显式导入**：WXT 配置为 `imports: false`，路径别名 `@src` 指向 `src/`；TypeScript 严格模式。
- **测试分层**：纯逻辑写单元测试；需要副作用计数（请求、tracks、队列、释放）的用集成测试；扩展加载与页面往返用 E2E；工具栏手势、真实音频、系统声音、真实 YouTube 与 sub2api 只能人工或冒烟测试覆盖，并在 [docs/VALIDATION.md](docs/VALIDATION.md) 如实记录。不以删除断言、跳过测试或吞掉异常换取通过。
- **Git 暂存区由用户控制**：协作者（包括自动化工具）不执行 `git add` / `git stage` / `git commit -a` 或任何改变索引的操作，不自动提交；所有修改留在工作区，由用户自行 review 与暂存。

## 文档索引

| 文档                                                 | 内容                                                |
| ---------------------------------------------------- | --------------------------------------------------- |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md)             | 安装、配置 sub2api、使用、隐私、故障排查与已知限制  |
| [docs/ASR_LOCAL.md](docs/ASR_LOCAL.md)               | 本地识别服务的安装、启动/停止、模型下载、性能与排障 |
| [docs/VALIDATION.md](docs/VALIDATION.md)             | 自动化测试结果、T01–T40 验收矩阵与真实链路实测记录  |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md)         | 服务、浏览器、YouTube 能力矩阵与权限说明            |
| [docs/PROGRESS.md](docs/PROGRESS.md)                 | 阶段进度、阻塞项与技术决策                          |
| [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)           | 开发与验证环境、网络限制                            |
| [EXECUTION_PLAN.md](EXECUTION_PLAN.md)               | 执行计划、产品规格与完整验收矩阵                    |
| [docs/reference/README.md](docs/reference/README.md) | UI 原型参考说明（原型不是可交付的扩展）             |

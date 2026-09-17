# 开发与验证环境

记录日期：2026-09-16。以下为本次实施实际使用并锁定的环境。

## 本机

| 项目               | 值                                                                     |
| ------------------ | ---------------------------------------------------------------------- |
| 操作系统           | macOS 15.5（24F74），arm64                                             |
| CPU / 内存         | Apple M4 Pro / 24 GB                                                   |
| Chrome（日常使用） | Google Chrome 152.0.7977.84                                            |
| 自动化浏览器       | Playwright 1.63.0 自带 Chromium（chromium-1243）                       |
| Python             | 系统 3.10.0；本地识别服务由 uv 管理独立版本（见 docs/ASR_LOCAL.md）    |
| 其他               | uv（~/.local/bin/uv）、ffmpeg（/opt/homebrew/bin/ffmpeg）、macOS `say` |

## Node 工具链（已锁定）

| 项目       | 版本    | 说明                                                                                        |
| ---------- | ------- | ------------------------------------------------------------------------------------------- |
| Node       | 24.15.0 | `.nvmrc` 与 package.json `volta` 字段；WXT 0.21 要求 Node ≥ 22，本机默认 nvm Node 20 不满足 |
| pnpm       | 10.33.0 | `packageManager` 字段                                                                       |
| WXT        | 0.21.4  | 构建 MV3 扩展，`imports: false`（显式导入）                                                 |
| React      | 19.3.0  |                                                                                             |
| TypeScript | 6.0.3   | typescript-eslint 8.70 要求 < 6.1，未使用 TS 7                                              |
| zod        | 4.6.5   | 消息与模型返回的运行时校验                                                                  |
| Vitest     | 5.0.1   | unit / integration / smoke 三个项目                                                         |
| Playwright | 1.63.0  | 扩展 E2E                                                                                    |

在本机运行命令前：

```sh
export PATH=$HOME/.volta/tools/image/node/24.15.0/bin:$PATH
```

## 浏览器限制

- 品牌版 Google Chrome 137 起不再支持 `--load-extension` 命令行加载，自动化 E2E 使用 Playwright 自带 Chromium；日常人工验收在 Chrome 152 中通过「加载已解压的扩展程序」加载 `.output/chrome-mv3`。
- 扩展最低 Chrome 版本暂定 116（offscreen 接收 worker 取得的 tabCapture stream ID 的最低版本）。

## 网络（2026-09-16 实测）

| 目标                                       | 结果                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------- |
| registry.npmjs.org / pypi.org / github.com | 可达                                                                  |
| www.youtube.com                            | **不可达**（经本机代理 fake-IP 198.18.x，TLS 握手 SSL_ERROR_SYSCALL） |
| huggingface.co                             | **不可达**（同上）                                                    |
| hf-mirror.com                              | 可达                                                                  |

影响：真实 YouTube 页面结构、字幕轨道读取与广告等验收项目前无法在本机执行，已在 PROGRESS 中登记为外部阻塞；开发期间用本地夹具页面替代并明确标注。

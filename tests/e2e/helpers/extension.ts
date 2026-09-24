/**
 * 用 Playwright 自带 Chromium 加载构建后的扩展（品牌版 Chrome 137+ 不再支持 --load-extension）。
 *
 * 用法：先 `pnpm build`，再在测试中调用 launchExtension()。
 * 全链路测试使用 `TONGTING_E2E=1 pnpm exec wxt build` 产出的 .output-e2e 版本（manifest 预授予 http://127.0.0.1/*），
 * 通过 prepareE2EExtension() 复制到固定的临时目录后加载，避免测试期间他人重新构建导致资源文件变化。
 * YouTube 在测试中通过 context.route 指向本地夹具页面，不访问真实站点。
 */
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { createHash } from 'node:crypto';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const EXTENSION_DIR = resolve(import.meta.dirname, '../../../.output/chrome-mv3');
export const E2E_BUILD_DIR = resolve(import.meta.dirname, '../../../.output-e2e/chrome-mv3');

export interface LaunchedExtension {
  context: BrowserContext;
  extensionId: string;
  serviceWorker: Worker;
  userDataDir: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** 额外 Chromium 参数，例如 `--allowlisted-extension-id=<id>`（仅用于自动化验证 tabCapture）。 */
  extraArgs?: string[];
  headless?: boolean;
  /** 解包扩展目录，默认生产构建 .output/chrome-mv3。 */
  extensionDir?: string;
  /**
   * 去掉 Playwright 默认的 --mute-audio。静音时 tabCapture 只能得到全零 PCM（见 docs/validation/p0-audio.md），
   * 去掉后测试页与原声回放会从扬声器发声。
   */
  unmute?: boolean;
  /**
   * 启动后通过受信任扩展页面写入的界面语言。Playwright 的 Chromium 界面语言是英文，
   * 现有用例按中文文案定位元素，因此默认写入 'zh-CN'；传 'auto' 保持跟随浏览器（不写入）。
   */
  uiLocale?: 'auto' | 'zh-CN' | 'en';
}

export async function launchExtension(options: LaunchOptions = {}): Promise<LaunchedExtension> {
  const extensionDir = options.extensionDir ?? EXTENSION_DIR;
  const userDataDir = await mkdtemp(join(tmpdir(), 'tongting-e2e-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: options.headless ?? true,
      ignoreDefaultArgs: options.unmute ? ['--mute-audio'] : [],
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        '--autoplay-policy=no-user-gesture-required',
        ...(options.extraArgs ?? []),
      ],
    });
    let [serviceWorker] = context.serviceWorkers();
    if (!serviceWorker)
      serviceWorker = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    const extensionId = new URL(serviceWorker.url()).host;
    const uiLocale = options.uiLocale ?? 'zh-CN';
    if (uiLocale !== 'auto') await setUiLocale(context, extensionId, uiLocale);
    const launchedContext = context;
    return {
      context,
      extensionId,
      serviceWorker,
      userDataDir,
      async close() {
        const results = await Promise.allSettled([launchedContext.close()]);
        // Profile deletion must still run if browser shutdown fails.
        results.push(
          await rm(userDataDir, { recursive: true, force: true }).then(
            (): PromiseFulfilledResult<void> => ({ status: 'fulfilled', value: undefined }),
            (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }),
          ),
        );
        const failures = results.filter((result) => result.status === 'rejected');
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            'Extension cleanup failed',
          );
      },
    };
  } catch (error) {
    // Failure before returning the handle must not strand Chromium or its temporary profile.
    await context?.close().catch(() => undefined);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * 以受信任扩展页面（options.html，不唤醒内容脚本）的 UI 端口发送 settings/update，
 * 并等到快照中的 settings.uiLocale 生效后关闭页面。设置会落盘，同一 profile 重启后仍然有效。
 */
export async function setUiLocale(
  context: BrowserContext,
  extensionId: string,
  uiLocale: 'auto' | 'zh-CN' | 'en',
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/options.html`);
    await page.evaluate(
      (uiLocale) =>
        new Promise<void>((resolve, reject) => {
          type Port = {
            postMessage(m: unknown): void;
            disconnect(): void;
            onMessage: { addListener(cb: (m: Record<string, unknown>) => void): void };
          };
          const chromeApi = (
            globalThis as unknown as {
              chrome: { runtime: { connect(info: { name: string }): Port } };
            }
          ).chrome;
          const port = chromeApi.runtime.connect({ name: 'tongting:ui' });
          const requestId = `e2e-locale-${Date.now()}`;
          let accepted = false;
          let latest: string | undefined;
          const timer = setTimeout(() => {
            port.disconnect();
            reject(new Error(`uiLocale=${uiLocale} 未在快照中生效`));
          }, 15_000);
          const done = () => {
            clearTimeout(timer);
            port.disconnect();
            resolve();
          };
          port.onMessage.addListener((m) => {
            if (m.type === 'result' && m.requestId === requestId) {
              if (!m.ok) {
                clearTimeout(timer);
                port.disconnect();
                reject(new Error(`settings/update 失败：${JSON.stringify(m.error)}`));
                return;
              }
              accepted = true;
              if (latest === uiLocale) done();
            } else if (m.type === 'snapshot') {
              latest = (m.snapshot as { settings?: { uiLocale?: string } }).settings?.uiLocale;
              if (accepted && latest === uiLocale) done();
            }
          });
          port.postMessage({ type: 'subscribe', protocolVersion: 1, surface: 'options' });
          port.postMessage({
            type: 'command',
            requestId,
            command: { kind: 'settings/update', patch: { uiLocale } },
          });
        }),
      uiLocale,
    );
  } finally {
    await page.close();
  }
}

/**
 * Chromium 为解包扩展生成 ID 的算法：对绝对真实路径的 UTF-8 字节做 SHA-256，取前 16 字节，
 * 十六进制字符 0-9a-f 映射为 a-p。用于在启动前得到 `--allowlisted-extension-id` 所需的 ID。
 */
export function unpackedExtensionId(dir: string): string {
  const real = realpathSync(dir);
  const hex = createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

/**
 * 复制 .output-e2e 构建到固定临时目录（扩展 ID 因此固定），并确认它确实是 E2E 变体。
 * 可用环境变量 TONGTING_E2E_EXTENSION_DIR 直接指定目录（不复制）。
 */
export async function prepareE2EExtension(): Promise<{ dir: string; extensionId: string }> {
  const override = process.env.TONGTING_E2E_EXTENSION_DIR;
  const source = override ? resolve(override) : E2E_BUILD_DIR;
  let manifest: { host_permissions?: string[] };
  try {
    manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')) as typeof manifest;
  } catch {
    throw new Error(
      `找不到 E2E 构建 ${source}/manifest.json。请先运行：TONGTING_E2E=1 pnpm exec wxt build`,
    );
  }
  if (!manifest.host_permissions?.includes('http://127.0.0.1/*')) {
    throw new Error(`${source} 不是 E2E 构建（manifest 缺少 host_permissions http://127.0.0.1/*）`);
  }
  if (override) return { dir: source, extensionId: unpackedExtensionId(source) };
  const dir = join(tmpdir(), 'tongting-e2e-full-chain-extension');
  await rm(dir, { recursive: true, force: true });
  await cp(source, dir, { recursive: true });
  return { dir, extensionId: unpackedExtensionId(dir) };
}

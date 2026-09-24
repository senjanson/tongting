/** Real toolbar popups: never set a viewport or open popup.html as an ordinary tab. */
import { expect, test } from '@playwright/test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpEvaluate, cdpTargets, freePort, type CdpTarget } from './helpers/cdp';
import { EXTENSION_DIR, launchExtension, type LaunchedExtension } from './helpers/extension';

let ext: LaunchedExtension;
let temporary: string;
let port: number;
let popupSocket: WebSocket | undefined;

test.beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'tongting-popup-layout-'));
  const extensionDir = join(temporary, 'extension');
  await cp(EXTENSION_DIR, extensionDir, { recursive: true });
  port = await freePort();
  ext = await launchExtension({
    extensionDir,
    headless: false,
    extraArgs: [`--remote-debugging-port=${port}`],
  });
});

test.afterAll(async () => {
  try {
    await ext?.close();
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
});

const isPopup = (target: CdpTarget) =>
  target.url === `chrome-extension://${ext.extensionId}/popup.html`;

// Playwright does not expose action popups as Page objects. Connect only to the
// disposable test browser's own debugging port, never an existing user browser.
async function popupCommand<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!popupSocket) {
    const target = (await cdpTargets(port)).find(isPopup);
    if (!target?.webSocketDebuggerUrl) throw new Error('Toolbar popup is not open');
    popupSocket = new WebSocket(target.webSocketDebuggerUrl);
  }
  const ws = popupSocket;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Popup ${method} timed out`)), 5_000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Popup debugging connection failed'));
    };
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as {
        id?: number;
        result?: T;
        error?: { message: string };
      };
      if (data.id !== 1) return;
      clearTimeout(timer);
      if (data.error) reject(new Error(data.error.message));
      else resolve(data.result as T);
    };
    const send = () => ws.send(JSON.stringify({ id: 1, method, params }));
    if (ws.readyState === WebSocket.OPEN) send();
    else ws.onopen = send;
  });
}

function measureLayout() {
  const brand = [...document.querySelectorAll<HTMLElement>('header span')]
    .filter((element) => ['译听', 'VOCASUB'].includes(element.textContent ?? ''))
    .map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
  const controls = [...document.querySelectorAll<HTMLElement>('button, select')].map((element) => {
    const box = element.getBoundingClientRect();
    return { left: box.left, right: box.right, bottom: box.bottom };
  });
  return {
    ready: document.body.textContent?.includes('不是 YouTube 视频页。') ?? false,
    background: getComputedStyle(document.body).backgroundColor,
    runningAnimations: document
      .getAnimations()
      .filter((animation) => animation.playState === 'running').length,
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    brand,
    controls,
  };
}

const readLayout = () =>
  cdpEvaluate<ReturnType<typeof measureLayout>>(port, isPopup, `(${measureLayout.toString()})()`);

async function openToolbarPopup() {
  await ext.context.pages()[0]!.bringToFront();
  await expect(async () =>
    ext.serviceWorker.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: {
            windows: {
              getLastFocused(): Promise<{ id: number }>;
              update(id: number, options: { focused: boolean }): Promise<unknown>;
            };
            action: { openPopup(options: { windowId: number }): Promise<void> };
          };
        }
      ).chrome;
      const window = await api.windows.getLastFocused();
      // bringToFront activates the tab, but the OS window can still be inactive
      // after the headless browser cases earlier in the full suite.
      await api.windows.update(window.id, { focused: true });
      await api.action.openPopup({ windowId: window.id });
    }),
  ).toPass({ timeout: 5_000, intervals: [100, 250, 500] });
  await expect.poll(async () => (await cdpTargets(port)).some(isPopup)).toBe(true);
  await expect.poll(async () => (await readLayout()).ready).toBe(true);
}

for (const theme of ['light', 'dark'] as const) {
  test(`toolbar popup has its own readable width in ${theme} theme and after reopening`, async () => {
    for (const opening of [1, 2]) {
      await openToolbarPopup();
      try {
        await popupCommand('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        await expect
          .poll(async () => (await readLayout()).background)
          .toBe(theme === 'dark' ? 'rgb(23, 27, 25)' : 'rgb(243, 244, 240)');
        await expect.poll(async () => (await readLayout()).runningAnimations).toBe(0);
        // Chrome computes the viewport from intrinsic document size. A normal tab
        // with a predefined 340px viewport hides the width/100vw feedback loop.
        await expect.poll(async () => (await readLayout()).width).toBe(340);
        const layout = await readLayout();
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
        // Native popup autosizing and scrollHeight round fractional CSS pixels differently.
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.height + 1);
        expect(layout.height).toBeLessThanOrEqual(600);
        expect(layout.brand).toHaveLength(2);
        for (const brand of layout.brand) {
          expect(brand.width).toBeGreaterThan(35);
          expect(brand.height).toBeLessThan(24);
        }
        for (const control of layout.controls) {
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(layout.width);
          expect(control.bottom).toBeLessThanOrEqual(layout.height);
        }
        if (opening === 1) {
          const screenshot = await popupCommand<{ data: string }>('Page.captureScreenshot', {
            format: 'png',
          });
          await writeFile(
            test.info().outputPath(`toolbar-popup-${theme}.png`),
            Buffer.from(screenshot.data, 'base64'),
          );
        }
      } finally {
        try {
          if ((await cdpTargets(port)).some(isPopup)) {
            await popupCommand('Runtime.evaluate', {
              expression: 'setTimeout(() => window.close(), 0)',
            });
          }
        } finally {
          popupSocket?.close();
          popupSocket = undefined;
        }
        await expect.poll(async () => (await cdpTargets(port)).some(isPopup)).toBe(false);
      }
    }
  });
}

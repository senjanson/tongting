/** Real extension reload + browser restart in a disposable profile, using a fake key only. */
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { launchExtension, prepareE2EExtension } from './helpers/extension';
import { UiDriver } from './helpers/ui-driver';

const KEY = 'sk-fake-persistence-only-1234';

async function reloadExtension(context: BrowserContext, ui: UiDriver) {
  const previousWorker = (await ui.snapshot())!.workerInstanceId;
  const closed = ui.page.waitForEvent('close', { timeout: 10_000 });
  await ui.page.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          storage: { session: { set(data: unknown): Promise<void> } };
          runtime: { reload(): void };
        };
      }
    ).chrome;
    await api.storage.session.set({ 'e2e.reload-sentinel': true });
    setTimeout(() => api.runtime.reload(), 50);
  });
  // Reload closes extension pages; MV3 may not launch its worker again until a new UI opens.
  await closed;
  const wake = await context.newPage();
  await expect(async () => {
    // During unload/re-register the URL is briefly unavailable, before the worker can wake.
    await wake.goto(`chrome-extension://${ui.extensionId}/sidepanel.html`);
  }).toPass({ timeout: 10_000, intervals: [100, 250, 500] });
  const fresh = await UiDriver.open(context, ui.extensionId);
  await wake.close();
  expect((await fresh.snapshot())!.workerInstanceId).not.toBe(previousWorker);
  // This is a full extension reload: unlike worker suspension, storage.session is cleared.
  expect(
    await fresh.page.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };
        }
      ).chrome;
      return (await api.storage.session.get('e2e.reload-sentinel'))['e2e.reload-sentinel'];
    }),
  ).toBeUndefined();
  return fresh;
}

async function assertRemembered(ui: UiDriver) {
  await ui.waitSnapshot((s) => s.credential.configured && s.credential.storage === 'local');
  const snapshot = await ui.snapshot();
  expect(snapshot?.credential.masked).toBe('••••1234');
  expect(snapshot?.settings.rememberCredentials).toBe(true);
  expect(JSON.stringify(snapshot)).not.toContain(KEY);
  // Verify the complete value, without returning any stored secret from the browser.
  expect(
    await ui.page.evaluate(
      (expected) =>
        new Promise<boolean>((resolve, reject) => {
          const request = indexedDB.open('tongting-secure', 1);
          request.onerror = () => reject(new Error('test DB open failed'));
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('kv', 'readonly');
            const value = tx.objectStore('kv').get('secret.apiKey');
            tx.oncomplete = () => {
              db.close();
              resolve(value.result === expected);
            };
            tx.onerror = () => {
              db.close();
              reject(new Error('test DB read failed'));
            };
          };
        }),
      KEY,
    ),
  ).toBe(true);
}

for (const surface of ['sidepanel', 'options'] as const) {
  test(`${surface}: default save survives extension reload and full browser restart; deletion and explicit temporary mode do not resurrect keys`, async () => {
    const extension = await prepareE2EExtension();
    const ext = await launchExtension({ extensionDir: extension.dir });
    let context = ext.context;
    try {
      // Command-line loading works once without developer mode, but Chromium disables the
      // unpacked extension on reload unless developer mode is enabled in this temporary profile.
      const extensions = await context.newPage();
      await extensions.goto('chrome://extensions');
      await extensions.getByRole('button', { name: 'Developer mode', exact: true }).click();
      await expect(
        extensions.getByRole('button', { name: 'Load unpacked', exact: true }),
      ).toBeVisible();
      await extensions.close();
      let ui = await UiDriver.open(
        context,
        ext.extensionId,
        surface === 'options' ? '/options.html' : '/sidepanel.html',
      );
      await ui.ok({
        kind: 'settings/update',
        patch: { provider: { baseUrl: 'https://api.example.com' } },
      });
      await ui.page.setViewportSize({ width: 320, height: 900 });
      if (surface === 'sidepanel')
        await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
      await expect(
        ui.page.getByRole('checkbox', { name: '记住在本机', exact: true }),
      ).toBeChecked();
      await ui.page.getByLabel('API Key', { exact: true }).fill(KEY);
      await ui.page
        .getByRole('button', {
          name: surface === 'sidepanel' ? '保存连接设置' : '保存 Key',
          exact: true,
        })
        .click();
      await assertRemembered(ui);
      await expect(ui.page.getByLabel('API Key', { exact: true })).toHaveValue('');
      expect(await ui.page.evaluate(() => document.documentElement.scrollWidth <= 321)).toBe(true);
      await ui.page.screenshot({
        path: test.info().outputPath(`${surface}-remember-key.png`),
        fullPage: true,
      });

      ui = await reloadExtension(context, ui);
      await assertRemembered(ui);

      // Reuse only this test's temporary profile and the exact same unpacked extension path.
      await context.close();
      context = await chromium.launchPersistentContext(ext.userDataDir, {
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extension.dir}`, `--load-extension=${extension.dir}`],
      });
      ui = await UiDriver.open(context, ext.extensionId);
      await assertRemembered(ui);

      await ui.ok({ kind: 'credentials/clear' });
      ui = await reloadExtension(context, ui);
      expect((await ui.snapshot())?.credential.configured).toBe(false);
      await ui.ok({
        kind: 'credentials/set',
        apiKey: 'sk-fake-temporary-only-5678',
        remember: false,
      });
      await ui.waitSnapshot((s) => s.credential.storage === 'session');
      ui = await reloadExtension(context, ui);
      expect((await ui.snapshot())?.credential.configured).toBe(false);
      expect((await ui.snapshot())?.settings.rememberCredentials).toBe(false);
    } finally {
      await context.close().catch(() => undefined);
      await ext.close();
    }
  });
}

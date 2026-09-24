/**
 * 界面语言：不设置 uiLocale 时跟随浏览器界面语言（Playwright 的 Chromium 为英文），
 * 侧栏、弹窗、设置页显示英文；在设置页把「界面语言」切换为中文后，各页面显示中文。
 *
 * 依赖侧栏与设置页的文案迁移（src/ui/**）。页面用普通标签页打开，不代表真实 Side Panel 容器。
 */
import { expect, test, type Page } from '@playwright/test';
import { translate } from '../../src/i18n';
import { launchExtension, type LaunchedExtension } from './helpers/extension';

const CJK = /[㐀-鿿]/;

let ext: LaunchedExtension;

test.beforeAll(async () => {
  ext = await launchExtension({ uiLocale: 'auto' });
});

test.afterAll(async () => {
  await ext?.close();
});

async function open(path: string): Promise<Page> {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 420, height: 900 });
  await page.goto(`chrome-extension://${ext.extensionId}/${path}`);
  return page;
}

/** 页面可见文字（去掉下拉选项：目标语言等选项使用各语言自称，含中日韩文字）。 */
function visibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const clone = document.body.cloneNode(true) as HTMLElement;
    for (const el of clone.querySelectorAll('select, option, datalist, script, style')) el.remove();
    document.body.append(clone);
    clone.style.position = 'absolute';
    clone.style.left = '-99999px';
    const text = clone.innerText;
    clone.remove();
    return text;
  });
}

test('browser UI language is English, so pages default to English; switching to Chinese in settings applies everywhere', async () => {
  const uiLanguage = await ext.serviceWorker.evaluate(() =>
    (
      globalThis as unknown as { chrome: { i18n: { getUILanguage(): string } } }
    ).chrome.i18n.getUILanguage(),
  );
  test.skip(!/^en\b/i.test(uiLanguage), `浏览器界面语言为 ${uiLanguage}，不是英文`);

  const pages = ['sidepanel.html', 'popup.html', 'options.html'] as const;
  for (const path of pages) {
    const page = await open(path);
    // 页面渲染出英文文字，且可见文字中没有中文。
    await expect.poll(async () => /[A-Za-z]{3}/.test(await visibleText(page))).toBe(true);
    await expect
      .poll(async () => (await visibleText(page)).match(CJK)?.[0] ?? null, {
        message: `${path} 仍有中文文案`,
      })
      .toBeNull();
    await page.close();
  }

  const options = await open('options.html');
  await options
    .getByLabel(translate('en', 'options.general.uiLocale'), { exact: true })
    .selectOption('zh-CN');
  await expect(
    options.getByLabel(translate('zh-CN', 'options.general.uiLocale'), { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      ext.serviceWorker.evaluate(async () => {
        const { settings } = await (
          globalThis as unknown as {
            chrome: {
              storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
            };
          }
        ).chrome.storage.local.get('settings');
        return (settings as { uiLocale?: string } | undefined)?.uiLocale ?? null;
      }),
    )
    .toBe('zh-CN');

  for (const path of ['sidepanel.html', 'popup.html'] as const) {
    const page = await open(path);
    await expect
      .poll(async () => CJK.test(await visibleText(page)), { message: `${path} 没有显示中文` })
      .toBe(true);
    await page.close();
  }
  await options.close();
});

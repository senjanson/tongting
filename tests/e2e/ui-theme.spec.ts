/**
 * 外观主题：默认跟随系统；在设置页选择主题后写入设置，设置页立即换肤，
 * 之后打开的侧栏、弹窗、字幕工作台也使用同一主题（含首帧：本机记录先行）。
 *
 * 页面用普通标签页打开，不代表真实 Side Panel 容器。
 */
import { expect, test, type Page } from '@playwright/test';
import { translate } from '../../src/i18n';
import { launchExtension, type LaunchedExtension } from './helpers/extension';

let ext: LaunchedExtension;

test.beforeAll(async () => {
  ext = await launchExtension();
});

test.afterAll(async () => {
  await ext?.close();
});

async function open(path: string): Promise<Page> {
  const page = await ext.context.newPage();
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.goto(`chrome-extension://${ext.extensionId}/${path}`);
  return page;
}

const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.ttTheme);
const bgOf = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

function savedTheme(): Promise<string | null> {
  return ext.serviceWorker.evaluate(async () => {
    const { settings } = await (
      globalThis as unknown as {
        chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
      }
    ).chrome.storage.local.get('settings');
    return (settings as { uiTheme?: string } | undefined)?.uiTheme ?? null;
  });
}

const option = (name: 'common.theme.cinema' | 'common.theme.wave' | 'common.theme.auto') =>
  translate('zh-CN', 'common.theme.optionAria', { name: translate('zh-CN', name) });

test('choosing a theme in settings applies it to every extension page', async () => {
  const options = await open('options.html');
  const group = options.getByRole('group', { name: translate('zh-CN', 'common.theme.groupAria') });
  await expect(group).toBeVisible();
  await expect.poll(() => themeOf(options)).toBe('auto');
  await expect(group.getByRole('button', { name: option('common.theme.auto') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await group.getByRole('button', { name: option('common.theme.cinema') }).click();
  await expect.poll(() => themeOf(options)).toBe('cinema');
  await expect.poll(savedTheme).toBe('cinema');
  // 影院主题的底色 #0f1011
  await expect.poll(() => bgOf(options)).toBe('rgb(15, 16, 17)');
  await expect(group.getByRole('button', { name: option('common.theme.cinema') })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  for (const path of ['sidepanel.html', 'popup.html', 'workspace.html'] as const) {
    const page = await open(path);
    await expect.poll(() => themeOf(page), { message: `${path} 主题` }).toBe('cinema');
    await expect.poll(() => bgOf(page), { message: `${path} 底色` }).toBe('rgb(15, 16, 17)');
    await page.close();
  }

  // 换成声波后，已打开的页面随快照切换。
  const panel = await open('sidepanel.html');
  await group.getByRole('button', { name: option('common.theme.wave') }).click();
  await expect.poll(savedTheme).toBe('wave');
  await expect.poll(() => themeOf(panel)).toBe('wave');
  await expect.poll(() => bgOf(panel)).toBe('rgb(238, 240, 247)');

  // 恢复跟随系统，避免影响同一 profile 的其他用例。
  await group.getByRole('button', { name: option('common.theme.auto') }).click();
  await expect.poll(savedTheme).toBe('auto');
  await expect.poll(() => themeOf(panel)).toBe('auto');
  await panel.close();
  await options.close();
});

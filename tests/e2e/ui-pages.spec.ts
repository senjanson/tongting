/**
 * 扩展页面 UI 冒烟：在真实加载的扩展中打开 popup / sidepanel / options / workspace，
 * 检查无未捕获异常、显示正确的空状态、320px 窄栏与宽屏下没有横向溢出、演示模式标识可见。
 *
 * 注意：这里用普通标签页打开扩展页面，不能代表真实 Side Panel 容器与用户手势行为（需人工验收）。
 */
import { expect, test, type Page } from '@playwright/test';
import { launchExtension, type LaunchedExtension } from './helpers/extension';

let ext: LaunchedExtension;

test.beforeAll(async () => {
  ext = await launchExtension();
});

test.afterAll(async () => {
  await ext?.close();
});

async function openPage(path: string, width: number, colorScheme: 'light' | 'dark' = 'light') {
  const page = await ext.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.setViewportSize({ width, height: 760 });
  await page.emulateMedia({ colorScheme });
  await page.goto(`chrome-extension://${ext.extensionId}/${path}`);
  return { page, errors };
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const offenders = Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.right > doc.clientWidth + 1 &&
          getComputedStyle(el).position !== 'fixed'
        );
      })
      .slice(0, 5)
      .map((el) => `${el.tagName}.${el.className}`);
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, offenders };
  });
  expect(overflow.offenders, JSON.stringify(overflow)).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

test('side panel renders a real empty state at 320px without demo data or overflow', async () => {
  const testInfo = test.info();
  const { page, errors } = await openPage('sidepanel.html', 320);
  await expect(page.getByRole('heading', { level: 1, name: '译听', exact: true })).toBeVisible();
  // worker 未提供快照时显示连接中；提供快照后当前标签（扩展页本身）不是 YouTube 视频页
  await expect(
    page.getByText(/当前标签不是 YouTube 视频页|正在连接后台服务/).first(),
  ).toBeVisible();
  await expect(page.getByText(/演示|示例/)).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('sidepanel-320.png'), fullPage: true });

  const settingsTab = page.getByRole('tab', { name: '设置' });
  if (await settingsTab.count()) {
    await settingsTab.click();
    await expect(page.getByRole('button', { name: '打开完整设置' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath('sidepanel-settings-320.png'),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  await page.close();
});

test('side panel demo mode shows a persistent label and fits 320px in dark theme', async () => {
  const testInfo = test.info();
  const { page, errors } = await openPage('sidepanel.html?demo=1', 320, 'dark');
  const banner = page.getByText('演示模式 · 示例数据，不连接视频与服务');
  await expect(banner).toBeVisible();
  await expect(page.getByRole('button', { name: '暂停翻译' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({
    path: testInfo.outputPath('sidepanel-demo-dark-320.png'),
    fullPage: true,
  });

  await page.getByRole('tab', { name: '字幕' }).click();
  await expect(banner).toBeVisible();
  await expect(
    page.getByRole('list', { name: '字幕列表' }).getByRole('listitem').first(),
  ).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('sidepanel-demo-transcript-320.png') });

  await page.getByRole('button', { name: '导出字幕' }).click();
  await expect(page.getByRole('dialog', { name: '导出字幕' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sidepanel-demo-export-320.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: '退出演示' }).click();
  await expect(banner).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.close();
});

test('side panel demo mode looks right on a wide panel', async () => {
  const testInfo = test.info();
  const { page, errors } = await openPage('sidepanel.html?demo=1', 960);
  await expect(page.getByText('演示模式 · 示例数据，不连接视频与服务')).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('sidepanel-demo-960.png'), fullPage: true });
  expect(errors).toEqual([]);
  await page.close();
});

test('popup renders without errors', async () => {
  const testInfo = test.info();
  const { page, errors } = await openPage('popup.html', 340);
  await expect(page.getByRole('button', { name: '打开侧栏' })).toBeVisible();
  await expect(page.getByText(/不是 YouTube 视频页|等待后台服务/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.screenshot({ path: testInfo.outputPath('popup.png'), fullPage: true });
  expect(errors).toEqual([]);
  await page.close();
});

test('options page renders sections or a connecting state, at narrow and wide widths', async () => {
  const testInfo = test.info();
  for (const width of [360, 1280]) {
    const { page, errors } = await openPage('options.html', width);
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    const connection = page.getByRole('heading', { name: '模型连接' });
    const connecting = page.getByText('正在连接后台服务…').first();
    await expect(connection.or(connecting)).toBeVisible();
    if (await connection.count()) {
      await expect(page.getByLabel('API Key')).toHaveAttribute('type', 'password');
      await expect(page.getByText('未检测').first()).toBeVisible();
    }
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`options-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }
});

test('workspace renders an empty state without errors', async () => {
  const testInfo = test.info();
  for (const width of [360, 1280]) {
    const { page, errors } = await openPage('workspace.html', width);
    await expect(page.getByRole('heading', { name: '字幕工作台' })).toBeVisible();
    await expect(page.getByText('暂无字幕记录')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`workspace-${width}.png`), fullPage: true });
    expect(errors).toEqual([]);
    await page.close();
  }
});

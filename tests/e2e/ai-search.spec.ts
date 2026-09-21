import { expect, test, type Page } from '@playwright/test';
import { configureProvider, setupFullChain, type FullChain } from './helpers/full-chain';
import { searchEnvelope, searchRecord } from '../fixtures/search';

let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

async function openSearch() {
  fc = await setupFullChain({ videos: [], uiPath: '/options.html' });
  await configureProvider(fc, { provider: { model: 'gpt-5.6-luna' } });
  fc.mock.setDefault('responses', { kind: 'status', status: 200, body: searchEnvelope() });
  const page = await fc.ext.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto(`chrome-extension://${fc.ext.extensionId}/sidepanel.html`);
  await page.getByRole('tab', { name: '搜索', exact: true }).click();
  return { page, errors };
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.right > width + 1 && getComputedStyle(el).position !== 'fixed';
        })
        .map((el) => el.tagName + '.' + el.className);
    }),
  ).toEqual([]);
}

test('A sidebar: generate with saved Luna, edit, copy, search new tab, reload history, clear; light/dark 320px fit', async () => {
  const { page, errors } = await openSearch();
  await page.getByLabel('你想在 YouTube 上找什么？').fill(searchRecord.query);
  await page.getByRole('button', { name: '生成英文搜索词', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  await expect(page.getByRole('article').first()).toContainText('01 · 原文直译');
  await expect(page.getByText('1 条原文直译 + 2 条简短搜索词')).toBeVisible();
  await expect(page.getByText(searchRecord.items[0]!.keyword, { exact: true })).toBeVisible();
  const request = fc!.mock.requests.find((r) => r.endpoint === 'responses')!;
  expect(request.body).toMatchObject({
    model: 'gpt-5.6-luna',
    input: `Return JSON suggestions for this search topic:\n${JSON.stringify({ query: searchRecord.query })}`,
  });
  expect(fc!.mock.requests.filter((r) => r.endpoint === 'responses')).toHaveLength(1);
  await noOverflow(page);
  await page.screenshot({
    path: test.info().outputPath('search-light-320.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'dark' });
  await noOverflow(page);
  await page.screenshot({
    path: test.info().outputPath('search-dark-320.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByRole('button', { name: '编辑搜索词 1' }).click();
  const edited = 'AI video editing & YouTube #tutorial';
  await page.getByLabel('编辑英文搜索词', { exact: true }).fill(edited);
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByText('已编辑 · 中文注释对应原建议')).toBeVisible();
  await page.getByRole('button', { name: '复制', exact: true }).first().click();
  await expect(page.getByText('英文搜索词已复制。')).toBeVisible();
  await fc!.ext.context.route('https://www.youtube.com/results?**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<h1>YouTube search fixture</h1>',
    }),
  );
  const opened = fc!.ext.context.waitForEvent('page');
  await page.getByRole('button', { name: '搜索', exact: true }).first().click();
  const search = await opened;
  await expect(search).toHaveURL(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(edited)}`,
  );
  expect(page.url()).toContain('/sidepanel.html');
  await search.close();

  await page.reload();
  await page.getByRole('tab', { name: '搜索', exact: true }).click();
  await page.locator('summary').filter({ hasText: '最近生成' }).click();
  await page.getByRole('button', { name: new RegExp(searchRecord.query) }).click();
  await expect(page.getByText(searchRecord.items[0]!.keyword, { exact: true })).toBeVisible();
  expect(fc!.mock.requests.filter((r) => r.endpoint === 'responses')).toHaveLength(1);
  await page.getByRole('button', { name: '清空历史记录' }).click();
  await expect(page.getByText('还没有生成记录。')).toBeVisible();
  expect(await fc!.ui.ok({ kind: 'search/history' })).toEqual({ records: [] });
  expect(errors).toEqual([]);
});

test('A sidebar: cancel aborts HTTP and switching tabs preserves input without late output; invalid responses can retry', async () => {
  const { page, errors } = await openSearch();
  fc!.mock.setDefault('responses', { kind: 'hang' });
  await page.getByLabel('你想在 YouTube 上找什么？').fill('学习做饭');
  await page.getByRole('button', { name: '生成英文搜索词', exact: true }).click();
  await expect.poll(() => fc!.mock.requests.length).toBe(1);
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect.poll(() => fc!.mock.requests[0]!.aborted).toBe(true);
  await page.getByRole('button', { name: '生成英文搜索词', exact: true }).click();
  await expect.poll(() => fc!.mock.requests.length).toBe(2);
  await page.getByRole('tab', { name: '翻译', exact: true }).click();
  await expect.poll(() => fc!.mock.requests[1]!.aborted).toBe(true);
  await page.getByRole('tab', { name: '搜索', exact: true }).click();
  await expect(page.getByLabel('你想在 YouTube 上找什么？')).toHaveValue('学习做饭');
  expect(await fc!.ui.ok({ kind: 'search/history' })).toEqual({ records: [] });
  fc!.mock.setDefault('responses', { kind: 'status', status: 200, body: searchEnvelope([]) });
  await page.getByRole('button', { name: '生成英文搜索词', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('需要第一条原文直译和两条简短英文搜索词');
  fc!.mock.setDefault('responses', { kind: 'status', status: 200, body: searchEnvelope() });
  await page.getByRole('button', { name: '生成英文搜索词', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(3);
  expect(errors).toEqual([]);
});

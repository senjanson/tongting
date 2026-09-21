/**
 * 模型选择 UI 回归：临时 E2E 扩展 + 本机 mock /models + 测试假 Key。
 * 通过真实侧栏/完整设置操作，只发现模型与保存设置，不执行连接检查、翻译或语音调用。
 * 此文件由主测试进程统一运行，不能据此声称真实 sub2api 模型能力已验证。
 */
import { expect, test, type Page } from '@playwright/test';
import { configureProvider, setupFullChain, type FullChain } from './helpers/full-chain';

const LUNA = 'gpt-5.6-luna';
const TERRA = 'gpt-5.6-terra';
const MANUAL = 'private-text-model-42';
const OFFERED = [
  'gpt-5.4-mini',
  'gpt-5.5',
  'gpt-5.6',
  LUNA,
  TERRA,
  'gpt-6',
  'gpt-6-astra',
  'gpt-image-2',
  'gpt-5.6-audio',
  'gpt-6-realtime',
  'gpt-6-embedding',
];
const EXPECTED = ['gpt-5.6', LUNA, TERRA, 'gpt-6', 'gpt-6-astra'];

let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

function offer(models: string[]) {
  fc!.mock.setDefault('models', {
    kind: 'status',
    status: 200,
    body: { object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'e2e' })) },
  });
}

async function openSurface(surface: 'sidepanel' | 'options', savedModel = LUNA) {
  fc = await setupFullChain({ videos: [], uiPath: '/options.html' });
  // 必须在写入任何测试设置之前验证新安装默认值。
  expect((await fc.ui.snapshot())?.settings.provider.model).toBe(LUNA);
  offer(OFFERED);
  await configureProvider(fc, { provider: { model: savedModel } });
  const page = surface === 'options' ? fc.ui.page : await fc.ext.context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 320, height: 900 });
  if (surface === 'sidepanel') {
    await page.goto(`chrome-extension://${fc.ext.extensionId}/sidepanel.html`);
    await page.getByRole('tab', { name: '设置', exact: true }).click();
  }
  await expect(page.getByLabel('模型 ID（可手动填写）', { exact: true })).toHaveValue(savedModel);
  await expect(page.getByRole('button', { name: '获取模型列表', exact: true })).toBeEnabled();
  return { page, errors };
}

async function savedModelIs(model: string) {
  await expect.poll(async () => (await fc!.ui.snapshot())?.settings.provider.model).toBe(model);
}

async function assertNoOverflow(page: Page) {
  const dimensions = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowing = [...document.querySelectorAll<HTMLElement>('body *')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.width > 0 &&
          rect.right > doc.clientWidth + 1 &&
          getComputedStyle(element).position !== 'fixed'
        );
      })
      .slice(0, 6)
      .map((element) => `${element.tagName}.${element.className}`);
    return { viewport: doc.clientWidth, content: doc.scrollWidth, overflowing };
  });
  expect(dimensions.overflowing, JSON.stringify(dimensions)).toEqual([]);
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport + 1);
}

function assertDiscoveryOnly() {
  expect(fc!.mock.requests.length).toBeGreaterThan(0);
  expect(
    fc!.mock.requests.every((request) => request.endpoint === 'models' && request.method === 'GET'),
  ).toBe(true);
  expect(fc!.mock.translationRequests()).toHaveLength(0);
}

for (const surface of ['sidepanel', 'options'] as const) {
  test(`${surface}: actual model discovery filters candidates; selection/manual edit remain drafts until Save; 320px fits`, async () => {
    const { page, errors } = await openSurface(surface);
    const model = page.getByRole('combobox', { name: '翻译模型', exact: true });
    const manual = page.getByLabel('模型 ID（可手动填写）', { exact: true });
    const save = page.getByRole('button', {
      name: surface === 'options' ? '保存模型' : '保存连接设置',
      exact: true,
    });
    await expect(manual).toHaveValue(LUNA);
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(model).toBeEnabled();
    await expect(model.locator('option')).toHaveCount(EXPECTED.length);
    expect(
      await model
        .locator('option')
        .evaluateAll((options) =>
          options.map((option) => (option as HTMLOptionElement).value).sort(),
        ),
    ).toEqual([...EXPECTED].sort());
    await expect(model.locator('option', { hasText: '字幕翻译推荐' })).toHaveText(
      `${LUNA} · 字幕翻译推荐`,
    );
    await expect(model).toHaveValue(LUNA);
    await assertNoOverflow(page);

    await model.selectOption(TERRA);
    await expect(manual).toHaveValue(TERRA);
    await savedModelIs(LUNA);
    // /models 刷新期间及完成后均不得把草稿重置为持久化的 Luna 或列表推荐项。
    const beforeRefresh = fc!.mock.requests.length;
    await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await expect.poll(() => fc!.mock.requests.length).toBeGreaterThan(beforeRefresh);
    await expect(page.getByRole('button', { name: '刷新模型列表', exact: true })).toBeEnabled();
    await expect(model).toHaveValue(TERRA);
    await expect(manual).toHaveValue(TERRA);
    await savedModelIs(LUNA);
    await save.click();
    await savedModelIs(TERRA);

    await manual.fill(MANUAL);
    await savedModelIs(TERRA);
    await expect(model.locator('option:checked')).toHaveText('手动输入（当前设置）');
    await save.click();
    await savedModelIs(MANUAL);
    offer(['gpt-5.5', TERRA, 'gpt-6-realtime']);
    await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await expect(model.locator('option')).toHaveCount(2);
    expect(await model.locator('option').allTextContents()).toEqual([
      '手动输入（当前设置）',
      `${TERRA} · 字幕翻译推荐`,
    ]);
    await expect(manual).toHaveValue(MANUAL);
    await savedModelIs(MANUAL);
    await assertNoOverflow(page);
    await page.screenshot({
      path: test.info().outputPath(`${surface}-model-selector-320.png`),
      fullPage: true,
    });
    assertDiscoveryOnly();
    expect(errors).toEqual([]);
  });

  test(`${surface}: a saved legacy model is preserved only in manual input, and empty/failed discovery cannot erase the draft`, async () => {
    const { page, errors } = await openSurface(surface, 'gpt-5.5');
    const model = page.getByRole('combobox', { name: '翻译模型', exact: true });
    const manual = page.getByLabel('模型 ID（可手动填写）', { exact: true });
    await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    await expect(model).toBeEnabled();
    expect((await model.locator('option').allTextContents()).join(' ')).not.toMatch(
      /gpt-5\.4|gpt-5\.5/,
    );
    await expect(manual).toHaveValue('gpt-5.5');
    await savedModelIs('gpt-5.5');
    await manual.fill(MANUAL);
    offer(['gpt-5.4-mini', 'gpt-5.5', 'gpt-6-realtime', 'gpt-6-audio']);
    await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await expect(
      page.getByText('服务未返回 GPT 5.6 及以上文本模型，请确认账号权限或手动填写模型 ID。'),
    ).toBeVisible();
    await expect(model).toBeDisabled();
    await expect(manual).toHaveValue(MANUAL);
    await savedModelIs('gpt-5.5');

    fc!.mock.setDefault('models', {
      kind: 'status',
      status: 503,
      body: { error: { message: 'Local model fixture temporarily unavailable' } },
    });
    await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
    await expect(page.getByText(/模型发现失败：/)).toBeVisible();
    await expect(manual).toHaveValue(MANUAL);
    await savedModelIs('gpt-5.5');
    await assertNoOverflow(page);
    assertDiscoveryOnly();
    expect(errors).toEqual([]);
  });
}

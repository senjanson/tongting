/**
 * README 截图生成器。不属于验收用例，常规 `pnpm test:e2e` 会跳过。
 *
 * 运行：
 *   pnpm build
 *   TONGTING_E2E=1 pnpm exec wxt build
 *   TONGTING_SHOTS=1 pnpm exec playwright test tests/e2e/screenshots.spec.ts
 *
 * 产出目录：docs/screenshots/<界面语言>/，中英文各一套，分别供 README.zh-CN.md 与 README.md 引用。
 *
 *
 * 两类来源，README 中必须如实标注：
 * 1. 演示模式（产品构建 + `?demo=1`）——界面持续显示「演示模式」标识，不连接任何服务。
 * 2. 本地夹具全链路（E2E 构建）——真实扩展、真实 service worker 协调器、真实内容脚本与覆盖层，
 *    但 YouTube 指向本地夹具页与 ffmpeg 合成的静音视频，sub2api 指向本地模拟服务。
 *    截图里的译文来自模拟服务的固定对照表，不是任何模型的真实输出。
 *
 * 两套截图只有界面语言不同；视频内容与译文（英文 → 简体中文）保持一致，与演示数据相同。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { translate, type Locale, type MessageKey } from '../../src/i18n';
import { launchExtension, setUiTheme, type LaunchedExtension } from './helpers/extension';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import type { CaptionLine, FixtureVideo } from './fixtures/full-chain/youtube';

const OUT_ROOT = resolve(import.meta.dirname, '../../docs/screenshots');
const LOCALES: Locale[] = ['zh-CN', 'en'];
const SCALE = ['--force-device-scale-factor=2'];
/** 四种外观主题：README 并列展示侧栏与播放器字幕层在各主题下的样子。 */
const THEMES = ['paper', 'ink', 'cinema', 'wave'] as const;
const themeOf = (page: Page) => page.evaluate(() => document.documentElement.dataset.ttTheme);

/** 夹具字幕与对照译文：与演示模式同一组文案，保证 README 的截图语气一致。 */
const SENTENCES: Array<[string, string]> = [
  [
    'We often look at things without really seeing them.',
    '我们常常看着眼前的事物，却没有真正看见。',
  ],
  ['Attention is something we can practice.', '专注观察是一项可以练习的能力。'],
  ['Real learning begins with staying curious.', '真正的学习，始于保持好奇。'],
  ['You do not need to have all the answers.', '你不需要掌握所有答案。'],
  ['Sometimes a better question is enough.', '有时候，提出一个更好的问题就足够了。'],
  ['Try slowing down and noticing one small detail.', '试着慢下来，留意一个微小的细节。'],
  ['Familiar places can reveal new possibilities.', '熟悉的地方，也能让你看见新的可能。'],
];

const TABLE = new Map(SENTENCES);
const CAPTIONS: CaptionLine[] = SENTENCES.map(([text], i) => ({
  startMs: 1_000 + i * 6_000,
  durationMs: 5_600,
  text,
}));

/** 搜索页示例问题：演示数据固定为中文输入 → 英文搜索词，两套截图都用中文提问才与之一致。 */
const SEARCH_QUERY = '新手怎么用 AI 剪辑 YouTube 视频';

function shot(locale: Locale, page: Page, name: string, options: { fullPage?: boolean } = {}) {
  return page.screenshot({
    path: join(OUT_ROOT, locale, name),
    animations: 'disabled',
    caret: 'hide',
    ...options,
  });
}

test.describe('README 截图', () => {
  test.skip(process.env.TONGTING_SHOTS !== '1', '仅在生成 README 截图时运行（TONGTING_SHOTS=1）');
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    for (const locale of LOCALES) await mkdir(join(OUT_ROOT, locale), { recursive: true });
  });

  for (const locale of LOCALES) {
    const m = (key: MessageKey) => translate(locale, key);

    test(`演示模式界面与设置页（${locale}）`, async () => {
      let ext: LaunchedExtension | undefined;
      try {
        ext = await launchExtension({ extraArgs: SCALE, uiLocale: locale });
        const open = async (path: string, width: number, scheme: 'light' | 'dark' = 'light') => {
          const page = await ext!.context.newPage();
          await page.setViewportSize({ width, height: 900 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.goto(`chrome-extension://${ext!.extensionId}/${path}`);
          return page;
        };

        // 侧栏：演示模式（持续显示演示标识）
        const panel = await open('sidepanel.html?demo=1', 400);
        await expect(panel.getByText(m('common.demo.label'))).toBeVisible();
        await expect(panel.getByRole('button', { name: m('common.primary.pause') })).toBeVisible();
        await shot(locale, panel, 'sidepanel-translate.png', { fullPage: true });

        await panel.getByRole('tab', { name: m('sidepanel.tabs.transcript'), exact: true }).click();
        await expect(
          panel
            .getByRole('list', { name: m('options.transcript.listAria') })
            .getByRole('listitem')
            .first(),
        ).toBeVisible();
        await shot(locale, panel, 'sidepanel-transcript.png', { fullPage: true });

        await panel.getByRole('tab', { name: m('sidepanel.tabs.search'), exact: true }).click();
        await panel.getByLabel(m('sidepanel.search.question')).fill(SEARCH_QUERY);
        await panel.getByRole('button', { name: generateButton(locale) }).click();
        await expect(panel.getByRole('article')).toHaveCount(3);
        await shot(locale, panel, 'sidepanel-search.png', { fullPage: true });

        await panel.getByRole('tab', { name: m('sidepanel.tabs.settings'), exact: true }).click();
        await expect(
          panel.getByRole('button', { name: m('sidepanel.settings.openFull') }),
        ).toBeVisible();
        await shot(locale, panel, 'sidepanel-settings.png', { fullPage: true });
        await panel.close();

        // 深色主题
        const dark = await open('sidepanel.html?demo=1', 400, 'dark');
        await expect(dark.getByText(m('common.demo.label'))).toBeVisible();
        await shot(locale, dark, 'sidepanel-translate-dark.png', { fullPage: true });
        await dark.close();

        // 完整设置页：未配置时的真实空状态
        const options = await open('options.html', 1120);
        await expect(
          options.getByRole('heading', { level: 1, name: m('options.page.title') }),
        ).toBeVisible();
        await expect(
          options.getByRole('heading', { name: m('options.section.connection') }),
        ).toBeVisible();
        await shot(locale, options, 'options.png', { fullPage: true });
        await options.close();

        // 四种主题下的演示侧栏（演示模式沿用用户保存的主题）
        for (const theme of THEMES) {
          await setUiTheme(ext.context, ext.extensionId, theme);
          const themed = await open('sidepanel.html?demo=1', 400);
          await expect(themed.getByText(m('common.demo.label'))).toBeVisible();
          await expect.poll(() => themeOf(themed)).toBe(theme);
          await shot(locale, themed, `sidepanel-theme-${theme}.png`);
          await themed.close();
        }
        await setUiTheme(ext.context, ext.extensionId, 'auto');
      } finally {
        await ext?.close();
      }
    });

    test(`本地夹具全链路：播放器覆盖层、运行中的侧栏、弹窗与字幕工作台（${locale}）`, async () => {
      test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成夹具视频');
      const videos: FixtureVideo[] = [
        {
          videoId: 'SHOTS000001',
          title: 'Fixture: noticing small details',
          lengthSeconds: 60,
          captions: CAPTIONS,
          media: await silentVideo(60),
        },
      ];

      let fc: FullChain | undefined;
      try {
        fc = await setupFullChain({
          videos,
          extraArgs: () => SCALE,
          mock: { translate: (_target, text) => TABLE.get(text) ?? text },
        });
        await fc.ui.page.setViewportSize({ width: 400, height: 900 });
        await configureProvider(fc, { targetLanguage: 'zh-CN', uiLocale: locale });

        const { page, tabId } = await openWatch(fc, 'SHOTS000001');
        await fc.ui.waitPage('SHOTS000001', (p) => p.captionsAvailability === 'available');
        expect(await video(page).play()).toBe(true);
        await fc.ui.ok({ kind: 'session/start', tabId });
        const session = await fc.ui.waitSession(
          tabId,
          (s) => s.phase === 'running' && s.sourceMode === 'full-track',
          { timeout: 30_000, message: '会话进入 running/full-track' },
        );

        // 停在第 3 句，等覆盖层显示双语
        await video(page).pause();
        await video(page).seek(13.5);
        const expected = TABLE.get(SENTENCES[2]![0])!;
        const overlay = await waitOverlay(
          page,
          (s) => s.main === expected,
          30_000,
          '覆盖层显示译文',
        );
        expect(overlay.secondary).toBe(SENTENCES[2]![0]);
        expect(overlay.hideNative).toBe(true);

        await page.setViewportSize({ width: 720, height: 460 });
        await page.locator('#movie_player').screenshot({
          path: join(OUT_ROOT, locale, 'youtube-overlay.png'),
          animations: 'disabled',
        });

        // 四种主题下的播放器字幕层：切换主题只改外观，字幕内容不变。
        const stageTheme = () =>
          page.evaluate(
            () =>
              document
                .querySelector('[data-tongting-overlay]')
                ?.shadowRoot?.querySelector<HTMLElement>('.stage')?.dataset.theme,
          );
        for (const theme of THEMES) {
          await fc.ui.ok({ kind: 'settings/update', patch: { uiTheme: theme } });
          await expect.poll(stageTheme).toBe(theme);
          const themed = await waitOverlay(page, (s) => s.main === expected, 10_000, theme);
          expect(themed.secondary).toBe(SENTENCES[2]![0]);
          await page.locator('#movie_player').screenshot({
            path: join(OUT_ROOT, locale, `youtube-overlay-${theme}.png`),
            animations: 'disabled',
          });
        }
        await fc.ui.ok({ kind: 'settings/update', patch: { uiTheme: 'auto' } });
        await expect.poll(stageTheme).toBe('paper');
        await expect
          .poll(() => themeOf(fc!.ui.page), { message: '侧栏随设置恢复跟随系统' })
          .toBe('auto');

        // 运行中的侧栏（真实会话状态，不是演示数据）
        await fc.ui.waitSession(tabId, (s) => s.translation.done > 0, { timeout: 30_000 });
        await expect(
          fc.ui.page.getByRole('tab', { name: m('sidepanel.tabs.settings'), exact: true }),
        ).toBeVisible();
        await shot(locale, fc.ui.page, 'sidepanel-running.png', { fullPage: true });

        // 工具栏弹窗：先让观看页回到前台，弹窗才会显示真实的当前视频而不是自己所在的标签页
        const popup = await fc.ext.context.newPage();
        await popup.setViewportSize({ width: 360, height: 560 });
        await popup.goto(`chrome-extension://${fc.ext.extensionId}/popup.html`);
        await expect(
          popup.getByRole('button', { name: m('sidepanel.popup.openSidePanel') }),
        ).toBeVisible();
        await page.bringToFront();
        await expect(popup.getByLabel(m('sidepanel.popup.currentTab'))).toContainText(
          'Fixture: noticing small details',
          { timeout: 30_000 },
        );
        await shot(locale, popup, 'popup.png', { fullPage: true });
        await popup.close();

        // 字幕工作台：读取本次会话写入 IndexedDB 的记录，并选中它显示正文
        expect(session.recordId).toBeTruthy();
        const workspace = await fc.ext.context.newPage();
        await workspace.setViewportSize({ width: 1180, height: 980 });
        await workspace.goto(`chrome-extension://${fc.ext.extensionId}/workspace.html`);
        await expect(
          workspace.getByRole('heading', { name: m('options.workspace.title') }),
        ).toBeVisible();
        const record = workspace.getByRole('button', { name: /Fixture: noticing small details/ });
        await expect(record).toBeVisible({ timeout: 30_000 });
        await record.click();
        await expect(workspace.getByText(m('options.workspace.noneSelected'))).toHaveCount(0, {
          timeout: 30_000,
        });
        await expect(workspace.getByText(SENTENCES[0]![1], { exact: true }).first()).toBeVisible();
        await shot(locale, workspace, 'workspace.png', { fullPage: true });
        await workspace.close();
      } finally {
        await fc?.close();
      }
    });
  }
});

/** 搜索按钮文案带搜索词语言名（随界面语言变化），按模板前后缀匹配。 */
function generateButton(locale: Locale): RegExp {
  const [before, after] = translate(locale, 'sidepanel.search.generate', {
    keyword: '\u0000',
  }).split('\u0000');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escape(before!)}.+${escape(after!)}$`);
}

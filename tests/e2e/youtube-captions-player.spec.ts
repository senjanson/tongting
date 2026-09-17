/**
 * 夹具播放器行为改进后的字幕获取 E2E（真实协调器 + 本地夹具 + mock sub2api）。
 *
 * 覆盖 youtube-agent 提出的夹具需求（播放器行为均为推断模拟，见 fixtures/youtube/fake-player.js 顶部）：
 * 1. 目标轨道已激活时播放器不重新请求 timedtext；
 * 2. tlang 自动翻译；
 * 3. 页面加载时播放器立即请求正文（早于内容脚本就绪）；
 * 4. 播放器延迟初始化（getPlayerResponse 晚于元数据重试计划出现）；
 * 5. getOption 反映真实开关与轨道；
 * 6. 导航不重置字幕开关，开关与所选轨道跨视频保留。
 * 每个用例验证拿到完整轨道，或正确退回「当前显示字幕」并给出提示，并检查结束后原生字幕状态。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 */
import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  configureProvider,
  openWatch,
  overlayState,
  setupFullChain,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import {
  installContentTap,
  tapMessages,
  wakeContent,
  activeTabId,
  type TapMessage,
} from './helpers/content-tap';
import type { CaptionLine, FixtureVideo, PlayerOptions } from './fixtures/full-chain/youtube';

test.describe.configure({ timeout: 150_000 });

const VIDEO_A = 'AAAAAAAAAAA';
const VIDEO_D = 'DDDDDDDDDDD';
const VIDEO_E = 'EEEEEEEEEEE';
const lines = (prefix: string): CaptionLine[] =>
  Array.from({ length: 6 }, (_, i) => ({
    startMs: 500 + i * 3_000,
    durationMs: 2_800,
    text: `${prefix} caption ${i + 1} is here.`,
  }));
const LINES_A = lines('Alpha');
const LINES_D = lines('Delta');
const LINES_E = lines('Echo');

let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

async function setup(videos: FixtureVideo[], playerOptions: PlayerOptions = {}) {
  fc = await setupFullChain({ videos, playerOptions });
  await installContentTap(fc.ext.serviceWorker);
  await configureProvider(fc);
  return fc;
}

const fixture = (page: Page) =>
  page.evaluate(() => {
    const f = (
      window as unknown as {
        __fixture: { calls: unknown[][]; captionsOn: boolean; timedtextLog: unknown[] };
      }
    ).__fixture;
    const p = document.getElementById('movie_player') as unknown as {
      getOption?(m: string, o: string): unknown;
    };
    return {
      calls: f.calls,
      captionsOn: f.captionsOn,
      track: p.getOption ? p.getOption('captions', 'track') : 'no-api',
      nativeText: document.querySelector('.ytp-caption-window-container')?.textContent ?? '',
      nativeVisibility: getComputedStyle(document.querySelector('.ytp-caption-window-container')!)
        .visibility,
    };
  });

async function trackData(sw: Worker, videoId: string, after = 0): Promise<TapMessage> {
  let found: TapMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await tapMessages(sw)).filter(
          (m) => m.type === 'captions/track-data' && m.videoId === videoId,
        )[after];
        return !!found;
      },
      { timeout: 30_000, message: `等待 ${videoId} 的 track-data` },
    )
    .toBe(true);
  return found!;
}

const texts = (m: TapMessage) => (m.cues as Array<{ text: string }>).map((c) => c.text);
const potHits = (f: FullChain, videoId: string) =>
  f.route.timedtext.filter((t) => t.withPot && t.videoId === videoId);

test('轨道已激活但正文未缓存：桥先关再开让播放器重新请求，拿到完整轨道；同轨道重复设置不会重新请求', async () => {
  const f = await setup(
    [{ videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: LINES_A, timedtextFailFirst: 1 }],
    {
      captionsDefault: { languageCode: 'en' },
    },
  );
  const { page, tabId } = await openWatch(f, VIDEO_A);
  await expect.poll(() => potHits(f, VIDEO_A).length).toBe(1);
  const before = await fixture(page);
  expect(before.captionsOn).toBe(true);
  expect(before.track).toMatchObject({ languageCode: 'en', vss_id: '.en' });

  // 夹具行为自检：同一轨道再次设置是 noop，不请求 timedtext。
  await page.evaluate(() =>
    (
      window as unknown as { __fixture: { userSetCaptions(o: unknown): void } }
    ).__fixture.userSetCaptions({
      languageCode: 'en',
    }),
  );
  await page.waitForTimeout(500);
  expect(potHits(f, VIDEO_A)).toHaveLength(1);
  expect((await fixture(page)).calls.some((c) => c[0] === 'noop-same-track')).toBe(true);

  await f.ui.ok({ kind: 'session/start', tabId });
  const s = await f.ui.waitSession(
    tabId,
    (x) => x.phase === 'running' && x.sourceMode === 'full-track',
    {
      timeout: 40_000,
      message: '完整轨道',
    },
  );
  const data = await trackData(f.ext.serviceWorker, VIDEO_A);
  expect(data).toMatchObject({ complete: true, rejectedCount: 0 });
  expect(texts(data)).toEqual(LINES_A.map((l) => l.text));
  expect(potHits(f, VIDEO_A)).toHaveLength(2);
  const setCalls = (await fixture(page)).calls.filter((c) => c[0] === 'setOption');
  // 用户自检那次之后，桥发出 {} 再发出 en。
  expect(setCalls.slice(-2)).toEqual([
    ['setOption', 'captions', 'track', {}],
    ['setOption', 'captions', 'track', { languageCode: 'en', kind: '' }],
  ]);

  // 结束：恢复用户原来的开关（开启 en）。
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: s.identity.sessionId });
  await expect.poll(async () => (await fixture(page)).track).toMatchObject({ languageCode: 'en' });
  expect((await fixture(page)).nativeVisibility).toBe('visible');
});

test('tlang 自动翻译开启：桥切回原文轨道拿到完整原文，结束后恢复自动翻译', async () => {
  const f = await setup([{ videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: LINES_A }], {
    captionsDefault: {
      languageCode: 'en',
      translationLanguage: { languageCode: 'zh-Hans', languageName: 'Chinese' },
    },
  });
  const { page, tabId } = await openWatch(f, VIDEO_A);
  await expect.poll(() => potHits(f, VIDEO_A).map((h) => h.tlang)).toEqual(['zh-Hans']);
  expect((await fixture(page)).track).toMatchObject({
    languageCode: 'en',
    translationLanguage: { languageCode: 'zh-Hans' },
  });

  await f.ui.ok({ kind: 'session/start', tabId });
  const s = await f.ui.waitSession(
    tabId,
    (x) => x.phase === 'running' && x.sourceMode === 'full-track',
    {
      timeout: 40_000,
      message: '完整原文轨道',
    },
  );
  const data = await trackData(f.ext.serviceWorker, VIDEO_A);
  expect(data.complete).toBe(true);
  expect(texts(data)).toEqual(LINES_A.map((l) => l.text));
  expect(texts(data).some((t) => t.includes('[auto-'))).toBe(false);
  expect(potHits(f, VIDEO_A).map((h) => h.tlang)).toEqual(['zh-Hans', null]);

  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: s.identity.sessionId });
  await expect
    .poll(async () => (await fixture(page)).track, { message: '恢复自动翻译' })
    .toMatchObject({ languageCode: 'en', translationLanguage: { languageCode: 'zh-Hans' } });
  await expect
    .poll(() => potHits(f, VIDEO_A).map((h) => h.tlang))
    .toEqual(['zh-Hans', null, 'zh-Hans']);
  await video(page).seek(3.6);
  await expect
    .poll(async () => (await fixture(page)).nativeText)
    .toBe('[auto-zh-Hans] Alpha caption 2 is here.');
  expect((await fixture(page)).nativeVisibility).toBe('visible');
});

test('页面加载时播放器立即请求正文（早于内容脚本连接）：开始后用缓存重放，不再驱动播放器', async () => {
  const f = await setup([{ videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: LINES_A }], {
    captionsDefault: { languageCode: 'en' },
  });
  const { page, tabId } = await openWatch(f, VIDEO_A);
  const firstHit = potHits(f, VIDEO_A)[0]!;
  const firstMsg = (await tapMessages(f.ext.serviceWorker))[0]!;
  expect(firstHit.at).toBeLessThan(firstMsg.__at);
  await f.ui.ok({ kind: 'session/start', tabId });
  await f.ui.waitSession(tabId, (x) => x.phase === 'running' && x.sourceMode === 'full-track', {
    timeout: 30_000,
    message: '完整轨道',
  });
  const data = await trackData(f.ext.serviceWorker, VIDEO_A);
  expect(data.complete).toBe(true);
  expect(texts(data)).toEqual(LINES_A.map((l) => l.text));
  expect(potHits(f, VIDEO_A)).toHaveLength(1);
  expect((await fixture(page)).calls.filter((c) => c[0] === 'setOption')).toHaveLength(0);
  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({ bodyBeforeConnectMs: firstMsg.__at - firstHit.at }),
  });
});

// 元数据重试计划 [0, 300, 1000, 2500, 5000, 10000] ms，最后一次后 2 s 报告 captions-bridge-unavailable；
// 会话等待轨道列表上限 tracksWaitMs = 14 s（目标：约 13 s 内就绪的播放器都能拿到轨道）；starting 期间内容脚本每 500 ms 轮询元数据。
const DELAY_CASES = [
  { variant: 'init-before-start', initDelayMs: 14_000, label: '延迟 14 s，初始化后开始' },
  {
    variant: 'start-before-init',
    initDelayMs: 11_000,
    label: '延迟 11 s，初始化前就开始（在会话等待上限内）',
  },
  {
    variant: 'start-before-init',
    initDelayMs: 12_500,
    label: '延迟 12.5 s，初始化前就开始（接近会话等待上限）',
  },
  {
    variant: 'start-before-init-beyond-wait',
    initDelayMs: 16_000,
    label: '延迟 16 s，初始化前就开始（超过会话等待上限）',
  },
] as const;
for (const { variant, initDelayMs, label } of DELAY_CASES) {
  test(`播放器延迟初始化（晚于元数据重试计划）：${label}`, async () => {
    const f = await setup(
      [{ videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: LINES_A }],
      {
        initDelayMs,
      },
    );
    const sw = f.ext.serviceWorker;
    const page = await f.ext.context.newPage();
    const loadedAt = Date.now();
    await page.goto(`https://www.youtube.com/watch?v=${VIDEO_A}`);
    await page.bringToFront();
    const tabId = await activeTabId(sw);
    await wakeContent(sw, tabId);
    await f.ui.waitPage(VIDEO_A, (p) => p.tabId === tabId, 10_000);
    expect(await video(page).play()).toBe(true);
    if (variant === 'init-before-start') {
      // 重试计划结束后报告桥不可用（可用性仍为 unknown）。
      await expect
        .poll(
          async () =>
            (await tapMessages(sw)).find((m) => m.type === 'captions/error')?.error as
              { code?: string } | undefined,
          { timeout: 20_000 },
        )
        .toMatchObject({ code: 'captions-bridge-unavailable' });
      expect(
        (await f.ui.snapshot())!.pages.find((p) => p.tabId === tabId)?.captionsAvailability,
      ).toBe('unknown');
      await expect
        .poll(
          () =>
            page.evaluate(
              () => (window as unknown as { __fixture: { ready: boolean } }).__fixture.ready,
            ),
          { timeout: 10_000 },
        )
        .toBe(true);
      await page.waitForTimeout(500);
    }
    const startedAt = Date.now();
    await f.ui.ok({ kind: 'session/start', tabId });
    const s = await f.ui.waitSession(
      tabId,
      (x) => (x.phase === 'running' && x.sourceMode !== 'none') || x.phase === 'error',
      {
        timeout: 45_000,
        message: '会话结果',
      },
    );
    const snap = (await f.ui.snapshot())!;
    test.info().annotations.push({
      type: 'evidence',
      description: JSON.stringify({
        variant,
        startAfterLoadMs: startedAt - loadedAt,
        phase: s.phase,
        sourceMode: s.sourceMode,
        notice: s.notice?.code,
        error: s.error?.code,
        errorMessage: s.error?.message,
        capture: s.resources.capture,
        availability: snap.pages.find((p) => p.tabId === tabId)?.captionsAvailability,
        settledAfterLoadMs: Date.now() - loadedAt,
        tracksAvailableAfterLoadMs: await tapMessages(sw).then((ms) => {
          const m = ms.find((x) => x.type === 'captions/tracks' && x.availability === 'available');
          return m ? m.__at - loadedAt : null;
        }),
      }),
    });
    if (variant === 'start-before-init-beyond-wait') {
      // 超过有界等待：不无限等待，也不能启动识别捕获；记录实际提示（见验证文档中的观察项）。
      expect(s.phase).toBe('error');
      // 缺陷 #2 修复后：availability 仍为 unknown 时报「页面字幕接入尚未就绪」，不再声称视频没有字幕。
      expect(s.error?.code).toBe('captions-not-ready');
      expect(s.error?.message).not.toContain('没有可读取的字幕');
      expect(s.resources.capture).toBe('none');
      expect(s.sourceMode).toBe('none');
      return;
    }
    expect(s.phase).toBe('running');
    expect(s.sourceMode).toBe('full-track');
    const data = await trackData(sw, VIDEO_A);
    expect(data.complete).toBe(true);
    expect(texts(data)).toEqual(LINES_A.map((l) => l.text));
  });
}

test('字幕开关跨视频保留：导航后播放器自动请求新视频正文，会话用缓存；结束后按用户原状态恢复', async () => {
  const videos: FixtureVideo[] = [
    { videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: LINES_A },
    { videoId: VIDEO_D, title: 'D', lengthSeconds: 20, captions: LINES_D },
    { videoId: VIDEO_E, title: 'E', lengthSeconds: 20, captions: LINES_E },
  ];
  const f = await setup(videos);
  const { page, tabId } = await openWatch(f, VIDEO_A);
  const sw = f.ext.serviceWorker;

  // 情况一：用户自己在 A 打开 en 字幕，导航到 D 后开关保留、播放器自动请求 D 的正文。
  await page.evaluate(() =>
    (
      window as unknown as { __fixture: { userSetCaptions(o: unknown): void } }
    ).__fixture.userSetCaptions({
      languageCode: 'en',
    }),
  );
  await expect.poll(() => potHits(f, VIDEO_A).length).toBe(1);
  await video(page).navigate(VIDEO_D);
  await expect.poll(() => potHits(f, VIDEO_D).length).toBe(1);
  expect((await fixture(page)).track).toMatchObject({ languageCode: 'en' });
  await f.ui.waitPage(VIDEO_D, (p) => p.tabId === tabId && p.captionsAvailability === 'available');
  await f.ui.ok({ kind: 'session/start', tabId });
  const sD = await f.ui.waitSession(
    tabId,
    (x) => x.phase === 'running' && x.sourceMode === 'full-track' && x.identity.videoId === VIDEO_D,
    {
      timeout: 30_000,
    },
  );
  const dataD = await trackData(sw, VIDEO_D);
  expect(texts(dataD)).toEqual(LINES_D.map((l) => l.text));
  expect(potHits(f, VIDEO_D)).toHaveLength(1);
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: sD.identity.sessionId });
  await f.ui.waitSnapshot((x) => !x.sessions.some((y) => y.identity.tabId === tabId));
  await expect.poll(async () => (await fixture(page)).track).toMatchObject({ languageCode: 'en' });

  // 情况二：用户关闭字幕后进入 E（E 的正文不在桥缓存中，A/D 已缓存会直接重放、不会改动开关）；
  // 会话在 E 打开 en，会话中导航到 D（开关随导航保留），导航结束会话后应恢复为用户原来的关闭状态。
  await page.evaluate(() =>
    (
      window as unknown as { __fixture: { userSetCaptions(o: unknown): void } }
    ).__fixture.userSetCaptions({}),
  );
  await video(page).navigate(VIDEO_E);
  await f.ui.waitPage(VIDEO_E, (p) => p.tabId === tabId && p.captionsAvailability === 'available');
  expect((await fixture(page)).track).toEqual({});
  await f.ui.ok({ kind: 'session/start', tabId });
  await f.ui.waitSession(
    tabId,
    (x) => x.phase === 'running' && x.sourceMode === 'full-track' && x.identity.videoId === VIDEO_E,
    {
      timeout: 30_000,
    },
  );
  expect((await fixture(page)).track).toMatchObject({ languageCode: 'en' });
  expect(potHits(f, VIDEO_E)).toHaveLength(1);
  const hitsDBefore = potHits(f, VIDEO_D).length;
  await video(page).navigate(VIDEO_D);
  await f.ui.waitPage(VIDEO_D, (p) => p.tabId === tabId);
  await expect
    .poll(async () => (await fixture(page)).track, {
      timeout: 15_000,
      message: '导航后恢复用户原来的关闭状态',
    })
    .toEqual({});
  await page.waitForTimeout(1_000);
  const end = await fixture(page);
  expect(end.track).toEqual({});
  expect(end.captionsOn).toBe(false);
  expect(end.nativeText).toBe('');
  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({
      hitsDBefore,
      hitsDAfter: potHits(f, VIDEO_D).length,
      sessionsAfterNav: (await f.ui.snapshot())!.sessions.map((x) => ({
        v: x.identity.videoId,
        phase: x.phase,
      })),
    }),
  });
});

test('字幕轨道来源的覆盖层：句间空隙不显示上一句（识别模式的延迟显示不影响字幕轨道来源）', async () => {
  const gapLines: CaptionLine[] = [
    { startMs: 500, durationMs: 2_000, text: 'Before the gap line.' },
    { startMs: 6_000, durationMs: 2_000, text: 'After the gap line.' },
  ];
  const f = await setup([{ videoId: VIDEO_A, title: 'A', lengthSeconds: 20, captions: gapLines }]);
  const { page, tabId } = await openWatch(f, VIDEO_A);
  await f.ui.ok({ kind: 'session/start', tabId });
  await f.ui.waitSession(
    tabId,
    (x) =>
      x.phase === 'running' &&
      x.sourceMode === 'full-track' &&
      x.translation.total > 0 &&
      x.translation.done === x.translation.total,
    { timeout: 30_000, message: '字幕轨道全部翻译' },
  );
  await video(page).seek(1.5);
  await waitOverlay(
    page,
    (o) => o.main === mockTranslation('zh-CN', gapLines[0]!.text),
    15_000,
    '第一句译文',
  );
  // 空隙内（第一句结束 1.5 s 后）：不保留上一句。
  await video(page).seek(4.0);
  const gap = await waitOverlay(
    page,
    (o) => !o.main || o.mainHidden === true || o.hidden === true,
    10_000,
    '句间空隙隐藏字幕',
  );
  await page.waitForTimeout(1_000);
  const still = await overlayState(page);
  expect(!still.main || still.mainHidden === true || still.hidden === true).toBe(true);
  // 连续播放穿过空隙：空隙期间的采样都不显示上一句。
  await video(page).seek(2.2);
  expect(await video(page).play()).toBe(true);
  const visibleInGap: string[] = [];
  for (let i = 0; i < 24; i++) {
    const st = await video(page).state();
    const o = await overlayState(page);
    if (
      st.currentTimeMs > 2_700 &&
      st.currentTimeMs < 5_800 &&
      o.main &&
      !o.mainHidden &&
      !o.hidden
    ) {
      visibleInGap.push(`${st.currentTimeMs}:${o.main}`);
    }
    if (st.currentTimeMs >= 6_500) break;
    await page.waitForTimeout(200);
  }
  await waitOverlay(
    page,
    (o) => o.main === mockTranslation('zh-CN', gapLines[1]!.text),
    10_000,
    '第二句译文',
  );
  test
    .info()
    .annotations.push({ type: 'evidence', description: JSON.stringify({ gap, visibleInGap }) });
  expect(visibleInGap).toEqual([]);
});

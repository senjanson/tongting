/**
 * YouTube 页面接入 E2E（真实协调器）：在 Playwright Chromium 中加载 E2E 构建的扩展，service worker 是真实协调器，
 * YouTube 请求全部路由到本地人工构造夹具，sub2api 为本地 mock（假 Key）。
 *
 * 观察方式：
 * - UI 端口快照（pages / sessions），驱动页为 /options.html（该页面不会唤醒内容脚本，便于验证空闲不连接）；
 * - 内容脚本 → worker 消息用被动观察器记录（helpers/content-tap.ts，只追加监听，不回复、不替换协调器）；
 * - worker → 内容脚本方向（session/state、session/cues、request）由真实协调器产生，通过页面 DOM 结果验证。
 * 唤醒使用产品定义的 tongting:content-wake 消息，从扩展 worker 发送。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 */
import { expect, test, type Page, type Worker } from '@playwright/test';
import {
  configureProvider,
  overlayState,
  setupFullChain,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { UiDriver } from './helpers/ui-driver';
import { cdpEvaluator, freePort, isExtensionWorker } from './helpers/cdp';
import {
  activeTabId,
  installContentTap,
  tapMessages,
  tapState,
  wakeContent,
  type TapMessage,
} from './helpers/content-tap';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import type { CaptionLine, FixtureVideo } from './fixtures/full-chain/youtube';

test.describe.configure({ timeout: 120_000 });

const VIDEO_A = 'AAAAAAAAAAA';
const VIDEO_B = 'BBBBBBBBBBB';
const VIDEO_C = 'CCCCCCCCCCC';
const XSS_TEXT = 'This caption has <img src=x onerror="window.__ttXss=1"> inside.';
const LINES: CaptionLine[] = [
  { startMs: 500, durationMs: 2_500, text: 'Welcome to the fixture video.' },
  { startMs: 3_000, durationMs: 3_000, text: XSS_TEXT },
  {
    startMs: 6_000,
    durationMs: 3_000,
    text: 'Numbers like 3.5 and names like Mr. Smith stay intact.',
  },
  { startMs: 9_000, durationMs: 4_000, text: 'The end of the' },
  { startMs: 13_000, durationMs: 4_000, text: 'fixture captions.' },
];
const VIDEOS: FixtureVideo[] = [
  {
    videoId: VIDEO_A,
    title: 'Fixture Video A',
    lengthSeconds: 20,
    captions: LINES,
    tracks: [
      { lang: 'en', kind: null, name: 'English', vss: '.en' },
      { lang: 'en', kind: 'asr', name: 'English (auto-generated)', vss: 'a.en' },
    ],
  },
  { videoId: VIDEO_B, title: 'Fixture Video B', lengthSeconds: 20 },
  {
    videoId: VIDEO_C,
    title: 'Fixture Video C (timedtext blocked)',
    lengthSeconds: 20,
    captions: LINES,
    timedtextBlocked: true,
  },
];

let fc: FullChain | undefined;

test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

async function setup(cdpPort?: number): Promise<{ fc: FullChain; sw: Worker }> {
  fc = await setupFullChain({
    videos: VIDEOS,
    uiPath: '/options.html',
    extraArgs: () => (cdpPort ? [`--remote-debugging-port=${cdpPort}`] : []),
  });
  await installContentTap(fc.ext.serviceWorker);
  await configureProvider(fc);
  return { fc, sw: fc.ext.serviceWorker };
}

async function waitTap(
  sw: Worker,
  predicate: (m: TapMessage) => boolean,
  timeout = 15_000,
  message = '等待内容脚本消息',
): Promise<TapMessage> {
  let found: TapMessage | undefined;
  await expect
    .poll(
      async () => {
        found = (await tapMessages(sw)).find(predicate);
        return !!found;
      },
      { timeout, message },
    )
    .toBe(true);
  return found!;
}

async function openIdle(
  f: FullChain,
  sw: Worker,
  videoId: string,
): Promise<{ page: Page; tabId: number }> {
  const page = await f.ext.context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
  await page.bringToFront();
  const tabId = await activeTabId(sw);
  return { page, tabId };
}

async function openAwake(f: FullChain, sw: Worker, videoId: string) {
  const opened = await openIdle(f, sw, videoId);
  await wakeContent(sw, opened.tabId);
  await f.ui.waitPage(
    videoId,
    (p) => p.tabId === opened.tabId && p.captionsAvailability !== 'unknown',
  );
  return opened;
}

const fixtureCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fixture: { calls: unknown[][] } }).__fixture.calls);

test('空闲不连接；唤醒后 hello + 完整状态；上报视频/轨道/播放器事件；经播放器加载完整轨道', async () => {
  const { fc: f, sw } = await setup();
  const { page, tabId } = await openIdle(f, sw, VIDEO_A);

  // 空闲：页面加载、元数据就绪、播放器事件都不连接 worker。
  await page.waitForTimeout(3_000);
  await video(page).seek(2);
  await page.waitForTimeout(1_000);
  expect((await tapState(sw)).connects).toBe(0);
  expect((await f.ui.snapshot())!.pages.some((p) => p.tabId === tabId)).toBe(false);

  // 唤醒：连接并按 hello → page/video → captions/tracks → player/state 重放完整状态。
  await wakeContent(sw, tabId);
  await expect.poll(async () => (await tapState(sw)).connects).toBe(1);
  await expect
    .poll(async () => (await tapMessages(sw)).slice(0, 4).map((m) => m.type))
    .toEqual(['hello', 'page/video', 'captions/tracks', 'player/state']);
  const first = await tapMessages(sw);
  expect(first[0]).toMatchObject({
    type: 'hello',
    protocolVersion: 1,
    __frameId: 0,
    __tabId: tabId,
  });
  expect(first[1]).toMatchObject({
    videoId: VIDEO_A,
    title: 'Fixture Video A',
    channel: 'Fixture Channel',
  });
  expect(first[2]).toMatchObject({ videoId: VIDEO_A, availability: 'available' });
  expect(first[2]!.tracks).toEqual([
    { trackKey: '.en', languageCode: 'en', label: 'English', kind: 'manual' },
    { trackKey: 'a.en', languageCode: 'en', label: 'English (auto-generated)', kind: 'asr' },
  ]);
  expect((first[3]!.state as { currentTimeMs: number }).currentTimeMs).toBeGreaterThanOrEqual(
    1_900,
  );
  const pageInfo = await f.ui.waitPage(
    VIDEO_A,
    (p) => p.tabId === tabId && p.captionsAvailability === 'available',
  );
  expect(pageInfo.title).toBe('Fixture Video A');
  expect(pageInfo.tracks).toHaveLength(2);

  // 已连接时的播放器事件（无会话）：play / seeked / ratechange 上报，快照跟随。
  expect(await video(page).play()).toBe(true);
  await waitTap(sw, (m) => m.type === 'player/state' && m.reason === 'play');
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#movie_player video')!;
    v.currentTime = 4;
    v.playbackRate = 1.5;
  });
  await waitTap(
    sw,
    (m) =>
      m.type === 'player/state' &&
      m.reason === 'seeked' &&
      (m.state as { currentTimeMs: number }).currentTimeMs >= 3_900,
  );
  await waitTap(
    sw,
    (m) =>
      m.type === 'player/state' &&
      m.reason === 'ratechange' &&
      (m.state as { playbackRate: number }).playbackRate === 1.5,
  );
  await f.ui.waitPage(VIDEO_A, (p) => p.player?.playbackRate === 1.5);
  await video(page).pause();
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('#movie_player video')!.playbackRate = 1;
  });

  // 开始翻译：真实协调器请求 captions/load-track，由播放器自己请求（带 pot），桥被动捕获。
  await f.ui.ok({ kind: 'session/start', tabId });
  const s1 = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'full-track',
    {
      timeout: 30_000,
      message: '会话以完整轨道运行',
    },
  );
  const data = await waitTap(sw, (m) => m.type === 'captions/track-data');
  expect(data).toMatchObject({
    videoId: VIDEO_A,
    complete: true,
    format: 'json3',
    rejectedCount: 0,
    track: { trackKey: '.en', kind: 'manual' },
  });
  expect((data.cues as Array<{ text: string }>).map((c) => c.text)).toEqual(
    LINES.map((l) => l.text),
  );
  const potHits = () => f.route.timedtext.filter((t) => t.withPot).length;
  expect(potHits()).toBe(1);
  expect(f.route.timedtext.filter((t) => !t.withPot)).toHaveLength(0);
  expect(await fixtureCalls(page)).toContainEqual([
    'setOption',
    'captions',
    'track',
    { languageCode: 'en', kind: '' },
  ]);
  await expect(page.locator('#movie_player')).toHaveAttribute('data-tongting-hide-native', '');

  // 停止后再次开始：同一轨道由桥缓存重放，不再驱动播放器、不再请求 timedtext。
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: s1.identity.sessionId });
  await f.ui.waitSnapshot((s) => !s.sessions.some((x) => x.identity.tabId === tabId), {
    message: '会话结束',
  });
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-tongting-hide-native', '');
  const setOptionsBefore = (await fixtureCalls(page)).filter((c) => c[0] === 'setOption').length;
  const trackDataBefore = (await tapMessages(sw)).filter(
    (m) => m.type === 'captions/track-data',
  ).length;
  await f.ui.ok({ kind: 'session/start', tabId });
  const s2 = await f.ui.waitSession(
    tabId,
    (s) =>
      s.phase === 'running' &&
      s.sourceMode === 'full-track' &&
      s.identity.sessionId !== s1.identity.sessionId,
    { timeout: 30_000, message: '第二个会话以完整轨道运行' },
  );
  await expect
    .poll(
      async () => (await tapMessages(sw)).filter((m) => m.type === 'captions/track-data').length,
    )
    .toBeGreaterThan(trackDataBefore);
  expect(potHits()).toBe(1);
  expect((await fixtureCalls(page)).filter((c) => c[0] === 'setOption').length).toBe(
    setOptionsBefore,
  );

  // 不得把带签名/pot 的 URL 发给 worker。
  const all = JSON.stringify(await tapMessages(sw));
  expect(all).not.toContain('FIXTURESIG');
  expect(all).not.toContain('FIXTUREPOT');
  expect(all).not.toContain('/api/timedtext');
  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({
      sessions: [s1.identity.sessionId, s2.identity.sessionId],
      potHits: potHits(),
      setOptionsBefore,
    }),
  });
});

test('覆盖层：只挂载一次、HTML 文本按纯文本显示、全屏仍在、广告隐藏、会话结束后清理', async () => {
  const { fc: f, sw } = await setup();
  const { page, tabId } = await openAwake(f, sw, VIDEO_A);
  await expect(page.locator('[data-tongting-overlay]')).toHaveCount(0);
  await f.ui.ok({ kind: 'session/start', tabId });
  const session = await f.ui.waitSession(
    tabId,
    (s) =>
      s.phase === 'running' &&
      s.translation.total > 0 &&
      s.translation.done === s.translation.total,
    {
      timeout: 30_000,
      message: '全部字幕翻译完成',
    },
  );
  await video(page).seek(3.5);
  const ov = await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', XSS_TEXT),
    15_000,
    'XSS 字幕译文',
  );
  expect(ov).toMatchObject({ hosts: 1, secondary: XSS_TEXT, shadowElements: 0 });
  expect(ov.badge).toContain('翻译中');
  expect(ov.badge).not.toContain('译听 · 译听');
  expect(await page.locator('#movie_player > [data-tongting-overlay]').count()).toBe(1);
  expect(
    await page.evaluate(() => (window as unknown as { __ttXss?: number }).__ttXss),
  ).toBeUndefined();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.querySelector('[data-tongting-overlay]')!).pointerEvents,
    ),
  ).toBe('none');

  // 全屏：覆盖层仍在全屏子树中，且只有一个。
  await page.click('#fixture-fullscreen');
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null))
    .toBe('movie_player');
  expect(
    await page.evaluate(() =>
      document.fullscreenElement!.contains(document.querySelector('[data-tongting-overlay]')),
    ),
  ).toBe(true);
  await waitTap(
    sw,
    (m) =>
      m.type === 'player/state' &&
      m.reason === 'fullscreen' &&
      (m.state as { fullscreen: boolean }).fullscreen === true,
  );
  expect((await overlayState(page)).hosts).toBe(1);
  await page.evaluate(() => document.exitFullscreen());

  // 广告期间不显示字幕。
  const setAd = (on: boolean) =>
    page.evaluate(
      (v) => (window as unknown as { __fixture: { setAd(on: boolean): void } }).__fixture.setAd(v),
      on,
    );
  await setAd(true);
  await waitTap(sw, (m) => m.type === 'player/state' && m.reason === 'ad-start');
  await expect(page.locator('[data-tongting-overlay] .main')).toBeHidden();
  await setAd(false);
  await expect(page.locator('[data-tongting-overlay] .main')).toBeVisible();

  // 会话结束：移除覆盖层与原生字幕隐藏。
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: session.identity.sessionId });
  await expect(page.locator('[data-tongting-overlay]')).toHaveCount(0);
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-tongting-hide-native', '');
});

test('SPA A→B→A：navigationId 各不相同；video 元素替换后旧监听器解绑', async () => {
  const { fc: f, sw } = await setup();
  const { page, tabId } = await openAwake(f, sw, VIDEO_A);
  await waitTap(sw, (m) => m.type === 'captions/tracks' && m.availability === 'available');
  await video(page).navigate(VIDEO_B);
  await waitTap(
    sw,
    (m) =>
      m.type === 'captions/tracks' && m.videoId === VIDEO_B && m.availability === 'unavailable',
  );
  await f.ui.waitPage(
    VIDEO_B,
    (p) => p.tabId === tabId && p.captionsAvailability === 'unavailable',
  );
  await video(page).navigate(VIDEO_A);
  // 同一导航内 page/video 可能发送多次（导航时一次、播放器元数据就绪后再补一次），按 navigationId 归并。
  const byNav = async () => {
    const map = new Map<number, unknown>();
    for (const m of await tapMessages(sw))
      if (m.type === 'page/video') map.set(m.navigationId as number, m.videoId);
    return [...map.entries()];
  };
  await expect
    .poll(async () => (await byNav()).map(([, v]) => v))
    .toEqual([VIDEO_A, VIDEO_B, VIDEO_A]);
  const ids = (await byNav()).map(([n]) => n);
  expect(new Set(ids).size).toBe(3);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  for (const m of await tapMessages(sw)) {
    if (m.type === 'page/video' || m.type === 'captions/tracks') {
      expect(m.videoId).toBe(new Map(await byNav()).get(m.navigationId as number));
    }
  }
  const lastTracks = await waitTap(
    sw,
    (m) =>
      m.type === 'captions/tracks' && m.navigationId === ids[2] && m.availability === 'available',
  );
  expect(lastTracks.videoId).toBe(VIDEO_A);
  await f.ui.waitPage(VIDEO_A, (p) => p.tabId === tabId && p.captionsAvailability === 'available');

  // 有会话时替换 video 元素：上报 video-replaced，旧元素事件不再上报，新元素事件上报。
  await f.ui.ok({ kind: 'session/start', tabId });
  await f.ui.waitSession(tabId, (s) => s.phase === 'running', { timeout: 30_000 });
  const count = async (pred: (m: TapMessage) => boolean) =>
    (await tapMessages(sw)).filter(pred).length;
  const isRate = (m: TapMessage) => m.type === 'player/state' && m.reason === 'ratechange';
  const replacedBefore = await count(
    (m) => m.type === 'player/state' && m.reason === 'video-replaced',
  );
  await page.evaluate(() =>
    (window as unknown as { __fixture: { replaceVideo(): boolean } }).__fixture.replaceVideo(),
  );
  await expect
    .poll(() => count((m) => m.type === 'player/state' && m.reason === 'video-replaced'))
    .toBeGreaterThan(replacedBefore);
  const rateBefore = await count(isRate);
  await page.evaluate(() => {
    (window as unknown as { __fixtureOldVideo: HTMLVideoElement }).__fixtureOldVideo.playbackRate =
      2;
  });
  await page.waitForTimeout(800);
  expect(await count(isRate)).toBe(rateBefore);
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('#movie_player video')!.playbackRate = 0.75;
  });
  await waitTap(
    sw,
    (m) => isRate(m) && (m.state as { playbackRate: number }).playbackRate === 0.75,
  );
  await expect(page.locator('#movie_player video')).toHaveCount(1);
  await f.ui.waitPage(VIDEO_A, (p) => p.player?.playbackRate === 0.75);
});

test('worker 重启后内容脚本空闲不重连，唤醒后以新 hello 与完整状态重新登记', async () => {
  const cdpPort = await freePort();
  const { fc: f, sw } = await setup(cdpPort);
  const { page, tabId } = await openAwake(f, sw, VIDEO_A);
  await video(page).seek(7);
  await f.ui.waitPage(VIDEO_A, (p) => (p.player?.currentTimeMs ?? 0) >= 6_900);
  const before = (await f.ui.snapshot())!;
  const connectsBefore = (await tapState(sw)).connects;
  expect(connectsBefore).toBe(1);

  const cdp = await f.ext.context.newCDPSession(f.ui.page);
  await cdp.send('ServiceWorker.enable');
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await expect.poll(async () => (await f.ui.stats()).disconnected, { timeout: 10_000 }).toBe(true);
  await f.ui.close();
  f.ui = await UiDriver.open(f.ext.context, f.ext.extensionId, '/options.html');
  await f.ui.waitSnapshot((s) => s.workerInstanceId !== before.workerInstanceId, {
    message: '新 worker',
  });
  // Playwright 不为重启后的 worker 提供新句柄：经 CDP 在新 worker 中安装观察器。
  const sw2 = cdpEvaluator(cdpPort, isExtensionWorker(f.ext.extensionId));
  await expect
    .poll(() =>
      sw2(() => (globalThis as { __e2eTap?: unknown }).__e2eTap === undefined).catch(() => null),
    )
    .toBe(true);
  await installContentTap(sw2);

  // 空闲：内容脚本不自动重连（避免保活循环）。
  await page.waitForTimeout(3_000);
  expect((await tapState(sw2)).connects).toBe(0);
  expect((await f.ui.snapshot())!.pages.some((p) => p.tabId === tabId)).toBe(false);

  await wakeContent(sw2, tabId);
  await expect
    .poll(async () => (await tapMessages(sw2)).slice(0, 4).map((m) => m.type), { timeout: 10_000 })
    .toEqual(['hello', 'page/video', 'captions/tracks', 'player/state']);
  const replay = await tapMessages(sw2);
  const oldHello = before.pages.find((p) => p.tabId === tabId)!;
  expect(replay[1]).toMatchObject({ videoId: VIDEO_A, title: 'Fixture Video A' });
  const re = await f.ui.waitPage(
    VIDEO_A,
    (p) => p.tabId === tabId && p.captionsAvailability === 'available',
  );
  expect(re.tracks).toHaveLength(2);
  expect(re.documentId).toBe(oldHello.documentId);
  expect(re.player?.currentTimeMs ?? 0).toBeGreaterThanOrEqual(6_900);
});

test('observe-visible：拿不到完整轨道时读取原生显示字幕并提示，会话结束后恢复原生字幕', async () => {
  const { fc: f, sw } = await setup();
  const { page, tabId } = await openAwake(f, sw, VIDEO_C);
  const visibility = () =>
    page.evaluate(
      () => getComputedStyle(document.querySelector('.ytp-caption-window-container')!).visibility,
    );
  await f.ui.ok({ kind: 'session/start', tabId });
  const session = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'incremental-captions',
    { timeout: 40_000, message: '退回当前显示字幕模式' },
  );
  expect(session.notice?.code).toBe('incremental-captions');
  expect(f.route.timedtext.some((t) => t.withPot && t.videoId === VIDEO_C)).toBe(true);
  expect(await visibility()).toBe('hidden');

  // 增量来源在显示文本变化后才定稿：正常播放经过 3–6 s 的字幕。
  await video(page).seek(2.5);
  expect(await video(page).play()).toBe(true);
  const visible = await waitTap(
    sw,
    (m) => m.type === 'captions/visible' && String(m.text).includes('This caption has'),
    15_000,
  );
  expect(visible).toMatchObject({ videoId: VIDEO_C, text: XSS_TEXT });
  expect(visible.mediaTimeMs as number).toBeGreaterThanOrEqual(3_000);
  // 播放中：XSS 字幕定稿并翻译，覆盖层显示译文（纯文本）。
  await f.ui.subscribeCues(session.identity.sessionId);
  await expect
    .poll(
      async () =>
        (await f.ui.cues(session.identity.sessionId)).find((c) => c.sourceText === XSS_TEXT)
          ?.translatedText ?? null,
      { timeout: 20_000, message: '增量字幕 XSS 行译文' },
    )
    .toBe(mockTranslation('zh-CN', XSS_TEXT));
  const shown = await waitOverlay(
    page,
    (s) => !!s.main?.startsWith('译[zh-CN] '),
    20_000,
    '覆盖层显示增量字幕译文',
  );
  expect(shown.shadowElements).toBe(0);
  await video(page).pause();
  expect(
    await page.evaluate(() => (window as unknown as { __ttXss?: number }).__ttXss),
  ).toBeUndefined();

  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: session.identity.sessionId });
  await expect(page.locator('#movie_player')).not.toHaveAttribute('data-tongting-hide-native', '');
  await expect
    .poll(async () => (await fixtureCalls(page)).some((c) => c[0] === 'unloadModule'))
    .toBe(true);
  expect(await visibility()).toBe('visible');
  expect(
    await page.evaluate(() => {
      const p = document.getElementById('movie_player') as unknown as {
        getOption(m: string, o: string): unknown;
      };
      return p.getOption('captions', 'track');
    }),
  ).toEqual({});
  const afterStop = (await tapMessages(sw)).filter((m) => m.type === 'captions/visible').length;
  await video(page).seek(7);
  await page.waitForTimeout(800);
  expect((await tapMessages(sw)).filter((m) => m.type === 'captions/visible')).toHaveLength(
    afterStop,
  );
});

test('侧栏已打开时新开 YouTube 标签页：侧栏唤醒页面并登记（缺陷 #1 回归）', async () => {
  // 缺陷 #1（2026-09-17 发现并已修复）：侧栏在新标签页激活时（页面尚未加载）发出的唤醒落空后不再重试，
  // 快照中一直没有该页面。修复后 page-wake 在标签页加载完成时再唤醒并有界重试。
  fc = await setupFullChain({ videos: VIDEOS, uiPath: '/sidepanel.html' });
  const f = fc;
  await installContentTap(f.ext.serviceWorker);
  await configureProvider(f);
  const page = await f.ext.context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${VIDEO_A}`);
  const registered = await f.ui
    .waitPage(VIDEO_A, undefined, 12_000)
    .then(() => true)
    .catch(() => false);
  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({
      registered,
      connects: (await tapState(f.ext.serviceWorker)).connects,
    }),
  });
  expect(registered, '侧栏打开时 12 s 内应登记新打开的 YouTube 页面').toBe(true);
});

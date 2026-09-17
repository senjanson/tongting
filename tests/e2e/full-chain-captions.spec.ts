/**
 * 全链路 E2E（字幕模式）：真实 Chromium + E2E 构建的真实扩展（service worker 协调器、内容脚本、MAIN world 桥、覆盖层、UI 端口）。
 * YouTube → 本地夹具（context.route），sub2api → 本地模拟服务（127.0.0.1 随机端口）。不访问真实 YouTube / sub2api。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 * 运行：pnpm exec playwright test tests/e2e/full-chain-captions.spec.ts
 * 结果记录：docs/validation/e2e-full-chain.md
 */
import { expect, test, type Page } from '@playwright/test';
import {
  configureProvider,
  connectionCheck,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { UiDriver } from './helpers/ui-driver';
import { E2E_API_KEY, mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import {
  makeCaptionLines,
  type CaptionLine,
  type FixtureVideo,
} from './fixtures/full-chain/youtube';

test.describe.configure({ timeout: 180_000 });

const VIDEO_A = 'AAAAAAAAAAA';
const VIDEO_B = 'BBBBBBBBBBB';
const XSS_TEXT = 'Alpha has <img src=x onerror="window.__ttXss=1"> inside.';

let videos: FixtureVideo[];
let linesA: CaptionLine[];
let linesB: CaptionLine[];
const evidence: Record<string, unknown> = {};

test.beforeAll(async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成长视频夹具');
  const long = await silentVideo(150);
  linesA = makeCaptionLines('Alpha', 45);
  linesA[1] = { ...linesA[1]!, text: XSS_TEXT };
  linesB = makeCaptionLines('Bravo', 45);
  videos = [
    {
      videoId: VIDEO_A,
      title: 'Full Chain Alpha',
      lengthSeconds: 150,
      captions: linesA,
      media: long,
    },
    {
      videoId: VIDEO_B,
      title: 'Full Chain Bravo',
      lengthSeconds: 150,
      captions: linesB,
      media: long,
    },
  ];
});

test.afterAll(() => {
  if (Object.keys(evidence).length)
    console.log('[full-chain-captions evidence]', JSON.stringify(evidence, null, 2));
});

let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

function lineAt(lines: CaptionLine[], ms: number): CaptionLine | undefined {
  return lines.find((l) => l.startMs <= ms && ms < l.startMs + l.durationMs);
}

async function startRunning(page: Page, tabId: number) {
  expect(await video(page).play()).toBe(true);
  await fc!.ui.ok({ kind: 'session/start', tabId });
  const s = await fc!.ui.waitSession(
    tabId,
    (x) => x.phase === 'running' && x.sourceMode === 'full-track',
    {
      timeout: 30_000,
      message: '会话进入 running/full-track',
    },
  );
  await fc!.ui.subscribeCues(s.identity.sessionId);
  return s;
}

test('T01 字幕模式全链路：连接检查 → 开始 → mock 翻译 → 覆盖层双语 → IndexedDB 记录', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);

  const report = await connectionCheck(fc);
  evidence.t01ConnectionCheck = report.items.map((i) => ({
    key: i.key,
    status: i.status,
    reasonCode: i.reasonCode,
    latencyMs: i.latencyMs,
  }));
  expect(Object.fromEntries(report.items.map((i) => [i.key, i.status]))).toMatchObject({
    hostPermission: 'verified',
    reachability: 'verified',
    auth: 'verified',
    modelList: 'verified',
    model: 'verified',
    translation: 'verified',
  });
  const afterCheck = mock.requests.length;

  const { page, tabId } = await openWatch(fc, VIDEO_A);
  await ui.waitPage(VIDEO_A, (p) => p.captionsAvailability === 'available');
  const startedAt = Date.now();
  const running = await startRunning(page, tabId);
  evidence.t01StartToRunningMs = Date.now() - startedAt;
  expect(running.identity.videoId).toBe(VIDEO_A);
  expect(running.recordId).toBeTruthy();

  // mock 实际收到翻译请求：只发往 mock，带假 Key；请求体只含字幕 id 与文本（及语言、提示词），不含页面/签名信息。
  const sessionTranslations = () => mock.translationRequests().filter((r) => r.seq > afterCheck);
  await expect.poll(() => sessionTranslations().length, { timeout: 15_000 }).toBeGreaterThan(0);
  const allTexts = new Set(linesA.map((l) => l.text));
  for (const r of mock.requests.slice(afterCheck)) {
    expect(r.authorization).toBe(`Bearer ${E2E_API_KEY}`);
    expect(r.endpoint).toBe('responses');
  }
  for (const r of sessionTranslations()) {
    expect(r.targetLanguage).toBe('zh-CN');
    for (const item of r.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'text']);
      expect(allTexts.has(item.text)).toBe(true);
    }
    expect(r.rawBody).not.toContain(E2E_API_KEY);
    expect(r.rawBody).not.toMatch(
      /youtube\.com|FIXTURESIG|FIXTUREPOT|signature=|Full Chain Alpha|Fixture Channel|chrome-extension/,
    );
  }

  // 覆盖层：暂停在第 2 句（含 HTML 文本），显示译文 + 原文，HTML 不执行。
  await video(page).pause();
  await video(page).seek(3.8);
  const expectedMain = mockTranslation('zh-CN', XSS_TEXT);
  const ov = await waitOverlay(
    page,
    (s) => s.main === expectedMain,
    20_000,
    '覆盖层显示第 2 句译文',
  );
  expect(ov.hosts).toBe(1);
  expect(ov.secondary).toBe(XSS_TEXT);
  expect(ov.secondaryHidden).toBe(false);
  expect(ov.shadowElements).toBe(0);
  expect(ov.hideNative).toBe(true);
  expect(
    await page.evaluate(() => (window as unknown as { __ttXss?: number }).__ttXss),
  ).toBeUndefined();

  // UI 字幕：done 的译文与 mock 一致（id 未错配）。
  const cues = await ui.cues(running.identity.sessionId);
  const done = cues.filter((c) => c.translationState === 'done');
  expect(done.length).toBeGreaterThan(0);
  for (const c of done) expect(c.translatedText).toBe(mockTranslation('zh-CN', c.sourceText));

  // IndexedDB transcripts：recordId 与快照一致。
  const snap = await ui.waitSession(tabId, (s) => s.translation.done > 0);
  let record: Awaited<ReturnType<UiDriver['readTranscript']>> = null;
  await expect
    .poll(
      async () => {
        record = await ui.readTranscript(snap.recordId!);
        return !!record && record.cues.some((c) => c.translatedText);
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(record).toMatchObject({
    recordId: snap.recordId,
    videoId: VIDEO_A,
    lastSessionId: running.identity.sessionId,
    targetLanguage: 'zh-CN',
    sourceMode: 'full-track',
  });
  evidence.t01 = {
    translationRequests: sessionTranslations().length,
    itemsPerRequest: sessionTranslations().map((r) => r.items.length),
    requestOrigins: [...new Set(mock.requests.map((r) => r.origin ?? '(none)'))],
    overlay: ov,
    snapshotTranslation: snap.translation,
    recordId: record!.recordId,
    recordCues: record!.cues.length,
    recordTranslated: record!.cues.filter((c) => c.translatedText).length,
  };
});

test('T11/T16(字幕)/暂停恢复/停止/T20/T23：跳转、暂停翻译、侧栏重开、关闭标签页', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  const running = await startRunning(page, tabId);
  const sessionId = running.identity.sessionId;
  await ui.waitSession(tabId, (s) => s.translation.done >= 8, {
    timeout: 20_000,
    message: '起始窗口译文完成',
  });
  const e: Record<string, unknown> = {};

  // ---- T16（字幕部分）：视频暂停/继续，覆盖层与播放位置同步 ----
  await video(page).pause();
  await video(page).seek(10.0);
  const at10 = lineAt(linesA, 10_000)!;
  await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', at10.text),
    10_000,
    '暂停在 10s 的译文',
  );
  await ui.waitSession(tabId, (s) => s.player?.paused === true, { message: '快照 player.paused' });
  expect((await ui.session(tabId))!.phase).toBe('running');
  expect(await video(page).play()).toBe(true);
  await ui.waitSession(tabId, (s) => s.player?.paused === false, {
    message: '快照 player 恢复播放',
  });

  // ---- 暂停翻译：在途请求中止、之后不再发送请求 ----
  mock.setTranslateDelay(2_500);
  await ui.ok({ kind: 'player/seek', tabId, timeMs: 60_000 });
  await expect
    .poll(() => mock.translationRequests().filter((r) => !r.finishedAt).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const inflightAtPause = mock.translationRequests().filter((r) => !r.finishedAt);
  await ui.ok({ kind: 'session/pause', tabId });
  const paused = await ui.waitSession(tabId, (s) => s.phase === 'paused', {
    message: '快照 paused',
  });
  expect(paused.desiredState).toBe('paused');
  const countAtPause = mock.requests.length;
  await sleep(1_000);
  const abortedAtPause = inflightAtPause.filter((r) => r.aborted).length;
  // 暂停期间视频继续播放并跳到尚未翻译的区间：运行中这会触发新请求。
  await ui.ok({ kind: 'player/seek', tabId, timeMs: 62_000 });
  await sleep(5_000);
  const requestsWhilePaused = mock.requests.length - countAtPause;
  const overlayWhilePaused = await waitOverlay(page, () => true);
  expect(requestsWhilePaused).toBe(0);
  expect(abortedAtPause).toBe(inflightAtPause.length);
  expect(overlayWhilePaused.badge).toContain('暂停');
  e.pause = {
    inflightAtPause: inflightAtPause.length,
    abortedAtPause,
    requestsWhilePaused,
    overlayWhilePaused,
  };

  // ---- 继续翻译：恢复后重新请求当前区间（仍有 2.5s 延迟，留作下一步的在途请求） ----
  await ui.ok({ kind: 'session/resume', tabId });
  await ui.waitSession(tabId, (s) => s.phase === 'running', { message: '恢复 running' });
  await expect.poll(() => mock.requests.length, { timeout: 10_000 }).toBeGreaterThan(countAtPause);
  expect((await ui.session(tabId))!.identity.sessionId).toBe(sessionId);

  // ---- T11：请求在途时跳转到远处 ----
  await expect
    .poll(() => mock.translationRequests().filter((r) => !r.finishedAt).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const inflightAtSeek = mock.translationRequests().filter((r) => !r.finishedAt);
  const epochBeforeSeek = (await ui.session(tabId))!.identity.epoch;
  const beforeSeek = mock.requests.length;
  const seekResult = await ui.ok<{ accepted: true }>({
    kind: 'player/seek',
    tabId,
    timeMs: 125_000,
  });
  expect(seekResult).toEqual({ accepted: true });
  await video(page).pause();
  const atFar = lineAt(linesA, (await video(page).state()).currentTimeMs)!;
  // 译文到达前：覆盖层显示新位置的真实原文并标记待翻译（不是旧位置的译文）。
  const pendingState = await waitOverlay(
    page,
    (s) => s.main === atFar.text && !!s.pending,
    5_000,
    '新位置原文待翻译',
  );
  const after = await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', atFar.text),
    15_000,
    '新位置译文',
  );
  // 旧请求全部结束（中止或迟到返回）后，覆盖层与字幕仍正确。
  await expect
    .poll(() => inflightAtSeek.every((r) => r.finishedAt), { timeout: 10_000 })
    .toBe(true);
  await sleep(500);
  const stable = await waitOverlay(page, () => true);
  expect(stable.main).toBe(mockTranslation('zh-CN', atFar.text));
  const seekRequests = mock.translationRequests().filter((r) => r.seq > beforeSeek);
  expect(seekRequests.some((r) => r.items.some((i) => i.text === atFar.text))).toBe(true);
  expect((await ui.session(tabId))!.identity.epoch).toBeGreaterThan(epochBeforeSeek);
  const cuesAfterSeek = await ui.cues(sessionId);
  for (const c of cuesAfterSeek.filter((x) => x.translatedText))
    expect(c.translatedText).toBe(mockTranslation('zh-CN', c.sourceText));
  e.t11 = {
    seekToMs: 125_000,
    inflightAtSeek: inflightAtSeek.map((r) => ({
      items: r.items.length,
      first: r.items[0]?.text,
      aborted: r.aborted,
      durationMs: (r.finishedAt ?? 0) - r.receivedAt,
    })),
    pendingState: { main: pendingState.main, pending: pendingState.pending },
    overlayAfter: after.main,
    requestsAfterSeek: seekRequests.map((r) => ({
      items: r.items.length,
      first: r.items[0]?.text,
      aborted: r.aborted,
    })),
  };
  mock.setTranslateDelay(0);

  // ---- T20：关闭侧栏页后重新打开：仍是同一个真实会话，不重复 ----
  await ui.close();
  const ui2 = await UiDriver.open(fc.ext.context, fc.ext.extensionId);
  fc.ui = ui2;
  const reopened = await ui2.waitSnapshot((s) => s.sessions.length > 0, {
    message: '重开侧栏后快照含会话',
  });
  expect(reopened.sessions).toHaveLength(1);
  expect(reopened.sessions[0]!.identity.sessionId).toBe(sessionId);
  expect(reopened.sessions[0]!.phase).toBe('running');
  expect(reopened.audioOwner).toEqual({ tabId, sessionId });
  e.t20 = { sessions: reopened.sessions.length, sameSession: true };

  // ---- 停止：覆盖层移除、原生字幕恢复 ----
  const fixtureBefore = await page.evaluate(
    () => (window as unknown as { __fixture: { captionsOn: boolean } }).__fixture.captionsOn,
  );
  await ui2.ok({ kind: 'session/stop', tabId });
  await ui2.waitSnapshot((s) => s.sessions.length === 0, { message: '停止后无会话' });
  const stoppedOverlay = await waitOverlay(
    page,
    (s) => s.hosts === 0 && !s.hideNative,
    10_000,
    '停止后覆盖层移除',
  );
  const fixtureAfter = await page.evaluate(() => {
    const f = (window as unknown as { __fixture: { captionsOn: boolean; calls: unknown[][] } })
      .__fixture;
    return { captionsOn: f.captionsOn, lastCalls: f.calls.slice(-3) };
  });
  expect(fixtureAfter.captionsOn).toBe(false);
  const countAtStop = mock.requests.length;
  await video(page).play();
  await sleep(3_000);
  expect(mock.requests.length).toBe(countAtStop);
  e.stop = { stoppedOverlay, fixtureBefore, fixtureAfter };

  // ---- T23：清空翻译缓存后重新开始，请求在途时关闭 YouTube 标签页：会话与页面消失，请求中止 ----
  await ui2.ok({ kind: 'cache/clear' });
  mock.setTranslateDelay(4_000);
  await ui2.ok({ kind: 'session/start', tabId });
  const second = await ui2.waitSession(tabId, (s) => s.phase === 'running', {
    timeout: 30_000,
    message: '第二次开始',
  });
  expect(second.identity.sessionId).not.toBe(sessionId);
  await expect
    .poll(() => mock.translationRequests().filter((r) => !r.finishedAt).length, { timeout: 10_000 })
    .toBeGreaterThan(0);
  const inflightAtClose = mock.translationRequests().filter((r) => !r.finishedAt);
  await page.close();
  const closed = await ui2.waitSnapshot(
    (s) => s.sessions.length === 0 && !s.pages.some((p) => p.tabId === tabId),
    {
      timeout: 15_000,
      message: '关闭标签页后会话与页面消失',
    },
  );
  expect(closed.audioOwner).toBeNull();
  const countAtClose = mock.requests.length;
  await sleep(3_000);
  e.t23 = {
    inflightAtClose: inflightAtClose.length,
    abortedAfterClose: inflightAtClose.filter((r) => r.aborted).length,
    requestsAfterClose: mock.requests.length - countAtClose,
  };
  expect(mock.requests.length).toBe(countAtClose);
  expect(inflightAtClose.length).toBeGreaterThan(0);
  expect(inflightAtClose.every((r) => r.aborted)).toBe(true);
  evidence.lifecycle = e;
});

test('T12 A→B→A：会话身份隔离，旧视频译文不混入', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  const first = await startRunning(page, tabId);
  await ui.waitSession(tabId, (s) => s.translation.done >= 4, { message: 'A 首批译文' });
  // A 的在途请求延迟返回，导航后迟到。
  mock.setTranslateDelay(3_000);
  await ui.ok({ kind: 'player/seek', tabId, timeMs: 70_000 });
  await sleep(600);
  const aInflight = mock.translationRequests().filter((r) => !r.finishedAt);

  await video(page).navigate(VIDEO_B);
  const onB = await ui.waitSnapshot(
    (s) =>
      s.sessions.length === 1 &&
      s.sessions[0]!.identity.videoId === VIDEO_B &&
      s.sessions[0]!.phase === 'running',
    { timeout: 40_000, message: '导航到 B 后只有一个 B 会话' },
  );
  const sessionB = onB.sessions[0]!;
  expect(sessionB.identity.sessionId).not.toBe(first.identity.sessionId);
  await ui.subscribeCues(sessionB.identity.sessionId);
  mock.setTranslateDelay(0);
  await video(page).pause();
  await video(page).seek(4.0);
  const b2 = lineAt(linesB, 4_000)!;
  await waitOverlay(page, (s) => s.main === mockTranslation('zh-CN', b2.text), 20_000, 'B 的译文');
  // 等待 A 的迟到响应返回后，B 的覆盖层与字幕中没有 A 的文本。
  await sleep(3_500);
  const bCues = await ui.cues(sessionB.identity.sessionId);
  expect(
    bCues.every(
      (c) =>
        c.sourceText.startsWith('Bravo') &&
        (!c.translatedText || c.translatedText.includes('Bravo')),
    ),
  ).toBe(true);
  const ovB = await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', b2.text),
    5_000,
    'B 仍显示 B 译文',
  );

  await video(page).navigate(VIDEO_A);
  const back = await ui.waitSnapshot(
    (s) =>
      s.sessions.length === 1 &&
      s.sessions[0]!.identity.videoId === VIDEO_A &&
      s.sessions[0]!.identity.sessionId !== first.identity.sessionId &&
      s.sessions[0]!.phase === 'running',
    { timeout: 40_000, message: '回到 A 后只有一个新 A 会话' },
  );
  const sessionA2 = back.sessions[0]!;
  expect(sessionA2.identity.sessionId).not.toBe(sessionB.identity.sessionId);
  await video(page).pause();
  await video(page).seek(7.0);
  const a3 = lineAt(linesA, 7_000)!;
  const ovA2 = await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', a3.text),
    20_000,
    '回到 A 的译文',
  );
  expect(ovA2.hosts).toBe(1);
  await ui.subscribeCues(sessionA2.identity.sessionId);
  await expect
    .poll(async () => (await ui.cues(sessionA2.identity.sessionId)).length)
    .toBeGreaterThan(0);
  const a2Cues = await ui.cues(sessionA2.identity.sessionId);
  expect(
    a2Cues.every(
      (c) => !c.sourceText.startsWith('Bravo') && !(c.translatedText ?? '').includes('Bravo'),
    ),
  ).toBe(true);
  evidence.t12 = {
    sessionA1: first.identity.sessionId,
    sessionB: sessionB.identity.sessionId,
    sessionA2: sessionA2.identity.sessionId,
    aInflightAtNavigate: aInflight.length,
    aInflightAborted: aInflight.filter((r) => r.aborted).length,
    overlayB: ovB.main,
    overlayA2: ovA2.main,
    bCues: bCues.length,
    a2Cues: a2Cues.length,
  };
});

test('T13 运行中切换目标语言：新语言请求，覆盖层旧译文清除后替换', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  const running = await startRunning(page, tabId);
  await video(page).pause();
  await video(page).seek(13.0);
  const line = lineAt(linesA, 13_000)!;
  await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', line.text),
    20_000,
    '中文译文',
  );
  const configRevision = (await ui.snapshot())!.configRevision;

  mock.setTranslateDelay(1_500);
  const beforeSwitch = mock.requests.length;
  const switchedAt = Date.now();
  await ui.ok({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
  // 旧译文先被清除（显示原文、待翻译），然后替换为日文译文；期间不再出现中文译文。
  const seen: string[] = [];
  let cleared = false;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const s = await waitOverlay(page, () => true);
    if (s.main && !seen.includes(s.main)) seen.push(s.main);
    if (s.main === line.text) cleared = true;
    if (s.main === mockTranslation('ja', line.text)) break;
    await page.waitForTimeout(50);
  }
  const replacedAfterMs = Date.now() - switchedAt;
  expect(seen.at(-1)).toBe(mockTranslation('ja', line.text));
  expect(cleared).toBe(true);
  const newRequests = mock.translationRequests().filter((r) => r.seq > beforeSwitch);
  expect(newRequests.length).toBeGreaterThan(0);
  expect(newRequests.every((r) => r.targetLanguage === 'ja')).toBe(true);
  const snap = await ui.waitSession(
    tabId,
    (s) => s.targetLanguage === 'ja' && s.translation.done > 0,
  );
  expect(snap.identity.sessionId).toBe(running.identity.sessionId);
  expect((await ui.snapshot())!.configRevision).toBeGreaterThan(configRevision);
  // 稍后仍不会被旧语言结果覆盖。
  await sleep(2_000);
  const later = await waitOverlay(page, () => true);
  expect(later.main).toBe(mockTranslation('ja', line.text));
  const cues = await ui.cues(running.identity.sessionId);
  expect(
    cues.filter((c) => c.translatedText).every((c) => c.translatedText!.startsWith('译[ja]')),
  ).toBe(true);
  expect(snap.recordId).toContain('|ja|');
  evidence.t13 = {
    overlaySequence: seen,
    clearedBeforeReplace: cleared,
    replacedAfterMs,
    newRequests: newRequests.length,
    newRequestLanguages: [...new Set(newRequests.map((r) => r.targetLanguage))],
    recordId: snap.recordId,
  };
});

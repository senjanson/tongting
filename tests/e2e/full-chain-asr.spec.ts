/**
 * 全链路 E2E（P6 / T03、T32、T21、T22）：无字幕视频 → tabCapture → offscreen → 真实本地识别服务（faster-whisper small，
 * 离线、已缓存模型）→ ASR 字幕 → mock sub2api 翻译 → 覆盖层。
 *
 * 环境与替代说明：
 * - tabCapture 需要用户调用扩展（activeTab）。这里用 --allowlisted-extension-id 作为自动化替代，**不等同于真实用户手势**。
 * - 去掉 Playwright 默认的 --mute-audio（静音时捕获为全零 PCM），运行时测试页会从扬声器发声。
 * - 测试音频为 macOS say 合成的英文句子（fixtures/full-chain/media.ts speechVideo），不含真实人声或私人音频。
 * - 本地识别令牌在运行时由服务生成于临时目录，只在内存中传给扩展。
 * - offscreen 诊断与 worker 重启后的求值经 --remote-debugging-port 的 CDP 读取（helpers/cdp.ts）。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build；services/asr-local 已 uv sync 且缓存 small 模型；ffmpeg、say 可用。
 * 需显式设置 TONGTING_E2E_ASR=1（会发声、占用 8765 端口与较多 CPU）。
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  configureProvider,
  openWatch,
  overlayState,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { UiDriver } from './helpers/ui-driver';
import { cdpEvaluator, freePort, isExtensionWorker, isOffscreen } from './helpers/cdp';
import { prepareE2EExtension } from './helpers/extension';
import {
  ffmpegAvailable,
  sayAvailable,
  speechVideo,
  type SpeechVideo,
} from './fixtures/full-chain/media';
import {
  ASR_BASE_URL,
  localAsrAvailable,
  portOpen,
  startLocalAsr,
  type LocalAsr,
} from './fixtures/full-chain/asr-local';
import type { Cue } from '../../src/domain/cue';

test.describe.configure({ timeout: 300_000 });

const VIDEO_S = 'SSSSSSSSSSS';
const EVIDENCE_FILE = resolve(
  import.meta.dirname,
  '../../test-results/full-chain-asr-evidence.json',
);
const evidence: Record<string, unknown> = {};

let speech: SpeechVideo;
let asr: LocalAsr | undefined;
let fc: FullChain | undefined;
let cdpPort = 0;

test.beforeAll(async () => {
  test.skip(
    !process.env.TONGTING_E2E_ASR,
    '真实本地识别链路会发声并占用 8765 端口，需设置 TONGTING_E2E_ASR=1',
  );
  test.skip(
    !(await ffmpegAvailable()) || !(await sayAvailable()),
    '需要 ffmpeg 与 macOS say 生成语音视频',
  );
  const missing = await localAsrAvailable();
  test.skip(!!missing, missing ?? '');
  speech = await speechVideo(2_000);
  const { extensionId } = await prepareE2EExtension();
  asr = await startLocalAsr({ extensionId, logName: 'full-chain-asr' });
  evidence.asrHealth = await asr.health();
  evidence.speech = { durationMs: speech.durationMs, phrases: speech.phrases };
});

test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
  // 每个用例结束即合并写入证据（失败后 Playwright 会重启 worker 进程，模块级变量不保留）。
  await mkdir(dirname(EVIDENCE_FILE), { recursive: true });
  const prev = await readFile(EVIDENCE_FILE, 'utf8').then(
    (t) => JSON.parse(t) as Record<string, unknown>,
    () => ({}),
  );
  await writeFile(EVIDENCE_FILE, JSON.stringify({ ...prev, ...evidence }, null, 2));
});

test.afterAll(async () => {
  await asr?.close();
  if (asr) expect(await portOpen(8765)).toBe(false);
});

async function setup(): Promise<{ f: FullChain; page: Page; tabId: number }> {
  cdpPort = await freePort();
  const f = await setupFullChain({
    videos: [
      {
        videoId: VIDEO_S,
        title: 'Speech without captions',
        lengthSeconds: Math.ceil(speech.durationMs / 1000),
        media: speech.bytes,
      },
    ],
    unmute: true,
    extraArgs: (id) => [`--allowlisted-extension-id=${id}`, `--remote-debugging-port=${cdpPort}`],
  });
  fc = f;
  await configureProvider(f, {
    sourceStrategy: 'captions-first',
    sourceLanguage: 'auto',
    asr: { backend: 'local', localUrl: ASR_BASE_URL, segmentMs: 5_000 },
  });
  await f.ui.ok({ kind: 'asr/set-token', token: asr!.token });
  await f.ui.waitSnapshot((s) => s.asrToken.configured, { message: '识别令牌已配置' });
  const { page, tabId } = await openWatch(f, VIDEO_S);
  return { f, page, tabId };
}

type Offscreen = {
  status?: {
    lease: { leaseId: string; owner: { sessionId: string } } | null;
    resources: {
      capture: string;
      asr: string;
      activeTracks: number;
      pendingRequests: number;
      asrBacklogMs?: number;
    };
    audioContextState: string;
  };
  diagnostics?: {
    sessions: number;
    capture?: {
      chunks: number;
      segmentsQueued: number;
      resultsEmitted: number;
      trackReadyStates: string[];
      maxChunkDbfs?: number;
    };
    lastEnded?: {
      leaseId: string;
      pendingRequests: number;
      activeTracks: number;
      capture?: { trackReadyStates: string[]; segmentsQueued: number };
    };
  };
  __noTarget?: boolean;
};

async function offscreen(f: FullChain): Promise<Offscreen> {
  const ev = cdpEvaluator(cdpPort, isOffscreen(f.ext.extensionId));
  return ev(() => {
    const api = (
      globalThis as { __tongtingOffscreen?: { status(): unknown; diagnostics(): unknown } }
    ).__tongtingOffscreen;
    return JSON.parse(
      JSON.stringify({ status: api?.status(), diagnostics: api?.diagnostics() }),
    ) as Offscreen;
  }).catch((e: Error) => ({ error: e.message }) as unknown as Offscreen);
}

async function capturedTabs(
  f: FullChain,
  viaCdp = false,
): Promise<Array<{ tabId: number; status: string }>> {
  const fn = () =>
    (
      globalThis as unknown as {
        chrome: {
          tabCapture: { getCapturedTabs(): Promise<Array<{ tabId: number; status: string }>> };
        };
      }
    ).chrome.tabCapture
      .getCapturedTabs()
      .then((list) => list.map((t) => ({ tabId: t.tabId, status: t.status })));
  if (viaCdp) return cdpEvaluator(cdpPort, isExtensionWorker(f.ext.extensionId))(fn);
  return f.ext.serviceWorker.evaluate(fn);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

test('T03 无字幕视频走真实本地识别：捕获 → 识别 → 翻译 → 覆盖层；文本与音频相符；语句结束 → 译文延迟', async () => {
  const { f, page, tabId } = await setup();
  const check = await f.ui.ok<{
    items: Array<{ key: string; status: string; reasonCode?: string; latencyMs?: number }>;
  }>({ kind: 'connection/check', scope: 'asr', allowBilledAudioProbe: false }, 60_000);
  evidence.t03ConnectionCheck = check.items;

  expect((await f.ui.snapshot())!.pages.find((p) => p.tabId === tabId)?.captionsAvailability).toBe(
    'unavailable',
  );
  expect(await video(page).play()).toBe(true);
  const playAnchor = await page.evaluate(() => ({
    now: Date.now(),
    t: document.querySelector<HTMLVideoElement>('#movie_player video')!.currentTime * 1000,
  }));
  await f.ui.ok({ kind: 'session/start', tabId });
  const running = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'asr' && s.resources.capture === 'active',
    {
      timeout: 30_000,
      message: '识别会话 running',
    },
  );
  const sessionId = running.identity.sessionId;
  await f.ui.subscribeCues(sessionId);
  const offRunning = await offscreen(f);
  expect(offRunning.status?.lease?.owner.sessionId).toBe(sessionId);
  expect(offRunning.diagnostics?.capture?.trackReadyStates).toEqual(['live']);
  expect(await capturedTabs(f)).toEqual([{ tabId, status: 'active' }]);
  // 缺陷 #5(b) 修复后：会话快照 activeTracks 与 offscreen 实际 live 音轨同步（首个 asr/status 或 5 s 心跳后）。
  await f.ui.waitSession(tabId, (x) => x.resources.activeTracks === 1, {
    timeout: 8_000,
    message: '快照 activeTracks=1',
  });

  // 播放期间采样覆盖层与媒体时钟。
  const overlaySamples: Array<{ at: number; t: number; main: string | null }> = [];
  // 在视频结束前停止采样并暂停（避免 ended 使会话进入结束态），再等待最后一句的识别与翻译。
  const endMs = speech.phrases.at(-1)!.endMs + 1_500;
  for (;;) {
    const s = await page.evaluate(() => ({
      t: document.querySelector<HTMLVideoElement>('#movie_player video')!.currentTime * 1000,
      ended: document.querySelector<HTMLVideoElement>('#movie_player video')!.ended,
    }));
    const ov = await overlayState(page);
    overlaySamples.push({ at: Date.now(), t: s.t, main: ov.main });
    if (s.t >= Math.min(endMs, speech.durationMs - 300) || s.ended) break;
    await sleep(250);
  }
  const endAnchor = overlaySamples.at(-1)!;
  await video(page).pause();
  // 给最后一句留出识别 + 翻译时间。
  await sleep(8_000);
  const driftMs = endAnchor.at - playAnchor.now - (endAnchor.t - playAnchor.t);
  const offDuring = await offscreen(f);
  const cues: Cue[] = await f.ui.cues(sessionId);
  const events = await f.ui.cueEvents();
  const session = (await f.ui.session(tabId))!;

  // 识别文本与音频内容相符（逐句单词召回率）。
  const recognizedWords = norm(cues.map((c) => c.sourceText).join(' '));
  const recognizedSet = new Set(recognizedWords);
  const perPhrase = speech.phrases.map((p) => {
    const words = norm(p.text);
    const hit = words.filter((w) => recognizedSet.has(w)).length;
    return { text: p.text, recall: Math.round((hit / words.length) * 100) / 100 };
  });

  // 语句结束 → 可读译文：该句最后一个单词首次出现在 done 状态 cue 中的时间减去媒体到达句末的墙钟时间。
  const wallAt = (mediaMs: number) => playAnchor.now + (mediaMs - playAnchor.t);
  const latencies = speech.phrases.map((p) => {
    const last = norm(p.text).at(-1)!;
    const ev = events.find(
      (e) =>
        e.sessionId === sessionId &&
        e.cues.some(
          (c) =>
            c.translationState === 'done' &&
            !!c.translatedText &&
            norm(c.sourceText).includes(last) &&
            c.endMs >= p.startMs - 1_000 &&
            c.startMs <= p.endMs + 1_000,
        ),
    );
    return {
      phrase: p.text.slice(0, 32),
      lastWord: last,
      latencyMs: ev ? ev.at - wallAt(p.endMs) : null,
    };
  });
  const measured = latencies.map((l) => l.latencyMs).filter((v): v is number => v !== null);
  const overlayTranslated = overlaySamples.filter((s) => s.main?.startsWith('译[zh-CN] '));

  evidence.t03 = {
    sessionId,
    driftMs,
    cueCount: cues.length,
    cues: cues.map((c) => ({
      startMs: c.startMs,
      endMs: c.endMs,
      source: c.sourceText,
      state: c.translationState,
      stability: c.stability,
    })),
    perPhrase,
    latencies,
    latencyP50: percentile(measured, 50),
    latencyP95: percentile(measured, 95),
    latencyMax: measured.length ? Math.max(...measured) : null,
    overlayTranslatedSamples: overlayTranslated.length,
    overlayTimeline: overlaySamples
      .filter((x, i, arr) => i === 0 || x.main !== arr[i - 1]!.main)
      .map((x) => ({ t: Math.round(x.t), main: x.main?.slice(0, 50) ?? null })),
    overlayFirstTranslated: overlayTranslated[0],
    translationRequests: f.mock.translationRequests().length,
    sessionResources: session.resources,
    translation: session.translation,
    offscreenDuring: offDuring,
    mockRequestTexts: f.mock
      .translationRequests()
      .flatMap((r) => r.items.map((i) => i.text))
      .slice(0, 20),
  };
  console.log(
    '[T03 evidence]',
    JSON.stringify({
      perPhrase,
      latencies,
      p50: percentile(measured, 50),
      p95: percentile(measured, 95),
      driftMs,
    }),
  );

  expect(Math.abs(driftMs)).toBeLessThan(500);
  expect(cues.length).toBeGreaterThan(0);
  expect(cues.every((c) => !c.sourceText.includes('译['))).toBe(true);
  const meanRecall = perPhrase.reduce((n, p) => n + p.recall, 0) / perPhrase.length;
  expect(meanRecall).toBeGreaterThanOrEqual(0.8);
  expect(measured.length).toBeGreaterThanOrEqual(6);
  // 实时显示（缺陷 #3 修复后）：播放中覆盖层依次出现各句译文；第一条译文出现后到最后一条之间不出现空白。
  const phraseOf = (main: string) =>
    cues.findIndex((c) => !!c.translatedText && c.translatedText === main);
  const firstIdx = overlaySamples.findIndex((x) => x.main?.startsWith('译[zh-CN] '));
  const lastIdx = overlaySamples.findLastIndex((x) => x.main?.startsWith('译[zh-CN] '));
  const shownOrder = overlayTranslated
    .map((x) => phraseOf(x.main!))
    .filter((i, k, arr) => k === 0 || i !== arr[k - 1]);
  const blanksBetween =
    firstIdx < 0 ? -1 : overlaySamples.slice(firstIdx, lastIdx + 1).filter((x) => !x.main).length;
  Object.assign(evidence.t03 as Record<string, unknown>, { shownOrder, blanksBetween });
  expect(overlayTranslated.length).toBeGreaterThan(0);
  expect(shownOrder.every((i) => i >= 0)).toBe(true);
  expect([...shownOrder].sort((a, b) => a - b)).toEqual(shownOrder);
  expect(new Set(shownOrder).size).toBeGreaterThanOrEqual(6);
  expect(blanksBetween).toBe(0);
  // 覆盖层显示路径：回到已识别语句的时间点，覆盖层显示该句译文（纯文本）。
  const target = cues.find((c) => norm(c.sourceText).includes('timestamps'))!;
  await video(page).seek((target.startMs + target.endMs) / 2000);
  const shown = await waitOverlay(
    page,
    (o) => o.main === target.translatedText,
    15_000,
    '回看时覆盖层显示识别译文',
  );
  expect(shown.main).toBe(mockTranslation('zh-CN', target.sourceText));
  expect(shown.secondary).toBe(target.sourceText);
  (evidence.t03 as Record<string, unknown>).overlayOnSeekBack = shown;
  expect(offDuring.diagnostics?.capture?.segmentsQueued ?? 0).toBeGreaterThan(0);
  // 翻译请求只含识别出的原文，不含示例替代。
  expect(f.mock.translationRequests().length).toBeGreaterThan(0);

  await f.ui.ok({ kind: 'session/stop', tabId, sessionId });
});

test('T03 生命周期：暂停/继续翻译、视频暂停、跳转、停止后 track 结束、无在途识别请求', async () => {
  const { f, page, tabId } = await setup();
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s0 = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.resources.capture === 'active',
    { timeout: 30_000 },
  );
  const sessionId = s0.identity.sessionId;
  await f.ui.subscribeCues(sessionId);
  await expect
    .poll(async () => (await offscreen(f)).diagnostics?.capture?.resultsEmitted ?? 0, {
      timeout: 30_000,
      message: '有识别结果',
    })
    .toBeGreaterThan(0);
  const steps: Record<string, unknown> = {};
  evidence.lifecycle = steps;

  // 暂停翻译：释放捕获（track ended），不再发送识别请求；视频继续播放。
  await f.ui.ok({ kind: 'session/pause', tabId, sessionId });
  await f.ui.waitSession(tabId, (s) => s.phase === 'paused', { timeout: 15_000 });
  await sleep(1_500);
  const pausedOff = await offscreen(f);
  const pausedTabs = await capturedTabs(f);
  await sleep(5_000);
  const pausedOffLater = await offscreen(f);
  steps.pauseTranslation = {
    pausedOff,
    pausedTabs,
    pausedOffLater,
    video: await video(page).state(),
  };
  expect((await video(page).state()).paused).toBe(false);
  expect(pausedTabs.filter((t) => t.status === 'active')).toHaveLength(0);
  // 缺陷 #5(b)：释放捕获后快照 activeTracks 应回到 0（给 6 s 覆盖一次状态心跳）。
  const pausedTracks = await f.ui
    .waitSession(tabId, (x) => x.resources.activeTracks === 0, { timeout: 6_000 })
    .then(
      () => 0,
      async () => (await f.ui.session(tabId))?.resources.activeTracks,
    );
  steps.pausedSnapshotActiveTracks = pausedTracks;
  expect(pausedTracks).toBe(0);
  if (!pausedOff.__noTarget) {
    expect(pausedOff.status?.lease ?? null).toBeNull();
    expect(pausedOff.status?.resources.pendingRequests).toBe(0);
    expect(
      pausedOff.diagnostics?.lastEnded?.capture?.trackReadyStates.every((x) => x === 'ended'),
    ).toBe(true);
  }

  // 继续：重新捕获，新 track live，识别恢复。
  await video(page).seek(10);
  await f.ui.ok({ kind: 'session/resume', tabId, sessionId });
  await f.ui.waitSession(tabId, (s) => s.phase === 'running' && s.resources.capture === 'active', {
    timeout: 30_000,
  });
  const resumedOff = await offscreen(f);
  expect(resumedOff.diagnostics?.capture?.trackReadyStates).toEqual(['live']);
  const resultsAtResume = resumedOff.diagnostics?.capture?.resultsEmitted ?? 0;
  await expect
    .poll(async () => (await offscreen(f)).diagnostics?.capture?.resultsEmitted ?? 0, {
      timeout: 30_000,
      message: '继续后有新识别结果',
    })
    .toBeGreaterThan(resultsAtResume);
  steps.resume = { resumedOff: resumedOff.status };

  // 视频暂停：捕获保留但没有新分段/请求（静音不送识别）。
  await video(page).pause();
  await sleep(6_000);
  const vp1 = await offscreen(f);
  await sleep(5_000);
  const vp2 = await offscreen(f);
  steps.videoPause = {
    segmentsBefore: vp1.diagnostics?.capture?.segmentsQueued,
    segmentsAfter: vp2.diagnostics?.capture?.segmentsQueued,
    pending: vp2.status?.resources.pendingRequests,
    phase: (await f.ui.session(tabId))?.phase,
  };
  expect(vp2.diagnostics?.capture?.segmentsQueued).toBe(vp1.diagnostics?.capture?.segmentsQueued);
  expect(vp2.status?.resources.pendingRequests).toBe(0);

  // 跳转：epoch 递增，新结果映射到新位置附近。
  const epochBefore = (await f.ui.session(tabId))!.identity.epoch;
  const seekTarget = speech.phrases[5]!.startMs - 500;
  await video(page).seek(seekTarget / 1000);
  expect(await video(page).play()).toBe(true);
  const afterSeek = await f.ui.waitSession(tabId, (s) => s.identity.epoch > epochBefore, {
    timeout: 10_000,
  });
  const seekAt = Date.now();
  await expect
    .poll(
      async () =>
        (await f.ui.cueEvents()).some(
          (e) =>
            e.at > seekAt &&
            e.cues.some((c) => c.startMs >= seekTarget - 1_000 && norm(c.sourceText).length > 0),
        ),
      { timeout: 30_000, message: '跳转后新位置出现识别字幕' },
    )
    .toBe(true);
  steps.seek = { epochBefore, epochAfter: afterSeek.identity.epoch, seekTarget };

  // 停止：lease 释放、track ended、无在途请求、6 s 后分段计数不变、没有被捕获的标签页。
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId });
  await f.ui.waitSnapshot((s) => !s.sessions.some((x) => x.identity.tabId === tabId), {
    message: '会话结束',
  });
  await sleep(1_000);
  const stopped = await offscreen(f);
  const tabsAfterStop = await capturedTabs(f);
  await sleep(6_000);
  const stoppedLater = await offscreen(f);
  const contexts = await f.ext.serviceWorker.evaluate(() =>
    (
      globalThis as unknown as {
        chrome: { runtime: { getContexts(q: object): Promise<unknown[]> } };
      }
    ).chrome.runtime
      .getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
      .then((l) => l.length),
  );
  steps.stop = {
    stopped,
    tabsAfterStop,
    stoppedLater,
    offscreenContexts: contexts,
    video: await video(page).state(),
  };
  evidence.lifecycle = steps;
  console.log(
    '[T03 lifecycle]',
    JSON.stringify({
      stop: {
        lease: stopped.status?.lease ?? null,
        res: stopped.status?.resources,
        lastEnded: stopped.diagnostics?.lastEnded,
        tabsAfterStop,
        contexts,
      },
    }),
  );
  expect(tabsAfterStop.filter((t) => t.status === 'active')).toHaveLength(0);
  if (stopped.__noTarget) {
    // offscreen 已关闭（closeIfIdle）：文档销毁时其中的 track 一并释放。
    expect(contexts).toBe(0);
  } else {
    expect(stopped.status?.lease ?? null).toBeNull();
    expect(stopped.status?.resources).toMatchObject({
      capture: 'none',
      activeTracks: 0,
      pendingRequests: 0,
    });
    expect(stopped.diagnostics?.lastEnded?.capture?.trackReadyStates.length ?? 0).toBeGreaterThan(
      0,
    );
    expect(
      stopped.diagnostics?.lastEnded?.capture?.trackReadyStates.every((x) => x === 'ended'),
    ).toBe(true);
    expect(stoppedLater.diagnostics?.lastEnded?.capture?.segmentsQueued).toBe(
      stopped.diagnostics?.lastEnded?.capture?.segmentsQueued,
    );
  }
});

test('T32 积压：2× / 4× 倍速播放时识别队列有界并提示积压', async () => {
  const { f, page, tabId } = await setup();
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('#movie_player video')!.playbackRate = 2;
  });
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s0 = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.resources.capture === 'active',
    { timeout: 30_000 },
  );
  const samples: Array<Record<string, unknown>> = [];
  let rateSwitched = false;
  const started = Date.now();
  while (Date.now() - started < 40_000) {
    const st = await video(page).state();
    if (!rateSwitched && st.currentTimeMs > 16_000) {
      await page.evaluate(() => {
        document.querySelector<HTMLVideoElement>('#movie_player video')!.playbackRate = 4;
      });
      rateSwitched = true;
    }
    if (st.currentTimeMs >= speech.durationMs - 500) {
      await video(page).seek(2);
      await video(page).play();
    }
    const sess = await f.ui.session(tabId);
    const off = await offscreen(f);
    samples.push({
      at: Date.now() - started,
      mediaMs: st.currentTimeMs,
      rate: rateSwitched ? 4 : 2,
      asr: sess?.resources.asr,
      backlogMs: sess?.resources.asrBacklogMs,
      notice: sess?.notice?.code,
      pending: off.status?.resources.pendingRequests,
      segmentsQueued: off.diagnostics?.capture?.segmentsQueued,
    });
    await sleep(1_000);
  }
  const maxBacklog = Math.max(0, ...samples.map((s) => (s.backlogMs as number | undefined) ?? 0));
  const maxPending = Math.max(0, ...samples.map((s) => (s.pending as number | undefined) ?? 0));
  const notices = [...new Set(samples.map((s) => s.notice).filter(Boolean))];
  evidence.t32 = { samples, maxBacklog, maxPending, notices, sessionId: s0.identity.sessionId };
  console.log('[T32]', JSON.stringify({ maxBacklog, maxPending, notices }));
  // 队列有界：积压不超过 offscreen 上限 30 s 音频，在途请求有限。
  expect(maxBacklog).toBeLessThanOrEqual(30_000);
  expect(maxPending).toBeLessThanOrEqual(4);
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: s0.identity.sessionId });
});

test('T21 识别捕获进行中终止 service worker：握手核对后只保留一套捕获，会话恢复', async () => {
  const { f, page, tabId } = await setup();
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s0 = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.resources.capture === 'active',
    { timeout: 30_000 },
  );
  await expect
    .poll(async () => (await offscreen(f)).diagnostics?.capture?.resultsEmitted ?? 0, {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  const before = await offscreen(f);
  const snapBefore = (await f.ui.snapshot())!;

  const cdp = await f.ext.context.newCDPSession(f.ui.page);
  await cdp.send('ServiceWorker.enable');
  const stoppedAt = Date.now();
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();
  await expect.poll(async () => (await f.ui.stats()).disconnected, { timeout: 10_000 }).toBe(true);
  await f.ui.close();
  f.ui = await UiDriver.open(f.ext.context, f.ext.extensionId);
  await f.ui.waitSnapshot((s) => s.workerInstanceId !== snapBefore.workerInstanceId, {
    timeout: 15_000,
    message: '新 worker',
  });

  const trace: Array<Record<string, unknown>> = [];
  const t0 = Date.now();
  while (Date.now() - t0 < 25_000) {
    const off = await offscreen(f);
    const sess = await f.ui.session(tabId);
    const tabs = await capturedTabs(f, true).catch((e: Error) => [
      { tabId: -1, status: e.message.slice(0, 60) },
    ]);
    trace.push({
      at: Date.now() - stoppedAt,
      phase: sess?.phase,
      sessionId: sess?.identity.sessionId,
      capture: sess?.resources.capture,
      lease: off.status?.lease?.leaseId ?? null,
      offSessions: off.diagnostics?.sessions,
      liveTracks: off.diagnostics?.capture?.trackReadyStates,
      captured: tabs,
    });
    // 任何时刻都不能有两套捕获。
    expect(off.diagnostics?.sessions ?? 0).toBeLessThanOrEqual(1);
    expect(
      (tabs as Array<{ status: string }>).filter((t) => t.status === 'active').length,
    ).toBeLessThanOrEqual(1);
    if (sess?.phase === 'running' && sess.resources.capture === 'active' && trace.length > 3) break;
    await sleep(500);
  }
  const recovered = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.resources.capture === 'active',
    {
      timeout: 30_000,
      message: 'worker 重启后识别会话恢复',
    },
  );
  const after = await offscreen(f);
  const resultsAfter = after.diagnostics?.capture?.resultsEmitted ?? 0;
  await expect
    .poll(async () => (await offscreen(f)).diagnostics?.capture?.resultsEmitted ?? 0, {
      timeout: 30_000,
      message: '恢复后继续识别',
    })
    .toBeGreaterThan(resultsAfter);
  const final = await offscreen(f);
  evidence.t21 = {
    before: { lease: before.status?.lease?.leaseId, sessionId: s0.identity.sessionId },
    after: {
      lease: final.status?.lease?.leaseId,
      sessionId: recovered.identity.sessionId,
      sessions: final.diagnostics?.sessions,
    },
    trace,
    recoverMs: Date.now() - stoppedAt,
    snapshotSessions: (await f.ui.snapshot())!.sessions.length,
  };
  console.log(
    '[T21 asr]',
    JSON.stringify({
      before: before.status?.lease?.leaseId,
      after: final.status?.lease?.leaseId,
      sessions: final.diagnostics?.sessions,
      trace: trace.slice(0, 6),
    }),
  );
  expect((await f.ui.snapshot())!.sessions).toHaveLength(1);
  expect(final.diagnostics?.sessions).toBe(1);
  expect(final.diagnostics?.capture?.trackReadyStates).toEqual(['live']);
  expect((await capturedTabs(f, true)).filter((t) => t.status === 'active')).toHaveLength(1);
  if (final.status?.lease?.leaseId !== before.status?.lease?.leaseId) {
    // 未接管而是重新捕获：旧捕获必须已结束。
    expect(
      final.diagnostics?.lastEnded?.capture?.trackReadyStates.every((x) => x === 'ended'),
    ).toBe(true);
  }
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: recovered.identity.sessionId });
});

test('T22 offscreen 文档意外销毁：会话立即报 offscreen-lost，捕获停止，可重新开始', async () => {
  const { f, page, tabId } = await setup();
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s0 = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.resources.capture === 'active',
    { timeout: 30_000 },
  );
  expect(await capturedTabs(f)).toEqual([{ tabId, status: 'active' }]);
  const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{
    id: string;
    url: string;
  }>;
  const off = targets.find((t) => isOffscreen(f.ext.extensionId)(t as never));
  expect(off).toBeTruthy();
  const closedAt = Date.now();
  await fetch(`http://127.0.0.1:${cdpPort}/json/close/${off!.id}`);
  const failed = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'error' || s.error?.code === 'offscreen-lost',
    {
      timeout: 30_000,
      message: '会话报错 offscreen-lost',
    },
  );
  const detectMs = Date.now() - closedAt;
  // 缺陷 #5(a) 修复后：error 快照的资源状态反映停止后的真实情况。
  const settled = await f.ui.waitSession(
    tabId,
    (x) =>
      x.error?.code === 'offscreen-lost' &&
      x.resources.capture !== 'active' &&
      x.resources.asr === 'idle' &&
      x.resources.activeTracks === 0,
    { timeout: 3_000, message: 'error 快照资源复位' },
  );
  const resourcesSettledMs = Date.now() - closedAt;
  await sleep(1_000);
  const tabs = await capturedTabs(f);
  const snap = (await f.ui.snapshot())!;
  evidence.t22 = {
    detectMs,
    resourcesSettledMs,
    settledResources: settled.resources,
    error: failed.error,
    phase: failed.phase,
    resources: failed.resources,
    capturedTabs: tabs,
    audioOwner: snap.audioOwner,
  };
  console.log('[T22]', JSON.stringify(evidence.t22));
  expect(failed.error?.code).toBe('offscreen-lost');
  expect(tabs.filter((t) => t.status === 'active')).toHaveLength(0);
  expect((await video(page).state()).paused).toBe(false);

  // 无永久 busy：重新开始可以再次捕获。
  await f.ui.ok({ kind: 'session/start', tabId });
  const again = await f.ui.waitSession(
    tabId,
    (s) =>
      s.phase === 'running' &&
      s.resources.capture === 'active' &&
      s.identity.sessionId !== s0.identity.sessionId,
    { timeout: 30_000, message: '重新开始' },
  );
  expect((await offscreen(f)).diagnostics?.capture?.trackReadyStates).toEqual(['live']);
  (evidence.t22 as Record<string, unknown>).restartMs = Date.now() - closedAt;
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: again.identity.sessionId });
});

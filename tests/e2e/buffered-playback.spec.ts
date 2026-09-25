/**
 * Real HTMLVideo + content controller + coordinator + translation scheduler.
 * YouTube, text translation, local preloaded ASR, and the OS TTS boundary are
 * deterministic fixtures. No tabCapture, personal profile, real key, or sound.
 * Build: TONGTING_E2E=1 pnpm exec wxt build
 * Run: pnpm exec playwright test tests/e2e/buffered-playback.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import { makeCaptionLines, type FixtureVideo } from './fixtures/full-chain/youtube';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { installContentTap, tapMessages } from './helpers/content-tap';

test.describe.configure({ timeout: 90_000 });
const CAPTIONED = 'BUFFERED001';
const NO_CAPTIONS = 'PRELOAD0001';
const PAIRING_TOKEN = 'buffer-test-pairing-NOT-A-SECRET';
const lines = makeCaptionLines('Buffered', 40, 3_000, 500);
let fixtures: FixtureVideo[];
let fc: FullChain | undefined;
let preload: Awaited<ReturnType<typeof startPreloadServer>> | undefined;

test.beforeAll(async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成可跳转的视频夹具');
  const media = await silentVideo(125);
  fixtures = [
    { videoId: CAPTIONED, title: 'Buffered captions', lengthSeconds: 125, captions: lines, media },
    { videoId: NO_CAPTIONS, title: 'Buffered audio preload', lengthSeconds: 125, media },
  ];
});

test.afterEach(async () => {
  if (fc && test.info().status !== test.info().expectedStatus) {
    await test.info().attach('buffer-failure-state', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify(
          {
            snapshot: await fc.ui.snapshot(),
            playerMessages: (await tapMessages(fc.ext.serviceWorker).catch(() => [])).filter(
              (m) => m.type === 'player/state',
            ),
            requests: fc.mock.translationRequests().map((r) => ({
              items: r.items,
              finishedAt: r.finishedAt,
              aborted: r.aborted,
            })),
          },
          null,
          2,
        ),
      ),
    });
  }
  await fc?.close();
  fc = undefined;
  await preload?.close();
  preload = undefined;
});

async function startCaptioned(
  options: { playing?: boolean; dubbing?: boolean; translateDelayMs?: number } = {},
) {
  const f = await setupFullChain({ videos: fixtures });
  fc = f;
  await installContentTap(f.ext.serviceWorker);
  if (options.dubbing) await installSilentTts(f);
  await configureProvider(f, {
    playbackMode: 'buffered',
    bufferSeconds: 10,
    outputMode: options.dubbing ? 'subtitle-voice' : 'subtitle',
    sourceStrategy: 'captions-only',
  });
  f.mock.setTranslateDelay(options.translateDelayMs ?? 2_000);
  const { page, tabId } = await openWatch(f, CAPTIONED);
  if (options.playing !== false) expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const session = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'full-track',
  );
  await f.ui.subscribeCues(session.identity.sessionId);
  return { f, page, tabId, session };
}

async function assertHeld(page: Page) {
  await expect.poll(async () => (await video(page).state()).paused).toBe(true);
  const before = await video(page).state();
  await sleep(350);
  const after = await video(page).state();
  expect(after.paused).toBe(true);
  expect(Math.abs(after.currentTimeMs - before.currentTimeMs)).toBeLessThan(60);
  return after;
}

test('full captions: slow translation holds real playback until ten seconds are prepared', async () => {
  const { f, page, tabId } = await startCaptioned();
  await expect.poll(() => f.mock.translationRequests().some((r) => !r.finishedAt)).toBe(true);
  const held = await assertHeld(page);
  const preparing = await f.ui.waitSession(tabId, (s) => s.playbackBuffer?.state === 'preparing');
  expect(preparing.playbackBuffer?.targetMs).toBe(10_000);
  expect(preparing.playbackBuffer!.readyAheadMs).toBeLessThan(10_000);
  expect(held.currentTimeMs).toBeLessThan(2_000);
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await expect.poll(async () => (await video(page).state()).paused).toBe(false);
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThan(held.currentTimeMs + 350);
  await waitOverlay(page, (s) => !!s.main?.startsWith('译[zh-CN]'), 10_000);
});

test('the user keeps a video paused while translation prepares; readiness never autoplays it', async () => {
  const { f, page, tabId } = await startCaptioned({ playing: false });
  await assertHeld(page);
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await assertHeld(page);
  expect((await video(page).state()).currentTimeMs).toBeLessThan(60);
  expect((await f.ui.session(tabId))?.player?.paused).toBe(true);
  // A subsequent native play is honored once the translations are ready.
  expect(await video(page).play()).toBe(true);
  await expect.poll(async () => (await video(page).state()).currentTimeMs).toBeGreaterThan(350);
});

async function installNativeToggleControls(page: Page) {
  // Model a player waiting to distinguish a picture click from a double-click.
  // Product code and the native media element stay real; only the fixture's
  // otherwise absent picture-toggle handler is supplied here.
  await page.evaluate(() => {
    const v = document.querySelector<HTMLVideoElement>('#movie_player video')!;
    const toggle = () => {
      if (v.paused) void v.play();
      else v.pause();
    };
    v.addEventListener('click', () => {
      setTimeout(toggle, 300);
    });
    const button = document.createElement('button');
    button.className = 'ytp-play-button';
    button.textContent = 'Toggle playback';
    button.addEventListener('click', toggle);
    document.querySelector('.ytp-chrome-bottom')!.append(button);
    document.addEventListener('keydown', (event) => {
      if (event.key === 'k') toggle();
    });
  });
}

test('trusted picture clicks, toolbar clicks and keyboard toggles preserve native playback', async () => {
  const { f, page, tabId } = await startCaptioned({ playing: false });
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await assertHeld(page);
  await installNativeToggleControls(page);
  const picture = page.locator('#movie_player video');
  await picture.click();
  await expect.poll(async () => (await video(page).state()).currentTimeMs).toBeGreaterThan(1_000);
  expect((await video(page).state()).paused).toBe(false);
  await picture.click();
  const held = await assertHeld(page);
  expect(held.currentTimeMs).toBeGreaterThan(1_000);
  await picture.click();
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThan(held.currentTimeMs + 1_000);
  expect((await video(page).state()).paused).toBe(false);
  for (const toggle of [
    () => page.getByRole('button', { name: 'Toggle playback' }).click(),
    () => page.locator('body').press('k'),
  ]) {
    await toggle();
    const paused = await assertHeld(page);
    await toggle();
    await expect
      .poll(async () => (await video(page).state()).currentTimeMs)
      .toBeGreaterThan(paused.currentTimeMs + 1_000);
    expect((await video(page).state()).paused).toBe(false);
  }
});

test('a picture click still buffers pending translations and resumes when they are ready', async () => {
  const { f, page, tabId } = await startCaptioned({ playing: false, translateDelayMs: 4_000 });
  await installNativeToggleControls(page);
  await page.locator('#movie_player video').click();
  // Observe the delayed native play and subsequent buffer hold, rather than
  // accidentally accepting the initially paused video before the click settles.
  await expect
    .poll(async () => (await tapMessages(f.ext.serviceWorker)).some((m) => m.reason === 'play'))
    .toBe(true);
  const held = await assertHeld(page);
  expect(held.currentTimeMs).toBeLessThan(500);
  const preparing = await f.ui.waitSession(tabId, (s) => s.playbackBuffer?.state === 'preparing');
  expect(preparing.playbackBuffer!.readyAheadMs).toBeLessThan(10_000);
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThan(held.currentTimeMs + 1_000);
  expect((await video(page).state()).paused).toBe(false);
});

interface TtsTrace {
  calls: Array<{ at: number; text: string }>;
  stops: number[];
}

async function installSilentTts(f: FullChain) {
  await f.ext.serviceWorker.evaluate(() => {
    type Options = { onEvent?: (event: { type: string }) => void };
    const g = globalThis as unknown as {
      chrome: {
        tts: {
          getVoices(): Promise<Array<{ voiceName: string; lang: string; remote: boolean }>>;
          speak(text: string, options: Options): Promise<void>;
          stop(): Promise<void>;
        };
      };
      __bufferTts: TtsTrace;
    };
    g.__bufferTts = { calls: [], stops: [] };
    let end: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    g.chrome.tts.getVoices = async () => [
      { voiceName: 'Deterministic silent test voice', lang: 'zh-CN', remote: false },
    ];
    g.chrome.tts.speak = async (text, options) => {
      const current = ++generation;
      g.__bufferTts.calls.push({ text, at: Date.now() });
      queueMicrotask(() => {
        if (current === generation) options.onEvent?.({ type: 'start' });
      });
      end = setTimeout(() => {
        if (current === generation) options.onEvent?.({ type: 'end' });
      }, 1_000);
    };
    g.chrome.tts.stop = async () => {
      generation++;
      clearTimeout(end);
      g.__bufferTts.stops.push(Date.now());
    };
  });
}

function readTts(f: FullChain) {
  return f.ext.serviceWorker.evaluate(
    () => (globalThis as unknown as { __bufferTts: TtsTrace }).__bufferTts,
  );
}

test('seek discards old dubbing and buffers translations at the new media position before resuming', async () => {
  const { f, page, tabId, session } = await startCaptioned({ dubbing: true });
  await expect
    .poll(async () => (await readTts(f)).calls.length, { timeout: 15_000 })
    .toBeGreaterThan(0);
  const first = await readTts(f);
  const epoch = (await f.ui.session(tabId))!.identity.epoch;
  f.mock.setTranslateDelay(2_500);
  // Two native seeks before the first destination finishes preparing. The
  // second destination must own both the buffer resume and the dubbing queue.
  await f.ui.ok({ kind: 'player/seek', tabId, timeMs: 65_000 });
  await f.ui.ok({ kind: 'player/seek', tabId, timeMs: 80_000 });
  const held = await assertHeld(page);
  expect(held.currentTimeMs).toBeGreaterThanOrEqual(80_000);
  expect(held.currentTimeMs).toBeLessThan(80_200);
  await f.ui.waitSession(tabId, (s) => s.identity.epoch > epoch);
  const atSeek = await readTts(f);
  expect(atSeek.stops.length).toBeGreaterThan(first.stops.length);
  await sleep(350);
  expect((await readTts(f)).calls).toHaveLength(atSeek.calls.length);
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await expect
    .poll(async () => (await video(page).state()).paused, { timeout: 15_000 })
    .toBe(false);
  await expect
    .poll(async () => (await readTts(f)).calls.length, { timeout: 15_000 })
    .toBeGreaterThan(atSeek.calls.length);
  const after = await readTts(f);
  const currentCues = (await f.ui.cues(session.identity.sessionId)).filter((c) => c.endMs > 80_000);
  const allowed = new Set(currentCues.map((c) => c.translatedText));
  expect(after.calls.slice(atSeek.calls.length).every((call) => allowed.has(call.text))).toBe(true);
  await video(page).pause();
  const position = (await video(page).state()).currentTimeMs;
  const line = lines.filter((l) => l.startMs <= position).at(-1)!;
  await waitOverlay(page, (s) => s.main === mockTranslation('zh-CN', line.text), 5_000);
});

interface PreloadRequest {
  startMs: number;
  durationMs: number;
  videoId: string;
  language: string;
  authorization?: string;
  finished: boolean;
}

async function startPreloadServer(failure?: { status: number; code: string }) {
  const requests: PreloadRequest[] = [];
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', ready: true, model: 'fixture', device: 'fixture' }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/youtube/transcribe') {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PreloadRequest;
      const record = { ...body, authorization: req.headers.authorization, finished: false };
      requests.push(record);
      if (record.authorization !== `Bearer ${PAIRING_TOKEN}`) {
        res.writeHead(401).end();
        return;
      }
      if (failure) {
        record.finished = true;
        res.writeHead(failure.status, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: { code: failure.code, message: 'Fixture service error' } }),
        );
        return;
      }
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (res.destroyed) return;
        const durationMs = Math.min(body.durationMs, 125_000 - body.startMs);
        const segments = Array.from({ length: Math.ceil(durationMs / 4_000) }, (_, i) => ({
          startMs: i * 4_000,
          endMs: Math.min(durationMs, (i + 1) * 4_000),
          text: `Preloaded absolute time ${body.startMs + i * 4_000} milliseconds.`,
        }));
        record.finished = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            startMs: body.startMs,
            durationMs,
            language: 'en',
            text: segments.map((s) => s.text).join(' '),
            segments,
          }),
        );
      }, 1_200);
      timers.add(timer);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('no captions: future audio is preloaded while video is paused, with absolute timestamps and no tabCapture', async () => {
  preload = await startPreloadServer();
  const local = preload;
  const f = await setupFullChain({ videos: fixtures });
  fc = f;
  await configureProvider(f, {
    playbackMode: 'buffered',
    bufferSeconds: 10,
    sourceStrategy: 'asr-only',
    asr: { backend: 'local', localUrl: local.baseUrl },
  });
  await f.ui.ok({ kind: 'asr/set-token', token: PAIRING_TOKEN });
  await f.ext.serviceWorker.evaluate(() => {
    const g = globalThis as unknown as {
      __captureAttempts: number;
      chrome: { tabCapture: { getMediaStreamId(...args: unknown[]): Promise<string> } };
    };
    g.__captureAttempts = 0;
    g.chrome.tabCapture.getMediaStreamId = async () => {
      g.__captureAttempts++;
      throw new Error('Buffered preload must not request tabCapture');
    };
  });
  f.mock.setTranslateDelay(1_500);
  const { page, tabId } = await openWatch(f, NO_CAPTIONS);
  await video(page).seek(40);
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const session = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'asr-preload',
  );
  await f.ui.subscribeCues(session.identity.sessionId);
  await expect.poll(() => local.requests.length).toBeGreaterThan(0);
  const first = local.requests[0]!;
  expect(first.videoId).toBe(NO_CAPTIONS);
  expect(first.startMs).toBeGreaterThanOrEqual(40_000);
  expect(first.startMs).toBeLessThan(41_000);
  expect(first.authorization).toBe(`Bearer ${PAIRING_TOKEN}`);
  expect(first.finished).toBe(false);
  const held = await assertHeld(page);
  await expect.poll(() => first.finished).toBe(true);
  expect((await video(page).state()).paused).toBe(true);
  await f.ui.waitSession(tabId, (s) => (s.playbackBuffer?.readyAheadMs ?? 0) >= 10_000);
  await expect.poll(async () => (await video(page).state()).paused).toBe(false);
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThan(held.currentTimeMs + 300);
  const cues = await f.ui.cues(session.identity.sessionId);
  const firstCue = cues.find((cue) => cue.startMs === first.startMs);
  expect(firstCue?.endMs).toBe(first.startMs + 4_000);
  expect(firstCue?.translatedText).toBe(mockTranslation('zh-CN', firstCue!.sourceText));
  const settled = (await f.ui.session(tabId))!;
  expect(settled.resources.capture).toBe('none');
  expect(settled.resources.activeTracks).toBe(0);
  expect(
    await f.ext.serviceWorker.evaluate(
      () => (globalThis as unknown as { __captureAttempts: number }).__captureAttempts,
    ),
  ).toBe(0);
});

test('disabled local preloading gives actionable setup guidance in the real side panel', async () => {
  preload = await startPreloadServer({ status: 503, code: 'youtube_preload_unavailable' });
  const f = await setupFullChain({ videos: fixtures });
  fc = f;
  await f.ui.page.setViewportSize({ width: 320, height: 1000 });
  await configureProvider(f, {
    playbackMode: 'buffered',
    sourceStrategy: 'asr-only',
    asr: { backend: 'local', localUrl: preload.baseUrl },
  });
  await f.ui.ok({ kind: 'asr/set-token', token: PAIRING_TOKEN });
  const { tabId } = await openWatch(f, NO_CAPTIONS);
  await f.ui.ok({ kind: 'session/start', tabId });
  const session = await f.ui.waitSession(tabId, (s) => s.error?.code === 'preload-unavailable');
  expect(session.error?.retryable).toBe(false);
  await expect(
    f.ui.page.getByRole('alert').getByText(session.error!.message, { exact: true }),
  ).toBeVisible();
  await expect(f.ui.page.getByRole('button', { name: '检查设置', exact: true })).toBeVisible();
  await expect(f.ui.page.getByText('本地识别模型正在加载，请稍候。', { exact: true })).toHaveCount(
    0,
  );
  expect(
    await f.ui.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBe(true);
  await f.ui.page.screenshot({
    path: test.info().outputPath('preload-unavailable-320.png'),
    fullPage: true,
  });
});

test('incomplete captions in sync-first mode fall back to translating as the video plays', async () => {
  const f = await setupFullChain({
    videos: fixtures.map((fixture) => ({ ...fixture, timedtextBlocked: true })),
  });
  fc = f;
  await f.ui.page.setViewportSize({ width: 320, height: 1000 });
  await configureProvider(f, { playbackMode: 'buffered', sourceStrategy: 'captions-only' });
  const { page, tabId } = await openWatch(f, CAPTIONED);
  // 边播放边开始翻译：准备阶段闸门先暂停视频。
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  await expect
    .poll(async () => (await video(page).state()).paused, { intervals: [100] })
    .toBe(true);
  // 完整轨道读不到、又不能预读音频：不再报错，本次改为边播边译并说明原因。
  const session = await f.ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.sourceMode === 'incremental-captions',
    { timeout: 30_000 },
  );
  expect(session.error).toBeUndefined();
  expect(session.playbackBuffer).toBeUndefined();
  expect(session.notice?.message).toContain('边播边译');
  await expect(f.ui.page.getByText(session.notice!.message, { exact: true })).toBeVisible();
  expect(
    await f.ui.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
  ).toBe(true);
  await f.ui.page.screenshot({
    path: test.info().outputPath('incomplete-captions-fallback-320.png'),
    fullPage: true,
  });
  // 退回后闸门交还播放：准备阶段暂停的视频自动继续播放，不需要用户再点播放，并显示译文。
  await expect.poll(async () => (await video(page).state()).paused).toBe(false);
  const resumed = await video(page).state();
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThan(resumed.currentTimeMs + 350);
  await waitOverlay(page, (s) => !!s.main?.startsWith('译[zh-CN]'), 15_000);
});

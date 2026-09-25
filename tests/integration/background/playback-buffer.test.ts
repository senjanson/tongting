import { afterEach, describe, expect, it } from 'vitest';
import type {
  YoutubePreloadRequest,
  YoutubePreloadResult,
} from '@src/providers/asr/youtube-preload';
import { configure, createHarness, FakeScheduler, wait, type Harness } from './harness';

const active: Harness[] = [];
function harness() {
  const h = createHarness();
  active.push(h);
  return h;
}
afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  }
});

async function startPreload(h: Harness) {
  await configure(h, { asr: true, buffered: true });
  const requests: {
    request: YoutubePreloadRequest;
    resolve(value: YoutubePreloadResult): void;
    reject(error: Error): void;
  }[] = [];
  h.deps.preloadYoutubeAudio = (request) =>
    new Promise((resolve, reject) => requests.push({ request, resolve, reject }));
  const content = h.content(1);
  content.hello();
  content.navigate('aaaaaaaaaaa', { tracks: false });
  content.player({ currentTimeMs: 30000, durationMs: 120000, paused: true }, 'pause');
  await wait(10);
  await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
  await h.coordinator.idle();
  return { content, requests };
}
const latest = (h: Harness) => h.coordinator.buildSnapshot(0).sessions[0]!;

describe('buffered session orchestration', () => {
  it('loads future audio while video is paused without acquiring tab capture', async () => {
    const h = harness();
    const { content, requests } = await startPreload(h);
    expect(latest(h)).toMatchObject({
      sourceMode: 'asr-preload',
      phase: 'running',
      playbackBuffer: { state: 'preparing', readyAheadMs: 0 },
    });
    expect(requests[0]!.request).toMatchObject({
      startMs: 30000,
      durationMs: 20000,
      videoId: 'aaaaaaaaaaa',
    });
    expect(h.offscreen.requests.some((r) => r.kind === 'capture/start')).toBe(false);
    requests[0]!.resolve({
      startMs: 30000,
      durationMs: 20000,
      text: 'Hello',
      language: 'en',
      segments: [{ startMs: 0, endMs: 4000, text: 'Hello' }],
    });
    await wait(10);
    expect(latest(h).playbackBuffer?.readyAheadMs).toBe(0);
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit(
      scheduler.cues.map((c) => ({
        cueId: c.id,
        cueRevision: c.revision,
        state: 'done',
        translatedText: '你好',
      })),
    );
    await wait(10);
    expect(latest(h).playbackBuffer).toMatchObject({ state: 'ready', readyAheadMs: 20000 });
    expect(content.messages('session/state').at(-1)?.session?.playbackBuffer?.readyUntilMs).toBe(
      50000,
    );
  });
  it('aborts seeking/pause work and ignores late recognition, including returning to the same video', async () => {
    const h = harness();
    const { content, requests } = await startPreload(h);
    content.player({ currentTimeMs: 90000, durationMs: 120000, paused: true }, 'seeked');
    await wait(10);
    expect(requests[0]!.request.signal.aborted).toBe(true);
    expect(requests[1]!.request.startMs).toBe(90000);
    requests[0]!.resolve({
      startMs: 30000,
      durationMs: 20000,
      text: 'old',
      segments: [{ startMs: 0, endMs: 4000, text: 'old' }],
    });
    await wait(10);
    expect(FakeScheduler.all.at(-1)!.cues).toHaveLength(0);
    await h.coordinator.handleCommand({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    expect(requests[1]!.request.signal.aborted).toBe(true);
    expect(latest(h).phase).toBe('paused');
  });
  it('credential revocation cancels the active preload and cannot dispatch with the old token', async () => {
    const h = harness();
    const { requests } = await startPreload(h);
    await h.coordinator.handleCommand({ kind: 'asr/clear-token' });
    await h.coordinator.idle();
    expect(requests[0]!.request.signal.aborted).toBe(true);
    requests[0]!.resolve({ startMs: 30000, durationMs: 20000, text: '', segments: [] });
    await wait(10);
    expect(requests).toHaveLength(1);
    expect(latest(h).phase).toBe('error');
  });
  it('advances the epoch once when queued pause and volume events already sample a seek destination', async () => {
    const h = harness();
    const { content, requests } = await startPreload(h);
    const epoch = latest(h).identity.epoch;
    content.player(
      { currentTimeMs: 90000, durationMs: 120000, paused: true, seeking: true },
      'pause',
    );
    content.player(
      { currentTimeMs: 90000, durationMs: 120000, paused: true, seeking: true },
      'seeking',
    );
    content.player(
      { currentTimeMs: 95000, durationMs: 120000, paused: true, seeking: true },
      'volumechange',
    );
    await wait(10);
    expect(latest(h).identity.epoch).toBe(epoch);
    expect(requests[0]!.request.signal.aborted).toBe(true);
    content.player(
      { currentTimeMs: 95000, durationMs: 120000, paused: true, seeking: false },
      'seeked',
    );
    await wait(10);
    expect(latest(h).identity.epoch).toBe(epoch + 1);
    expect(requests[1]!.request.startMs).toBe(95000);
  });
  it('switching to continuous mode cancels preloading and starts the existing live capture route', async () => {
    const h = harness();
    const { requests } = await startPreload(h);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { playbackMode: 'continuous' },
    });
    await h.coordinator.idle();
    expect(requests[0]!.request.signal.aborted).toBe(true);
    expect(latest(h).sourceMode).toBe('asr');
    expect(latest(h).playbackBuffer).toBeUndefined();
    expect(h.offscreen.requests.some((r) => r.kind === 'capture/start')).toBe(true);
  });
  it('without captions and without preloadable recognition, sync-first falls back to live recognition', async () => {
    const h = harness();
    await configure(h, { asr: true, buffered: true });
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { asr: { backend: 'sub2api', sub2apiModel: 'asr-test' } },
    });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    content.player({ currentTimeMs: 30000, durationMs: 120000, paused: true }, 'pause');
    await wait(10);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(20);
    expect(latest(h).error).toBeUndefined();
    expect(latest(h)).toMatchObject({
      phase: 'running',
      sourceMode: 'asr',
      notice: { code: 'buffered-fallback-asr', level: 'warning' },
    });
    // 边播边识别：不保持视频，也不向页面下发缓冲闸门。
    expect(latest(h).playbackBuffer).toBeUndefined();
    expect(h.offscreen.requests.some((r) => r.kind === 'capture/start')).toBe(true);
  });
  it('shows preload failures as blocked rather than claiming buffered silence', async () => {
    const h = harness();
    const { requests } = await startPreload(h);
    requests[0]!.reject(new Error('unavailable'));
    await wait(10);
    expect(latest(h).playbackBuffer).toMatchObject({ state: 'blocked', readyAheadMs: 0 });
    expect(latest(h).error).toBeDefined();
  });
  it('requires the contiguous translated prefix of a full subtitle track before readiness', async () => {
    const h = harness();
    await configure(h, { buffered: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    content.player({ paused: true, durationMs: 20000 });
    await wait(10);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(10);
    content.trackData();
    await h.coordinator.idle();
    expect(latest(h).playbackBuffer?.readyAheadMs).toBe(0);
    const scheduler = FakeScheduler.all.at(-1)!;
    expect(scheduler.config.prefetch).toBe(true);
    scheduler.emit(
      scheduler.cues.map((c) => ({
        cueId: c.id,
        cueRevision: c.revision,
        state: 'done',
        translatedText: '测试译文',
      })),
    );
    await wait(10);
    expect(latest(h).playbackBuffer).toMatchObject({ state: 'ready', readyAheadMs: 20000 });
  });
});

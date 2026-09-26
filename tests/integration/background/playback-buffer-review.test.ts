import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import type {
  YoutubePreloadRequest,
  YoutubePreloadResult,
} from '@src/providers/asr/youtube-preload';
import { configure, createHarness, FakeScheduler, wait, type Harness } from './harness';

const active: Harness[] = [];
afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10_000);
    await h.coordinator.idle();
  }
  vi.useRealTimers();
});

async function startPreload() {
  const h = createHarness();
  active.push(h);
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
  return { h, content, requests };
}

const latest = (h: Harness) => h.coordinator.buildSnapshot(0).sessions[0]!;

describe('buffered playback failure and configuration recovery', () => {
  it('retries and resumes in one click when a failed preload was subsequently paused', async () => {
    const { h, requests } = await startPreload();
    requests[0]!.reject(
      new AppError({
        code: 'preload-test-failure',
        category: 'network',
        retryable: true,
        message: '请重试',
      }),
    );
    await wait(10);
    await h.coordinator.handleCommand({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    expect(latest(h).phase).toBe('paused');
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    expect(latest(h).phase).toBe('running');
    expect(latest(h).error).toBeUndefined();
    expect(requests).toHaveLength(2);
  });

  // Retryable preload failures (model loading, a full queue, network) recover on their own: the
  // buffer keeps preparing and the preloader re-requests after Retry-After or backoff.
  const retryable = {
    network: { retryAfterMs: undefined, window: [500, 1_000] },
    timeout: { retryAfterMs: undefined, window: [500, 1_000] },
    'rate-limit': { retryAfterMs: 3_000, window: [3_000, 3_500] },
  } as const;
  const preloadFailure = (category: keyof typeof retryable) =>
    new AppError({
      code: 'preload-test-failure',
      category,
      retryable: true,
      message: '请重试',
      ...(retryable[category].retryAfterMs !== undefined
        ? { retryAfterMs: retryable[category].retryAfterMs }
        : {}),
    });

  it.each(['network', 'timeout', 'rate-limit'] as const)(
    'keeps preparing after a single %s preload failure and re-requests after the backoff',
    async (category) => {
      const { h, requests } = await startPreload();
      vi.useFakeTimers();
      requests[0]!.reject(preloadFailure(category));
      await vi.advanceTimersByTimeAsync(10);
      expect(latest(h).playbackBuffer?.state).toBe('preparing');
      expect(latest(h).error).toBeUndefined();
      // Still starting up rather than failed: no chunk has been recognized yet.
      expect(latest(h).resources.asr).toBe('loading');
      const [earliest, latestRetry] = retryable[category].window;
      await vi.advanceTimersByTimeAsync(earliest - 11);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(latestRetry - earliest + 20);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.request).toMatchObject({ startMs: 30000, durationMs: 20000 });
      requests[1]!.resolve({
        startMs: 30000,
        durationMs: 20000,
        text: 'Hello',
        language: 'en',
        segments: [{ startMs: 0, endMs: 4000, text: 'Hello' }],
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(latest(h).playbackBuffer?.state).toBe('preparing');
      expect(latest(h).resources.asr).toBe('running');
      expect(FakeScheduler.all.at(-1)!.cues).toHaveLength(1);
    },
  );

  it.each(['network', 'timeout', 'rate-limit'] as const)(
    'retries a %s preload error through the UI callout session/start command once automatic retries run out',
    async (category) => {
      const { h, requests } = await startPreload();
      vi.useFakeTimers();
      // The first failure plus five automatic retries; only the last one blocks playback.
      for (let i = 0; i < 6; i++) {
        requests[i]!.reject(preloadFailure(category));
        await vi.advanceTimersByTimeAsync(10);
        if (i === 5) break;
        expect(latest(h).playbackBuffer?.state).toBe('preparing');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(requests).toHaveLength(i + 2);
      }
      expect(latest(h).playbackBuffer?.state).toBe('blocked');
      expect(latest(h).error).toMatchObject({ code: 'preload-test-failure' });
      expect(latest(h).resources.asr).toBe('error');
      expect(latest(h).translation.failed).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(requests).toHaveLength(6);

      await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await h.coordinator.idle();
      expect(requests).toHaveLength(7);
      expect(latest(h).error).toBeUndefined();
      expect(latest(h).playbackBuffer?.state).toBe('preparing');
      expect(latest(h).resources.asr).toBe('running');
      // Repeated clicks while the retry is in flight must not create duplicate requests.
      await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
      await vi.advanceTimersByTimeAsync(0);
      await h.coordinator.idle();
      expect(requests).toHaveLength(7);
      requests[6]!.resolve({
        startMs: 30000,
        durationMs: 20000,
        text: 'Hello',
        language: 'en',
        segments: [{ startMs: 0, endMs: 4000, text: 'Hello' }],
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(latest(h).playbackBuffer?.state).toBe('preparing');
      const scheduler = FakeScheduler.all.at(-1)!;
      scheduler.emit(
        scheduler.cues.map((c) => ({
          cueId: c.id,
          cueRevision: c.revision,
          state: 'done',
          translatedText: '你好',
        })),
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(latest(h).playbackBuffer).toMatchObject({ state: 'ready', readyAheadMs: 20000 });
      expect(latest(h).error).toBeUndefined();
    },
  );

  it.each(['url', 'token', 'backend'] as const)(
    'preserves paused intent after changing the ASR %s, then rebuilds on explicit resume',
    async (change) => {
      const { h, requests } = await startPreload();
      await h.coordinator.handleCommand({ kind: 'session/pause', tabId: 1 });
      await h.coordinator.idle();
      const sessionId = latest(h).identity.sessionId;
      expect(requests[0]!.request.signal.aborted).toBe(true);
      if (change === 'token') {
        await h.coordinator.handleCommand({ kind: 'asr/set-token', token: 'new-test-local-token' });
      } else {
        await h.coordinator.handleCommand({
          kind: 'settings/update',
          patch: {
            asr: change === 'url' ? { localUrl: 'http://127.0.0.1:8766' } : { backend: 'none' },
          },
        });
      }
      await h.coordinator.idle();
      expect(latest(h)).toMatchObject({
        identity: { sessionId },
        phase: 'paused',
        desiredState: 'paused',
      });
      expect(requests).toHaveLength(1);
      requests[0]!.resolve({
        startMs: 30000,
        durationMs: 20000,
        text: 'Stale',
        segments: [{ startMs: 0, endMs: 4000, text: 'Stale' }],
      });
      await wait(10);
      expect(FakeScheduler.all.at(-1)!.cues).toHaveLength(0);

      await h.coordinator.handleCommand({ kind: 'session/resume', tabId: 1, sessionId });
      await h.coordinator.idle();
      expect(latest(h).identity.sessionId).not.toBe(sessionId);
      if (change === 'backend') {
        expect(latest(h)).toMatchObject({ phase: 'error', error: { code: 'asr-not-configured' } });
        expect(requests).toHaveLength(1);
      } else {
        expect(latest(h).phase).toBe('running');
        expect(requests).toHaveLength(2);
        expect(requests[1]!.request).toMatchObject(
          change === 'url'
            ? { baseUrl: 'http://127.0.0.1:8766' }
            : { token: 'new-test-local-token' },
        );
      }
    },
  );
});

describe('translation errors are cleared when the translation config changes', () => {
  async function startFullTrack() {
    const h = createHarness();
    active.push(h);
    await configure(h, { buffered: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    content.player({ currentTimeMs: 0, durationMs: 8000, paused: true }, 'pause');
    await wait(10);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(50);
    return h;
  }

  const failAll = (category: 'config' | 'auth', code: string) => {
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit(
      scheduler.cues.map((c) => ({
        cueId: c.id,
        cueRevision: c.revision,
        state: 'failed' as const,
        error: { code, category, retryable: false, message: code },
      })),
    );
  };
  const translateAll = () => {
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit(
      scheduler.cues.map((c) => ({
        cueId: c.id,
        cueRevision: c.revision,
        state: 'done' as const,
        translatedText: '译文',
      })),
    );
  };

  it('clears model-not-found after a valid model is saved, so buffered playback becomes ready', async () => {
    const h = await startFullTrack();
    failAll('config', 'model-not-found');
    await wait(10);
    expect(latest(h).error).toMatchObject({ code: 'model-not-found' });
    expect(latest(h).playbackBuffer?.state).toBe('blocked');

    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { model: 'gpt-5.6-luna' } },
    });
    await h.coordinator.idle();
    expect(latest(h).error).toBeUndefined();
    translateAll();
    await wait(10);
    expect(latest(h).playbackBuffer).toMatchObject({ state: 'ready' });
    expect(latest(h).error).toBeUndefined();
    expect(latest(h).notice?.code).not.toBe('translation-failing');
  });

  it('a config error is also cleared when a later translation succeeds', async () => {
    const h = await startFullTrack();
    failAll('config', 'model-not-found');
    await wait(10);
    translateAll();
    await wait(10);
    expect(latest(h).error).toBeUndefined();
    expect(latest(h).playbackBuffer).toMatchObject({ state: 'ready' });
  });

  it('clears an auth error as soon as a new API key is saved', async () => {
    const h = await startFullTrack();
    failAll('auth', 'auth-invalid');
    await wait(10);
    expect(latest(h).error).toMatchObject({ code: 'auth-invalid' });
    await h.coordinator.handleCommand({
      kind: 'credentials/set',
      apiKey: 'sk-test-another-key-123456',
      remember: false,
    });
    await h.coordinator.idle();
    expect(latest(h).error).toBeUndefined();
  });
});

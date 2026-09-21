import { afterEach, describe, expect, it } from 'vitest';
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
    await h.coordinator.idle();
  }
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

  it.each(['network', 'timeout', 'rate-limit'] as const)(
    'retries a %s preload error through the UI callout session/start command',
    async (category) => {
      const { h, requests } = await startPreload();
      requests[0]!.reject(
        new AppError({
          code: 'preload-test-failure',
          category,
          retryable: true,
          message: '请重试',
        }),
      );
      await wait(10);
      expect(latest(h).playbackBuffer?.state).toBe('blocked');
      expect(latest(h).translation.failed).toBe(0);

      await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
      await h.coordinator.idle();
      expect(requests).toHaveLength(2);
      expect(latest(h).error).toBeUndefined();
      expect(latest(h).playbackBuffer?.state).toBe('preparing');
      expect(latest(h).resources.asr).toBe('running');
      // Repeated clicks while the retry is in flight must not create duplicate requests.
      await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
      await h.coordinator.idle();
      expect(requests).toHaveLength(2);
      requests[1]!.resolve({
        startMs: 30000,
        durationMs: 20000,
        text: 'Hello',
        language: 'en',
        segments: [{ startMs: 0, endMs: 4000, text: 'Hello' }],
      });
      await wait(10);
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
      await wait(10);
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

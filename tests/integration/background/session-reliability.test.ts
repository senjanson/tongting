import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIncrementalCaptionAssembler } from '@src/captions/incremental';
import type { TranscriptRecord } from '@src/storage/db';
import { errorNextStep, sessionProblem } from '@src/ui/state/derive';
import {
  configure,
  createHarness,
  FakeScheduler,
  wait,
  type Harness,
  type ContentClient,
} from './harness';

const active: Harness[] = [];
const releases: (() => void)[] = [];
function harness() {
  const h = createHarness();
  active.push(h);
  return h;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  releases.push(resolve);
  return { promise, resolve };
}
const latest = (h: Harness) => h.coordinator.buildSnapshot(1).sessions[0]!;
const trackRequests = (c: ContentClient) =>
  c.requestKinds().filter((k) => k === 'captions/load-track').length;
const trackFailure = (c: ContentClient) =>
  c.send({
    type: 'captions/error',
    navigationId: c.navigationId,
    videoId: c.videoId,
    error: {
      code: 'track-fetch-failed',
      category: 'network',
      retryable: true,
      message: '轨道加载失败',
    },
  });

async function start(
  h: Harness,
  options: {
    fallback?: boolean;
    timeout?: boolean;
    shorts?: boolean;
    count?: number;
    partial?: boolean;
  } = {},
) {
  h.deps.createIncrementalCaptionAssembler = createIncrementalCaptionAssembler;
  const c = h.content(1);
  c.hello();
  c.navigate('aaaaaaaaaaa');
  if (options.shorts)
    c.send({
      type: 'page/video',
      navigationId: c.navigationId,
      videoId: c.videoId!,
      isLive: false,
      isShorts: true,
      durationMs: 600_000,
    });
  await wait(5);
  await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
  await vi.waitFor(() => expect(trackRequests(c)).toBe(1), { interval: 5 });
  if (options.fallback) trackFailure(c);
  else if (!options.timeout) {
    const cues = Array.from({ length: options.count ?? 2 }, (_, i) => ({
      startMs: i * 2000,
      endMs: i * 2000 + 2000,
      text: `Test sentence ${i}.`,
    }));
    if (options.partial)
      c.send({
        type: 'captions/track-data',
        navigationId: c.navigationId,
        videoId: c.videoId!,
        track: { trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' },
        format: 'json3',
        complete: false,
        rejectedCount: 0,
        cues,
      });
    else c.trackData(cues);
  }
  await h.coordinator.idle();
  return c;
}

afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  }
  vi.restoreAllMocks();
});

describe('buffered captions diagnostics and recovery', () => {
  it.each([
    ['captions-only', 'failure'],
    ['captions-first', 'failure'],
    ['captions-only', 'timeout'],
    ['captions-first', 'timeout'],
  ] as const)(
    'explains incomplete captions for %s after %s and recovers in continuous mode',
    async (sourceStrategy, reason) => {
      const h = harness();
      await configure(h, { buffered: true });
      await h.coordinator.handleCommand({ kind: 'settings/update', patch: { sourceStrategy } });
      if (reason === 'timeout') h.deps.timings = { trackLoadTimeoutMs: 30 };
      const c = await start(h, { fallback: reason === 'failure', timeout: reason === 'timeout' });
      expect(latest(h)).toMatchObject({
        phase: 'error',
        sourceMode: 'incremental-captions',
        error: {
          code: 'buffered-captions-incomplete',
          retryable: false,
        },
      });
      expect(latest(h).notice).toBeUndefined();
      expect(latest(h).error!.message).toContain('连续播放');
      expect(latest(h).error!.message).not.toContain('没有可读取的字幕');
      expect(errorNextStep(latest(h).error!).action).toBe('open-settings');
      expect(
        c.requests
          .filter((r) => r.request.kind === 'captions/observe-visible')
          .map((r) => (r.request as { enable: boolean }).enable),
      ).toEqual([true, false]);

      await h.coordinator.handleCommand({
        kind: 'settings/update',
        patch: { playbackMode: 'continuous' },
      });
      await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
      await vi.waitFor(() => expect(trackRequests(c)).toBe(2), { interval: 5 });
      trackFailure(c);
      await h.coordinator.idle();
      expect(latest(h)).toMatchObject({
        phase: 'running',
        sourceMode: 'incremental-captions',
        notice: { code: 'incremental-captions' },
      });
      expect(latest(h).error).toBeUndefined();
    },
  );

  it('still falls back to configured local audio preloading when full captions fail', async () => {
    const h = harness();
    await configure(h, { buffered: true, asr: true });
    h.deps.preloadYoutubeAudio = vi.fn(async (request) => ({
      startMs: request.startMs,
      durationMs: request.durationMs,
      text: '',
      segments: [],
    }));
    const c = await start(h, { fallback: true });
    c.player({ currentTimeMs: 0, durationMs: 100_000, paused: true }, 'pause');
    await vi.waitFor(() => expect(h.deps.preloadYoutubeAudio).toHaveBeenCalled());
    expect(latest(h)).toMatchObject({ phase: 'running', sourceMode: 'asr-preload' });
    expect(latest(h).notice).toBeUndefined();
    expect(h.offscreen.kinds()).not.toContain('capture/start');
  });
});

describe('translation problems take priority and source notices return after recovery', () => {
  it.each(['shorts', 'incremental'] as const)(
    '%s keeps rate-limit, blocked and failure notices visible',
    async (source) => {
      const h = harness();
      await configure(h);
      const c = await start(h, { shorts: source === 'shorts', fallback: source === 'incremental' });
      if (source === 'incremental')
        c.send({
          type: 'captions/visible',
          navigationId: c.navigationId,
          videoId: c.videoId!,
          text: 'Hello world.',
          mediaTimeMs: 0,
          sampledAtEpochMs: Date.now(),
        });
      const scheduler = FakeScheduler.all.at(-1)!;
      await vi.waitFor(() => expect(scheduler.cues.length).toBeGreaterThan(0));
      const sourceCode = source === 'shorts' ? 'shorts-unverified' : 'incremental-captions';
      const base = scheduler.stats();
      const stats = vi.spyOn(scheduler, 'stats');
      stats.mockReturnValue({ ...base, rateLimitedUntil: Date.now() + 60_000 } as typeof base);
      expect(latest(h).notice!.code).toBe('translation-rate-limited');
      stats.mockReturnValue(base);
      expect(latest(h).notice!.code).toBe(sourceCode);
      const error = {
        code: 'test-provider-error',
        category: 'network' as const,
        retryable: true,
        message: '测试服务故障',
      };
      stats.mockReturnValue({ ...base, blockedError: error } as typeof base);
      expect(latest(h).notice!.code).toBe('translation-blocked');
      expect(sessionProblem(latest(h))?.source).toBe('blocked');
      stats.mockReturnValue(base);
      const cue = scheduler.cues[0]!;
      scheduler.emit([{ cueId: cue.id, cueRevision: cue.revision, state: 'failed', error }]);
      expect(latest(h).notice!.code).toBe('translation-failing');
      scheduler.emit([
        { cueId: cue.id, cueRevision: cue.revision, state: 'done', translatedText: '你好' },
      ]);
      expect(latest(h).notice!.code).toBe(sourceCode);
      if (source === 'incremental') {
        c.trackData();
        await vi.waitFor(() => expect(latest(h).sourceMode).toBe('full-track'));
        expect(latest(h).notice).toBeUndefined();
      }
    },
  );
});

describe('transcript snapshots are coalesced without losing the last update or record identity', () => {
  it.each([false, true])(
    'preserves a partial track without mixing it into local preloading (asr=%s)',
    async (asr) => {
      const h = harness();
      await configure(h, { buffered: true, asr });
      h.deps.timings = { transcriptSaveDebounceMs: 60_000 };
      h.deps.preloadYoutubeAudio = vi.fn(async (request) => ({
        startMs: request.startMs,
        durationMs: request.durationMs,
        text: 'Audio only',
        language: 'en',
        segments: [{ startMs: 0, endMs: 1000, text: 'Audio only' }],
      }));
      const c = await start(h, { partial: true });
      if (asr) {
        expect(latest(h).sourceMode).toBe('asr-preload');
        expect(FakeScheduler.all.at(-1)!.cues).toHaveLength(0);
        expect(c.messages('session/cues').at(-1)).toMatchObject({ full: true, cues: [] });
        c.player({ currentTimeMs: 0, durationMs: 20_000, paused: true }, 'pause');
        await vi.waitFor(() => expect(FakeScheduler.all.at(-1)!.cues).toHaveLength(1));
      } else expect(latest(h).error!.code).toBe('buffered-captions-incomplete');
      await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
      await h.coordinator.idle();
      const track = h.transcripts.get('aaaaaaaaaaa|zh-CN|track:en') as TranscriptRecord;
      expect(track.sourceLabel).toBe('English');
      expect(track.cues.map((cue) => cue.sourceText)).toEqual([
        'Test sentence 0.',
        'Test sentence 1.',
      ]);
      const audio = [...h.transcripts.values()].find(
        (record) => (record as TranscriptRecord).sourceMode === 'asr-preload',
      ) as TranscriptRecord | undefined;
      if (asr) expect(audio?.cues.map((cue) => cue.sourceText)).toEqual(['Audio only']);
      else expect(audio).toBeUndefined();
    },
  );

  it('coalesces 5000-cue updates until the timer and flushes the final update on stop', async () => {
    const h = harness();
    await configure(h);
    h.deps.timings = { transcriptSaveDebounceMs: 250 };
    const put = vi.spyOn(h.deps.transcripts, 'putTranscript');
    await start(h, { count: 5000 });
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const scheduler = FakeScheduler.all.at(-1)!;
    for (const cue of scheduler.cues.slice(0, 3))
      scheduler.emit([
        { cueId: cue.id, cueRevision: cue.revision, state: 'done', translatedText: '测试译文' },
      ]);
    expect(
      clone.mock.calls.filter(([input]) => {
        const record = input as Partial<TranscriptRecord> | undefined;
        return record?.recordId && record.cues?.length === 5000;
      }),
    ).toHaveLength(0);
    expect(put).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0]![0].cues.slice(0, 3).map((cue) => cue.translatedText)).toEqual([
      '测试译文',
      '测试译文',
      '测试译文',
    ]);
    const last = scheduler.cues[3]!;
    scheduler.emit([
      {
        cueId: last.id,
        cueRevision: last.revision,
        state: 'done',
        translatedText: '停止前最后更新',
      },
    ]);
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![0].cues[3]!.translatedText).toBe('停止前最后更新');
    await wait(270);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('freezes old language and track before transitions even when storage is still waiting', async () => {
    const h = harness();
    await configure(h);
    h.deps.timings = { transcriptSaveDebounceMs: 60_000 };
    const c = await start(h);
    const storage = deferred();
    const get = h.deps.transcripts.getTranscript;
    h.deps.transcripts.getTranscript = async (id) => {
      await storage.promise;
      return get(id);
    };
    const scheduler = FakeScheduler.all.at(-1)!;
    const cue = scheduler.cues[0]!;
    scheduler.emit([
      { cueId: cue.id, cueRevision: cue.revision, state: 'done', translatedText: '原轨道中文' },
    ]);
    await h.coordinator.handleCommand({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    c.send({
      type: 'captions/tracks',
      navigationId: c.navigationId,
      videoId: c.videoId!,
      availability: 'available',
      tracks: [{ trackKey: 'fr', languageCode: 'fr', label: 'French', kind: 'manual' }],
    });
    c.send({
      type: 'captions/track-data',
      navigationId: c.navigationId,
      videoId: c.videoId!,
      track: { trackKey: 'fr', languageCode: 'fr', label: 'French', kind: 'manual' },
      format: 'json3',
      complete: true,
      rejectedCount: 0,
      cues: [{ startMs: 0, endMs: 2000, text: 'Bonjour.' }],
    });
    await vi.waitFor(() => expect(latest(h).sourceTrack?.trackKey).toBe('fr'));
    storage.resolve();
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
    const chinese = h.transcripts.get('aaaaaaaaaaa|zh-CN|track:en') as TranscriptRecord;
    const japanese = h.transcripts.get('aaaaaaaaaaa|ja|track:en') as TranscriptRecord;
    const french = h.transcripts.get('aaaaaaaaaaa|ja|track:fr') as TranscriptRecord;
    expect(chinese.cues[0]).toMatchObject({
      targetLanguage: 'zh-CN',
      translatedText: '原轨道中文',
    });
    expect(japanese.cues[0]).toMatchObject({
      targetLanguage: 'ja',
      sourceText: 'Test sentence 0.',
    });
    expect(japanese.cues[0]!.translatedText).toBeUndefined();
    expect(french.cues[0]).toMatchObject({ targetLanguage: 'ja', sourceText: 'Bonjour.' });
  });
});

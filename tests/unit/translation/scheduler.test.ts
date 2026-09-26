import { describe, expect, it } from 'vitest';
import {
  buildTranslationCacheKey,
  createMemoryTranslationCache,
} from '@src/storage/translation-cache';
import { translatedUntil } from '@src/translation/playback-buffer';
import {
  createTranslationScheduler,
  createTranslationSchedulerWithOptions,
  type SchedulerOptions,
} from '@src/translation/scheduler';
import type {
  SchedulerIdentity,
  TranslationCache,
  TranslationConfig,
} from '@src/translation/types';
import {
  baseConfig,
  collectUpdates,
  FakeClock,
  FakeProvider,
  makeCue,
  makeTrack,
  settle,
  waitUntil,
} from './fakes';

const identityA: SchedulerIdentity = {
  sessionId: 'session-A',
  epoch: 1,
  configRevision: 1,
  sourceKey: 'videoA|en-manual',
};

function setup(
  params: {
    config?: Partial<TranslationConfig>;
    options?: Partial<SchedulerOptions>;
    provider?: FakeProvider;
    cache?: TranslationCache;
    identity?: SchedulerIdentity;
  } = {},
) {
  const clock = new FakeClock();
  const provider = params.provider ?? new FakeProvider();
  const cache = params.cache ?? createMemoryTranslationCache();
  const updates = collectUpdates();
  const config = { ...baseConfig, ...params.config };
  const identity = params.identity ?? identityA;
  const scheduler = createTranslationSchedulerWithOptions(
    { provider, cache, now: clock.now, random: () => 0.5 },
    config,
    identity,
    { timers: clock, ...params.options },
  );
  scheduler.onUpdate(updates.listener);
  return { clock, provider, cache, updates, scheduler, config };
}

const ids = (call: { input: { items: { id: string }[] } }) => call.input.items.map((i) => i.id);
const range = (prefix: string, from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

describe('translation scheduler: priority, batching, prefetch', () => {
  it('translates the cue at the playhead first, in contiguous batches ≤ 8 with bounded context, at concurrency 2', async () => {
    const { provider, scheduler, updates } = setup();
    expect(scheduler.stats()).toEqual({ total: 0, done: 0, pending: 0, running: 0, failed: 0 });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(60), identityA);

    await waitUntil(() => provider.calls.length === 2);
    await settle();
    expect(provider.calls).toHaveLength(2);
    expect(ids(provider.calls[0]!)).toEqual(range('c', 20, 27));
    expect(provider.calls[0]!.input.context.map((c) => c.text)).toEqual(
      [17, 18, 19].map((i) => `This is line number ${i} of the video.`),
    );
    expect(ids(provider.calls[1]!)).toEqual(['c19']);
    expect(updates.of('running').map((u) => u.cueId)).toEqual([...range('c', 20, 27), 'c19']);
    expect(scheduler.stats()).toMatchObject({ total: 60, running: 9, done: 0 });
    expect(scheduler.stats().lastLatencyMs).toBeUndefined();

    provider.respond(provider.calls[0]!);
    await waitUntil(() => provider.calls.length === 3);
    const done = updates.of('done');
    expect(done.map((u) => u.cueId)).toEqual(range('c', 20, 27));
    expect(done[0]).toMatchObject({
      cueRevision: 0,
      translatedText: '译：This is line number 20 of the video.',
    });
    expect(done[0]!.translationKey).toMatch(/^test-prompt-v1:/);
    expect(scheduler.stats()).toMatchObject({ done: 8, lastLatencyMs: 321, model: 'model-a-2026' });
    // 下一批是预取
    expect(ids(provider.calls[2]!)).toEqual(range('c', 28, 35));
  });

  it('prefetches only up to ~45 s ahead, and not at all when prefetch is disabled', async () => {
    const off = setup({ config: { prefetch: false } });
    off.scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    off.scheduler.setCues(makeTrack(100), identityA);
    await waitUntil(() => off.provider.calls.length === 1);
    expect(ids(off.provider.calls[0]!)).toEqual(range('c', 19, 23));
    off.provider.respond(off.provider.calls[0]!);
    await settle(20);
    expect(off.provider.calls).toHaveLength(1);

    const on = setup();
    on.scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    on.scheduler.setCues(makeTrack(100), identityA);
    for (let guard = 0; guard < 30; guard++) {
      await waitUntil(() => on.scheduler.inspect().pendingLookups === 0);
      await settle(5);
      const open = on.provider.open();
      if (open.length === 0) break;
      for (const call of open) on.provider.respond(call);
    }
    const requested = new Set(on.provider.calls.flatMap(ids));
    expect([...requested].sort()).toEqual(range('c', 19, 42).sort());
    expect(on.scheduler.stats()).toMatchObject({ done: 24, pending: 76 });
  });

  it('bounds the number of unfinished cues admitted by prefetch', async () => {
    const { provider, scheduler } = setup({
      options: { maxPendingCues: 4, currentAheadMs: 1_000 },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: false, playbackRate: 1 });
    scheduler.setCues(
      makeTrack(40).map((c) => ({ ...c, startMs: c.startMs + 10_000, endMs: c.endMs + 10_000 })),
      identityA,
    );
    await waitUntil(() => provider.calls.length >= 1);
    await settle();
    expect(provider.calls.flatMap(ids)).toEqual(range('c', 0, 3));
  });

  it('scales windows with playback rate and keeps late ASR finals behind the playhead', async () => {
    const { provider, scheduler } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 60_000, playing: true, playbackRate: 2 });
    scheduler.setCues(
      [
        makeCue('old-track', 45_000, 50_000, 'An old caption track line that already passed.'),
        makeCue('late-asr', 45_000, 50_000, 'A recognized sentence that arrived late.', {
          source: 'asr',
        }),
        makeCue('ahead-2x', 74_000, 75_000, 'This line is fourteen seconds ahead.'),
      ],
      identityA,
    );
    await waitUntil(() => provider.calls.length >= 1);
    await settle();
    const requested = provider.calls.flatMap(ids);
    expect(requested).toContain('late-asr');
    expect(requested).toContain('ahead-2x');
    expect(requested).not.toContain('old-track');
  });
});

describe('translation scheduler: skipped, interim, revisions', () => {
  it('does not translate interim, empty or same-language cues, and translates a cue once it becomes final', async () => {
    const { provider, scheduler, updates } = setup();
    scheduler.setPlayhead({ mediaTimeMs: 1_000, playing: true, playbackRate: 1 });
    scheduler.setCues(
      [
        makeCue('interim', 0, 2_000, 'we are still hearing this', {
          stability: 'interim',
          source: 'asr',
        }),
        makeCue('zh', 0, 2_000, '这已经是中文了', { sourceLanguage: 'zh-CN' }),
        makeCue('empty', 0, 2_000, '   '),
        makeCue('normal', 2_000, 3_000, 'Normal English line here.'),
      ],
      identityA,
    );
    await waitUntil(() => provider.calls.length === 1);
    expect(
      updates
        .of('skipped')
        .map((u) => u.cueId)
        .sort(),
    ).toEqual(['empty', 'zh']);
    expect(ids(provider.calls[0]!)).toEqual(['normal']);

    scheduler.upsertCues([
      makeCue('interim', 0, 2_000, 'we are still hearing this now', {
        stability: 'final',
        source: 'asr',
        revision: 3,
      }),
    ]);
    await waitUntil(() => provider.calls.length === 2);
    expect(ids(provider.calls[1]!)).toEqual(['interim']);
    provider.respond(provider.calls[1]!);
    await waitUntil(() => updates.doneFor('interim').length === 1);
    expect(updates.doneFor('interim')[0]).toMatchObject({
      cueRevision: 3,
      translatedText: '译：we are still hearing this now',
    });
    expect(scheduler.stats()).toMatchObject({ total: 2 });
  });

  it('drops a result whose cue revision changed while in flight, keeps the rest, and retranslates the new revision', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(3), identityA);
    await waitUntil(() => provider.calls.length === 1);
    scheduler.upsertCues([
      makeCue('c1', 2_000, 4_000, 'Corrected second line text.', { revision: 1 }),
    ]);
    provider.respond(provider.calls[0]!);
    await waitUntil(() => provider.calls.length === 2);
    expect(
      updates
        .of('done')
        .map((u) => u.cueId)
        .sort(),
    ).toEqual(['c0', 'c2']);
    expect(ids(provider.calls[1]!)).toEqual(['c1']);
    expect(provider.calls[1]!.input.items[0]!.text).toBe('Corrected second line text.');
    provider.respond(provider.calls[1]!);
    await waitUntil(() => updates.doneFor('c1').length === 1);
    expect(updates.doneFor('c1')[0]).toMatchObject({
      cueRevision: 1,
      translatedText: '译：Corrected second line text.',
    });
  });

  it('removing all cues of an in-flight batch aborts the request', async () => {
    const { provider, scheduler } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(2), identityA);
    await waitUntil(() => provider.calls.length === 1);
    scheduler.removeCues(['c0', 'c1']);
    expect(provider.calls[0]!.aborted).toBe(true);
    expect(scheduler.inspect().inflightRequests).toBe(0);
  });
});

describe('translation scheduler: cache (T27, T38)', () => {
  const keyParts = (text: string, overrides: Record<string, unknown> = {}) => ({
    sourceKey: identityA.sourceKey,
    sourceText: text,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    profileKey: new FakeProvider().profileKey,
    promptVersion: 'test-prompt-v1',
    style: 'natural' as const,
    glossary: [],
    ...overrides,
  });

  it('serves a full-key cache hit without a request', async () => {
    const cache = createMemoryTranslationCache();
    await cache.set(await buildTranslationCacheKey(keyParts('Cached line.')), '缓存里的译文');
    const { provider, scheduler, updates } = setup({ cache });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'Cached line.')], identityA);
    await waitUntil(() => updates.doneFor('a').length === 1);
    expect(updates.doneFor('a')[0]).toMatchObject({
      translatedText: '缓存里的译文',
      fromCache: true,
    });
    await settle(10);
    expect(provider.calls).toHaveLength(0);
  });

  it.each([
    ['glossary changed', { glossary: [{ source: 'line', target: '台词' }] }, {}],
    [
      'model/profile changed',
      {},
      { profileKey: 'https://api.example.com|responses|model-b|reasoning=omit' },
    ],
    ['style changed', { style: 'faithful' }, {}],
    ['target changed', { targetLanguage: 'zh-TW' }, {}],
  ] as const)(
    'does not hit a stale cache entry when %s',
    async (_label, configOverride, providerOverride) => {
      const cache = createMemoryTranslationCache();
      await cache.set(await buildTranslationCacheKey(keyParts('Cached line.')), '旧版本译文');
      const provider = new FakeProvider(
        (providerOverride as { profileKey?: string }).profileKey ??
          'https://api.example.com|responses|model-a|reasoning=omit',
      );
      const { scheduler, updates } = setup({
        cache,
        provider,
        config: configOverride as Partial<TranslationConfig>,
      });
      scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
      scheduler.setCues([makeCue('a', 0, 2_000, 'Cached line.')], identityA);
      await waitUntil(() => provider.calls.length === 1);
      expect(updates.doneFor('a')).toHaveLength(0);
    },
  );

  it('does not hit when the source text or source version changed', async () => {
    const cache = createMemoryTranslationCache();
    await cache.set(await buildTranslationCacheKey(keyParts('Cached line.')), '旧版本译文');
    const { provider, scheduler } = setup({
      cache,
      identity: { ...identityA, sourceKey: 'videoA|asr-2' },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(
      [makeCue('a', 0, 2_000, 'Cached line.'), makeCue('b', 2_000, 3_000, 'Cached line!')],
      { ...identityA, sourceKey: 'videoA|asr-2' },
    );
    await waitUntil(() => provider.calls.length === 1);
    expect(ids(provider.calls[0]!)).toEqual(['a', 'b']);
  });

  it('keeps translating when cache reads and writes fail, and counts the failures', async () => {
    const failing: TranslationCache = {
      get: () => Promise.reject(new Error('idb read broken')),
      set: () => Promise.reject(new Error('idb quota exceeded')),
      clear: () => Promise.resolve(),
    };
    const { provider, scheduler, updates } = setup({ cache: failing, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'Line one.')], identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.respond(provider.calls[0]!);
    await waitUntil(
      () => updates.doneFor('a').length === 1 && scheduler.inspect().cacheWriteFailures === 1,
    );
    expect(scheduler.inspect().cacheReadFailures).toBe(1);
  });

  it('never writes failed or empty results to the cache', async () => {
    const writes: [string, string][] = [];
    const cache: TranslationCache = {
      get: async () => undefined,
      set: async (k, v) => {
        writes.push([k, v]);
      },
      clear: async () => undefined,
    };
    const { provider, scheduler, updates } = setup({
      cache,
      config: { prefetch: false },
      options: { maxRetries: 0 },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(
      [makeCue('a', 0, 2_000, 'Line one.'), makeCue('b', 2_000, 3_000, 'Line two.')],
      identityA,
    );
    await waitUntil(() => provider.calls.length === 1);
    provider.respond(provider.calls[0]!, (id, text) => (id === 'a' ? `译：${text}` : '   '));
    await waitUntil(() => provider.calls.length === 2);
    provider.fail(provider.calls[1]!, {
      code: 'server-error',
      category: 'server',
      retryable: true,
      message: 'x',
    });
    await waitUntil(() => updates.of('failed').length === 1);
    expect(writes.map(([, v]) => v)).toEqual(['译：Line one.']);
  });
});

describe('translation scheduler: epochs, sessions, config (T11, T12, T13, T28)', () => {
  it('T11: a far seek aborts unrelated requests; a late old result is cached but never written to the new epoch', async () => {
    const provider = new FakeProvider(undefined, true);
    const { scheduler, updates } = setup({ provider, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(150), identityA);
    await waitUntil(() => provider.calls.length === 1);
    const oldCall = provider.calls[0]!;
    expect(ids(oldCall)).toEqual(range('c', 19, 23));

    scheduler.setPlayhead({ mediaTimeMs: 200_000, playing: true, playbackRate: 1 });
    scheduler.setEpoch(2);
    expect(oldCall.aborted).toBe(true);
    await waitUntil(() => provider.calls.length === 2);
    expect(ids(provider.calls[1]!)).toEqual(range('c', 99, 103));

    // 旧请求迟到返回（传输层没有响应 abort）
    provider.respond(oldCall);
    await settle(20);
    expect(updates.of('done')).toHaveLength(0);
    expect(scheduler.inspect().memoryResults).toBe(5);

    // 回到旧位置：从缓存发出，不再请求
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    scheduler.setEpoch(3);
    await waitUntil(() => updates.of('done').length === 5);
    expect(updates.of('done').every((u) => u.fromCache)).toBe(true);
    expect(provider.calls.flatMap(ids).filter((id) => id === 'c20')).toHaveLength(1);
  });

  it('epoch change without leaving the window keeps the request, and emits its result only through the current-epoch cache path', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(3), identityA);
    await waitUntil(() => provider.calls.length === 1);
    scheduler.setEpoch(2);
    expect(provider.calls[0]!.aborted).toBe(false);
    provider.respond(provider.calls[0]!);
    await waitUntil(() => updates.of('done').length === 3);
    expect(updates.of('done').every((u) => u.fromCache === true)).toBe(true);
    expect(provider.calls).toHaveLength(1);
  });

  it('T12: video A→B→A — old A result arriving late never writes into the new A session', async () => {
    const provider = new FakeProvider(undefined, true);
    const { scheduler, updates } = setup({ provider, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('x1', 0, 2_000, 'Hello from video A.')], identityA);
    await waitUntil(() => provider.calls.length === 1);
    const oldA = provider.calls[0]!;

    const identityB = {
      sessionId: 'session-B',
      epoch: 1,
      configRevision: 1,
      sourceKey: 'videoB|en',
    };
    scheduler.setCues([makeCue('x1', 0, 2_000, 'Hello from video B.')], identityB);
    expect(oldA.aborted).toBe(true);
    await waitUntil(() => provider.calls.length === 2);
    const callB = provider.calls[1]!;

    const identityA2 = {
      sessionId: 'session-A2',
      epoch: 1,
      configRevision: 1,
      sourceKey: 'videoA|en-manual',
    };
    scheduler.setCues([makeCue('x1', 0, 2_000, 'Hello from video A, second visit.')], identityA2);
    expect(callB.aborted).toBe(true);
    await waitUntil(() => provider.calls.length === 3);

    provider.respond(oldA);
    provider.respond(callB);
    await settle(20);
    expect(updates.of('done')).toHaveLength(0);

    provider.respond(provider.calls[2]!);
    await waitUntil(() => updates.of('done').length === 1);
    expect(updates.of('done')[0]).toMatchObject({
      cueId: 'x1',
      translatedText: '译：Hello from video A, second visit.',
    });
  });

  it('T13/T28: setConfig aborts in-flight requests, switches provider, and ignores late results from the old provider', async () => {
    const oldProvider = new FakeProvider(
      'https://old.example.com|responses|model-a|reasoning=omit',
      true,
    );
    const { scheduler, updates } = setup({ provider: oldProvider, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(2), identityA);
    await waitUntil(() => oldProvider.calls.length === 1);

    const newProvider = new FakeProvider('https://new.example.com|chat|model-b|reasoning=omit');
    scheduler.setConfig({ ...baseConfig, prefetch: false, targetLanguage: 'ja' }, 2, newProvider);
    expect(oldProvider.calls[0]!.aborted).toBe(true);
    await waitUntil(() => newProvider.calls.length === 1);
    expect(newProvider.calls[0]!.input.targetLanguage).toBe('ja');

    oldProvider.respond(oldProvider.calls[0]!, (_id, text) => `旧中文：${text}`);
    await settle(20);
    expect(updates.of('done')).toHaveLength(0);
    expect(oldProvider.calls).toHaveLength(1);

    newProvider.respond(newProvider.calls[0]!, (_id, text) => `訳：${text}`);
    await waitUntil(() => updates.of('done').length === 2);
    expect(updates.of('done').map((u) => u.translatedText)).toEqual([
      '訳：This is line number 0 of the video.',
      '訳：This is line number 1 of the video.',
    ]);
    expect(scheduler.stats().model).toBe('model-a-2026');
  });

  it('setConfig with the same revision and provider (scheduling-only change) keeps done translations and in-flight requests', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(40), identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.respond(provider.calls[0]!);
    await waitUntil(() => updates.of('done').length === 4);
    scheduler.setPlayhead({ mediaTimeMs: 6_000, playing: true, playbackRate: 1 });
    await waitUntil(() => provider.calls.length === 2);
    const inFlight = provider.calls[1]!;

    scheduler.setConfig(
      { ...baseConfig, prefetch: true, timeoutMs: 30_000 },
      identityA.configRevision,
      provider,
    );
    expect(inFlight.aborted).toBe(false);
    expect(scheduler.stats().done).toBe(4);
    expect(updates.of('skipped')).toHaveLength(0);
    provider.respond(inFlight);
    await waitUntil(() => provider.calls.length >= 3);
    expect(provider.calls[2]!.options.timeoutMs).toBe(30_000);
    expect(scheduler.stats().done).toBe(7);
    // 预取已生效，且已完成的 cue 不会被重新请求
    const requested = provider.calls.flatMap(ids);
    expect(new Set(requested).size).toBe(requested.length);
    expect(requested).toContain('c7');
  });

  it('T28: same-revision setConfig with a new provider instance (e.g. new Key) aborts old requests, keeps done translations and unblocks auth failures', async () => {
    const oldProvider = new FakeProvider(undefined, true);
    const { scheduler, updates } = setup({ provider: oldProvider, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(40), identityA);
    await waitUntil(() => oldProvider.calls.length === 1);
    oldProvider.respond(oldProvider.calls[0]!);
    await waitUntil(() => updates.of('done').length === 4);

    scheduler.setPlayhead({ mediaTimeMs: 8_000, playing: true, playbackRate: 1 });
    await waitUntil(() => oldProvider.calls.length === 2);
    oldProvider.fail(oldProvider.calls[1]!, {
      code: 'auth-invalid',
      category: 'auth',
      retryable: false,
      message: 'Key 无效',
    });
    await waitUntil(() => updates.of('failed').length > 0);
    expect(scheduler.inspect().blockedError).toBeDefined();
    scheduler.setPlayhead({ mediaTimeMs: 16_000, playing: true, playbackRate: 1 });
    await settle(20);
    expect(oldProvider.calls).toHaveLength(2);

    const newKeyProvider = new FakeProvider(oldProvider.profileKey);
    scheduler.setConfig(
      { ...baseConfig, prefetch: false },
      identityA.configRevision,
      newKeyProvider,
    );
    expect(scheduler.inspect().blockedError).toBeUndefined();
    expect(scheduler.stats().done).toBe(4);
    await waitUntil(() => newKeyProvider.calls.length >= 1);
    // 新 Key 只用于新实例；旧实例不再收到任何调用
    await settle(20);
    expect(oldProvider.calls).toHaveLength(2);
    for (const call of newKeyProvider.open()) newKeyProvider.respond(call);
    await waitUntil(
      () => scheduler.stats().running === 0 && scheduler.inspect().pendingLookups === 0,
    );
    expect(new Set(newKeyProvider.calls.flatMap(ids)).has('c8')).toBe(true);
  });

  it('setConfig with a new revision, or a changed translation fingerprint, resets translations and aborts requests', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(4), identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.respond(provider.calls[0]!);
    await waitUntil(() => updates.of('done').length === 4);

    // 同 revision 但目标语言变了：防御性地按完整失效处理
    scheduler.setConfig(
      { ...baseConfig, prefetch: false, targetLanguage: 'ko' },
      identityA.configRevision,
      provider,
    );
    expect(scheduler.stats()).toMatchObject({ done: 0 });
    await waitUntil(() => provider.calls.length === 2);
    expect(provider.calls[1]!.input.targetLanguage).toBe('ko');

    scheduler.setConfig(
      { ...baseConfig, prefetch: false, targetLanguage: 'ko' },
      identityA.configRevision + 1,
      provider,
    );
    expect(provider.calls[1]!.aborted).toBe(true);
    expect(scheduler.stats()).toMatchObject({ done: 0, running: 0 });
    await waitUntil(() => provider.calls.length === 3);
  });

  it('coordinator flow: setConfig(new revision) then setCues(cleared cues) sends one set of requests only', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(3), identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.respond(provider.calls[0]!);
    await waitUntil(() => updates.of('done').length === 3);

    const next = new FakeProvider('https://api.example.com|chat|model-b|reasoning=omit');
    scheduler.setConfig({ ...baseConfig, prefetch: false, style: 'faithful' }, 2, next);
    scheduler.setEpoch(2);
    scheduler.setCues(makeTrack(3), { ...identityA, epoch: 2, configRevision: 2 });
    await waitUntil(() => next.calls.length === 1);
    await settle(20);
    expect(next.calls).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    next.respond(next.calls[0]!);
    await waitUntil(() => updates.of('done').length === 6);
    expect(
      updates
        .of('done')
        .slice(3)
        .every((u) => typeof u.translatedText === 'string' && u.translatedText.length > 0),
    ).toBe(true);
  });

  it('partial streaming text is emitted only as rollback-able running updates for the current identity', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'Streaming line.')], identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.calls[0]!.options.onPartial?.([{ id: 'a', text: '流式' }]);
    expect(updates.all.filter((u) => u.partial)).toEqual([
      { cueId: 'a', cueRevision: 0, state: 'running', translatedText: '流式', partial: true },
    ]);
    scheduler.setEpoch(2);
    provider.calls[0]!.options.onPartial?.([{ id: 'a', text: '流式更多' }]);
    expect(updates.all.filter((u) => u.partial)).toHaveLength(1);
  });
});

describe('translation scheduler: failures, retries, rate limits (T05, T07, T08, T09)', () => {
  it('retries network/server failures at most twice with exponential backoff, then fails', async () => {
    const { clock, provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: false, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'Retry me.')], identityA);
    await waitUntil(() => provider.calls.length === 1);

    provider.fail(provider.calls[0]!, {
      code: 'server-error',
      category: 'server',
      retryable: true,
      message: '5xx',
    });
    await settle(10);
    await clock.advance(749);
    expect(provider.calls).toHaveLength(1);
    await clock.advance(1);
    await waitUntil(() => provider.calls.length === 2);

    provider.fail(provider.calls[1]!, {
      code: 'stream-interrupted',
      category: 'network',
      retryable: true,
      message: 'cut',
    });
    await settle(10);
    await clock.advance(1_499);
    expect(provider.calls).toHaveLength(2);
    await clock.advance(1);
    await waitUntil(() => provider.calls.length === 3);

    provider.fail(provider.calls[2]!, {
      code: 'timeout',
      category: 'timeout',
      retryable: true,
      message: 'slow',
    });
    await waitUntil(() => updates.of('failed').length === 1);
    await clock.advance(60_000);
    expect(provider.calls).toHaveLength(3);
    expect(updates.of('failed')[0]!.error).toMatchObject({ category: 'timeout' });
    expect(scheduler.stats()).toMatchObject({ failed: 1, pending: 0 });
    expect(scheduler.retryFailed()).toBe(1);
    await waitUntil(() => provider.calls.length === 4);
  });

  it('T05: 401/403 are not retried and block new requests until the user acts', async () => {
    const { clock, provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'First line.')], identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.fail(provider.calls[0]!, {
      code: 'auth-invalid',
      category: 'auth',
      retryable: false,
      message: 'Key 无效',
      httpStatus: 401,
    });
    await waitUntil(() => updates.of('failed').length === 1);

    scheduler.upsertCues([makeCue('b', 1_000, 3_000, 'Second line.')]);
    await waitUntil(() => updates.of('failed').length === 2);
    await clock.advance(120_000);
    scheduler.setPlayhead({ mediaTimeMs: 1_500, playing: true, playbackRate: 1 });
    await settle(10);
    expect(provider.calls).toHaveLength(1);
    expect(scheduler.inspect().blockedError).toMatchObject({ category: 'auth' });
    expect(updates.of('failed')[1]).toMatchObject({ cueId: 'b', error: { category: 'auth' } });

    expect(scheduler.retryFailed()).toBe(2);
    await waitUntil(() => provider.calls.length === 2);
    expect(ids(provider.calls[1]!)).toEqual(['a', 'b']);
  });

  it('T07: 429 shares one cooldown, drops concurrency to 1, pauses prefetch, and never retries in a storm', async () => {
    const { clock, provider, scheduler, updates } = setup({
      options: { prefetchResumeDelayMs: 15_000 },
    });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: false, playbackRate: 1 });
    scheduler.setCues(makeTrack(100), identityA);
    await waitUntil(() => provider.calls.length === 2);

    const rateLimited = {
      code: 'rate-limited',
      category: 'rate-limit',
      retryable: true,
      message: '429',
      httpStatus: 429,
      retryAfterMs: 2_000,
    } as const;
    provider.fail(provider.calls[0]!, rateLimited);
    provider.fail(provider.calls[1]!, rateLimited);
    await settle(10);
    expect(scheduler.inspect()).toMatchObject({
      concurrencyLimit: 1,
      prefetchSuspended: true,
      inflightRequests: 0,
    });
    expect(scheduler.stats().rateLimitedUntil).toBe(clock.t + 2_000);
    expect(updates.of('failed')).toHaveLength(0);

    await clock.advance(2_499);
    expect(provider.calls).toHaveLength(2);
    await clock.advance(1);
    await waitUntil(() => provider.calls.length === 3);
    await settle(10);
    expect(provider.open()).toHaveLength(1);
    expect(ids(provider.calls[2]!)).toEqual(range('c', 19, 23));

    provider.respond(provider.calls[2]!);
    await settle(20);
    // 预取仍暂停，当前窗口已完成 → 没有新请求
    expect(provider.calls).toHaveLength(3);

    await clock.advance(15_000);
    await waitUntil(() => provider.calls.length === 4);
    expect(provider.open()).toHaveLength(1);
    provider.respond(provider.calls[3]!);
    await waitUntil(() => provider.calls.length === 5);
    expect(provider.open()).toHaveLength(1);
    provider.respond(provider.calls[4]!);
    // 连续 3 次成功后恢复并发 2（剩余预取 cue 只够组成一批）
    await waitUntil(() => provider.calls.length === 6);
    expect(scheduler.inspect()).toMatchObject({ concurrencyLimit: 2, prefetchSuspended: false });
    expect(provider.calls.slice(3).map(ids)).toEqual([
      range('c', 24, 31),
      range('c', 32, 39),
      range('c', 40, 42),
    ]);
    expect(provider.maxOpen).toBeLessThanOrEqual(2);
  });

  it('T07: a Retry-After longer than the auto-retry limit fails visibly instead of waiting silently', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues([makeCue('a', 0, 2_000, 'Rate limited line.')], identityA);
    await waitUntil(() => provider.calls.length === 1);
    provider.fail(provider.calls[0]!, {
      code: 'rate-limited',
      category: 'rate-limit',
      retryable: true,
      message: '429',
      retryAfterMs: 3_600_000,
    });
    await waitUntil(() => updates.of('failed').length === 1);
    expect(updates.of('failed')[0]!.error).toMatchObject({ retryAfterMs: 3_600_000 });
  });

  it('T09: incomplete batch results are retried per cue as single requests, then fail without mismatching', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(4), identityA);
    await waitUntil(() => provider.calls.length === 1);
    expect(ids(provider.calls[0]!)).toEqual(range('c', 0, 3));
    provider.respond(provider.calls[0]!, (id, text) =>
      id === 'c1' || id === 'c3' ? undefined : `译：${text}`,
    );
    await waitUntil(() => provider.calls.length === 3);
    expect(provider.calls.slice(1).map(ids)).toEqual([['c1'], ['c3']]);
    expect(updates.of('done').map((u) => u.cueId)).toEqual(['c0', 'c2']);

    provider.respond(provider.calls[1]!);
    provider.fail(provider.calls[2]!, {
      code: 'translation-invalid',
      category: 'format',
      retryable: true,
      message: 'bad json',
    });
    await waitUntil(() => updates.of('failed').length === 1);
    expect(updates.of('failed')[0]).toMatchObject({
      cueId: 'c3',
      error: { category: 'format', retryable: true },
    });
    expect(updates.doneFor('c1')[0]!.translatedText).toBe(
      '译：This is line number 1 of the video.',
    );
    await settle(10);
    expect(provider.calls).toHaveLength(3);
  });
});

describe('translation scheduler: pause, resume, dispose', () => {
  it('pause aborts in-flight requests and sends nothing until resume; dispose stops all callbacks', async () => {
    const provider = new FakeProvider(undefined, true);
    const { clock, scheduler, updates } = setup({ provider });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(30), identityA);
    await waitUntil(() => provider.calls.length === 2);

    scheduler.pause();
    expect(provider.calls.every((c) => c.aborted)).toBe(true);
    expect(scheduler.inspect().inflightRequests).toBe(0);
    expect(scheduler.stats().running).toBe(0);
    provider.respond(provider.calls[0]!);
    await clock.advance(60_000);
    scheduler.setPlayhead({ mediaTimeMs: 10_000, playing: true, playbackRate: 1 });
    await settle(10);
    expect(provider.calls).toHaveLength(2);
    expect(updates.of('done')).toHaveLength(0);

    scheduler.resume();
    await waitUntil(() => provider.calls.length >= 3);
    const inFlight = provider.calls.at(-1)!;

    const updatesBefore = updates.all.length;
    scheduler.dispose();
    expect(inFlight.aborted).toBe(true);
    provider.respond(inFlight);
    inFlight.options.onPartial?.([{ id: inFlight.input.items[0]!.id, text: 'late' }]);
    scheduler.setPlayhead({ mediaTimeMs: 20_000, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(5), identityA);
    await clock.advance(60_000);
    await settle(20);
    expect(updates.all.length).toBe(updatesBefore);
    expect(scheduler.onUpdate(() => undefined)()).toBeUndefined();
    expect(scheduler.inspect()).toMatchObject({ disposed: true, inflightRequests: 0 });
  });

  it('exposes the contract factory', () => {
    const scheduler = createTranslationScheduler(
      { provider: new FakeProvider(), cache: createMemoryTranslationCache() },
      baseConfig,
      identityA,
    );
    expect(scheduler.stats()).toEqual({ total: 0, done: 0, pending: 0, running: 0, failed: 0 });
    scheduler.dispose();
  });
});

describe('translation scheduler: full-track backfill', () => {
  it('translates the rest of a full track one request at a time once the playback window is done', async () => {
    const { provider, scheduler } = setup();
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(60), identityA);
    await settle();
    for (let round = 0; round < 30 && provider.open().length > 0; round++) {
      for (const call of provider.open()) provider.respond(call);
      await settle();
    }
    const windowIds = provider.calls.flatMap(ids);
    expect(windowIds).not.toContain('c59');
    expect(scheduler.stats().done).toBeLessThan(60);

    scheduler.setBackfill(true);
    await settle();
    let rounds = 0;
    while (provider.open().length > 0 && rounds++ < 40) {
      expect(provider.open()).toHaveLength(1);
      provider.respond(provider.open()[0]!);
      await settle();
    }
    expect(scheduler.stats().done).toBe(60);
    expect(provider.maxOpen).toBeLessThanOrEqual(2);
  });

  it('stops sending backfill requests when disabled or paused', async () => {
    const { provider, scheduler } = setup();
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(60), identityA);
    await settle();
    for (let round = 0; round < 30 && provider.open().length > 0; round++) {
      for (const call of provider.open()) provider.respond(call);
      await settle();
    }
    scheduler.setBackfill(true);
    await settle();
    expect(provider.open()).toHaveLength(1);
    scheduler.setBackfill(false);
    provider.respond(provider.open()[0]!);
    await settle();
    expect(provider.open()).toHaveLength(0);
    scheduler.setBackfill(true);
    await settle();
    expect(provider.open()).toHaveLength(1);
    scheduler.pause();
    await settle();
    expect(provider.open()).toHaveLength(0);
  });
});

describe('translation scheduler: cues longer than 60 s', () => {
  it('requests a 0–120 s cue at playhead 95 s so the translated range moves past the playhead', async () => {
    // 已保存的字幕记录、ASR 等来源不经过 normalize 的 60 s 上限，直接进入调度器。
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    const long = makeCue('long', 0, 120_000, 'Background music keeps playing for two minutes.');
    scheduler.setPlayhead({ mediaTimeMs: 95_000, playing: true, playbackRate: 1 });
    scheduler.setCues([long], identityA);

    await waitUntil(() => provider.calls.length === 1);
    expect(ids(provider.calls[0]!)).toEqual(['long']);
    const ranges = [{ startMs: 0, endMs: 150_000 }];
    expect(translatedUntil(95_000, ranges, [long])).toBe(95_000);

    provider.respond(provider.calls[0]!);
    await waitUntil(() => updates.doneFor('long').length === 1);
    const done = updates.doneFor('long')[0]!;
    const translated = {
      ...long,
      translationState: 'done' as const,
      translatedText: done.translatedText,
    };
    expect(translatedUntil(95_000, ranges, [translated])).toBe(150_000);
  });

  it('recomputes the lookback when a long cue arrives or an existing cue grows through upsertCues', async () => {
    const { provider, scheduler } = setup({ config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 170_000, playing: true, playbackRate: 1 });
    const grow = makeCue('grow', 5_000, 20_000, 'A caption whose end is extended later.');
    scheduler.setCues([grow], identityA);
    await settle();
    expect(provider.calls).toHaveLength(0);

    scheduler.upsertCues([
      makeCue('asr-long', 60_000, 180_000, 'A long ASR segment.', { source: 'asr' }),
    ]);
    await waitUntil(() => provider.calls.length === 1);
    expect(ids(provider.calls[0]!)).toEqual(['asr-long']);
    provider.respond(provider.calls[0]!);
    await settle();

    // 只改时间（revision/文本不变）也要重算跨度：grow 的新跨度超过 asr-long，起点落在旧窗口之外。
    scheduler.upsertCues([{ ...grow, endMs: 175_000 }]);
    await waitUntil(() => provider.calls.length === 2);
    expect(ids(provider.calls[1]!)).toEqual(['grow']);
  });
});

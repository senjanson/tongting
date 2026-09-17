/**
 * 翻译模块审查问题的回归测试（#1/#2 非阻断 400、#4 pending、#5 缓存超时、#6 熔断、#10、#13、#17）。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cancelledError, type AppErrorInfo } from '@src/domain/errors';
import { errorFromHttpStatus } from '@src/providers/text/http-errors';
import type {
  TranslateBatchInput,
  TranslateBatchResult,
  TranslateOptions,
} from '@src/providers/text/types';
import { createMemoryTranslationCache } from '@src/storage/translation-cache';
import {
  createTranslationSchedulerWithOptions,
  type SchedulerOptions,
  type SchedulerTranslateOptions,
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
  makeTrack,
  settle,
  waitUntil,
} from './fakes';

const FIXTURES = resolve(__dirname, '../../fixtures/sub2api');
const identity: SchedulerIdentity = {
  sessionId: 's-review',
  epoch: 1,
  configRevision: 1,
  sourceKey: 'v|en',
};

function setup(
  params: {
    provider?: {
      profileKey: string;
      promptVersion: string;
      translateBatch: FakeProvider['translateBatch'];
    };
    cache?: TranslationCache;
    config?: Partial<TranslationConfig>;
    options?: Partial<SchedulerOptions>;
  } = {},
) {
  const clock = new FakeClock();
  const provider = params.provider ?? new FakeProvider();
  const updates = collectUpdates();
  const scheduler = createTranslationSchedulerWithOptions(
    {
      provider,
      cache: params.cache ?? createMemoryTranslationCache(),
      now: clock.now,
      random: () => 0.5,
    },
    { ...baseConfig, ...params.config },
    identity,
    { timers: clock, ...params.options },
  );
  scheduler.onUpdate(updates.listener);
  return { clock, provider, updates, scheduler };
}

const lastState = (updates: ReturnType<typeof collectUpdates>, id: string) =>
  updates.all.filter((u) => u.cueId === id && !u.partial).at(-1)?.state;
const ids = (call: { input: { items: { id: string }[] } }) => call.input.items.map((i) => i.id);

describe('#1/#2 a rejected cue does not block the session', () => {
  it('content-policy 400 fails one cue; later cues keep being translated', async () => {
    const { clock, provider, scheduler, updates } = setup({
      config: { prefetch: false },
      options: { maxBatchItems: 1 },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(100), identity);
    const provider_ = provider as FakeProvider;
    await waitUntil(() => provider_.calls.length === 2);
    const rejected = errorFromHttpStatus(
      400,
      new Headers(),
      readFileSync(resolve(FIXTURES, 'error-400-invalid-prompt.json'), 'utf8'),
    );
    provider_.fail(provider_.calls[0]!, rejected);
    provider_.respond(provider_.calls[1]!);
    await settle(20);
    for (let t = 2_000; t <= 20_000; t += 2_000) {
      await clock.advance(2_000);
      scheduler.setPlayhead({ mediaTimeMs: t, playing: true, playbackRate: 1 });
      await settle(5);
      for (const call of provider_.open()) provider_.respond(call);
    }
    await settle(10);
    expect(scheduler.stats().blockedError).toBeUndefined();
    expect(updates.of('failed').map((u) => u.cueId)).toEqual([ids(provider_.calls[0]!)[0]]);
    expect(updates.of('failed')[0]!.error).toMatchObject({ code: 'content-rejected' });
    expect(provider_.calls.length).toBeGreaterThan(10);
  });
});

describe('#4 cues never stay in running after retry backoff / cooldown / abort', () => {
  it.each([
    [
      '429 Retry-After 30s',
      0,
      {
        code: 'rate-limited',
        category: 'rate-limit',
        retryable: true,
        message: '429',
        retryAfterMs: 30_000,
        httpStatus: 429,
      },
    ],
    [
      '5xx backoff',
      3_000,
      {
        code: 'server-error',
        category: 'server',
        retryable: true,
        message: '5xx',
        httpStatus: 502,
      },
    ],
  ] as const)(
    '%s: first batch goes back to pending and never ends as running',
    async (_label, start, info) => {
      const { clock, provider, scheduler, updates } = setup({ config: { prefetch: false } });
      const fake = provider as FakeProvider;
      scheduler.setPlayhead({ mediaTimeMs: start, playing: true, playbackRate: 1 });
      scheduler.setCues(makeTrack(200), identity);
      await waitUntil(() => fake.calls.length === 1);
      const firstIds = ids(fake.calls[0]!);
      fake.fail(fake.calls[0]!, info as Omit<AppErrorInfo, 'at'>);
      await settle(10);
      for (const id of firstIds) expect(lastState(updates, id)).toBe('pending');
      for (let t = start + 250; t <= start + 60_000; t += 250) {
        await clock.advance(250);
        scheduler.setPlayhead({ mediaTimeMs: t, playing: true, playbackRate: 1 });
        await settle(1);
        for (const call of fake.open()) fake.respond(call);
      }
      await settle(10);
      const inFlight = new Set(fake.open().flatMap(ids));
      const stuck = firstIds.filter(
        (id) => lastState(updates, id) === 'running' && !inFlight.has(id),
      );
      expect(stuck).toEqual([]);
      expect(scheduler.stats().running).toBe(inFlight.size);
    },
  );

  it('pause, far seek and same-revision provider swap emit pending for the aborted running cues', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(200), identity);
    await waitUntil(() => fake.calls.length === 1);
    scheduler.pause();
    for (const id of ids(fake.calls[0]!)) expect(lastState(updates, id)).toBe('pending');

    scheduler.resume();
    await waitUntil(() => fake.calls.length === 2);
    scheduler.setPlayhead({ mediaTimeMs: 300_000, playing: true, playbackRate: 1 });
    for (const id of ids(fake.calls[1]!)) expect(lastState(updates, id)).toBe('pending');

    await waitUntil(() => fake.calls.length === 3);
    const swapped = new FakeProvider(fake.profileKey);
    scheduler.setConfig({ ...baseConfig, prefetch: false }, identity.configRevision, swapped);
    expect(fake.calls[2]!.aborted).toBe(true);
    for (const id of ids(fake.calls[2]!)) expect(lastState(updates, id)).toBe('pending');
    await waitUntil(() => swapped.calls.length === 1);
  });
});

describe('#5 cache lookups are bounded', () => {
  it('a hanging cache.get times out as a miss and translation proceeds; hits are emitted without waiting for the group', async () => {
    const hanging: TranslationCache = {
      get: (key) =>
        key.endsWith('HIT')
          ? Promise.resolve('never')
          : new Promise<string | undefined>(() => undefined),
      set: async () => undefined,
      clear: async () => undefined,
    };
    const { clock, provider, scheduler, updates } = setup({
      cache: hanging,
      config: { prefetch: false },
    });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(4), identity);
    await settle(30);
    expect(fake.calls).toHaveLength(0);
    await clock.advance(799);
    expect(fake.calls).toHaveLength(0);
    await clock.advance(1);
    await waitUntil(() => fake.calls.length === 1);
    expect(ids(fake.calls[0]!)).toEqual(['c0', 'c1', 'c2', 'c3']);
    expect(scheduler.inspect().cacheReadTimeouts).toBe(4);
    expect(updates.of('done')).toHaveLength(0);
  });

  it('an immediate cache hit is flushed before slower lookups in the same group finish', async () => {
    const values = new Map<string, string>();
    let resolveSlow: (() => void) | undefined;
    const cache: TranslationCache = {
      get: (key) => {
        if (values.has(key)) return Promise.resolve(values.get(key));
        return new Promise((r) => {
          resolveSlow = () => r(undefined);
        });
      },
      set: async (k, v) => {
        values.set(k, v);
      },
      clear: async () => undefined,
    };
    // 先用同一缓存完成一次翻译，得到 c0 的缓存键
    const first = setup({ cache, config: { prefetch: false } });
    first.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    first.scheduler.setCues(makeTrack(1), identity);
    await settle(30);
    // c0 的查找挂起中；放行后发请求并写缓存
    resolveSlow?.();
    await waitUntil(() => (first.provider as FakeProvider).calls.length === 1);
    (first.provider as FakeProvider).respond((first.provider as FakeProvider).calls[0]!);
    await waitUntil(() => values.size === 1);
    first.scheduler.dispose();

    const second = setup({ cache, config: { prefetch: false } });
    second.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    second.scheduler.setCues(makeTrack(3), identity);
    await waitUntil(() => second.updates.doneFor('c0').length === 1);
    expect(second.updates.doneFor('c0')[0]!.fromCache).toBe(true);
    expect((second.provider as FakeProvider).calls).toHaveLength(0);
    expect(second.scheduler.inspect().pendingLookups).toBe(2);
  });
});

describe('#6 circuit breaker for systematic failures', () => {
  it('persistent format failures stop after a bounded number of calls and expose blockedError', async () => {
    const { provider, scheduler, updates } = setup({ config: { prefetch: false } });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(8, 'c', 1_000), identity);
    const formatError = {
      code: 'translation-invalid',
      category: 'format',
      retryable: true,
      message: 'bad json',
    } as const;
    for (let guard = 0; guard < 40; guard++) {
      await waitUntil(() => scheduler.inspect().pendingLookups === 0);
      await settle(5);
      const open = fake.open();
      if (open.length === 0) break;
      for (const call of open) fake.fail(call, formatError);
    }
    await settle(10);
    expect(fake.calls.length).toBeLessThanOrEqual(7);
    expect(updates.of('failed')).toHaveLength(8);
    expect(scheduler.stats().blockedError).toMatchObject({
      code: 'circuit-open',
      category: 'format',
      retryable: true,
    });
    // 单条重试不再让 provider 追加修复请求
    const singles = fake.calls.filter((c) => c.input.items.length === 1);
    expect(singles.length).toBeGreaterThan(0);
    expect(
      singles.every((c) => (c.options as SchedulerTranslateOptions).maxRepairAttempts === 0),
    ).toBe(true);

    expect(scheduler.retryFailed()).toBe(8);
    expect(scheduler.stats().blockedError).toBeUndefined();
    await waitUntil(() => fake.open().length > 0);
  });

  it('persistent 5xx across batches opens the breaker instead of retrying forever', async () => {
    const { clock, provider, scheduler } = setup();
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: false, playbackRate: 1 });
    scheduler.setCues(makeTrack(60), identity);
    for (let i = 0; i < 60; i++) {
      await settle(5);
      for (const call of fake.open())
        fake.fail(call, {
          code: 'server-error',
          category: 'server',
          retryable: true,
          message: '503',
          httpStatus: 503,
        });
      await clock.advance(5_000);
    }
    expect(scheduler.stats().blockedError).toMatchObject({
      code: 'circuit-open',
      category: 'server',
    });
    const calls = fake.calls.length;
    expect(calls).toBeLessThanOrEqual(6);
    await clock.advance(600_000);
    await settle(10);
    expect(fake.calls.length).toBe(calls);
  });

  it('a success resets the failure streak', async () => {
    const { provider, scheduler } = setup({
      config: { prefetch: false },
      options: { maxBatchItems: 1, maxRetries: 0 },
    });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(4, 'c', 2_000), identity);
    const serverError = {
      code: 'server-error',
      category: 'server',
      retryable: true,
      message: '5xx',
    } as const;
    await waitUntil(() => fake.open().length === 2);
    fake.fail(fake.calls[0]!, serverError);
    fake.fail(fake.calls[1]!, serverError);
    await waitUntil(() => fake.open().length === 2);
    fake.respond(fake.open()[0]!);
    await settle(10);
    expect(scheduler.inspect().consecutiveFailedCalls).toBe(0);
  });
});

describe('#13 cancellations not caused by the scheduler', () => {
  it('are retried with backoff and counted, not re-sent immediately forever', async () => {
    let calls = 0;
    const provider = {
      profileKey: 'p',
      promptVersion: 'v',
      translateBatch(
        _input: TranslateBatchInput,
        _o: TranslateOptions,
      ): Promise<TranslateBatchResult> {
        calls++;
        return new Promise((_, reject) => setImmediate(() => reject(cancelledError('transport'))));
      },
    };
    const { clock, scheduler, updates } = setup({ provider, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(1), identity);
    await settle(80);
    expect(calls).toBe(1);
    await clock.advance(750);
    await settle(20);
    expect(calls).toBe(2);
    await clock.advance(1_500);
    await settle(20);
    expect(calls).toBe(3);
    await clock.advance(60_000);
    await settle(20);
    expect(calls).toBe(3);
    expect(updates.of('failed')[0]!.error).toMatchObject({
      code: 'request-cancelled',
      category: 'network',
    });
  });
});

describe('#10 same revision but changed translation fingerprint', () => {
  it('resets like a new revision and emits pending for previously done cues', async () => {
    const p1 = new FakeProvider('https://a|responses|m|reasoning=omit');
    const { provider, scheduler, updates } = setup({ provider: p1, config: { prefetch: false } });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(30), identity);
    await waitUntil(() => fake.calls.length === 1);
    fake.respond(fake.calls[0]!);
    await waitUntil(() => updates.of('done').length === 4);
    updates.clear();
    const p2 = new FakeProvider('https://a|chat|m|reasoning=omit');
    scheduler.setConfig({ ...baseConfig, prefetch: false }, identity.configRevision, p2);
    expect(scheduler.stats().done).toBe(0);
    expect(updates.of('pending').map((u) => u.cueId)).toEqual(['c0', 'c1', 'c2', 'c3']);
    await waitUntil(() => p2.calls.length === 1);
  });
});

describe('#17 stats expose blocking and cache write failures', () => {
  it('fills blockedError and cacheWriteFailures', async () => {
    const failingSet: TranslationCache = {
      get: async () => undefined,
      set: () => Promise.reject(new Error('quota')),
      clear: async () => undefined,
    };
    const { provider, scheduler } = setup({ cache: failingSet, config: { prefetch: false } });
    const fake = provider as FakeProvider;
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(makeTrack(10), identity);
    expect(scheduler.stats().cacheWriteFailures).toBeUndefined();
    await waitUntil(() => fake.calls.length === 1);
    fake.respond(fake.calls[0]!);
    await waitUntil(() => scheduler.stats().cacheWriteFailures === 4);
    scheduler.setPlayhead({ mediaTimeMs: 8_000, playing: true, playbackRate: 1 });
    await waitUntil(() => fake.calls.length === 2);
    fake.fail(fake.calls[1]!, {
      code: 'auth-invalid',
      category: 'auth',
      retryable: false,
      message: 'Key 无效',
      httpStatus: 401,
    });
    await waitUntil(() => scheduler.stats().blockedError !== undefined);
    expect(scheduler.stats().blockedError).toMatchObject({ code: 'auth-invalid' });
    scheduler.resume();
    expect(scheduler.stats().blockedError).toBeUndefined();
  });
});

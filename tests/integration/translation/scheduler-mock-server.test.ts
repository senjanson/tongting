/**
 * 调度器 + 真实 provider + 真实 fetch + 模拟 sub2api + IndexedDB 缓存：
 * 断言服务端观察到的真实副作用（请求数、并发、连接中止、Authorization 去向）。
 * 覆盖 T07、T08、T09、T11、T12、T13、T27、T28、T38 与暂停。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Cue } from '@src/domain/cue';
import { DB_NAME, resetDbForTests } from '@src/storage/db';
import { createTextProvider } from '@src/providers/text/factory';
import type { TextProviderConfig } from '@src/providers/text/types';
import {
  buildTranslationCacheKey,
  createIdbTranslationCache,
  createMemoryTranslationCache,
} from '@src/storage/translation-cache';
import {
  createTranslationSchedulerWithOptions,
  type InspectableTranslationScheduler,
  type SchedulerOptions,
} from '@src/translation/scheduler';
import type {
  CueTranslationUpdate,
  SchedulerIdentity,
  TranslationCache,
  TranslationConfig,
} from '@src/translation/types';
import {
  startMockSub2api,
  type MockSub2api,
  type RecordedRequest,
} from '../../helpers/mock-sub2api/server';

const servers: MockSub2api[] = [];
const schedulers: InspectableTranslationScheduler[] = [];
async function server(options: Parameters<typeof startMockSub2api>[0] = {}) {
  const s = await startMockSub2api(options);
  servers.push(s);
  return s;
}

beforeEach(async () => {
  await resetDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});
afterEach(async () => {
  for (const s of schedulers.splice(0)) s.dispose();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const translationConfig: TranslationConfig = {
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  style: 'natural',
  glossary: [],
  prefetch: true,
  useCache: true,
  timeoutMs: 5_000,
};

const fastOptions: Partial<SchedulerOptions> = {
  baseRetryDelayMs: 40,
  maxRetryDelayMs: 400,
  prefetchResumeDelayMs: 150,
};

function providerConfig(
  s: MockSub2api,
  overrides: Partial<TextProviderConfig> = {},
): TextProviderConfig {
  return {
    baseUrl: s.baseUrl,
    apiKey: 'test-fake-key-not-a-secret',
    protocol: 'responses',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'omit',
    streaming: false,
    ...overrides,
  };
}

function track(count: number, stepMs = 2_000, prefix = 'c'): Cue[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    revision: 0,
    startMs: i * stepMs,
    endMs: (i + 1) * stepMs,
    sourceText: `Line ${i}: we did not buy ${i} apples.`,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track' as const,
    stability: 'final' as const,
    translationState: 'pending' as const,
  }));
}

function makeScheduler(params: {
  s: MockSub2api;
  identity: SchedulerIdentity;
  cache?: TranslationCache;
  config?: Partial<TranslationConfig>;
  provider?: Partial<TextProviderConfig>;
  options?: Partial<SchedulerOptions>;
}) {
  const updates: CueTranslationUpdate[] = [];
  const scheduler = createTranslationSchedulerWithOptions(
    {
      provider: createTextProvider(providerConfig(params.s, params.provider)),
      cache: params.cache ?? createMemoryTranslationCache(),
    },
    { ...translationConfig, ...params.config },
    params.identity,
    { ...fastOptions, ...params.options },
  );
  schedulers.push(scheduler);
  scheduler.onUpdate((u) => updates.push(...u));
  const done = () => updates.filter((u) => u.state === 'done');
  return { scheduler, updates, done };
}

async function until(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('until timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** 每个请求开始时刻仍在进行中的请求数（含自身）的最大值；毫秒级时间戳，首尾相接不算重叠。 */
function maxOverlap(requests: RecordedRequest[]): number {
  let max = 0;
  for (const x of requests) {
    const active = requests.filter(
      (r) =>
        r === x ||
        (r.receivedAt <= x.receivedAt && (r.finishedAt ?? Number.MAX_SAFE_INTEGER) > x.receivedAt),
    ).length;
    max = Math.max(max, active);
  }
  return max;
}

const idA: SchedulerIdentity = {
  sessionId: 'session-A-0001',
  epoch: 1,
  configRevision: 1,
  sourceKey: 'videoAAAAAA|en',
};

describe('scheduler over HTTP', () => {
  it('translates the window with ≤ 2 concurrent requests and bounded total requests', async () => {
    const s = await server();
    s.enqueue(
      'responses',
      ...Array.from({ length: 10 }, () => ({ kind: 'translate' as const, delayMs: 30 })),
    );
    const { scheduler, done } = makeScheduler({ s, identity: idA });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    scheduler.setCues(track(200), idA);
    await until(() => done().length === 24);
    await new Promise((r) => setTimeout(r, 100));
    expect(s.maxInflight()).toBeLessThanOrEqual(2);
    expect(s.requestsTo('responses').length).toBeLessThanOrEqual(5);
    expect(
      done().every(
        (u) =>
          u.translatedText ===
          `译：Line ${u.cueId.slice(1)}: we did not buy ${u.cueId.slice(1)} apples.`,
      ),
    ).toBe(true);
    expect(scheduler.stats()).toMatchObject({ done: 24, running: 0, failed: 0 });
    expect(scheduler.stats().lastLatencyMs).toBeGreaterThan(0);
  });

  it('T07: 429 with Retry-After → shared cooldown, no request during cooldown, serial retries, no storm', async () => {
    const s = await server();
    const tooMany = {
      kind: 'status' as const,
      status: 429,
      headers: { 'retry-after-ms': '300' },
      body: { error: { message: 'Rate limit reached for requests', type: 'rate_limit_error' } },
    };
    s.enqueue('responses', { ...tooMany, delayMs: 20 }, { ...tooMany, delayMs: 20 });
    const { scheduler, done } = makeScheduler({ s, identity: idA });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: false, playbackRate: 1 });
    scheduler.setCues(track(200), idA);

    await s.waitForRequests('responses', 2);
    await until(() => s.requestsTo('responses').filter((r) => r.completed).length === 2);
    const limited = s.requestsTo('responses').slice(0, 2);
    const cooldownStart = Math.min(...limited.map((r) => r.finishedAt!));
    await until(() => done().length === 24, 8_000);

    const after = s.requestsTo('responses').slice(2);
    expect(after.length).toBeGreaterThan(0);
    // 冷却期内没有任何请求
    expect(Math.min(...after.map((r) => r.receivedAt))).toBeGreaterThanOrEqual(cooldownStart + 280);
    // 限流后的前几次请求串行（并发 1）
    expect(maxOverlap(after.slice(0, 3))).toBe(1);
    // 没有重试风暴：24 条字幕总请求数有界
    expect(s.requestsTo('responses').length).toBeLessThanOrEqual(8);
    expect(updatesFailed(scheduler)).toBe(0);
  });

  it('T08: a truncated SSE response is retried; only the final validated text is emitted and cached', async () => {
    const s = await server();
    const cut = {
      kind: 'sse' as const,
      chunks: [
        'data: {"choices":[{"index":0,"delta":{"content":"{\\"translations\\":[{\\"id\\":\\"c0\\",\\"text\\":\\"半截"}}]}\n\n',
      ],
      chunkDelayMs: 10,
      end: 'destroy' as const,
    };
    s.enqueue('chat', cut);
    const cache = createIdbTranslationCache();
    const { scheduler, updates, done } = makeScheduler({
      s,
      identity: idA,
      cache,
      config: { prefetch: false },
      provider: { protocol: 'chat', streaming: true },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(1), idA);
    await until(() => done().length === 1);
    expect(done()[0]!.translatedText).toBe('译：Line 0: we did not buy 0 apples.');
    expect(updates.filter((u) => u.partial && u.translatedText === '半截')).toHaveLength(0);
    expect(s.requestsTo('chat')).toHaveLength(2);
    expect(s.requestsTo('chat')[0]!.completed).toBe(false);
    const key = await buildTranslationCacheKey({
      sourceKey: idA.sourceKey,
      sourceText: track(1)[0]!.sourceText,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      profileKey: `${s.baseUrl}|chat|gpt-5.6-terra|reasoning=omit`,
      promptVersion: createTextProvider(providerConfig(s)).promptVersion,
      style: 'natural',
      glossary: [],
    });
    // 缓存写入是异步的：轮询直到命中或超时，不依赖固定等待时间。
    let cached: string | undefined;
    for (let i = 0; i < 400 && cached === undefined; i++) {
      cached = await cache.get(key);
      if (cached === undefined) await new Promise((r) => setTimeout(r, 5));
    }
    expect(cached).toBe('译：Line 0: we did not buy 0 apples.');
    expect(await cache.size()).toBe(1);
    expect(scheduler.inspect().cacheWriteFailures).toBe(0);
  });

  it('T08: when every attempt is cut, the cue fails after bounded retries and nothing is cached', async () => {
    const s = await server();
    const cut = {
      kind: 'sse' as const,
      chunks: ['data: {"choices":[{"index":0,"delta":{"content":"{\\"tr"}}]}\n\n', 'data: {"choi'],
      chunkDelayMs: 10,
      end: 'destroy' as const,
    };
    s.enqueue('chat', cut, cut, cut, cut);
    const cache = createIdbTranslationCache();
    const { scheduler, updates } = makeScheduler({
      s,
      identity: idA,
      cache,
      config: { prefetch: false },
      provider: { protocol: 'chat', streaming: true },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(1), idA);
    await until(() => updates.some((u) => u.state === 'failed'));
    expect(s.requestsTo('chat')).toHaveLength(3);
    expect(updates.find((u) => u.state === 'failed')!.error).toMatchObject({
      code: 'stream-interrupted',
      retryable: true,
    });
    expect(await cache.size()).toBe(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.requestsTo('chat')).toHaveLength(3);
  });

  it('#6: a model that always returns non-JSON trips the circuit breaker after a bounded number of HTTP requests', async () => {
    const s = await server();
    s.enqueue(
      'responses',
      ...Array.from({ length: 100 }, () => ({
        kind: 'translate' as const,
        transform: () => 'Sorry, here is the translation: 我们没有买苹果。',
      })),
    );
    const { scheduler, updates } = makeScheduler({ s, identity: idA, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: false, playbackRate: 1 });
    scheduler.setCues(track(8, 1_000), idA);
    await until(() => updates.filter((u) => u.state === 'failed').length === 8, 8_000);
    await new Promise((r) => setTimeout(r, 150));
    // 批量 1 次（含 1 次修复 = 2 个 HTTP）+ 单条最多 5 次（不再修复）
    expect(s.requestsTo('responses').length).toBeLessThanOrEqual(8);
    expect(scheduler.stats().blockedError).toMatchObject({ code: 'circuit-open' });
    const requests = s.requestsTo('responses').length;
    scheduler.setPlayhead({ mediaTimeMs: 4_000, playing: true, playbackRate: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.requestsTo('responses').length).toBe(requests);
  });

  it('T09: a shifted batch never mismatches neighbours; cues are recovered with single requests', async () => {
    const s = await server();
    const shifted = (items: { id: string; text: string }[]) =>
      items.slice(1).map((it, i) => ({ id: items[i]!.id, text: `译：${it.text}` }));
    s.enqueue(
      'responses',
      { kind: 'translate', transform: shifted },
      { kind: 'translate', transform: shifted },
    );
    const { scheduler, done } = makeScheduler({ s, identity: idA, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(4), idA);
    await until(() => done().length === 4);
    for (const u of done()) {
      expect(u.translatedText).toBe(
        `译：Line ${u.cueId.slice(1)}: we did not buy ${u.cueId.slice(1)} apples.`,
      );
    }
    const itemCounts = s.requestsTo('responses').map(
      (r) =>
        (
          JSON.parse(String((r.body as { input: string }).input.split('\n').at(-1))) as {
            items: unknown[];
          }
        ).items.length,
    );
    expect(itemCounts).toEqual([4, 4, 1, 1, 1, 1]);
  });

  it('T11: seeking far aborts the unrelated HTTP request on the server, and its late result never appears', async () => {
    const s = await server();
    s.enqueue('responses', { kind: 'translate', delayMs: 2_000 });
    const { scheduler, done } = makeScheduler({ s, identity: idA, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 40_000, playing: true, playbackRate: 1 });
    scheduler.setCues(track(300), idA);
    await s.waitFor(() => s.inflight() === 1);

    scheduler.setPlayhead({ mediaTimeMs: 400_000, playing: true, playbackRate: 1 });
    scheduler.setEpoch(2);
    await s.waitFor(() => s.requests[0]!.aborted);
    await until(() => done().length === 5);
    expect(
      done()
        .map((u) => u.cueId)
        .sort(),
    ).toEqual(['c199', 'c200', 'c201', 'c202', 'c203']);
    expect(done().some((u) => ['c19', 'c20', 'c21'].includes(u.cueId))).toBe(false);
  });

  it('T12: A→B→A aborts old requests; the new A session only receives results of its own requests', async () => {
    const s = await server();
    s.enqueue(
      'responses',
      { kind: 'translate', delayMs: 1_500 },
      { kind: 'translate', delayMs: 1_500 },
    );
    const { scheduler, done } = makeScheduler({ s, identity: idA, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(2), idA);
    await s.waitForRequests('responses', 1);

    const idB = {
      sessionId: 'session-B-0001',
      epoch: 1,
      configRevision: 1,
      sourceKey: 'videoBBBBBB|en',
    };
    scheduler.setCues(track(2, 2_000, 'b'), idB);
    await s.waitForRequests('responses', 2);
    await s.waitFor(() => s.requests[0]!.aborted);

    const idA2 = { ...idA, sessionId: 'session-A-0002' };
    scheduler.setCues(track(2), idA2);
    await s.waitFor(() => s.requests[1]!.aborted);
    await until(() => done().length === 2);
    expect(done().map((u) => u.cueId)).toEqual(['c0', 'c1']);
    expect(s.requestsTo('responses')).toHaveLength(3);
    expect(s.requestsTo('responses')[2]!.completed).toBe(true);
  });

  it('T13/T28: changing Key/Base URL mid-request aborts the old request and the new Key never reaches the old origin', async () => {
    const oldServer = await server({ apiKey: 'fake-key-old' });
    const newServer = await server({ apiKey: 'fake-key-new' });
    oldServer.enqueue('responses', { kind: 'translate', delayMs: 3_000 });
    const { scheduler, done } = makeScheduler({
      s: oldServer,
      identity: idA,
      config: { prefetch: false },
      provider: { apiKey: 'fake-key-old' },
    });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(2), idA);
    await oldServer.waitFor(() => oldServer.inflight() === 1);

    const newProvider = createTextProvider(
      providerConfig(newServer, { apiKey: 'fake-key-new', protocol: 'chat' }),
    );
    scheduler.setConfig(
      { ...translationConfig, prefetch: false, targetLanguage: 'zh-TW' },
      2,
      newProvider,
    );
    await oldServer.waitFor(() => oldServer.requests[0]!.aborted);
    await until(() => done().length === 2);

    expect(oldServer.requests.every((r) => r.authorization === 'Bearer fake-key-old')).toBe(true);
    expect(newServer.requests.every((r) => r.authorization === 'Bearer fake-key-new')).toBe(true);
    expect(oldServer.requests).toHaveLength(1);
    expect(newServer.requestsTo('chat')).toHaveLength(1);
    const body = newServer.requestsTo('chat')[0]!.body as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toContain('Traditional Chinese');
    await new Promise((r) => setTimeout(r, 100));
    expect(done()).toHaveLength(2);
  });

  it('pause aborts the in-flight HTTP request and sends nothing until resume', async () => {
    const s = await server();
    s.enqueue('responses', { kind: 'translate', delayMs: 3_000 });
    const { scheduler, done } = makeScheduler({ s, identity: idA, config: { prefetch: false } });
    scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    scheduler.setCues(track(3), idA);
    await s.waitFor(() => s.inflight() === 1);
    scheduler.pause();
    await s.waitFor(() => s.requests[0]!.aborted && s.inflight() === 0);
    scheduler.setPlayhead({ mediaTimeMs: 1_000, playing: true, playbackRate: 1 });
    await new Promise((r) => setTimeout(r, 150));
    expect(s.requests).toHaveLength(1);
    scheduler.resume();
    await until(() => done().length === 3);
    expect(s.requests).toHaveLength(2);
  });

  it('T38 + T27: replay hits the IndexedDB cache with zero requests; glossary change misses; cache failure does not fail translation', async () => {
    const s = await server();
    const cache = createIdbTranslationCache();
    const first = makeScheduler({ s, identity: idA, cache, config: { prefetch: false } });
    first.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    first.scheduler.setCues(track(4), idA);
    await until(() => first.done().length === 4);
    for (let i = 0; i < 400 && (await cache.size()) !== 4; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(await cache.size()).toBe(4);
    first.scheduler.dispose();
    const requestsAfterFirst = s.requests.length;

    const idReplay = { ...idA, sessionId: 'session-A-replay' };
    const replay = makeScheduler({ s, identity: idReplay, cache, config: { prefetch: false } });
    replay.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    replay.scheduler.setCues(track(4), idReplay);
    await until(() => replay.done().length === 4);
    expect(replay.done().every((u) => u.fromCache)).toBe(true);
    expect(s.requests.length).toBe(requestsAfterFirst);
    replay.scheduler.dispose();

    const idGlossary = { ...idA, sessionId: 'session-A-glossary' };
    const changed = makeScheduler({
      s,
      identity: idGlossary,
      cache,
      config: { prefetch: false, glossary: [{ source: 'apples', target: '苹果' }] },
    });
    changed.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    changed.scheduler.setCues(track(4), idGlossary);
    await until(() => changed.done().length === 4);
    expect(changed.done().some((u) => u.fromCache)).toBe(false);
    expect(s.requests.length).toBe(requestsAfterFirst + 1);
    const glossaryBody = (s.requests.at(-1)!.body as { input: string }).input;
    expect(glossaryBody).toContain('"glossary":[{"source":"apples","target":"苹果"}]');
    changed.scheduler.dispose();

    const broken: TranslationCache = {
      get: () => Promise.reject(new Error('IDB unavailable')),
      set: () => Promise.reject(new Error('QuotaExceededError')),
      clear: () => Promise.resolve(),
    };
    const idBroken = { ...idA, sessionId: 'session-A-broken', sourceKey: 'videoCCCCCC|en' };
    const resilient = makeScheduler({
      s,
      identity: idBroken,
      cache: broken,
      config: { prefetch: false },
    });
    resilient.scheduler.setPlayhead({ mediaTimeMs: 0, playing: true, playbackRate: 1 });
    resilient.scheduler.setCues(track(4), idBroken);
    await until(
      () => resilient.done().length === 4 && resilient.scheduler.inspect().cacheWriteFailures === 4,
    );
  });
});

function updatesFailed(scheduler: InspectableTranslationScheduler): number {
  return scheduler.stats().failed;
}

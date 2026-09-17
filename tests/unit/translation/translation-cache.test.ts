import { beforeEach, describe, expect, it } from 'vitest';
import { DB_NAME, openTongtingDb, resetDbForTests } from '@src/storage/db';
import {
  buildTranslationCacheKey,
  createIdbTranslationCache,
  createMemoryTranslationCache,
  type TranslationCacheKeyParts,
} from '@src/storage/translation-cache';
import {
  backoffDelay,
  isAutoRetryable,
  isBlockingError,
  retryDelay,
  shortFingerprint,
} from '@src/translation/retry';

const parts: TranslationCacheKeyParts = {
  sourceKey: 'dQw4w9WgXcQ|en-manual',
  sourceText: 'Never gonna give you up.',
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  profileKey: 'https://api.example.com|responses|gpt-5.6-terra|reasoning=omit',
  promptVersion: 'tt-subtitle-2026-09-16.1',
  style: 'natural',
  glossary: [{ source: 'Rick', target: '里克' }],
};

async function deleteDb(): Promise<void> {
  await resetDbForTests();
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('buildTranslationCacheKey (T38)', () => {
  it('is a deterministic SHA-256 key that normalizes whitespace/NFC of the text', async () => {
    const key = await buildTranslationCacheKey(parts);
    expect(key).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(
      await buildTranslationCacheKey({ ...parts, sourceText: '  Never gonna give you up.  ' }),
    ).toBe(key);
    expect(await buildTranslationCacheKey({ ...parts, sourceText: 'Café', glossary: [] })).toBe(
      await buildTranslationCacheKey({ ...parts, sourceText: 'Café', glossary: [] }),
    );
  });

  it.each([
    ['sourceKey', { sourceKey: 'dQw4w9WgXcQ|asr-1' }],
    ['sourceText', { sourceText: 'Never gonna let you down.' }],
    ['sourceLanguage', { sourceLanguage: 'ja' }],
    ['targetLanguage', { targetLanguage: 'zh-TW' }],
    [
      'profileKey (model)',
      { profileKey: 'https://api.example.com|responses|gpt-5.6-luna|reasoning=omit' },
    ],
    ['promptVersion', { promptVersion: 'tt-subtitle-2026-09-17.1' }],
    ['style', { style: 'faithful' as const }],
    ['glossary', { glossary: [{ source: 'Rick', target: '瑞克' }] }],
  ])('changes when %s changes', async (_name, change) => {
    expect(await buildTranslationCacheKey({ ...parts, ...change })).not.toBe(
      await buildTranslationCacheKey(parts),
    );
  });
});

describe('IndexedDB translation cache', () => {
  beforeEach(async () => {
    await deleteDb();
  });

  it('stores, reads and clears non-empty translations', async () => {
    const cache = createIdbTranslationCache();
    await cache.set('k1', '永远不会放弃你。');
    expect(await cache.get('k1')).toBe('永远不会放弃你。');
    expect(await cache.get('missing')).toBeUndefined();
    await cache.clear();
    expect(await cache.get('k1')).toBeUndefined();
  });

  it('refuses to store empty or oversized values', async () => {
    const cache = createIdbTranslationCache();
    await expect(cache.set('k', '   ')).rejects.toMatchObject({
      info: { category: 'storage', code: 'cache-empty-value' },
    });
    await expect(cache.set('k', 'x'.repeat(8_001))).rejects.toMatchObject({
      info: { code: 'cache-value-too-large' },
    });
    expect(await cache.size()).toBe(0);
  });

  it('expires entries by age on read', async () => {
    let t = 1_000;
    const cache = createIdbTranslationCache({ maxAgeMs: 10_000, now: () => t });
    await cache.set('old', '旧译文');
    t += 10_001;
    expect(await cache.get('old')).toBeUndefined();
    // 过期删除在只读读取之后批量执行
    expect(await cache.size()).toBe(1);
    await cache.flushMaintenance();
    expect(await cache.size()).toBe(0);
  });

  it('reads with a readonly transaction and batches LRU touches into a later write (review #5)', async () => {
    let t = 1_000;
    const cache = createIdbTranslationCache({
      touchIntervalMs: 0,
      maintenanceDelayMs: 60_000,
      now: () => t,
    });
    await cache.set('k', '译文');
    const db = await openTongtingDb();
    t = 5_000;
    expect(await cache.get('k')).toBe('译文');
    expect(await cache.get('k')).toBe('译文');
    expect((await db.get('translationCache', 'k'))!.lastUsedAt).toBe(1_000);
    await cache.flushMaintenance();
    expect((await db.get('translationCache', 'k'))!.lastUsedAt).toBe(5_000);
  });

  it('does not delete an entry that was rewritten after it was found expired', async () => {
    let t = 1_000;
    const cache = createIdbTranslationCache({
      maxAgeMs: 10_000,
      maintenanceDelayMs: 60_000,
      now: () => t,
    });
    await cache.set('k', '旧');
    t += 10_001;
    expect(await cache.get('k')).toBeUndefined();
    await cache.set('k', '新');
    await cache.flushMaintenance();
    expect(await cache.get('k')).toBe('新');
  });

  it('evicts least-recently-used entries beyond the capacity limit', async () => {
    let t = 0;
    const cache = createIdbTranslationCache({
      maxEntries: 10,
      pruneEvery: 1,
      touchIntervalMs: 0,
      now: () => t,
    });
    for (let i = 0; i < 10; i++) {
      t += 10;
      await cache.set(`k${i}`, `译文${i}`);
    }
    // 读取 k0，使其成为最近使用
    t += 10;
    expect(await cache.get('k0')).toBe('译文0');
    t += 10;
    await cache.set('k10', '译文10');
    const size = await cache.size();
    expect(size).toBeLessThanOrEqual(10);
    expect(size).toBeGreaterThanOrEqual(9);
    expect(await cache.get('k0')).toBe('译文0');
    expect(await cache.get('k1')).toBeUndefined();
    expect(await cache.get('k10')).toBe('译文10');
  });

  it('reports storage errors as storage AppErrors (caller decides not to fail translation)', async () => {
    const cache = createIdbTranslationCache({
      openDb: () => Promise.reject(new Error('QuotaExceededError')),
    });
    await expect(cache.set('k', 'v')).rejects.toMatchObject({
      info: { category: 'storage', code: 'cache-write-failed' },
    });
    await expect(cache.get('k')).rejects.toMatchObject({
      info: { category: 'storage', code: 'cache-read-failed' },
    });
    // 真实数据库仍可打开
    await expect(openTongtingDb()).resolves.toBeTruthy();
  });
});

describe('memory translation cache', () => {
  it('is an LRU with a size bound and rejects empty values', async () => {
    const cache = createMemoryTranslationCache({ maxEntries: 2 });
    await cache.set('a', '甲');
    await cache.set('b', '乙');
    await cache.get('a');
    await cache.set('c', '丙');
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toBe('甲');
    expect(cache.size()).toBe(2);
    await expect(cache.set('d', '')).rejects.toMatchObject({ info: { code: 'cache-empty-value' } });
  });
});

describe('retry policy helpers', () => {
  it('uses exponential backoff with equal jitter and honours Retry-After first', () => {
    const policy = { baseDelayMs: 1_000, maxDelayMs: 8_000 };
    expect(backoffDelay(1, policy, () => 0)).toBe(500);
    expect(backoffDelay(1, policy, () => 1)).toBe(1_000);
    expect(backoffDelay(3, policy, () => 0.5)).toBe(3_000);
    expect(backoffDelay(10, policy, () => 1)).toBe(8_000);
    const info = {
      code: 'x',
      category: 'rate-limit' as const,
      retryable: true,
      message: 'm',
      retryAfterMs: 4_000,
    };
    expect(retryDelay(info, 1, policy, () => 0)).toBe(4_000);
    expect(retryDelay(info, 1, policy, () => 1)).toBe(4_500);
  });

  it('classifies retryable and blocking errors', () => {
    const e = (category: string, retryable: boolean) =>
      ({ code: 'x', category, retryable, message: 'm' }) as never;
    expect(isAutoRetryable(e('server', true))).toBe(true);
    expect(isAutoRetryable(e('rate-limit', true))).toBe(true);
    expect(isAutoRetryable(e('format', true))).toBe(false);
    expect(isAutoRetryable(e('auth', false))).toBe(false);
    expect(isBlockingError(e('auth', false))).toBe(true);
    expect(isBlockingError(e('permission', false))).toBe(true);
    expect(isBlockingError(e('quota', false))).toBe(true);
    expect(isBlockingError(e('format', true))).toBe(false);
    expect(isBlockingError(e('network', true))).toBe(false);
    expect(shortFingerprint('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(shortFingerprint('abc')).not.toBe(shortFingerprint('abd'));
  });
});

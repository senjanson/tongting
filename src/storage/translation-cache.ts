/**
 * 翻译缓存。
 *
 * - IndexedDB `translationCache` store（经 openTongtingDb），LRU（byLastUsedAt 索引）+ 时间上限。
 * - 缓存键为 SHA-256，至少包含：来源版本 sourceKey、原文、源/目标语言、provider profileKey
 *   （origin + 协议 + 模型 + 参数）、promptVersion、风格、术语表。任何一项变化都不会命中旧结果（T38）。
 * - 只接受非空译文；失败或空结果不得写入。读写失败以 storage 类 AppError 抛出，由调度器记录且不影响翻译。
 */
import { AppError } from '../domain/errors';
import type { GlossaryEntry, TranslationStyle } from '../domain/settings';
import type { TranslationCache } from '../translation/types';
import { openTongtingDb, type TongtingDb } from './db';

export const TRANSLATION_CACHE_KEY_VERSION = 1;
export const DEFAULT_CACHE_MAX_ENTRIES = 5_000;
export const DEFAULT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** 单条译文上限（与 Cue.translatedText 上限一致）。 */
export const MAX_CACHE_VALUE_LENGTH = 8_000;

export interface TranslationCacheKeyParts {
  /** 视频 ID + 字幕轨道 key，或 ASR 来源版本。 */
  sourceKey: string;
  sourceText: string;
  /** 实际使用的源语言（配置为 auto 时为 'auto' 或字幕轨道语言）。 */
  sourceLanguage: string;
  targetLanguage: string;
  profileKey: string;
  promptVersion: string;
  style: TranslationStyle;
  glossary: readonly GlossaryEntry[];
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function buildTranslationCacheKey(parts: TranslationCacheKeyParts): Promise<string> {
  const payload = JSON.stringify([
    'tongting-translation',
    TRANSLATION_CACHE_KEY_VERSION,
    parts.sourceKey,
    parts.sourceText.normalize('NFC').trim(),
    parts.sourceLanguage.toLowerCase(),
    parts.targetLanguage.toLowerCase(),
    parts.profileKey,
    parts.promptVersion,
    parts.style,
    parts.glossary.map((g) => [g.source, g.target]),
  ]);
  return `v${TRANSLATION_CACHE_KEY_VERSION}:${await sha256Hex(payload)}`;
}

function storageError(code: string, message: string, cause?: unknown): AppError {
  return new AppError({ code, category: 'storage', retryable: true, message }, { cause });
}

function assertCacheValue(value: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw storageError('cache-empty-value', '空译文不能写入缓存。');
  }
  if (value.length > MAX_CACHE_VALUE_LENGTH) {
    throw storageError('cache-value-too-large', '译文过长，未写入缓存。');
  }
  return value;
}

export interface IdbTranslationCacheOptions {
  maxEntries?: number;
  maxAgeMs?: number;
  now?: () => number;
  /** 每写入多少条检查一次容量（首次写入也会检查）。 */
  pruneEvery?: number;
  /** lastUsedAt 更新的最小间隔，减少读路径写入。 */
  touchIntervalMs?: number;
  /** 读路径产生的 LRU 更新与过期删除延后多久批量写入。 */
  maintenanceDelayMs?: number;
  openDb?: () => Promise<TongtingDb>;
}

export interface ManagedTranslationCache extends TranslationCache {
  /** 删除过期与超出容量的条目，返回删除数量（会先写入待定的 LRU 更新）。 */
  prune(): Promise<number>;
  /** 立即写入延后的 LRU 更新与过期删除。 */
  flushMaintenance(): Promise<void>;
  size(): Promise<number>;
}

export function createIdbTranslationCache(
  options: IdbTranslationCacheOptions = {},
): ManagedTranslationCache {
  const maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES);
  const maxAgeMs = Math.max(1, options.maxAgeMs ?? DEFAULT_CACHE_MAX_AGE_MS);
  const now = options.now ?? (() => Date.now());
  const pruneEvery = Math.max(1, options.pruneEvery ?? 25);
  const touchIntervalMs = options.touchIntervalMs ?? 60_000;
  const maintenanceDelayMs = Math.max(0, options.maintenanceDelayMs ?? 2_000);
  const openDb = options.openDb ?? openTongtingDb;
  let writes = 0;

  // 读路径只用只读事务；LRU 更新与过期删除收集后批量写入，避免每次读取都占用读写事务。
  let pendingTouches = new Map<string, number>();
  let pendingDeletes = new Set<string>();
  let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleMaintenance(): void {
    if (maintenanceTimer !== undefined) return;
    maintenanceTimer = setTimeout(() => {
      maintenanceTimer = undefined;
      void flushMaintenance().catch(() => undefined);
    }, maintenanceDelayMs);
  }

  async function flushMaintenance(): Promise<void> {
    if (maintenanceTimer !== undefined) {
      clearTimeout(maintenanceTimer);
      maintenanceTimer = undefined;
    }
    if (pendingTouches.size === 0 && pendingDeletes.size === 0) return;
    const touches = pendingTouches;
    const deletes = pendingDeletes;
    pendingTouches = new Map();
    pendingDeletes = new Set();
    const db = await openDb();
    const tx = db.transaction('translationCache', 'readwrite');
    for (const key of deletes) {
      const record = await tx.store.get(key);
      // 删除决定之后若被重新写入（createdAt 更新），不要误删新值。
      if (record && now() - record.createdAt > maxAgeMs) await tx.store.delete(key);
    }
    for (const [key, usedAt] of touches) {
      const record = await tx.store.get(key);
      if (record && record.lastUsedAt < usedAt) {
        await tx.store.put({ ...record, lastUsedAt: usedAt });
      }
    }
    await tx.done;
  }

  async function prune(): Promise<number> {
    await flushMaintenance().catch(() => undefined);
    const db = await openDb();
    const tx = db.transaction('translationCache', 'readwrite');
    let count = await tx.store.count();
    const target = Math.floor(maxEntries * 0.9);
    const expiredBefore = now() - maxAgeMs;
    let removed = 0;
    const overCapacity = count > maxEntries;
    // 游标按 lastUsedAt 升序（最久未使用在前）。lastUsedAt 未过期但 createdAt 已过期的条目在读取时惰性删除。
    let cursor = await tx.store.index('byLastUsedAt').openCursor();
    while (cursor) {
      const record = cursor.value;
      const expired = record.lastUsedAt < expiredBefore || record.createdAt < expiredBefore;
      if (expired || (overCapacity && count > target)) {
        await cursor.delete();
        count--;
        removed++;
      } else {
        break;
      }
      cursor = await cursor.continue();
    }
    await tx.done;
    return removed;
  }

  return {
    async get(key: string): Promise<string | undefined> {
      let record;
      try {
        const db = await openDb();
        record = await db.get('translationCache', key);
      } catch (error) {
        throw storageError('cache-read-failed', '读取翻译缓存失败，将直接请求翻译。', error);
      }
      if (!record) return undefined;
      const t = now();
      if (t - record.createdAt > maxAgeMs || !record.value.trim()) {
        pendingTouches.delete(key);
        pendingDeletes.add(key);
        scheduleMaintenance();
        return undefined;
      }
      if (t - record.lastUsedAt >= touchIntervalMs) {
        pendingTouches.set(key, t);
        scheduleMaintenance();
      }
      return record.value;
    },

    async set(key: string, value: string): Promise<void> {
      const text = assertCacheValue(value);
      try {
        const db = await openDb();
        const t = now();
        pendingDeletes.delete(key);
        await db.put('translationCache', {
          key,
          value: text,
          createdAt: t,
          lastUsedAt: t,
          size: text.length,
        });
      } catch (error) {
        throw storageError('cache-write-failed', '写入翻译缓存失败，本次译文仍然可用。', error);
      }
      writes++;
      if (writes === 1 || writes % pruneEvery === 0) {
        await prune().catch(() => 0);
      }
    },

    async clear(): Promise<void> {
      pendingTouches = new Map();
      pendingDeletes = new Set();
      if (maintenanceTimer !== undefined) {
        clearTimeout(maintenanceTimer);
        maintenanceTimer = undefined;
      }
      try {
        const db = await openDb();
        await db.clear('translationCache');
      } catch (error) {
        throw storageError('cache-clear-failed', '清空翻译缓存失败，请重试。', error);
      }
    },

    prune,
    flushMaintenance,

    async size(): Promise<number> {
      const db = await openDb();
      return db.count('translationCache');
    },
  };
}

/** 内存 LRU 缓存（测试、演示隔离或 IndexedDB 不可用时使用）。 */
export function createMemoryTranslationCache(
  options: { maxEntries?: number } = {},
): TranslationCache & { size(): number } {
  const maxEntries = Math.max(1, options.maxEntries ?? 2_000);
  const map = new Map<string, string>();
  return {
    async get(key) {
      const value = map.get(key);
      if (value === undefined) return undefined;
      map.delete(key);
      map.set(key, value);
      return value;
    },
    async set(key, value) {
      const text = assertCacheValue(value);
      map.delete(key);
      map.set(key, text);
      while (map.size > maxEntries) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    async clear() {
      map.clear();
    },
    size: () => map.size,
  };
}

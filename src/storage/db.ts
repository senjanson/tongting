/**
 * IndexedDB 结构（扩展 origin，worker 与扩展页面共享）。
 *
 * - transcripts：按「视频 + 目标语言 + 来源」保存的字幕记录（可重建）。
 * - favorites / notes：用户数据，与可重建缓存分开；迁移失败不得静默清除。
 * - translationCache：LRU 翻译缓存（可清空）。
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Cue, SubtitleCoverage } from '../domain/cue';
import type { SourceMode } from '../domain/session';

export const DB_NAME = 'tongting';
export const DB_VERSION = 1;
export const RECORD_SCHEMA_VERSION = 1;

export interface TranscriptRecord {
  schemaVersion: number;
  /** `${videoId}|${targetLanguage}|${sourceKey}` */
  recordId: string;
  videoId: string;
  title?: string;
  channel?: string;
  targetLanguage: string;
  sourceLanguage: string;
  sourceMode: SourceMode;
  /** 字幕轨道 key 或 'asr'。 */
  sourceKey: string;
  sourceLabel?: string;
  /** 最近一次写入该记录的会话。 */
  lastSessionId: string;
  /** 保存时的非敏感翻译配置，用于恢复时判断已有译文能否继续使用。 */
  translationFingerprint?: string;
  cues: Cue[];
  coverage: SubtitleCoverage;
  durationMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface FavoriteRecord {
  schemaVersion: number;
  /** `${recordId}|${cueId}` */
  favoriteId: string;
  recordId: string;
  videoId: string;
  cueId: string;
  startMs: number;
  endMs: number;
  sourceText: string;
  translatedText?: string;
  createdAt: number;
}

export interface NoteRecord {
  schemaVersion: number;
  videoId: string;
  text: string;
  updatedAt: number;
}

export interface TranslationCacheRecord {
  key: string;
  value: string;
  createdAt: number;
  lastUsedAt: number;
  size: number;
}

export interface TongtingDbSchema extends DBSchema {
  transcripts: {
    key: string;
    value: TranscriptRecord;
    indexes: { byVideo: string; byUpdatedAt: number };
  };
  favorites: {
    key: string;
    value: FavoriteRecord;
    indexes: { byRecord: string; byVideo: string };
  };
  notes: {
    key: string;
    value: NoteRecord;
  };
  translationCache: {
    key: string;
    value: TranslationCacheRecord;
    indexes: { byLastUsedAt: number };
  };
  meta: {
    key: string;
    value: { key: string; value: unknown };
  };
}

export type TongtingDb = IDBPDatabase<TongtingDbSchema>;

let dbPromise: Promise<TongtingDb> | undefined;

export function transcriptRecordId(
  videoId: string,
  targetLanguage: string,
  sourceKey: string,
): string {
  return `${videoId}|${targetLanguage}|${sourceKey}`;
}

export function openTongtingDb(): Promise<TongtingDb> {
  if (!dbPromise) {
    dbPromise = openDB<TongtingDbSchema>(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const transcripts = db.createObjectStore('transcripts', { keyPath: 'recordId' });
          transcripts.createIndex('byVideo', 'videoId');
          transcripts.createIndex('byUpdatedAt', 'updatedAt');
          const favorites = db.createObjectStore('favorites', { keyPath: 'favoriteId' });
          favorites.createIndex('byRecord', 'recordId');
          favorites.createIndex('byVideo', 'videoId');
          db.createObjectStore('notes', { keyPath: 'videoId' });
          const cache = db.createObjectStore('translationCache', { keyPath: 'key' });
          cache.createIndex('byLastUsedAt', 'lastUsedAt');
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // 后续版本在此追加迁移；不得删除 favorites / notes。
      },
      blocked() {
        console.warn('[tongting] IndexedDB upgrade blocked by another context');
      },
      // 其他上下文（新版本扩展页面）需要升级时关闭本连接，避免升级被永久阻塞；下次访问重新打开。
      blocking(_current, _blocked, event) {
        (event.target as IDBDatabase | null)?.close();
        dbPromise = undefined;
      },
      terminated() {
        dbPromise = undefined;
      },
    }).catch((error: unknown) => {
      dbPromise = undefined;
      throw error;
    });
  }
  return dbPromise;
}

/** 测试用：关闭并重置连接。 */
export async function resetDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => undefined);
    db?.close();
  }
  dbPromise = undefined;
}

/**
 * 「记住在本机」凭证的存储区：扩展 origin 下的独立 IndexedDB。
 *
 * chrome.storage.local 默认对内容脚本可读，且 setAccessLevel 只作用于 storage.session；
 * 扩展 origin 的 IndexedDB 只能由扩展页面与 service worker 访问，YouTube 页面里的内容脚本读不到。
 * 独立数据库，避免与字幕记录库的版本升级互相阻塞。
 */
import { openDB, type IDBPDatabase } from 'idb';
import type { KeyValueArea } from '../background/deps';

const SECURE_DB_NAME = 'tongting-secure';
const SECURE_DB_VERSION = 1;
const STORE = 'kv';

export function createSecureLocalArea(dbName = SECURE_DB_NAME): KeyValueArea {
  let dbPromise: Promise<IDBPDatabase> | undefined;
  const open = (): Promise<IDBPDatabase> => {
    if (!dbPromise) {
      dbPromise = openDB(dbName, SECURE_DB_VERSION, {
        upgrade(db) {
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
        },
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
  };
  return {
    async get(keys) {
      const db = await open();
      const tx = db.transaction(STORE, 'readonly');
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        const value: unknown = await tx.store.get(key);
        if (value !== undefined) out[key] = value;
      }
      await tx.done;
      return out;
    },
    async set(items) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      for (const [key, value] of Object.entries(items)) await tx.store.put(value, key);
      await tx.done;
    },
    async remove(keys) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      for (const key of keys) await tx.store.delete(key);
      await tx.done;
    },
  };
}

import { z } from 'zod';
import { cancelledError } from '../domain/errors';
import { SEARCH_HISTORY_LIMIT, SearchRecordSchema, type SearchRecord } from '../domain/search';
import { openTongtingDb } from './db';

const KEY = 'search-history-v1';
const Records = z.array(SearchRecordSchema).max(SEARCH_HISTORY_LIMIT);
export interface SearchHistoryRepo {
  list(): Promise<SearchRecord[]>;
  save(record: SearchRecord, signal: AbortSignal): Promise<void>;
  clear(): Promise<void>;
}
export const searchHistory: SearchHistoryRepo = {
  async list() {
    const db = await openTongtingDb();
    const stored = await db.get('meta', KEY);
    return Records.parse(stored?.value ?? []);
  },
  async save(record, signal) {
    const valid = SearchRecordSchema.parse(record);
    const db = await openTongtingDb();
    if (signal.aborted) throw cancelledError();
    const tx = db.transaction('meta', 'readwrite');
    const cancel = () => {
      try {
        tx.abort();
      } catch {
        /* Already committed. */
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const stored = await tx.store.get(KEY);
      if (signal.aborted) throw cancelledError();
      const previous = Records.parse(stored?.value ?? []);
      await tx.store.put({
        key: KEY,
        value: [valid, ...previous.filter((r) => r.query !== valid.query)].slice(
          0,
          SEARCH_HISTORY_LIMIT,
        ),
      });
      await tx.done;
    } catch (error) {
      cancel();
      await tx.done.catch(() => undefined);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  },
  async clear() {
    const db = await openTongtingDb();
    await db.delete('meta', KEY);
  },
};

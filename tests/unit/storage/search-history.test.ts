import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { openTongtingDb, resetDbForTests } from '@src/storage/db';
import { searchHistory } from '@src/storage/search-history';
import { searchRecord } from '../../fixtures/search';

const original = globalThis.indexedDB;
const signal = () => new AbortController().signal;
beforeEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = original;
});

describe('local search history', () => {
  it('keeps earlier long suggestions and their labels readable after the new generation rules', async () => {
    const legacy = {
      ...searchRecord,
      items: searchRecord.items.map((item, i) => ({
        ...item,
        label: i === 0 ? '实用技巧' : item.label,
        keyword: `Codex tips and tricks for more efficient use ${i}`,
      })),
    };
    const db = await openTongtingDb();
    await db.put('meta', { key: 'search-history-v1', value: [legacy] });
    expect(await searchHistory.list()).toEqual([legacy]);
    await searchHistory.save({ ...searchRecord, query: '新的查询' }, signal());
    expect((await searchHistory.list())[1]).toEqual(legacy);
  });
  it('reads legacy Chinese→English records next to new multilingual records', async () => {
    const multilingual = {
      ...searchRecord,
      id: 'search-ja-ko',
      query: '料理の基本を学びたい',
      userLanguage: 'ja',
      keywordLanguage: 'ko',
      items: [
        { label: '直訳', keyword: '요리 기초를 배우고 싶어요', annotation: '料理の基本を学びたい' },
        { label: '入門', keyword: '요리 기초', annotation: '料理の基本' },
        { label: 'レシピ', keyword: '초보 요리 레시피', annotation: '初心者向けレシピ' },
      ],
    };
    const db = await openTongtingDb();
    await db.put('meta', { key: 'search-history-v1', value: [searchRecord] });
    await searchHistory.save(multilingual, signal());
    const records = await searchHistory.list();
    expect(records).toEqual([multilingual, searchRecord]);
    expect(records[1]).not.toHaveProperty('userLanguage');
  });
  it('serializes concurrent writes, bounds history to 20 and replaces repeated topics', async () => {
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        searchHistory.save({ ...searchRecord, id: `search-${i}`, query: `主题 ${i}` }, signal()),
      ),
    );
    const records = await searchHistory.list();
    expect(records).toHaveLength(20);
    expect(new Set(records.map((r) => r.query)).size).toBe(20);
    const query = records[5]!.query;
    await searchHistory.save({ ...searchRecord, id: 'replacement', query }, signal());
    expect((await searchHistory.list())[0]).toMatchObject({ id: 'replacement', query });
    expect((await searchHistory.list()).filter((r) => r.query === query)).toHaveLength(1);
  });
  it('does not write cancelled requests and clears only its own metadata', async () => {
    const db = await openTongtingDb();
    await db.put('meta', { key: 'unrelated', value: 'keep' });
    const abort = new AbortController();
    abort.abort();
    await expect(searchHistory.save(searchRecord, abort.signal)).rejects.toThrow();
    expect(await searchHistory.list()).toEqual([]);
    await searchHistory.save(searchRecord, signal());
    await searchHistory.clear();
    expect(await searchHistory.list()).toEqual([]);
    expect(await db.get('meta', 'unrelated')).toEqual({ key: 'unrelated', value: 'keep' });
  });
  it('reports corrupted history without silently overwriting it', async () => {
    const db = await openTongtingDb();
    await db.put('meta', { key: 'search-history-v1', value: ['broken'] });
    await expect(searchHistory.list()).rejects.toThrow();
    await expect(searchHistory.save(searchRecord, signal())).rejects.toThrow();
    expect((await db.get('meta', 'search-history-v1'))?.value).toEqual(['broken']);
    await searchHistory.clear();
    await searchHistory.save(searchRecord, signal());
    expect(await searchHistory.list()).toEqual([searchRecord]);
  });
});

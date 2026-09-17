import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import type { Cue } from '@src/domain/cue';
import {
  openTongtingDb,
  resetDbForTests,
  RECORD_SCHEMA_VERSION,
  transcriptRecordId,
  type TranscriptRecord,
} from '@src/storage/db';
import {
  deleteTranscript,
  getTranscript,
  listTranscripts,
  listTranscriptsByVideo,
  putTranscript,
} from '@src/storage/transcripts';
import {
  listFavoritesByRecord,
  listFavoritesByVideo,
  toggleFavorite,
} from '@src/storage/favorites';
import { getNote, saveNote } from '@src/storage/notes';

const VIDEO = 'abcdefghijk';
const OTHER_VIDEO = 'zyxwvutsrqp';

function cue(id: string, startMs: number): Cue {
  return {
    id,
    revision: 0,
    startMs,
    endMs: startMs + 1000,
    sourceText: `source ${id}`,
    translatedText: `译文 ${id}`,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track',
    stability: 'final',
    translationState: 'done',
  };
}

function record(
  videoId: string,
  targetLanguage: string,
  updatedAt: number,
  cues: Cue[] = [cue('a', 0)],
): TranscriptRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId: transcriptRecordId(videoId, targetLanguage, 'en.track'),
    videoId,
    title: `视频 ${videoId}`,
    targetLanguage,
    sourceLanguage: 'en',
    sourceMode: 'full-track',
    sourceKey: 'en.track',
    lastSessionId: 'session-0001',
    cues,
    coverage: { complete: true, ranges: [{ startMs: 0, endMs: 1000 }], gaps: [] },
    createdAt: updatedAt,
    updatedAt,
  };
}

const originalIndexedDb = globalThis.indexedDB;

beforeEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = new IDBFactory();
});

afterEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = originalIndexedDb;
});

describe('transcripts repository', () => {
  it('puts, gets and lists records by updatedAt descending with a limit', async () => {
    await putTranscript(record(VIDEO, 'zh-CN', 100));
    await putTranscript(record(OTHER_VIDEO, 'zh-CN', 300));
    await putTranscript(record(VIDEO, 'ja', 200));

    const all = await listTranscripts();
    expect(all.map((r) => r.updatedAt)).toEqual([300, 200, 100]);
    expect((await listTranscripts({ limit: 2 })).map((r) => r.updatedAt)).toEqual([300, 200]);
    expect((await listTranscriptsByVideo(VIDEO)).map((r) => r.targetLanguage)).toEqual([
      'ja',
      'zh-CN',
    ]);
    const got = await getTranscript(transcriptRecordId(VIDEO, 'zh-CN', 'en.track'));
    expect(got?.cues).toHaveLength(1);
    expect(await getTranscript('missing')).toBeUndefined();
  });

  it('drops corrupted records and invalid cues instead of failing the whole list', async () => {
    const good = record(VIDEO, 'zh-CN', 100, [
      cue('b', 5000),
      { ...cue('bad', 0), startMs: -1 },
      cue('a', 0),
    ]);
    await putTranscript(good);
    const db = await openTongtingDb();
    // 模拟旧版本或损坏数据：缺少 cues 数组
    await db.put('transcripts', {
      recordId: 'broken',
      videoId: VIDEO,
      updatedAt: 999,
    } as unknown as TranscriptRecord);

    const listed = await listTranscripts();
    expect(listed.map((r) => r.recordId)).toEqual([good.recordId]);
    const got = await getTranscript(good.recordId);
    expect(got?.cues.map((c) => c.id)).toEqual(['a', 'b']);
    expect(await getTranscript('broken')).toBeUndefined();
  });

  it('deleting a transcript keeps notes and favorites', async () => {
    const r = record(VIDEO, 'zh-CN', 100);
    await putTranscript(r);
    await saveNote(VIDEO, '重要笔记');
    await toggleFavorite({
      recordId: r.recordId,
      videoId: VIDEO,
      cueId: 'a',
      startMs: 0,
      endMs: 1000,
      sourceText: 'source a',
    });

    await deleteTranscript(r.recordId);

    expect(await getTranscript(r.recordId)).toBeUndefined();
    expect((await getNote(VIDEO))?.text).toBe('重要笔记');
    expect(await listFavoritesByVideo(VIDEO)).toHaveLength(1);
  });
});

describe('favorites repository', () => {
  it('toggles on and off and lists by record and video in time order', async () => {
    const recordId = transcriptRecordId(VIDEO, 'zh-CN', 'en.track');
    const base = { recordId, videoId: VIDEO, sourceText: 'x' };
    expect(await toggleFavorite({ ...base, cueId: 'late', startMs: 9000, endMs: 9500 })).toBe(true);
    expect(
      await toggleFavorite({
        ...base,
        cueId: 'early',
        startMs: 1000,
        endMs: 1500,
        translatedText: '早',
      }),
    ).toBe(true);
    expect((await listFavoritesByRecord(recordId)).map((f) => f.cueId)).toEqual(['early', 'late']);

    expect(await toggleFavorite({ ...base, cueId: 'late', startMs: 9000, endMs: 9500 })).toBe(
      false,
    );
    const remaining = await listFavoritesByVideo(VIDEO);
    expect(remaining.map((f) => f.cueId)).toEqual(['early']);
    expect(remaining[0]).toMatchObject({
      favoriteId: `${recordId}|early`,
      translatedText: '早',
      schemaVersion: RECORD_SCHEMA_VERSION,
    });
    expect(await listFavoritesByRecord('other')).toEqual([]);
  });

  it('rejects incomplete input', async () => {
    await expect(
      toggleFavorite({
        recordId: '',
        videoId: VIDEO,
        cueId: 'a',
        startMs: 0,
        endMs: 1,
        sourceText: '',
      }),
    ).rejects.toThrow();
  });
});

describe('notes repository', () => {
  it('saves and loads notes', async () => {
    expect(await getNote(VIDEO)).toBeUndefined();
    await saveNote(VIDEO, '第一版');
    await saveNote(VIDEO, '第二版');
    expect(await getNote(VIDEO)).toMatchObject({
      videoId: VIDEO,
      text: '第二版',
      schemaVersion: RECORD_SCHEMA_VERSION,
    });
  });

  it('propagates storage failures instead of pretending the note was saved', async () => {
    await resetDbForTests();
    globalThis.indexedDB = {
      open() {
        throw new DOMException('模拟配额不足', 'QuotaExceededError');
      },
    } as unknown as IDBFactory;
    await expect(saveNote(VIDEO, '不会被保存')).rejects.toThrow('模拟配额不足');
  });

  it('rejects invalid video ids and oversized notes', async () => {
    await expect(saveNote('bad id!', 'x')).rejects.toThrow('无效的视频 ID');
    await expect(saveNote(VIDEO, 'x'.repeat(200_001))).rejects.toThrow();
  });
});

describe('review fixes: storage', () => {
  it('setFavorite is idempotent and returns the final state', async () => {
    const { setFavorite } = await import('@src/storage/favorites');
    const input = {
      recordId: 'r1',
      videoId: VIDEO,
      cueId: 'a',
      startMs: 0,
      endMs: 1,
      sourceText: 'x',
    };
    expect(await setFavorite(input, true)).toBe(true);
    expect(await setFavorite(input, true)).toBe(true);
    expect(await listFavoritesByRecord('r1')).toHaveLength(1);
    expect(await setFavorite(input, false)).toBe(false);
    expect(await setFavorite(input, false)).toBe(false);
    expect(await listFavoritesByRecord('r1')).toHaveLength(0);
  });

  it('saveNoteChecked detects conflicting updates and does not overwrite', async () => {
    const { NoteConflictError, saveNoteChecked } = await import('@src/storage/notes');
    const first = await saveNoteChecked(VIDEO, '页面 A', 0);
    // 页面 B 基于同一旧版本保存：冲突
    await expect(saveNoteChecked(VIDEO, '页面 B', 0)).rejects.toBeInstanceOf(NoteConflictError);
    expect((await getNote(VIDEO))?.text).toBe('页面 A');
    const second = await saveNoteChecked(VIDEO, '页面 A 第二版', first.updatedAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('loadTranscript reports dropped cues and future schema versions; summaries omit cue bodies', async () => {
    const { loadTranscript, listTranscriptSummaries } = await import('@src/storage/transcripts');
    const r = record(VIDEO, 'zh-CN', 100, [cue('a', 0), { ...cue('bad', 0), startMs: -1 }]);
    await putTranscript({ ...r, schemaVersion: RECORD_SCHEMA_VERSION + 1 });
    const loaded = await loadTranscript(r.recordId);
    expect(loaded).toMatchObject({ invalidCueCount: 1, readOnly: true });
    expect(loaded?.record.cues.map((c) => c.id)).toEqual(['a']);
    const [summary] = await listTranscriptSummaries();
    expect(summary).toMatchObject({ recordId: r.recordId, cueCount: 2 });
    expect(summary).not.toHaveProperty('cues');
  });
});

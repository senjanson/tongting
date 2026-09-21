import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { resetDbForTests, type TranscriptRecord } from '@src/storage/db';
import { createTranscriptWriter, getTranscript } from '@src/storage/transcripts';

const record = (
  text: string,
  sourceMode: TranscriptRecord['sourceMode'] = 'full-track',
  id = 'a',
): TranscriptRecord => ({
  schemaVersion: 1,
  recordId: 'video|zh-CN|source',
  videoId: 'video',
  targetLanguage: 'zh-CN',
  sourceLanguage: 'en',
  sourceMode,
  sourceKey: 'source',
  lastSessionId: 'session',
  cues: [
    {
      id,
      revision: 0,
      startMs: id === 'a' ? 0 : 5000,
      endMs: id === 'a' ? 1000 : 6000,
      sourceText: text,
      translatedText: `译${text}`,
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      source: sourceMode === 'asr' ? 'asr' : 'caption-track',
      stability: 'final',
      translationState: 'done',
    },
  ],
  coverage: { complete: sourceMode === 'full-track', ranges: [], gaps: [] },
  createdAt: 1,
  updatedAt: 2,
});

beforeEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = new IDBFactory();
});
afterEach(() => resetDbForTests());

describe('review #4/#5: atomic transcript writers', () => {
  it('rejects a late old session write after a newer session saved the same record, including after DB reconnect', async () => {
    const old = createTranscriptWriter();
    const newer = createTranscriptWriter();
    await newer.save(record('NEW'));
    await resetDbForTests();
    await old.save(record('OLD'));
    expect((await getTranscript(record('').recordId))?.cues[0]?.sourceText).toBe('NEW');
  });

  it('freezes the supplied record before any await and orders repeated saves in the same writer', async () => {
    const writer = createTranscriptWriter();
    const snapshot = record('first');
    const pending = writer.save(snapshot);
    snapshot.targetLanguage = 'ja';
    snapshot.cues[0]!.sourceText = 'mutated';
    await pending;
    expect(await getTranscript(snapshot.recordId)).toMatchObject({
      targetLanguage: 'zh-CN',
      cues: [{ sourceText: 'first' }],
    });
    await Promise.all([writer.save(record('second')), writer.save(record('third'))]);
    expect((await getTranscript(snapshot.recordId))?.cues[0]?.sourceText).toBe('third');
  });

  it('accumulates ASR history, translations and coverage across writer recovery, and deduplicates repeat saves', async () => {
    await createTranscriptWriter().save(record('Before', 'asr'));
    const recovered = createTranscriptWriter();
    await recovered.save(record('After', 'asr', 'b'));
    await recovered.save(record('After', 'asr', 'b'));
    expect(await getTranscript(record('').recordId)).toMatchObject({
      cues: [
        { sourceText: 'Before', translatedText: '译Before' },
        { sourceText: 'After', translatedText: '译After' },
      ],
      coverage: {
        ranges: [
          { startMs: 0, endMs: 1000 },
          { startMs: 5000, endMs: 6000 },
        ],
      },
    });
  });

  it('keeps complete track replacement semantics', async () => {
    const writer = createTranscriptWriter();
    await writer.save(record('Before'));
    await writer.save(record('After', 'full-track', 'b'));
    expect((await getTranscript(record('').recordId))?.cues.map((c) => c.sourceText)).toEqual([
      'After',
    ]);
  });
});

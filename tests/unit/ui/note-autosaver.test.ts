import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NoteAutosaver, type NoteSaveStatus } from '@src/ui/workspace/note-autosaver';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('NoteAutosaver', () => {
  let statuses: NoteSaveStatus[];
  beforeEach(() => {
    vi.useFakeTimers();
    statuses = [];
  });
  afterEach(() => vi.useRealTimers());

  it('debounces, saves the latest text, and reports saved only after success', async () => {
    const saves: string[] = [];
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: '',
      delayMs: 500,
      save: async (_id, text) => {
        saves.push(text);
      },
      onStatus: (s) => statuses.push(s),
    });
    saver.change('a');
    saver.change('ab');
    expect(statuses.at(-1)).toBe('pending');
    await vi.advanceTimersByTimeAsync(500);
    expect(saves).toEqual(['ab']);
    expect(statuses.at(-1)).toBe('saved');
    expect(saver.hasUnsaved).toBe(false);
  });

  it('serializes saves and saves edits made while a save is in flight', async () => {
    const first = deferred();
    const saves: string[] = [];
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: '',
      delayMs: 100,
      save: (_id, text) => {
        saves.push(text);
        return saves.length === 1 ? first.promise : Promise.resolve();
      },
      onStatus: (s) => statuses.push(s),
    });
    saver.change('v1');
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toBe('saving');
    saver.change('v2');
    await vi.advanceTimersByTimeAsync(100);
    expect(saves).toEqual(['v1']); // 第二次保存等待第一次完成
    first.resolve();
    await vi.runAllTimersAsync();
    expect(saves).toEqual(['v1', 'v2']);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('reports failure, keeps the content for retry, and never shows saved on failure', async () => {
    let fail = true;
    const saves: string[] = [];
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: 'old',
      delayMs: 100,
      save: async (_id, text) => {
        saves.push(text);
        if (fail) throw new Error('QuotaExceededError');
      },
      onStatus: (s) => statuses.push(s),
    });
    saver.change('new text');
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses.at(-1)).toBe('error');
    expect(statuses).not.toContain('saved');
    expect(saver.hasUnsaved).toBe(true);
    fail = false;
    await saver.retry();
    expect(saves).toEqual(['new text', 'new text']);
    expect(statuses.at(-1)).toBe('saved');
  });

  it('flushes unsaved content on dispose without further status callbacks', async () => {
    const saves: string[] = [];
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: '',
      delayMs: 10_000,
      save: async (_id, text) => {
        saves.push(text);
      },
      onStatus: (s) => statuses.push(s),
    });
    saver.change('draft');
    const count = statuses.length;
    await saver.dispose();
    expect(saves).toEqual(['draft']);
    saver.change('after dispose');
    await vi.runAllTimersAsync();
    expect(saves).toEqual(['draft']);
    expect(statuses.slice(count)).not.toContain('saved');
  });

  it('does not write when text returns to the saved baseline', async () => {
    const save = vi.fn(async () => undefined);
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: 'same',
      delayMs: 50,
      save,
      onStatus: (s) => statuses.push(s),
    });
    saver.change('same');
    await vi.advanceTimersByTimeAsync(50);
    expect(save).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toBe('saved');
  });
});

describe('NoteAutosaver review fixes', () => {
  it('dispose reports failure so the caller keeps a draft', async () => {
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: '',
      delayMs: 10_000,
      save: async () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      onStatus: () => undefined,
    });
    saver.change('切换视频前刚输入的笔记');
    await expect(saver.dispose()).resolves.toBe(false);
  });

  it('reports conflict separately from ordinary errors', async () => {
    const statuses: NoteSaveStatus[] = [];
    class Conflict extends Error {}
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: '',
      delayMs: 0,
      save: async () => {
        throw new Conflict();
      },
      isConflict: (e) => e instanceof Conflict,
      onStatus: (s) => statuses.push(s),
    });
    saver.change('x');
    await saver.flush();
    expect(statuses.at(-1)).toBe('conflict');
    expect(saver.hasUnsaved).toBe(true);
  });
});

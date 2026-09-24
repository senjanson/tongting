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

  it('stays in conflict while typing, even back to the last saved text, until the user overwrites', async () => {
    vi.useFakeTimers();
    try {
      const statuses: NoteSaveStatus[] = [];
      const saves: string[] = [];
      class Conflict extends Error {}
      // 另一页面已保存了同一视频的笔记：本页基线过期，覆盖前的每次保存都会冲突。
      let conflicting = true;
      const saver = new NoteAutosaver({
        videoId: 'abcdefghijk',
        baseline: 'old',
        delayMs: 100,
        save: async (_id, text) => {
          saves.push(text);
          if (conflicting) throw new Conflict();
        },
        isConflict: (e) => e instanceof Conflict,
        onStatus: (s) => statuses.push(s),
      });
      saver.change('old x');
      await vi.advanceTimersByTimeAsync(100);
      expect(statuses.at(-1)).toBe('conflict');

      // 把刚加的内容删掉：文本等于本页上次保存的版本，但存储里仍是另一页面的内容。
      saver.change('old');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(statuses.at(-1)).toBe('conflict');
      expect(statuses.slice(statuses.indexOf('conflict'))).not.toContain('saved');
      expect(saver.hasUnsaved).toBe(true);
      // 冲突待决时不自动保存（必然再次冲突）。
      expect(saves).toEqual(['old x']);
      saver.change('old y');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(saves).toEqual(['old x']);
      expect(saver.currentStatus).toBe('conflict');

      // 用户选择「用本页内容覆盖」：写入最新输入。
      conflicting = false;
      await saver.retry();
      expect(saves).toEqual(['old x', 'old y']);
      expect(statuses.at(-1)).toBe('saved');
      expect(saver.hasUnsaved).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('overwrites even when the text equals the version this page saved before the conflict', async () => {
    const saves: string[] = [];
    class Conflict extends Error {}
    let conflicting = true;
    const saver = new NoteAutosaver({
      videoId: 'abcdefghijk',
      baseline: 'old',
      delayMs: 0,
      save: async (_id, text) => {
        saves.push(text);
        if (conflicting) throw new Conflict();
      },
      isConflict: (e) => e instanceof Conflict,
      onStatus: () => undefined,
    });
    saver.change('old x');
    await saver.flush();
    saver.change('old');
    conflicting = false;
    await saver.retry();
    // 不能因为「与上次保存相同」就跳过写入：存储里是另一页面的内容。
    expect(saves).toEqual(['old x', 'old']);
    expect(saver.currentStatus).toBe('saved');
  });

  it('does not run a save scheduled before the conflict, and dispose keeps the content as unsaved', async () => {
    vi.useFakeTimers();
    try {
      let rejectFirst!: (e: unknown) => void;
      const saves: string[] = [];
      class Conflict extends Error {}
      const saver = new NoteAutosaver({
        videoId: 'abcdefghijk',
        baseline: '',
        delayMs: 100,
        save: (_id, text) => {
          saves.push(text);
          return saves.length === 1
            ? new Promise<void>((_resolve, reject) => {
                rejectFirst = reject;
              })
            : Promise.reject(new Conflict());
        },
        isConflict: (e) => e instanceof Conflict,
        onStatus: () => undefined,
      });
      saver.change('v1');
      await vi.advanceTimersByTimeAsync(100);
      // 保存进行中继续输入：定时保存已排定。
      saver.change('v2');
      rejectFirst(new Conflict());
      await vi.advanceTimersByTimeAsync(1_000);
      expect(saves).toEqual(['v1']);
      expect(saver.currentStatus).toBe('conflict');
      await expect(saver.dispose()).resolves.toBe(false);
      expect(saves).toEqual(['v1']);
    } finally {
      vi.useRealTimers();
    }
  });
});

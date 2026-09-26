// @vitest-environment happy-dom
/**
 * 笔记草稿存储：同一视频可有多份草稿；删除必须指明内容或写入者，不按 videoId 整体删除。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearNoteDraft,
  readNoteDraft,
  readNoteDrafts,
  writeNoteDraft,
} from '@src/ui/workspace/note-drafts';

const VIDEO = 'abcdefghijk';
const KEY = `tongting:note-draft:${VIDEO}`;

afterEach(() => localStorage.clear());

describe('note drafts', () => {
  it('reads a draft stored by the previous single-draft format', () => {
    localStorage.setItem(KEY, JSON.stringify({ text: '旧格式草稿', savedAt: 100 }));
    expect(readNoteDraft(VIDEO)).toEqual({
      id: 'saved-100',
      text: '旧格式草稿',
      savedAt: 100,
      baseUpdatedAt: 0,
    });
  });

  it('ignores corrupt or malformed entries', () => {
    localStorage.setItem(KEY, '{not json');
    expect(readNoteDrafts(VIDEO)).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([{ text: 1 }, { text: '有效', savedAt: 5 }]));
    expect(readNoteDrafts(VIDEO).map((d) => d.text)).toEqual(['有效']);
  });

  it('keeps other drafts when a writer replaces its own draft', () => {
    localStorage.setItem(KEY, JSON.stringify({ text: '未处理的旧草稿', savedAt: 100 }));
    writeNoteDraft(VIDEO, { id: 'page', text: '第一次', savedAt: 200, baseUpdatedAt: 1 });
    writeNoteDraft(VIDEO, { id: 'page', text: '第二次', savedAt: 300, baseUpdatedAt: 1 });
    expect(readNoteDrafts(VIDEO).map((d) => d.text)).toEqual(['第二次', '未处理的旧草稿']);
    expect(readNoteDraft(VIDEO)?.text).toBe('第二次');
  });

  it('lists the newest first and collapses drafts with the same content', () => {
    writeNoteDraft(VIDEO, { id: 'a', text: '相同内容', savedAt: 100, baseUpdatedAt: 0 });
    writeNoteDraft(VIDEO, { id: 'b', text: '另一份', savedAt: 150, baseUpdatedAt: 0 });
    writeNoteDraft(VIDEO, { id: 'c', text: '相同内容', savedAt: 200, baseUpdatedAt: 0 });
    expect(readNoteDrafts(VIDEO).map((d) => d.id)).toEqual(['c', 'b']);
  });

  it('clears only drafts whose content matches', () => {
    writeNoteDraft(VIDEO, { id: 'a', text: '已保存的内容', savedAt: 100, baseUpdatedAt: 0 });
    writeNoteDraft(VIDEO, { id: 'b', text: '未处理的草稿', savedAt: 150, baseUpdatedAt: 0 });
    writeNoteDraft(VIDEO, { id: 'c', text: '已保存的内容', savedAt: 200, baseUpdatedAt: 0 });
    clearNoteDraft(VIDEO, { text: '已保存的内容' });
    expect(readNoteDrafts(VIDEO).map((d) => d.id)).toEqual(['b']);
    clearNoteDraft(VIDEO, { text: '不存在的内容' });
    expect(readNoteDrafts(VIDEO).map((d) => d.id)).toEqual(['b']);
  });

  it('clears only the given writer’s draft, and removes the key once empty', () => {
    writeNoteDraft(VIDEO, { id: 'page', text: '本页草稿', savedAt: 100, baseUpdatedAt: 0 });
    writeNoteDraft(VIDEO, { id: 'other', text: '旧草稿', savedAt: 50, baseUpdatedAt: 0 });
    clearNoteDraft(VIDEO, { id: 'page' });
    expect(readNoteDrafts(VIDEO).map((d) => d.id)).toEqual(['other']);
    clearNoteDraft(VIDEO, { id: 'other' });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

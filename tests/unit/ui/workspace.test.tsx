// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { RECORD_SCHEMA_VERSION, resetDbForTests, transcriptRecordId } from '@src/storage/db';
import { putTranscript } from '@src/storage/transcripts';
import { WorkspaceApp } from '@src/ui/workspace/WorkspaceApp';
import { makeCue, makePage, makeSession, makeSnapshot, TAB_ID, VIDEO_ID } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

const notes = vi.hoisted(() => ({
  NoteConflictError: class NoteConflictError extends Error {},
  saveNoteChecked: vi.fn(),
  getNote: vi.fn(),
  saveNote: vi.fn(),
}));

vi.mock('@src/storage/notes', () => notes);

let worker: FakeWorker;
const recordId = transcriptRecordId(VIDEO_ID, 'zh-CN', 'en.manual');

beforeEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = new IDBFactory();
  notes.getNote.mockResolvedValue({
    schemaVersion: 1,
    videoId: VIDEO_ID,
    text: '已有笔记',
    updatedAt: 1,
  });
  notes.saveNote.mockResolvedValue(undefined);
  notes.saveNoteChecked.mockImplementation(
    async (videoId: string, text: string, expected: number) => ({
      schemaVersion: 1,
      videoId,
      text,
      updatedAt: expected + 1,
    }),
  );
  await putTranscript({
    schemaVersion: RECORD_SCHEMA_VERSION,
    recordId,
    videoId: VIDEO_ID,
    title: '记录中的视频标题',
    targetLanguage: 'zh-CN',
    sourceLanguage: 'en',
    sourceMode: 'full-track',
    sourceKey: 'en.manual',
    lastSessionId: 'session-00000001',
    cues: [makeCue('a', 1_000), makeCue('b', 5_000)],
    coverage: {
      complete: true,
      ranges: [{ startMs: 0, endMs: 600_000 }],
      gaps: [],
      durationMs: 600_000,
    },
    createdAt: 1,
    updatedAt: 2,
  });
  window.history.replaceState({}, '', `/workspace.html?videoId=${VIDEO_ID}`);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  await resetDbForTests();
});

function start(snapshot = makeSnapshot()) {
  worker = createFakeWorker(snapshot);
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
  render(<WorkspaceApp />);
}

describe('workspace', () => {
  it('preselects the record from ?videoId and disables playback control when the source tab is gone', async () => {
    start();
    expect(await screen.findByText('源标签页已关闭，播放控制不可用。')).toBeTruthy();
    expect(screen.getAllByText('记录中的视频标题').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /跳转到/ })).toBeNull();
    expect(await screen.findByDisplayValue('已有笔记')).toBeTruthy();
  });

  it('allows seeking when the source tab is still registered', async () => {
    start(makeSnapshot({ pages: [makePage()] }));
    fireEvent.click(await screen.findByRole('button', { name: '跳转到 0:05' }));
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'player/seek',
        tabId: TAB_ID,
        timeMs: 5_000,
      }),
    );
  });

  it('shows 保存失败 when saving the note fails, keeps the text, and recovers on retry', async () => {
    notes.saveNoteChecked.mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));
    start();
    const area = (await screen.findByLabelText('视频笔记')) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '已有笔记\n新的想法' } });
    expect(
      await screen.findByText('保存失败，内容仍在输入框中', {}, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    expect(area.value).toBe('已有笔记\n新的想法');

    fireEvent.click(screen.getByRole('button', { name: '重试保存' }));
    expect(await screen.findByText('已保存')).toBeTruthy();
    expect(notes.saveNoteChecked).toHaveBeenLastCalledWith(VIDEO_ID, '已有笔记\n新的想法', 1);
  });

  it('inserts a timed quote from the transcript into the note', async () => {
    start();
    const area = (await screen.findByLabelText('视频笔记')) as HTMLTextAreaElement;
    fireEvent.click(await screen.findByRole('button', { name: '把 0:01 字幕引用到笔记' }));
    await waitFor(() => expect(area.value).toBe('已有笔记\n\n> [0:01] 译文 a\n> source a\n'));
  });

  it('disables note editing when the note cannot be loaded, so it is never overwritten', async () => {
    notes.getNote.mockRejectedValueOnce(new Error('broken'));
    start();
    expect(
      await screen.findByText('读取笔记失败。为避免覆盖已有笔记，暂时不能编辑。'),
    ).toBeTruthy();
    expect(screen.queryByLabelText('视频笔记')).toBeNull();
    expect(notes.saveNoteChecked).not.toHaveBeenCalled();
  });

  it('deleting a record keeps the note', async () => {
    start();
    await screen.findByDisplayValue('已有笔记');
    fireEvent.click(await screen.findByRole('button', { name: '删除记录' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '删除记录' }));
    await waitFor(() => expect(screen.getByText(/这个视频还没有保存的字幕记录/)).toBeTruthy());
    expect(screen.getByDisplayValue('已有笔记')).toBeTruthy();
    expect(notes.saveNoteChecked).not.toHaveBeenCalled();
  });

  it('reloads the record on 刷新记录 and keeps an implicit selection fixed', async () => {
    const other = transcriptRecordId('zzzzzzzzzzz', 'zh-CN', 'en.manual');
    start();
    expect(await screen.findByText(/2 \/ 2 条字幕/)).toBeTruthy();
    await putTranscript({
      schemaVersion: RECORD_SCHEMA_VERSION,
      recordId,
      videoId: VIDEO_ID,
      title: '记录中的视频标题',
      targetLanguage: 'zh-CN',
      sourceLanguage: 'en',
      sourceMode: 'full-track',
      sourceKey: 'en.manual',
      lastSessionId: 'session-00000001',
      cues: [makeCue('a', 1_000), makeCue('b', 5_000), makeCue('c', 9_000)],
      coverage: { complete: true, ranges: [], gaps: [] },
      createdAt: 1,
      updatedAt: 5,
    });
    await putTranscript({
      schemaVersion: RECORD_SCHEMA_VERSION,
      recordId: other,
      videoId: 'zzzzzzzzzzz',
      title: '更新的其他视频',
      targetLanguage: 'zh-CN',
      sourceLanguage: 'en',
      sourceMode: 'full-track',
      sourceKey: 'en.manual',
      lastSessionId: 'session-00000002',
      cues: [makeCue('x', 0)],
      coverage: { complete: true, ranges: [], gaps: [] },
      createdAt: 1,
      updatedAt: 50,
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新记录' }));
    expect(await screen.findByText(/3 \/ 3 条字幕/)).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await screen.findByText('更新的其他视频');
    expect(screen.getAllByText('记录中的视频标题').length).toBeGreaterThan(1);
    expect((screen.getByLabelText('视频笔记') as HTMLTextAreaElement).value).toBe('已有笔记');
  });

  it('lists a live session that has no stored record yet', async () => {
    const liveRecord = transcriptRecordId('yyyyyyyyyyy', 'zh-CN', 'asr');
    const session = makeSession({
      identity: {
        sessionId: 'session-live-0001',
        tabId: TAB_ID,
        documentId: 'doc-1',
        videoId: 'yyyyyyyyyyy',
        epoch: 0,
        configRevision: 1,
      },
      recordId: liveRecord,
      sourceMode: 'asr',
      sourceTrack: undefined,
    });
    window.history.replaceState({}, '', '/workspace.html');
    start(makeSnapshot({ sessions: [session] }));
    expect(await screen.findByText('实时会话 · 尚未保存为本地记录')).toBeTruthy();
  });

  it('shows a conflict instead of overwriting a note changed elsewhere, and offers draft recovery', async () => {
    notes.saveNoteChecked.mockRejectedValueOnce(new notes.NoteConflictError('conflict'));
    start();
    const area = (await screen.findByLabelText('视频笔记')) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '本页修改' } });
    expect(
      await screen.findByText('笔记已在其他页面修改，未保存本页内容', {}, { timeout: 3_000 }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '用本页内容覆盖' })).toBeTruthy();
    expect(screen.queryByText('已保存')).toBeNull();
    // 卸载时仍有未保存内容且最终保存失败：保留草稿，下次打开提示恢复
    notes.saveNoteChecked.mockRejectedValue(new DOMException('quota', 'QuotaExceededError'));
    cleanup();
    await new Promise((r) => setTimeout(r, 20));
    notes.saveNoteChecked.mockReset();
    start();
    expect(await screen.findByText('发现未保存的笔记草稿')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '恢复草稿' }));
    expect((screen.getByLabelText('视频笔记') as HTMLTextAreaElement).value).toBe('本页修改');
    localStorage.clear();
  });
});

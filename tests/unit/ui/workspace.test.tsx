// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { RECORD_SCHEMA_VERSION, resetDbForTests, transcriptRecordId } from '@src/storage/db';
import { loadTranscript, putTranscript } from '@src/storage/transcripts';
import { WorkspaceApp } from '@src/ui/workspace/WorkspaceApp';
import { makeCue, makePage, makeSession, makeSnapshot, TAB_ID, VIDEO_ID } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

// 界面语言跟随浏览器（快照中 uiLocale 默认 auto）：本文件的断言使用中文界面。
beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue('zh-CN');
});

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

  // 正常停止后 worker 把会话从快照中移除；出错结束的会话以 error 快照保留。两种都要覆盖。
  it.each([
    ['removed from the snapshot', 'removed'],
    ['kept as an ended snapshot', 'ended'],
  ] as const)(
    'keeps a live-only entry through the session end (%s) and replaces it with the record it saved',
    async (_label, endShape) => {
      const liveVideo = 'yyyyyyyyyyy';
      const liveRecord = transcriptRecordId(liveVideo, 'zh-CN', 'asr');
      const identity = {
        sessionId: 'session-live-0001',
        tabId: TAB_ID,
        documentId: 'doc-1',
        videoId: liveVideo,
        epoch: 0,
        configRevision: 1,
      };
      const session = makeSession({
        identity,
        recordId: liveRecord,
        sourceMode: 'asr',
        sourceTrack: undefined,
      });
      const snapshot = makeSnapshot({ sessions: [session] });
      window.history.replaceState({}, '', '/workspace.html');
      worker = createFakeWorker(
        snapshot,
        {},
        new Map([[identity.sessionId, [makeCue('a', 1_000)]]]),
      );
      vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
      render(<WorkspaceApp />);
      fireEvent.click(await screen.findByText('实时会话 · 尚未保存为本地记录'));
      await screen.findByText('译文 a');

      // worker 在会话停止前写入记录，然后快照显示会话已结束（或已移除）。
      await putTranscript({
        schemaVersion: RECORD_SCHEMA_VERSION,
        recordId: liveRecord,
        videoId: liveVideo,
        targetLanguage: 'zh-CN',
        sourceLanguage: 'en',
        sourceMode: 'asr',
        sourceKey: 'asr',
        lastSessionId: identity.sessionId,
        cues: [makeCue('a', 1_000)],
        coverage: { complete: false, ranges: [{ startMs: 1_000, endMs: 3_000 }], gaps: [] },
        createdAt: 1,
        updatedAt: 2,
      });
      act(() => {
        worker.emit({
          type: 'snapshot',
          snapshot: {
            ...snapshot,
            snapshotVersion: 2,
            sessions:
              endShape === 'removed'
                ? []
                : [{ ...session, phase: 'idle', desiredState: 'stopped' }],
          },
        });
      });
      // 重新读取完成前：条目保留，不显示空状态，也不先显示「已不存在」。
      expect(screen.getByText('翻译已结束 · 正在读取本地记录…')).toBeTruthy();
      expect(screen.queryByText(/还没有保存的字幕记录|没有选中的字幕记录/)).toBeNull();
      expect(screen.queryByText('这条字幕记录已不存在')).toBeNull();
      // 去抖后重新读取列表：条目由刚写入的本地记录取代，仍保持选中。
      expect(await screen.findByText(/部分字幕 · 1 条/)).toBeTruthy();
      expect(screen.queryByText('翻译已结束 · 正在读取本地记录…')).toBeNull();
      expect(screen.queryByText(/还没有保存的字幕记录|没有选中的字幕记录/)).toBeNull();
      expect(await screen.findByText('译文 a')).toBeTruthy();
      expect(screen.queryByText('这条字幕记录已不存在')).toBeNull();
    },
  );

  it('drops an ended session that never saved a record once the list is re-read', async () => {
    const liveVideo = 'yyyyyyyyyyy';
    const liveRecord = transcriptRecordId(liveVideo, 'zh-CN', 'asr');
    const session = makeSession({
      identity: {
        sessionId: 'session-live-0001',
        tabId: TAB_ID,
        documentId: 'doc-1',
        videoId: liveVideo,
        epoch: 0,
        configRevision: 1,
      },
      recordId: liveRecord,
      sourceMode: 'asr',
      sourceTrack: undefined,
    });
    const snapshot = makeSnapshot({ sessions: [session] });
    start(snapshot);
    expect(await screen.findByText('实时会话 · 尚未保存为本地记录')).toBeTruthy();
    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          snapshotVersion: 2,
          sessions: [{ ...session, phase: 'error', desiredState: 'stopped' }],
        },
      });
    });
    await waitFor(() =>
      expect(screen.queryByText(/实时会话 · 尚未保存为本地记录|翻译已结束/)).toBeNull(),
    );
    expect(screen.getAllByText('记录中的视频标题').length).toBeGreaterThan(0);
  });

  it('disables deleting a record while its translation is still running', async () => {
    const session = makeSession({ recordId });
    const snapshot = makeSnapshot({ sessions: [session] });
    start(snapshot);
    const button = (await screen.findByRole('button', { name: '删除记录' })) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText('翻译进行中，停止后才能删除这条记录。')).toBeTruthy();

    // 停止中（尚未结束）仍会写回记录：保持禁用。
    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          snapshotVersion: 2,
          sessions: [{ ...session, phase: 'stopping', desiredState: 'stopped' }],
        },
      });
    });
    expect((screen.getByRole('button', { name: '删除记录' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          snapshotVersion: 3,
          sessions: [{ ...session, phase: 'idle', desiredState: 'stopped' }],
        },
      });
    });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: '删除记录' }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    expect(screen.queryByText('翻译进行中，停止后才能删除这条记录。')).toBeNull();
  });

  it('refuses to delete when a translation of the record starts while the dialog is open', async () => {
    const snapshot = makeSnapshot();
    start(snapshot);
    fireEvent.click(await screen.findByRole('button', { name: '删除记录' }));
    const dialog = await screen.findByRole('dialog');
    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: { ...snapshot, snapshotVersion: 2, sessions: [makeSession({ recordId })] },
      });
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除记录' }));
    expect(
      await screen.findByText('翻译进行中，停止后才能删除这条记录。', { selector: 'span' }),
    ).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(await loadTranscript(recordId)).toBeDefined();
    expect(screen.getAllByText('记录中的视频标题').length).toBeGreaterThan(0);
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
  it('blocks editing during a focus-triggered reload instead of losing new input', async () => {
    start();
    await screen.findByDisplayValue('已有笔记');
    const before = notes.getNote.mock.calls.length;
    let release!: (value: unknown) => void;
    notes.getNote.mockResolvedValueOnce({
      videoId: VIDEO_ID,
      text: '其他页面的新版本',
      updatedAt: 2,
    });
    notes.getNote.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    act(() => window.dispatchEvent(new Event('focus')));
    await waitFor(() => expect(notes.getNote.mock.calls.length).toBe(before + 2));
    expect(screen.queryByLabelText('视频笔记')).toBeNull();
    expect(screen.getByText('正在读取笔记…')).toBeTruthy();
    await act(async () => release({ videoId: VIDEO_ID, text: '其他页面的新版本', updatedAt: 2 }));
    const area = (await screen.findByLabelText('视频笔记')) as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: '读取完成后继续编辑' } });
    await waitFor(() =>
      expect(notes.saveNoteChecked).toHaveBeenLastCalledWith(VIDEO_ID, '读取完成后继续编辑', 2),
    );
    expect(area.value).toBe('读取完成后继续编辑');
  });
});

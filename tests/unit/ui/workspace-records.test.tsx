// @vitest-environment happy-dom
/**
 * 工作台记录列表：实时会话变化时去抖重新读取，迟到的旧读取结果不覆盖新列表。
 * listTranscriptSummaries 由测试控制完成顺序。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { RECORD_SCHEMA_VERSION, resetDbForTests, transcriptRecordId } from '@src/storage/db';
import type * as Transcripts from '@src/storage/transcripts';
import type { TranscriptSummary } from '@src/storage/transcripts';
import { WorkspaceApp } from '@src/ui/workspace/WorkspaceApp';
import { makeSession, makeSnapshot, TAB_ID } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

// 界面语言跟随浏览器（快照中 uiLocale 默认 auto）：本文件的断言使用中文界面。
beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue('zh-CN');
});

const lists = vi.hoisted(() => ({
  reads: [] as { resolve(list: TranscriptSummary[]): void }[],
}));

vi.mock('@src/storage/transcripts', async (importOriginal) => ({
  ...(await importOriginal<typeof Transcripts>()),
  listTranscriptSummaries: vi.fn(
    () =>
      new Promise<TranscriptSummary[]>((resolve) => {
        lists.reads.push({ resolve });
      }),
  ),
}));

vi.mock('@src/storage/notes', () => ({
  NoteConflictError: class NoteConflictError extends Error {},
  saveNoteChecked: vi.fn(),
  getNote: vi.fn(async () => undefined),
  saveNote: vi.fn(),
}));

const VIDEO = 'yyyyyyyyyyy';
const RECORD = transcriptRecordId(VIDEO, 'zh-CN', 'asr');

function summary(title: string): TranscriptSummary {
  return {
    recordId: RECORD,
    videoId: VIDEO,
    title,
    targetLanguage: 'zh-CN',
    sourceLanguage: 'en',
    sourceMode: 'asr',
    sourceKey: 'asr',
    lastSessionId: 'session-live-0001',
    cueCount: 3,
    coverage: { complete: false, ranges: [], gaps: [] },
    schemaVersion: RECORD_SCHEMA_VERSION,
    createdAt: 1,
    updatedAt: 2,
  };
}

function session(sessionId: string, ended = false) {
  return makeSession({
    identity: {
      sessionId,
      tabId: TAB_ID,
      documentId: 'doc-1',
      videoId: VIDEO,
      epoch: 0,
      configRevision: 1,
    },
    recordId: RECORD,
    sourceMode: 'asr',
    sourceTrack: undefined,
    ...(ended ? { phase: 'idle' as const, desiredState: 'stopped' as const } : {}),
  });
}

let worker: FakeWorker;
let version = 1;
const base = makeSnapshot();

function emit(sessions: AppSnapshot['sessions']) {
  version++;
  act(() => {
    worker.emit({ type: 'snapshot', snapshot: { ...base, snapshotVersion: version, sessions } });
  });
}

beforeEach(async () => {
  await resetDbForTests();
  globalThis.indexedDB = new IDBFactory();
  lists.reads = [];
  version = 1;
  window.history.replaceState({}, '', '/workspace.html');
  worker = createFakeWorker(base);
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
});

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
  await resetDbForTests();
});

it('re-reads the list after a live session appears, and a late older read does not overwrite it', async () => {
  render(<WorkspaceApp />);
  await waitFor(() => expect(lists.reads).toHaveLength(1));
  await screen.findByText('正在读取…');

  emit([session('session-live-0001')]);
  await waitFor(() => expect(lists.reads).toHaveLength(2));
  await act(async () => lists.reads[1]!.resolve([summary('新读取的记录')]));
  expect(await screen.findByText(/部分字幕 · 3 条/)).toBeTruthy();

  // 挂载时的第一次读取迟到：结果已过时，不能覆盖更新的列表。
  await act(async () => lists.reads[0]!.resolve([]));
  expect(screen.getByText(/部分字幕 · 3 条/)).toBeTruthy();
  expect(screen.getAllByText('新读取的记录').length).toBeGreaterThan(0);
  expect(screen.queryByText('实时会话 · 尚未保存为本地记录')).toBeNull();
});

it('debounces bursts of session changes into one re-read, including A→B→A', async () => {
  render(<WorkspaceApp />);
  await waitFor(() => expect(lists.reads).toHaveLength(1));
  await act(async () => lists.reads[0]!.resolve([]));
  expect(await screen.findByText('暂无字幕记录')).toBeTruthy();

  // 会话开始后很快停止并从快照中移除（实时集合回到原值）：仍需重新读取，因为会话可能已写入记录；
  // 重新读取完成前保留条目。
  emit([session('session-live-0001')]);
  emit([]);
  expect(screen.getByText('翻译已结束 · 正在读取本地记录…')).toBeTruthy();
  await new Promise((r) => setTimeout(r, 450));
  expect(lists.reads).toHaveLength(2);
  await act(async () => lists.reads[1]!.resolve([summary('会话写入的记录')]));
  expect(await screen.findByText(/部分字幕 · 3 条/)).toBeTruthy();
  expect(screen.queryByText('翻译已结束 · 正在读取本地记录…')).toBeNull();

  // 同一记录的新会话开始、以 ended 快照结束：去抖后只读取一次。
  emit([session('session-live-0002')]);
  emit([session('session-live-0002', true)]);
  await new Promise((r) => setTimeout(r, 450));
  expect(lists.reads).toHaveLength(3);

  // 会话的其他字段变化（例如进度与更新时间）不触发重新读取。
  emit([session('session-live-0003')]);
  await new Promise((r) => setTimeout(r, 450));
  expect(lists.reads).toHaveLength(4);
  emit([{ ...session('session-live-0003'), updatedAt: 99, cueVersion: 7 }]);
  emit([{ ...session('session-live-0003'), updatedAt: 120, cueVersion: 9 }]);
  await new Promise((r) => setTimeout(r, 450));
  expect(lists.reads).toHaveLength(4);
});

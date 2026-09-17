// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FavoriteRecord } from '@src/storage/db';
import { ToastProvider } from '@src/ui/components/toast';
import { PanelView } from '@src/ui/sidepanel/SidePanelApp';
import { TranscriptView } from '@src/ui/transcript/TranscriptView';
import { UiClientProvider } from '@src/ui/state/hooks';
import { ReposProvider, type UiRepos } from '@src/ui/state/repos';
import { cuesCopyText } from '@src/ui/transcript/text';
import { makeCue, makePage, makeSession, makeSnapshot, TAB_ID, VIDEO_ID } from './fixtures';
import { StaticClient } from './static-client';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function memoryRepos(): UiRepos & { store: Map<string, FavoriteRecord> } {
  const store = new Map<string, FavoriteRecord>();
  return {
    store,
    favorites: {
      listByRecord: async (recordId) => [...store.values()].filter((f) => f.recordId === recordId),
      set: async (input, favorited) => {
        const id = `${input.recordId}|${input.cueId}`;
        if (favorited) store.set(id, { ...input, favoriteId: id, schemaVersion: 1, createdAt: 1 });
        else store.delete(id);
        return favorited;
      },
    },
    transcripts: { listByVideo: async () => [] },
  };
}

function setup() {
  return setupWithRepos(memoryRepos());
}

function setupWithRepos(repos: ReturnType<typeof memoryRepos>) {
  const session = makeSession({
    sourceMode: 'asr',
    sourceTrack: undefined,
    recordId: `${VIDEO_ID}|zh-CN|asr`,
    coverage: {
      complete: false,
      ranges: [{ startMs: 0, endMs: 60_000 }],
      gaps: [],
      durationMs: 600_000,
    },
  });
  const snapshot = makeSnapshot({ pages: [makePage()], sessions: [session] });
  const client = new StaticClient({ connection: 'connected', snapshot, reconnectAttempts: 0 });
  client.cuesState = {
    sessionId: session.identity.sessionId,
    status: 'ready',
    cueVersion: 3,
    cues: [
      makeCue('a', 1_000, { source: 'asr', sourceText: 'hello world', translatedText: '你好世界' }),
      makeCue('b', 4_000, {
        source: 'asr',
        sourceText: 'second <b>line</b>',
        translatedText: '第二句 <b>行</b>',
      }),
      makeCue('c', 8_000, {
        source: 'asr',
        sourceText: 'pending one',
        translatedText: undefined,
        translationState: 'pending',
      }),
      makeCue('d', 12_000, {
        source: 'asr',
        sourceText: 'still speaking',
        stability: 'interim',
        translatedText: undefined,
        translationState: 'pending',
      }),
    ],
  };
  render(
    <ToastProvider>
      <UiClientProvider client={client}>
        <ReposProvider repos={repos}>
          <PanelView activeTab={{ loading: false, tab: { tabId: TAB_ID, windowId: 1 } }} />
        </ReposProvider>
      </UiClientProvider>
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
  return { client, repos, session };
}

describe('transcript tab', () => {
  it('subscribes to live cues, renders text safely, and labels ASR coverage as partial', async () => {
    const { client, session } = setup();
    expect(client.cueSubscriptions).toContain(session.identity.sessionId);
    const list = await screen.findByRole('list', { name: '字幕列表' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(4);
    // HTML 以文本显示，不会生成元素
    expect(within(list).getByText('第二句 <b>行</b>')).toBeTruthy();
    expect(list.querySelector('b')).toBeNull();
    expect(screen.getByText(/部分字幕（非全视频，语音识别）/)).toBeTruthy();
    expect(within(list).getAllByText('等待翻译')).toHaveLength(2);
    expect(within(list).getByText('临时识别')).toBeTruthy();
  });

  it('seeks the source tab when a time is clicked', async () => {
    const { client } = setup();
    fireEvent.click(await screen.findByRole('button', { name: '跳转到 0:04' }));
    await waitFor(() =>
      expect(client.sent).toContainEqual({ kind: 'player/seek', tabId: TAB_ID, timeMs: 4_000 }),
    );
  });

  it('searches, toggles favorites and filters to favorites only', async () => {
    const { repos, session } = setup();
    // 收藏列表读取完成前按钮不可用
    await waitFor(() =>
      expect(
        (screen.getByRole('button', { name: '收藏 0:01 字幕' }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole('button', { name: '收藏 0:01 字幕' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '取消收藏 0:01 字幕' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect([...repos.store.keys()]).toEqual([`${VIDEO_ID}|zh-CN|asr|a`]);
    expect(session.identity.videoId).toBe(VIDEO_ID);

    fireEvent.click(screen.getByRole('button', { name: '只看收藏' }));
    expect(
      within(screen.getByRole('list', { name: '字幕列表' })).getAllByRole('listitem'),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '显示全部字幕' }));

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索字幕' }), {
      target: { value: '第二' },
    });
    expect(
      within(screen.getByRole('list', { name: '字幕列表' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('shows the export dialog with real coverage and counts, and downloads without the downloads API', async () => {
    setup();
    const createObjectURL = vi.fn(() => 'blob:test');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL: revoke });
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicks.push(this.download);
    });

    fireEvent.click(await screen.findByRole('button', { name: '导出字幕' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/部分字幕（非全视频，语音识别）/)).toBeTruthy();
    const stats = within(dialog).getByRole('list', { name: '导出统计' });
    // 双语默认标记未翻译（c），临时结果（d）默认排除
    expect(within(stats).getByText('导出 3 条')).toBeTruthy();
    expect(within(stats).getByText('未完成翻译已标记 1 条')).toBeTruthy();
    expect(within(stats).getByText('临时识别结果已排除 1 条')).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('内容'), { target: { value: 'translation' } });
    expect(within(stats).getByText('导出 2 条')).toBeTruthy();
    expect(within(stats).getByText('未完成翻译已排除 1 条')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'VTT' }));
    const preview = within(dialog).getByLabelText('导出内容预览') as HTMLTextAreaElement;
    expect(preview.value.startsWith('WEBVTT')).toBe(true);
    expect(preview.value).toContain('第二句 &lt;b&gt;行&lt;/b&gt;');

    fireEvent.click(within(dialog).getByRole('button', { name: '下载 VTT' }));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicks).toEqual(['真实视频标题.zh-CN.vtt']);
  });

  it('disables favorites when the snapshot has no recordId (no locally built key)', async () => {
    cleanup();
    const session = makeSession({ recordId: undefined });
    const client = new StaticClient({
      connection: 'connected',
      snapshot: makeSnapshot({ pages: [makePage()], sessions: [session] }),
      reconnectAttempts: 0,
    });
    client.cuesBySession.set(session.identity.sessionId, [makeCue('a', 1_000)]);
    render(
      <ToastProvider>
        <UiClientProvider client={client}>
          <ReposProvider repos={memoryRepos()}>
            <PanelView activeTab={{ loading: false, tab: { tabId: TAB_ID, windowId: 1 } }} />
          </ReposProvider>
        </UiClientProvider>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
    const button = await screen.findByRole('button', { name: '收藏 0:01 字幕' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('字幕记录尚未确定，暂不能收藏')).toBeTruthy();
  });

  it('marks interim cues when copying', () => {
    expect(cuesCopyText([makeCue('i', 0, { stability: 'interim' })], 'bilingual')).toBe(
      '[0:00] [临时] 译文 i\nsource i',
    );
  });

  it('counts only favorites present in the current record and offers a BOM download', async () => {
    const { repos } = setup();
    repos.store.set('x', {
      favoriteId: 'x',
      recordId: `${VIDEO_ID}|zh-CN|asr`,
      videoId: VIDEO_ID,
      cueId: 'gone',
      startMs: 0,
      endMs: 1,
      sourceText: 'old',
      schemaVersion: 1,
      createdAt: 1,
    });
    // 重新挂载以读取收藏
    cleanup();
    setupWithRepos(repos);
    const blobs: Blob[] = [];
    Object.assign(URL, {
      createObjectURL: (b: Blob) => {
        blobs.push(b);
        return 'blob:x';
      },
      revokeObjectURL: () => undefined,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    fireEvent.click(await screen.findByRole('button', { name: '导出字幕' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() =>
      expect(within(dialog).getByRole('option', { name: '仅收藏（0 条）' })).toBeTruthy(),
    );
    expect(within(dialog).getByText('收藏中 1 条已不在当前记录，导出时不会包含。')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /UTF-8 带 BOM/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: '下载 SRT' }));
    const text = await blobs[0]!.text();
    expect(text.charCodeAt(0)).toBe(0xfeff);
  });

  it('disables favorites until the list has loaded, so a late read cannot overwrite a toggle', async () => {
    cleanup();
    let resolveList!: (v: FavoriteRecord[]) => void;
    const set = vi.fn(async (_input: unknown, favorited: boolean) => favorited);
    const repos: UiRepos = {
      favorites: { listByRecord: () => new Promise((r) => (resolveList = r)), set },
      transcripts: { listByVideo: async () => [] },
    };
    render(
      <ToastProvider>
        <UiClientProvider
          client={
            new StaticClient({
              connection: 'connected',
              snapshot: makeSnapshot(),
              reconnectAttempts: 0,
            })
          }
        >
          <ReposProvider repos={repos}>
            <TranscriptView
              cues={[makeCue('a', 1_000)]}
              source={{
                kind: 'record',
                recordId: 'rec-1',
                videoId: VIDEO_ID,
                targetLanguage: 'zh-CN',
                sourceLanguage: 'en',
                sourceMode: 'full-track',
              }}
            />
          </ReposProvider>
        </UiClientProvider>
      </ToastProvider>,
    );
    const button = screen.getByRole('button', { name: '收藏 0:01 字幕' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(set).not.toHaveBeenCalled();
    await act(async () => resolveList([]));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ cueId: 'a' }), true),
    );
  });
});

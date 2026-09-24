// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ToastProvider, useToast } from '@src/ui/components/toast';
import { Dialog } from '@src/ui/components/layout';
import { AppError } from '@src/domain/errors';
import { CONTENT_WAKE_MESSAGE_TYPE } from '@src/messaging/wake';
import { resetPageWakeForTests } from '@src/ui/state/page-wake';
import { PanelView, SidePanelApp } from '@src/ui/sidepanel/SidePanelApp';
import type { ActiveTabState } from '@src/ui/state/active-tab';
import { UiClientProvider } from '@src/ui/state/hooks';
import { ReposProvider, type UiRepos } from '@src/ui/state/repos';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { makePage, makeSession, makeSnapshot, TAB_ID } from './fixtures';
import { StaticClient } from './static-client';

const memoryRepos: UiRepos = {
  favorites: { listByRecord: async () => [], set: async (_input, favorited) => favorited },
  transcripts: { listByVideo: async () => [] },
};

const videoTab: ActiveTabState = { loading: false, tab: { tabId: TAB_ID, windowId: 1 } };
const otherTab: ActiveTabState = {
  loading: false,
  tab: { tabId: 999, windowId: 1, url: 'https://example.com/' },
};

function renderPanel(client: StaticClient, activeTab: ActiveTabState = videoTab) {
  return render(
    <ToastProvider>
      <UiClientProvider client={client}>
        <ReposProvider repos={memoryRepos}>
          <PanelView activeTab={activeTab} onEnterDemo={() => undefined} />
        </ReposProvider>
      </UiClientProvider>
    </ToastProvider>,
  );
}

function connected(snapshot: AppSnapshot) {
  return { connection: 'connected' as const, snapshot, reconnectAttempts: 0 };
}

// 界面语言跟随浏览器（快照中 uiLocale 默认 auto）：本文件的断言使用中文界面。
beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue('zh-CN');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('side panel states', () => {
  it('shows continuous original silence by default and reveals mixing controls only when explicitly selected', async () => {
    const snapshot = makeSnapshot({ pages: [makePage()] }, { outputMode: 'subtitle-voice' });
    const client = new StaticClient(connected(snapshot), {
      'tts/voices': () => ({ voices: [{ voiceName: 'Tingting', lang: 'zh-CN' }] }),
      'settings/update': () => ({ persisted: true }),
    });
    renderPanel(client);
    expect(screen.getByRole('button', { name: '全程静音' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.queryByLabelText('原声音量')).toBeNull();
    expect(screen.queryByText('配音时自动降低原声')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '保留原声' }));
    await waitFor(() =>
      expect(client.sent).toContainEqual({
        kind: 'settings/update',
        patch: { audio: { originalMode: 'mix' } },
      }),
    );
    act(() =>
      client.setState(
        connected(
          makeSnapshot(
            { pages: [makePage()] },
            { outputMode: 'subtitle-voice', audio: { originalMode: 'mix' } },
          ),
        ),
      ),
    );
    expect(screen.getByLabelText('原声音量')).toBeTruthy();
    expect(screen.getByText('配音时自动降低原声')).toBeTruthy();
  });
  it('shows a connecting state before the first snapshot', () => {
    renderPanel(
      new StaticClient({ connection: 'connecting', snapshot: null, reconnectAttempts: 0 }),
    );
    expect(screen.getAllByText('正在连接后台服务…').length).toBeGreaterThan(0);
    expect(screen.getAllByText('正在连接').length).toBeGreaterThan(0);
    expect(screen.queryByText('运行中')).toBeNull();
  });

  it('shows reconnecting banner while keeping the last snapshot', () => {
    renderPanel(
      new StaticClient({
        connection: 'reconnecting',
        snapshot: makeSnapshot({ pages: [makePage()] }),
        reconnectAttempts: 2,
      }),
    );
    expect(screen.getByText('正在重新连接后台服务，下方显示的可能不是最新状态。')).toBeTruthy();
    expect((screen.getByRole('button', { name: /开始翻译/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('shows the non-YouTube empty state and the unconfigured hint without any demo data', () => {
    const snapshot = makeSnapshot(
      {
        credential: { configured: false, generation: 1, storage: 'none' },
        hostPermission: { granted: false },
      },
      {},
    );
    renderPanel(new StaticClient(connected(snapshot)), otherTab);
    expect(screen.getByText('当前标签不是 YouTube 视频页')).toBeTruthy();
    expect(screen.getByText('尚未配置翻译服务')).toBeTruthy();
    expect(screen.getAllByText('未配置服务').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toMatch(/演示|示例/);
  });

  it('shows real video info, progress numbers from the snapshot and separate pause/stop commands', async () => {
    const session = makeSession({ player: undefined });
    const snapshot = makeSnapshot({ pages: [makePage()], sessions: [session] });
    const client = new StaticClient(connected(snapshot));
    renderPanel(client);

    fireEvent.click(screen.getByText('播放与翻译详情'));

    expect(screen.getByText('真实视频标题')).toBeTruthy();
    expect(screen.getAllByText('运行中').length).toBeGreaterThan(0);
    expect(screen.getByText('视频播放中')).toBeTruthy();
    expect(screen.getByText('4 / 10')).toBeTruthy();
    expect(screen.getByText('最近一次请求往返').nextSibling?.textContent).toBe('未知');

    fireEvent.click(screen.getByRole('button', { name: '暂停翻译' }));
    fireEvent.click(screen.getByRole('button', { name: '停止并释放音频' }));
    await waitFor(() =>
      expect(client.sent).toEqual([
        { kind: 'session/pause', tabId: TAB_ID, sessionId: session.identity.sessionId },
        { kind: 'session/stop', tabId: TAB_ID, sessionId: session.identity.sessionId },
      ]),
    );
  });

  it('shows the player paused state independently from the translation state', () => {
    const snapshot = makeSnapshot({
      pages: [makePage({ player: { ...makePage().player!, paused: true } })],
      sessions: [makeSession()],
    });
    renderPanel(new StaticClient(connected(snapshot)));
    expect(screen.getByText('视频已暂停')).toBeTruthy();
    expect(screen.getByRole('button', { name: '暂停翻译' })).toBeTruthy();
  });

  it('shows start failures with an actionable next step and allows restarting', () => {
    const session = makeSession({
      phase: 'error',
      desiredState: 'stopped',
      error: {
        code: 'auth',
        category: 'auth',
        retryable: false,
        message: 'API Key 无效，请在设置中重新填写。',
      },
      notice: {
        code: 'no-captions',
        level: 'warning',
        message: '此视频没有可读字幕，需配置语音识别服务',
      },
    });
    const client = new StaticClient(
      connected(makeSnapshot({ pages: [makePage()], sessions: [session] })),
    );
    renderPanel(client);
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText('API Key 无效，请在设置中重新填写。')).toBeTruthy();
    expect(within(alert).getByRole('button', { name: '检查设置' })).toBeTruthy();
    expect(screen.getByText('此视频没有可读字幕，需配置语音识别服务')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新开始翻译' }));
    expect(client.sent).toEqual([{ kind: 'session/start', tabId: TAB_ID }]);
  });

  it('degrades to subtitles when no voice matches the target language', async () => {
    const snapshot = makeSnapshot(
      { pages: [makePage()], sessions: [makeSession({ targetLanguage: 'ko' })] },
      {
        provider: { baseUrl: 'https://api.example.com' },
        targetLanguage: 'ko',
        outputMode: 'subtitle-voice',
      },
    );
    const client = new StaticClient(connected(snapshot), {
      'tts/voices': () => ({ voices: [{ voiceName: 'Samantha', lang: 'en-US' }] }),
    });
    renderPanel(client);
    await waitFor(() =>
      expect(screen.getAllByText(/系统没有可用的「한국어」声音/).length).toBeGreaterThan(0),
    );
    expect((screen.getByRole('button', { name: '试听' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('warns when a settings change is applied but not persisted', async () => {
    const client = new StaticClient(connected(makeSnapshot({ pages: [makePage()] })), {
      'settings/update': () => ({ persisted: false }),
    });
    renderPanel(client);
    fireEvent.change(screen.getByLabelText('翻译为'), { target: { value: 'ja' } });
    await waitFor(() => expect(screen.getByText(/仅本次生效，保存失败/)).toBeTruthy());
    expect(client.sent).toEqual([{ kind: 'settings/update', patch: { targetLanguage: 'ja' } }]);
  });

  it('supports tablist keyboard navigation', () => {
    renderPanel(new StaticClient(connected(makeSnapshot({ pages: [makePage()] }))));
    const tabs = screen.getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    fireEvent.keyDown(tabs[0]!, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '字幕' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      'panel-tab-transcript',
    );
    fireEvent.keyDown(screen.getByRole('tab', { name: '字幕' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: '设置' }).getAttribute('aria-selected')).toBe('true');
  });

  it('keeps prefetch enabled for buffered playback and restores the saved continuous-mode choice', async () => {
    const client = new StaticClient(
      connected(
        makeSnapshot({ pages: [makePage()] }, { playbackMode: 'buffered', prefetch: false }),
      ),
      { 'settings/update': () => ({ persisted: true }) },
    );
    renderPanel(client);
    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    const prefetch = screen.getByRole('switch', { name: '预翻译后续字幕' }) as HTMLInputElement;
    expect(prefetch.checked).toBe(true);
    expect(prefetch.disabled).toBe(true);
    expect(client.sent).toEqual([{ kind: 'tts/voices' }]);

    act(() =>
      client.setState(
        connected(
          makeSnapshot({ pages: [makePage()] }, { playbackMode: 'continuous', prefetch: false }),
        ),
      ),
    );
    expect(prefetch.checked).toBe(false);
    expect(prefetch.disabled).toBe(false);
    fireEvent.click(prefetch);
    await waitFor(() =>
      expect(client.sent).toEqual([
        { kind: 'tts/voices' },
        { kind: 'settings/update', patch: { prefetch: true } },
      ]),
    );
  });
});

describe('demo mode', () => {
  it('shows a persistent demo label, sends no UiCommand, and exits back to the real state', async () => {
    const posted: unknown[] = [];
    vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(
      () =>
        ({
          name: 'tongting:ui',
          postMessage: (m: unknown) => posted.push(m),
          disconnect: () => undefined,
          onMessage: { addListener: () => undefined, removeListener: () => undefined },
          onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
        }) as never,
    );
    window.history.replaceState({}, '', '/sidepanel.html?demo=1');
    try {
      render(<SidePanelApp />);
      expect(screen.getByText('演示模式 · 示例数据，不连接视频与服务')).toBeTruthy();
      expect(screen.getByText('示例视频：留意身边的小细节（演示）')).toBeTruthy();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: '暂停翻译' }));
      });
      await waitFor(() => expect(screen.getByRole('button', { name: '继续翻译' })).toBeTruthy());
      // 演示期间标识始终可见（切换标签后仍在）
      fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
      expect(screen.getByText('演示模式 · 示例数据，不连接视频与服务')).toBeTruthy();
      expect(posted.filter((m) => (m as { type?: string }).type === 'command')).toEqual([]);

      fireEvent.click(screen.getByRole('button', { name: '退出演示' }));
      expect(screen.queryByText('演示模式 · 示例数据，不连接视频与服务')).toBeNull();
      expect(screen.queryByText('示例视频：留意身边的小细节（演示）')).toBeNull();
      expect(screen.getAllByText('正在连接后台服务…').length).toBeGreaterThan(0);
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });
});

describe('review fixes', () => {
  it('shows a running-session auth error and never reports 运行中', () => {
    const message = 'API Key 无效（401），请在设置中检查。';
    const session = makeSession({
      phase: 'running',
      error: { code: 'http-401', category: 'auth', retryable: false, message },
    });
    renderPanel(
      new StaticClient(connected(makeSnapshot({ pages: [makePage()], sessions: [session] }))),
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(within(alert).getByRole('button', { name: '检查设置' })).toBeTruthy();
    expect(screen.queryByText('运行中')).toBeNull();
    expect(screen.getAllByText('翻译受阻').length).toBeGreaterThan(0);
  });

  it('shows translation.blockedError while running', () => {
    const session = makeSession({
      translation: {
        total: 10,
        done: 0,
        pending: 10,
        running: 0,
        failed: 0,
        blockedError: {
          code: 'quota',
          category: 'quota',
          retryable: false,
          message: '余额不足，翻译已停止发送请求。',
        },
      },
    });
    renderPanel(
      new StaticClient(connected(makeSnapshot({ pages: [makePage()], sessions: [session] }))),
    );
    expect(
      within(screen.getByRole('alert')).getByText('余额不足，翻译已停止发送请求。'),
    ).toBeTruthy();
  });

  it('shows a paused capture-not-allowed error with gesture guidance', () => {
    const message = '继续翻译需要重新获取标签页音频。';
    const session = makeSession({
      phase: 'paused',
      desiredState: 'paused',
      sourceMode: 'asr',
      sourceTrack: undefined,
      error: { code: 'capture-not-allowed', category: 'capture', retryable: true, message },
    });
    renderPanel(
      new StaticClient(connected(makeSnapshot({ pages: [makePage()], sessions: [session] }))),
    );
    const alert = screen.getByRole('alert');
    expect(within(alert).getByText(message)).toBeTruthy();
    expect(
      within(alert).getByText(/点击浏览器工具栏中的译听图标，或按 Alt\+T 后再继续/),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续翻译' })).toBeTruthy();
  });

  it('treats an error snapshot as ended: no stop/retry, transcript shows saved records', async () => {
    const session = makeSession({
      phase: 'error',
      desiredState: 'stopped',
      translation: { total: 3, done: 1, pending: 0, running: 0, failed: 2 },
      error: { code: 'config', category: 'config', retryable: false, message: '已停止' },
    });
    const client = new StaticClient(
      connected(makeSnapshot({ pages: [makePage()], sessions: [session] })),
    );
    renderPanel(client);
    expect(screen.queryByRole('button', { name: '停止并释放音频' })).toBeNull();
    expect(screen.queryByRole('button', { name: /重试失败的/ })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
    expect(await screen.findByText('还没有这个视频的字幕')).toBeTruthy();
    expect(client.cueSubscriptions).toEqual([]);
  });

  it('maps notice codes to actions and uses the 另一个标签页正在翻译 wording', () => {
    const session = makeSession({
      notice: {
        code: 'incremental-captions',
        level: 'warning',
        message: '只能读取当前显示的字幕。',
      },
    });
    renderPanel(
      new StaticClient(
        connected(
          makeSnapshot({
            pages: [makePage()],
            sessions: [session],
            audioOwner: { tabId: 7, sessionId: 'session-other-001' },
          }),
        ),
      ),
    );
    const notice = screen.getByText('只能读取当前显示的字幕。').closest('[role="status"]')!;
    expect(within(notice as HTMLElement).queryByRole('button', { name: '打开设置' })).toBeNull();
    expect(screen.getByText(/另一个标签页正在翻译/)).toBeTruthy();
  });

  it('offers full-track backfill in the live transcript and sends it for the current session', async () => {
    const seen: unknown[] = [];
    const client = new StaticClient(
      connected(makeSnapshot({ pages: [makePage()], sessions: [makeSession()] })),
      {
        'session/backfill': (command) => {
          seen.push(command);
          return { enabled: true };
        },
      },
    );
    renderPanel(client);
    fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
    expect(await screen.findByText(/翻译全片后可导出完整译文/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '翻译全片' }));
    await waitFor(() =>
      expect(seen).toContainEqual(
        expect.objectContaining({ kind: 'session/backfill', enabled: true }),
      ),
    );
  });

  it('shows 状态已变化，已刷新 instead of an error for stale-session', async () => {
    const client = new StaticClient(
      connected(makeSnapshot({ pages: [makePage()], sessions: [makeSession()] })),
      {
        'session/pause': () => {
          throw new AppError({
            code: 'stale-session',
            category: 'internal',
            retryable: true,
            message: 'stale',
          });
        },
      },
    );
    renderPanel(client);
    fireEvent.click(screen.getByRole('button', { name: '暂停翻译' }));
    expect(await screen.findByText('状态已变化，已刷新。')).toBeTruthy();
    expect(screen.queryByText('无法暂停翻译：stale')).toBeNull();
  });

  it('wakes the content script and shows 正在连接页面… before judging the tab', async () => {
    resetPageWakeForTests();
    const send = vi.spyOn(fakeBrowser.tabs, 'sendMessage').mockResolvedValue(undefined as never);
    renderPanel(new StaticClient(connected(makeSnapshot())), {
      loading: false,
      tab: { tabId: 55, windowId: 1 },
    });
    expect(await screen.findByText('正在连接页面…')).toBeTruthy();
    expect(send).toHaveBeenCalledWith(55, { type: CONTENT_WAKE_MESSAGE_TYPE });
    expect(
      await screen.findByText('当前标签不是 YouTube 视频页', {}, { timeout: 3_000 }),
    ).toBeTruthy();
    // 新标签页激活时内容脚本尚未注入：页面加载完成时再唤醒一次（绕过节流）。
    const before = send.mock.calls.length;
    await fakeBrowser.tabs.onUpdated.trigger(55, { status: 'complete' }, { id: 55 } as never);
    await waitFor(() => expect(send.mock.calls.length).toBeGreaterThan(before));
  });

  it('keeps toasts visible inside an open dialog', async () => {
    renderPanel(
      new StaticClient(connected(makeSnapshot({ pages: [makePage()], sessions: [makeSession()] }))),
    );
    fireEvent.click(screen.getByRole('tab', { name: '字幕' }));
    // 无字幕时导出按钮禁用：直接渲染一个打开的对话框验证提示区域位置
    cleanup();
    const { container } = render(
      <ToastProvider>
        <Dialog open title="测试" onClose={() => undefined}>
          <NotifyButton />
        </Dialog>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '提示' }));
    const dialog = container.ownerDocument.querySelector('dialog')!;
    expect(await within(dialog as HTMLElement).findByText('对话框内提示')).toBeTruthy();
  });
});

function NotifyButton() {
  const notify = useToast();
  return (
    <button type="button" onClick={() => notify('对话框内提示')}>
      提示
    </button>
  );
}

it('saves the prototype connection form and preserves edits made during the request', async () => {
  let resolveSave!: (value: unknown) => void;
  const client = new StaticClient(connected(makeSnapshot({ pages: [makePage()] })), {
    'settings/update': () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    'credentials/set': () => ({ persisted: false, storage: 'none' }),
  });
  renderPanel(client);
  fireEvent.click(screen.getByRole('tab', { name: '设置' }));
  const address = screen.getByLabelText('sub2api 服务地址') as HTMLInputElement;
  const key = screen.getByLabelText('API Key') as HTMLInputElement;
  fireEvent.change(address, { target: { value: 'https://first.example.com/v1' } });
  fireEvent.change(key, { target: { value: 'sk-first' } });
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  expect((screen.getByRole('button', { name: '保存连接设置' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.change(address, { target: { value: 'https://next.example.com/v1' } });
  fireEvent.change(key, { target: { value: 'sk-next' } });
  await act(async () => resolveSave({ persisted: true }));
  expect(address.value).toBe('https://next.example.com/v1');
  expect(key.value).toBe('sk-next');
  expect(client.sent).toEqual([
    { kind: 'tts/voices' },
    { kind: 'settings/update', patch: { provider: { baseUrl: 'https://first.example.com/v1' } } },
    { kind: 'credentials/set', apiKey: 'sk-first', remember: true },
  ]);
  expect(await screen.findByText('Key 未能完整保存，请重试保存后再重新加载扩展。')).toBeTruthy();
});

it('retains the submitted key after a persistence failure and lets the user retry', async () => {
  let persisted = false;
  const client = new StaticClient(connected(makeSnapshot()), {
    'credentials/set': () => ({ persisted, storage: 'local' }),
  });
  renderPanel(client);
  fireEvent.click(screen.getByRole('tab', { name: '设置' }));
  const key = screen.getByLabelText('API Key') as HTMLInputElement;
  fireEvent.change(key, { target: { value: 'sk-retry-fake' } });
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  await screen.findByText('Key 未能完整保存，请重试保存后再重新加载扩展。');
  expect(key.value).toBe('sk-retry-fake');
  persisted = true;
  fireEvent.click(screen.getByRole('button', { name: '保存连接设置' }));
  await screen.findByText('Key 已保存在本机，重新加载扩展或重启浏览器后仍可使用。');
  expect(key.value).toBe('');
  expect(client.sent.filter((command) => command.kind === 'credentials/set')).toHaveLength(2);
});

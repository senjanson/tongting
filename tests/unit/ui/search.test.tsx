// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ToastProvider } from '@src/ui/components/toast';
import { PanelView } from '@src/ui/sidepanel/SidePanelApp';
import { UiClientProvider } from '@src/ui/state/hooks';
import { TARGET_LANGUAGES } from '@src/domain/languages';
import type { SearchRecord } from '@src/domain/search';
import { applySettingsPatch, type SettingsPatch } from '@src/domain/settings';
import * as clipboard from '@src/ui/shared/clipboard';
import { DemoClient } from '@src/ui/demo/demo-client';
import { StaticClient } from './static-client';
import { makeSnapshot } from './fixtures';
import { searchRecord, deferred } from '../../fixtures/search';

function setup(
  options: {
    generate?: () => unknown;
    history?: () => unknown;
    clear?: () => unknown;
    configured?: boolean;
    settings?: SettingsPatch;
  } = {},
) {
  const base = makeSnapshot(
    options.configured === false
      ? { credential: { configured: false, generation: 1, storage: 'none' } }
      : {},
  );
  const snapshot = options.settings
    ? { ...base, settings: applySettingsPatch(base.settings, options.settings) }
    : base;
  const client = new StaticClient(
    { connection: 'connected', snapshot, reconnectAttempts: 0 },
    {
      'search/history': options.history ?? (() => ({ records: [] })),
      'search/generate': options.generate ?? (() => ({ record: searchRecord, persisted: true })),
      'search/clear-history': options.clear ?? (() => ({ cleared: true })),
      // 模拟 worker：应用设置补丁并推送新快照。
      'settings/update': (command) => {
        if (command.kind !== 'settings/update') return undefined;
        const state = client.getState();
        client.setState({
          ...state,
          snapshot: {
            ...state.snapshot!,
            settings: applySettingsPatch(state.snapshot!.settings, command.patch),
          },
        });
        return { persisted: true };
      },
    },
  );
  render(
    <ToastProvider>
      <UiClientProvider client={client}>
        <PanelView
          activeTab={{
            loading: false,
            tab: { tabId: 3, windowId: 1, url: 'https://example.com/' },
          }}
          onEnterDemo={() => undefined}
        />
      </UiClientProvider>
    </ToastProvider>,
  );
  fireEvent.click(screen.getByRole('tab', { name: '搜索' }));
  return client;
}
function input(query = searchRecord.query) {
  fireEvent.change(screen.getByLabelText('你想在 YouTube 上找什么？'), {
    target: { value: query },
  });
}
async function generate() {
  input();
  fireEvent.click(screen.getByRole('button', { name: '生成英文搜索词' }));
  await screen.findByText(searchRecord.items[0]!.keyword);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('search sidebar A', () => {
  it('generates on a non-YouTube tab, edits a phrase and opens only the encoded YouTube search URL', async () => {
    const open = vi.spyOn(fakeBrowser.tabs, 'create').mockResolvedValue({} as never);
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    const client = setup();
    await generate();
    expect(screen.getAllByRole('article')).toHaveLength(3);
    expect(client.sent.filter((c) => c.kind === 'search/generate')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '编辑搜索词 1' }));
    // 搜索词与语言无关，只要求单行：换行的输入被拒绝。
    fireEvent.change(screen.getByLabelText('编辑英文搜索词'), {
      target: { value: 'first line\nsecond line' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('alert').textContent).toContain('单行搜索词');
    const edited = 'AI video editing & YouTube #tutorial';
    fireEvent.change(screen.getByLabelText('编辑英文搜索词'), { target: { value: edited } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByText('已编辑 · 中文注释对应原建议')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0]!);
    await screen.findByText('英文搜索词已复制。');
    expect(copy).toHaveBeenCalledWith(edited);
    fireEvent.click(screen.getAllByRole('button', { name: '搜索' })[0]!);
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({
        url: `https://www.youtube.com/results?search_query=${encodeURIComponent(edited)}`,
      }),
    );
  });

  it('keeps Chinese drafts when opening Settings, and blocks generation without credentials', async () => {
    const client = setup({ configured: false });
    input('我想找露营装备');
    expect(
      (screen.getByRole('button', { name: '生成英文搜索词' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    fireEvent.click(screen.getByRole('tab', { name: '搜索' }));
    expect((screen.getByLabelText('你想在 YouTube 上找什么？') as HTMLTextAreaElement).value).toBe(
      '我想找露营装备',
    );
    expect(client.sent.some((c) => c.kind === 'search/generate')).toBe(false);
    await act(async () => undefined);
  });

  it('prevents duplicate requests and ignores late results after cancellation and tab re-entry', async () => {
    const pending = deferred<{ record: SearchRecord; persisted: boolean }>();
    const client = setup({ generate: () => pending.promise });
    input();
    const form = screen.getByRole('button', { name: '生成英文搜索词' }).closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(client.sent.filter((c) => c.kind === 'search/generate')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    fireEvent.submit(form);
    fireEvent.click(screen.getByRole('tab', { name: '翻译' }));
    fireEvent.click(screen.getByRole('tab', { name: '搜索' }));
    await act(async () => pending.resolve({ record: searchRecord, persisted: true }));
    expect(screen.queryByText(searchRecord.items[0]!.keyword)).toBeNull();
    expect(client.sent.filter((c) => c.kind === 'search/cancel')).toHaveLength(2);
    expect(
      (screen.getByRole('button', { name: '生成英文搜索词' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('loads history without AI and preserves it if clear fails', async () => {
    const client = setup({
      history: () => ({ records: [searchRecord] }),
      clear: () => {
        throw new Error('disk');
      },
    });
    await waitFor(() => expect(document.querySelector('details button')).toBeTruthy());
    const details = document.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(searchRecord.query) }));
    expect(screen.getByText(searchRecord.items[0]!.keyword)).toBeTruthy();
    expect(client.sent.some((c) => c.kind === 'search/generate')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '清空历史记录' }));
    await screen.findByText('清空失败，历史记录仍保留，请重试。');
    expect(screen.getByRole('button', { name: new RegExp(searchRecord.query) })).toBeTruthy();
  });

  it('offers recovery for unreadable history and reports copy/open failures honestly', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(false);
    vi.spyOn(fakeBrowser.tabs, 'create').mockRejectedValue(new Error('blocked'));
    setup({
      history: () => {
        throw new Error('corrupted');
      },
    });
    await screen.findByText('最近生成记录未能读取，请稍后重新展开。');
    const details = document.querySelector('details')!;
    details.open = true;
    fireEvent.click(screen.getByRole('button', { name: '清空历史记录' }));
    await waitFor(() =>
      expect(screen.queryByText('最近生成记录未能读取，请稍后重新展开。')).toBeNull(),
    );
    await generate();
    fireEvent.click(screen.getAllByRole('button', { name: '复制' })[0]!);
    await screen.findByText('复制失败，请选中搜索词手动复制。');
    fireEvent.click(screen.getAllByRole('button', { name: '搜索' })[0]!);
    await screen.findByText('未能打开 YouTube 搜索，请重试或复制关键词。');
  });

  it('defaults to the target language and English, saves dropdown changes and updates the wording', async () => {
    const client = setup({ settings: { targetLanguage: 'ja' } });
    expect(screen.getByRole('heading', { name: '用日文，搜英文' })).toBeTruthy();
    const mine = screen.getByLabelText('我的语言') as HTMLSelectElement;
    const target = screen.getByLabelText('搜索语言') as HTMLSelectElement;
    expect(mine.value).toBe('ja');
    expect(target.value).toBe('en');
    expect(mine.options.length).toBe(TARGET_LANGUAGES.length);
    fireEvent.change(target, { target: { value: 'zh-TW' } });
    fireEvent.change(mine, { target: { value: 'zh-CN' } });
    expect(client.sent.filter((c) => c.kind === 'settings/update')).toEqual([
      { kind: 'settings/update', patch: { search: { keywordLanguage: 'zh-TW' } } },
      { kind: 'settings/update', patch: { search: { userLanguage: 'zh-CN' } } },
    ]);
    await screen.findByRole('heading', { name: '用简体中文，搜繁体中文' });
    expect(screen.getByRole('button', { name: '生成繁体中文搜索词' })).toBeTruthy();
    expect(
      screen.getByText('输入简体中文后，这里会显示繁体中文搜索词和简体中文注释。'),
    ).toBeTruthy();
    expect(screen.getByText('1 条原文直译 + 2 条简短搜索词')).toBeTruthy();
    fireEvent.change(target, { target: { value: 'zh-CN' } });
    await screen.findByRole('heading', { name: '用中文，搜中文' });
    expect(screen.getByText('1 条完整搜索句 + 2 条简短搜索词')).toBeTruthy();
    expect(screen.getByText('输入中文后，这里会显示优化后的搜索词和注释。')).toBeTruthy();
    fireEvent.change(mine, { target: { value: 'fr' } });
    await screen.findByRole('heading', { name: '用法文，搜中文' });
    expect(
      (screen.getByLabelText('你想在 YouTube 上找什么？') as HTMLTextAreaElement).placeholder,
    ).toContain('用法文描述');
  });

  it('sends the displayed languages with the request and labels results by their record languages', async () => {
    const record: SearchRecord = {
      ...searchRecord,
      userLanguage: 'en',
      keywordLanguage: 'ja',
      items: [
        {
          label: 'Direct translation',
          keyword: '初心者のAI動画編集',
          annotation: 'AI video editing for beginners',
        },
        { label: 'Tutorial', keyword: 'AI 動画編集 入門', annotation: 'Intro tutorial' },
        { label: 'Tools', keyword: 'AI 動画編集 ツール', annotation: 'Editing tools' },
      ],
    };
    const client = setup({
      settings: { search: { userLanguage: 'en', keywordLanguage: 'ja' } },
      generate: () => ({ record, persisted: true }),
    });
    input();
    fireEvent.click(screen.getByRole('button', { name: '生成日文搜索词' }));
    await screen.findByText('初心者のAI動画編集');
    expect(client.sent.find((c) => c.kind === 'search/generate')).toMatchObject({
      userLanguage: 'en',
      keywordLanguage: 'ja',
    });
    expect(screen.getByText('01 · Direct translation')).toBeTruthy();
    expect(screen.getByText('英文注释 · 可编辑')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成日文搜索词' })).toBeTruthy();
    // 切换语言后，旧结果标为「上次生成」并注明其语言，按钮不再是「重新生成」。
    fireEvent.change(screen.getByLabelText('搜索语言'), { target: { value: 'de' } });
    await screen.findByRole('button', { name: '生成德文搜索词' });
    expect(screen.getByText('上次生成')).toBeTruthy();
    expect(screen.getByText(`${searchRecord.query} · 英文 → 日文`)).toBeTruthy();
    expect(screen.getByRole('region', { name: '日文搜索词' })).toBeTruthy();
  });

  it('shows legacy history records as Chinese → English', async () => {
    setup({
      settings: { targetLanguage: 'en' },
      history: () => ({ records: [searchRecord] }),
    });
    const details = document.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(searchRecord.query) }));
    expect(screen.getByText(/中文 → 英文 · gpt-5\.6-luna/)).toBeTruthy();
    expect(screen.getByText('01 · 原文直译')).toBeTruthy();
    expect(screen.getByText('中文注释 · 可编辑')).toBeTruthy();
  });

  it('demo mode switches languages locally and keeps showing the fixed Chinese → English sample', async () => {
    const client = new DemoClient();
    const send = vi.spyOn(client, 'sendCommand');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    render(
      <ToastProvider>
        <UiClientProvider client={client}>
          <PanelView
            activeTab={{
              loading: false,
              tab: { tabId: 3, windowId: 1, url: 'https://example.com/' },
            }}
            onEnterDemo={() => undefined}
          />
        </UiClientProvider>
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: '搜索' }));
    fireEvent.change(screen.getByLabelText('搜索语言'), { target: { value: 'ko' } });
    await screen.findByRole('heading', { name: '用中文，搜韩文' });
    input();
    fireEvent.click(screen.getByRole('button', { name: '生成韩文搜索词' }));
    await screen.findByText(searchRecord.items[0]!.keyword);
    // 演示数据是英文搜索词：按数据实际语言标注，而不是冒充所选的韩文。
    expect(screen.getByRole('region', { name: '英文搜索词' })).toBeTruthy();
    expect(send.mock.calls.map(([c]) => c.kind)).toEqual(
      expect.arrayContaining(['settings/update', 'search/generate']),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

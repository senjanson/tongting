// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { ToastProvider } from '@src/ui/components/toast';
import { PanelView } from '@src/ui/sidepanel/SidePanelApp';
import { UiClientProvider } from '@src/ui/state/hooks';
import type { SearchRecord } from '@src/domain/search';
import * as clipboard from '@src/ui/shared/clipboard';
import { StaticClient } from './static-client';
import { makeSnapshot } from './fixtures';
import { searchRecord, deferred } from '../../fixtures/search';

function setup(
  options: {
    generate?: () => unknown;
    history?: () => unknown;
    clear?: () => unknown;
    configured?: boolean;
  } = {},
) {
  const snapshot = makeSnapshot(
    options.configured === false
      ? { credential: { configured: false, generation: 1, storage: 'none' } }
      : {},
  );
  const client = new StaticClient(
    { connection: 'connected', snapshot, reconnectAttempts: 0 },
    {
      'search/history': options.history ?? (() => ({ records: [] })),
      'search/generate': options.generate ?? (() => ({ record: searchRecord, persisted: true })),
      'search/clear-history': options.clear ?? (() => ({ cleared: true })),
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
    fireEvent.change(screen.getByLabelText('编辑英文搜索词'), { target: { value: '中文词' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(screen.getByRole('alert').textContent).toContain('单行英文');
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
    await screen.findByText('复制失败，请选中英文词手动复制。');
    fireEvent.click(screen.getAllByRole('button', { name: '搜索' })[0]!);
    await screen.findByText('未能打开 YouTube 搜索，请重试或复制关键词。');
  });
});

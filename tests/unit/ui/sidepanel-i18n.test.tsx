// @vitest-environment happy-dom
/**
 * 侧栏、工具栏弹窗与演示模式的界面语言：英文显示、跟随浏览器、手动切换并立即生效，以及语言名称与日期格式。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { LocalePreference } from '@src/i18n';
import { setLocale } from '@src/i18n';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { ToastProvider } from '@src/ui/components/toast';
import {
  formatDateTime,
  formatLatency,
  languageLabel,
  searchLanguageName,
  sourceLanguageLabel,
} from '@src/ui/format';
import { PopupApp } from '@src/ui/popup/PopupApp';
import { SnapshotI18nProvider } from '@src/ui/shared/LocaleRoot';
import { PanelView, SidePanelApp } from '@src/ui/sidepanel/SidePanelApp';
import type { ActiveTabState } from '@src/ui/state/active-tab';
import { errorMessageOf, notConnectedError } from '@src/ui/state/client';
import { deriveServiceConfig, deriveStatus, errorNextStep } from '@src/ui/state/derive';
import { UiClientProvider } from '@src/ui/state/hooks';
import { ReposProvider, type UiRepos } from '@src/ui/state/repos';
import { createFakeWorker } from './fake-worker-port';
import { makePage, makeSnapshot, TAB_ID } from './fixtures';
import { StaticClient } from './static-client';

const memoryRepos: UiRepos = {
  favorites: { listByRecord: async () => [], set: async (_input, favorited) => favorited },
  transcripts: { listByVideo: async () => [] },
};

const videoTab: ActiveTabState = { loading: false, tab: { tabId: TAB_ID, windowId: 1 } };

function withLocale(uiLocale: LocalePreference, base: AppSnapshot): AppSnapshot {
  return { ...base, settings: { ...base.settings, uiLocale } };
}

function connected(snapshot: AppSnapshot) {
  return { connection: 'connected' as const, snapshot, reconnectAttempts: 0 };
}

function renderPanel(client: StaticClient) {
  return render(
    <UiClientProvider client={client}>
      <ReposProvider repos={memoryRepos}>
        <SnapshotI18nProvider>
          <ToastProvider>
            <PanelView activeTab={videoTab} onEnterDemo={() => undefined} />
          </ToastProvider>
        </SnapshotI18nProvider>
      </ReposProvider>
    </UiClientProvider>,
  );
}

function browserLanguage(language: string) {
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue(language);
}

beforeEach(() => browserLanguage('zh-CN'));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // 根组件会同步页面级当前语言；恢复默认，避免影响同文件的其他用例。
  setLocale('zh-CN');
});

describe('side panel locale', () => {
  it('shows English when the setting is English, even in a Chinese browser', () => {
    const snapshot = withLocale('en', makeSnapshot({ pages: [makePage()] }));
    renderPanel(new StaticClient(connected(snapshot)));
    const tabs = within(screen.getByRole('tablist', { name: 'Tongting sections' }));
    expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Translate',
      'Subtitles',
      'Search',
      'Settings',
    ]);
    expect(screen.getByRole('heading', { level: 1, name: 'Live translation' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start translation' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'LANGUAGE' })).toBeTruthy();
    const target = screen.getByRole('combobox', { name: 'Translate to' }) as HTMLSelectElement;
    const labels = within(target)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(labels).toContain('Simplified Chinese');
    expect(labels).toContain('Japanese');
    const source = screen.getByRole('combobox', { name: 'Video language' });
    expect(within(source).getByRole('option', { name: 'Auto-detect' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stay in sync' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/开始翻译|翻译为|视频语言|字幕位置/);
  });

  it('follows the browser: Chinese (incl. Traditional) browsers get Chinese, others English', () => {
    const base = makeSnapshot({ pages: [makePage()] });
    browserLanguage('zh-TW');
    renderPanel(new StaticClient(connected(withLocale('auto', base))));
    expect(screen.getByRole('tab', { name: '翻译' })).toBeTruthy();
    cleanup();
    vi.restoreAllMocks();
    browserLanguage('fr-FR');
    renderPanel(new StaticClient(connected(withLocale('auto', base))));
    expect(screen.getByRole('tab', { name: 'Translate' })).toBeTruthy();
  });

  it('switching the interface language sends settings/update and switches immediately', async () => {
    let snapshot = withLocale('auto', makeSnapshot({ pages: [makePage()] }));
    browserLanguage('en-US');
    const client: StaticClient = new StaticClient(connected(snapshot), {
      'settings/update': (command) => {
        if (command.kind !== 'settings/update') throw new Error('unexpected');
        snapshot = {
          ...snapshot,
          snapshotVersion: snapshot.snapshotVersion + 1,
          settings: { ...snapshot.settings, ...command.patch } as AppSnapshot['settings'],
        };
        client.setState(connected(snapshot));
        return { persisted: true };
      },
    });
    renderPanel(client);
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    const select = screen.getByRole('combobox', {
      name: 'Interface language',
    }) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Follow browser', '中文', 'English']);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'zh-CN' } });
    });
    expect(client.sent).toContainEqual({ kind: 'settings/update', patch: { uiLocale: 'zh-CN' } });
    await waitFor(() => expect(screen.getByRole('tab', { name: '设置' })).toBeTruthy());
    expect((screen.getByRole('combobox', { name: '界面语言' }) as HTMLSelectElement).value).toBe(
      'zh-CN',
    );
    expect(screen.getByRole('heading', { name: 'INTERFACE / 界面' })).toBeTruthy();
    // 非组件代码（客户端错误）同步使用页面语言。
    expect(errorMessageOf(notConnectedError())).toBe('正在连接后台服务，请稍后重试。');

    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: '界面语言' }), {
        target: { value: 'en' },
      });
    });
    expect(client.sent).toContainEqual({ kind: 'settings/update', patch: { uiLocale: 'en' } });
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy());
    expect(errorMessageOf(notConnectedError())).toMatch(/^Still connecting/);
  });

  it('shows the AI search tab in English with English language names', () => {
    const snapshot = withLocale('en', makeSnapshot({ pages: [makePage()] }));
    renderPanel(new StaticClient(connected(snapshot)));
    fireEvent.click(screen.getByRole('tab', { name: 'Search' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Tongting · AI Search' })).toBeTruthy();
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading.textContent).toMatch(/^Describe in .+, search in .+$/);
    expect(heading.textContent).not.toMatch(/[一-龥]/);
    expect(screen.getByRole('combobox', { name: 'My language' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Search language' })).toBeTruthy();
    expect(screen.getByLabelText('What do you want to find on YouTube?')).toBeTruthy();
  });

  it('shows the demo mode in English, including the sample labels', async () => {
    browserLanguage('en-US');
    vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(
      () =>
        ({
          postMessage: () => undefined,
          disconnect: () => undefined,
          onMessage: { addListener: () => undefined, removeListener: () => undefined },
          onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
        }) as never,
    );
    window.history.replaceState({}, '', '/sidepanel.html?demo=1');
    try {
      render(<SidePanelApp />);
      expect(
        screen.getByText('Demo mode · Sample data, no video or service connected'),
      ).toBeTruthy();
      expect(screen.getByText('Sample video: Notice the small things (demo)')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Pause translation' })).toBeTruthy();
      // 在演示中切换为中文：界面与示例标签一起切换。
      fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
      await act(async () => {
        fireEvent.change(screen.getByRole('combobox', { name: 'Interface language' }), {
          target: { value: 'zh-CN' },
        });
      });
      await waitFor(() =>
        expect(screen.getByText('演示模式 · 示例数据，不连接视频与服务')).toBeTruthy(),
      );
      fireEvent.click(screen.getByRole('tab', { name: '翻译' }));
      expect(screen.getByText('示例视频：留意身边的小细节（演示）')).toBeTruthy();
    } finally {
      window.history.replaceState({}, '', '/');
    }
  });
});

describe('popup locale', () => {
  it('shows English when the browser is not Chinese', async () => {
    browserLanguage('en-US');
    const worker = createFakeWorker(makeSnapshot());
    vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/', active: true });
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([tab] as never);
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText(/Not a YouTube video page/)).toBeTruthy());
    expect(screen.getByText('Translation service: Not checked')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open side panel' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Workspace' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
    const target = screen.getByRole('combobox', { name: 'Translate to' });
    expect(within(target).getByRole('option', { name: 'Traditional Chinese' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[一-龥]/);
  });

  it('shows Chinese when the setting is Chinese, even in an English browser', async () => {
    browserLanguage('en-US');
    const worker = createFakeWorker(withLocale('zh-CN', makeSnapshot()));
    vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
    render(<PopupApp />);
    await waitFor(() => expect(screen.getByText('翻译服务：未检测')).toBeTruthy());
    expect(screen.getByRole('button', { name: '打开侧栏' })).toBeTruthy();
  });
});

describe('locale-aware formatting', () => {
  it('uses English language names in English and keeps Chinese names in Chinese', () => {
    expect(languageLabel('ja', 'en')).toBe('Japanese');
    expect(languageLabel('zh-CN', 'en')).toBe('Simplified Chinese');
    expect(languageLabel('zh-TW', 'en')).toBe('Traditional Chinese');
    expect(languageLabel('en-AU', 'en')).toBe('English (en-AU)');
    expect(languageLabel('und', 'en')).toBe('Unknown language');
    expect(sourceLanguageLabel('auto', 'en')).toBe('Auto-detect');
    expect(sourceLanguageLabel('en', 'en')).toBe('English');

    expect(languageLabel('ja', 'zh-CN')).toBe('日本語');
    expect(languageLabel('en-AU', 'zh-CN')).toBe('英语（en-AU）');
    expect(sourceLanguageLabel('en', 'zh-CN')).toBe('英语');
    expect(sourceLanguageLabel('auto', 'zh-CN')).toBe('自动识别');
  });

  it('names search languages naturally in both locales', () => {
    expect(searchLanguageName('en', 'zh-CN', 'en')).toBe('English');
    expect(searchLanguageName('zh-CN', 'en', 'en')).toBe('Chinese');
    expect(searchLanguageName('zh-CN', 'zh-TW', 'en')).toBe('Simplified Chinese');
    expect(searchLanguageName('ja', 'en', 'en')).toBe('Japanese');
    expect(searchLanguageName('en', 'zh-CN', 'zh-CN')).toBe('英文');
    expect(searchLanguageName('zh-CN', 'en', 'zh-CN')).toBe('中文');
  });

  it('formats dates and latency per locale', () => {
    const at = new Date(2026, 8, 24, 14, 5).getTime();
    expect(formatDateTime(at, 'zh-CN')).toBe('2026-09-24 14:05');
    expect(formatDateTime(at, 'en')).toBe('Sep 24, 2026, 14:05');
    expect(formatDateTime(undefined, 'en')).toBe('Unknown time');
    expect(formatLatency(1500, 'en')).toBe('1.5 s');
    expect(formatLatency(320, 'zh-CN')).toBe('320 毫秒');
  });

  it('derives status, config messages and next steps in the requested locale', () => {
    const snapshot = makeSnapshot({}, { provider: { baseUrl: '' } });
    const config = deriveServiceConfig(snapshot, 'en');
    expect(config.message).toBe('The sub2api service URL is not set. Add it in Settings first.');
    expect(deriveServiceConfig(snapshot, 'zh-CN').message).toBe(
      '尚未配置 sub2api 服务地址，请先在设置中填写。',
    );
    const status = deriveStatus({
      connection: 'connected',
      snapshot,
      tabContext: { kind: 'no-tab' },
      config,
      locale: 'en',
    });
    expect(status.label).toBe('Not set up');
    expect(errorNextStep({ category: 'youtube', retryable: false }, 'en').label).toBe(
      'Reload YouTube page',
    );
  });
});

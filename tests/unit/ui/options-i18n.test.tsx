// @vitest-environment happy-dom
/**
 * 设置页、字幕工作台与导出对话框的界面语言：英文显示、跟随浏览器、手动切换并保存。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AppError } from '@src/domain/errors';
import type { LocalePreference } from '@src/i18n';
import { I18nProvider } from '@src/i18n/react';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { resetDbForTests } from '@src/storage/db';
import { ToastProvider } from '@src/ui/components/toast';
import { OptionsApp } from '@src/ui/options/OptionsApp';
import { ReposProvider, type UiRepos } from '@src/ui/state/repos';
import { TranscriptView } from '@src/ui/transcript/TranscriptView';
import { WorkspaceApp } from '@src/ui/workspace/WorkspaceApp';
import { makeCue, makeSnapshot, VIDEO_ID } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

let worker: FakeWorker;

function withLocale(uiLocale: LocalePreference, version = 0): AppSnapshot {
  const base = makeSnapshot();
  return {
    ...base,
    snapshotVersion: base.snapshotVersion + version,
    settings: { ...base.settings, uiLocale },
  };
}

function useWorker(fake: FakeWorker, uiLanguage: string) {
  worker = fake;
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue(uiLanguage);
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('options page locale', () => {
  it('shows English when the setting is English, even in a Chinese browser', async () => {
    useWorker(createFakeWorker(withLocale('en')), 'zh-CN');
    render(<OptionsApp />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Model connection' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recognition & playback' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Glossary' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Data & privacy' })).toBeTruthy();
    expect(screen.getByLabelText('API key')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save key' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Check connection' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clear translation cache' })).toBeTruthy();
    expect(document.title).toBe('Tongting Settings');
    expect(document.documentElement.lang).toBe('en');
    expect(document.body.textContent).not.toMatch(/模型连接|保存 Key|检查连接/);
  });

  it('follows the browser language when set to auto: non-Chinese browsers get English', async () => {
    useWorker(createFakeWorker(withLocale('auto')), 'fr-FR');
    render(<OptionsApp />);
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    const select = screen.getByRole('combobox', {
      name: 'Interface language',
    }) as HTMLSelectElement;
    expect(select.value).toBe('auto');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Follow browser', '中文', 'English']);
  });

  it('follows a Traditional Chinese browser with Chinese', async () => {
    useWorker(createFakeWorker(withLocale('auto')), 'zh-TW');
    render(<OptionsApp />);
    expect(await screen.findByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: '界面语言' })).toBeTruthy();
    expect(document.title).toBe('同听设置');
  });

  it('switching the interface language sends settings/update and switches immediately', async () => {
    useWorker(createFakeWorker(withLocale('auto')), 'en-US');
    render(<OptionsApp />);
    const select = (await screen.findByRole('combobox', {
      name: 'Interface language',
    })) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'zh-CN' } });
    // 乐观切换：不等待快照
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    expect((screen.getByRole('combobox', { name: '界面语言' }) as HTMLSelectElement).value).toBe(
      'zh-CN',
    );
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'settings/update',
        patch: { uiLocale: 'zh-CN' },
      }),
    );
    await waitFor(() => expect(document.title).toBe('同听设置'));

    // worker 回推新快照后以快照为准；其他页面再改回英文时也随之切换。
    act(() => worker.emit({ type: 'snapshot', snapshot: withLocale('zh-CN', 1) }));
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    act(() => worker.emit({ type: 'snapshot', snapshot: withLocale('en', 2) }));
    expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy();
    expect(
      (screen.getByRole('combobox', { name: 'Interface language' }) as HTMLSelectElement).value,
    ).toBe('en');
  });

  it('does not keep showing the preview when the worker accepts but never adopts the value', async () => {
    // 例如扩展更新后尚未重新加载的旧版 worker：命令成功，但快照里没有该字段。
    useWorker(
      createFakeWorker(withLocale('en'), { 'settings/update': () => ({ persisted: true }) }),
      'en-US',
    );
    render(<OptionsApp />);
    const select = await screen.findByRole('combobox', { name: 'Interface language' });
    fireEvent.change(select, { target: { value: 'zh-CN' } });
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    await waitFor(
      () => expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy(),
      { timeout: 4_000 },
    );
  });

  it('reverts the optimistic switch when the worker rejects the update', async () => {
    useWorker(
      createFakeWorker(withLocale('en'), {
        'settings/update': () => {
          throw new AppError({
            code: 'test',
            category: 'internal',
            retryable: false,
            message: 'rejected',
          });
        },
      }),
      'en-US',
    );
    render(<OptionsApp />);
    const select = await screen.findByRole('combobox', { name: 'Interface language' });
    fireEvent.change(select, { target: { value: 'zh-CN' } });
    expect(screen.getByRole('heading', { level: 1, name: '设置' })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeTruthy(),
    );
    expect(
      (screen.getByRole('combobox', { name: 'Interface language' }) as HTMLSelectElement).value,
    ).toBe('en');
  });
});

describe('workspace locale', () => {
  beforeEach(async () => {
    await resetDbForTests();
    globalThis.indexedDB = new IDBFactory();
    window.history.replaceState({}, '', '/workspace.html');
  });

  afterEach(async () => {
    window.history.replaceState({}, '', '/');
    await resetDbForTests();
  });

  it('shows English key text and title when the setting is English', async () => {
    useWorker(createFakeWorker(withLocale('en')), 'zh-CN');
    render(<WorkspaceApp />);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Subtitle workspace' }),
    ).toBeTruthy();
    expect(await screen.findByText('No subtitle records yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh records' })).toBeTruthy();
    expect(screen.getByText('No subtitle record selected')).toBeTruthy();
    expect(document.title).toBe('Tongting · Subtitle Workspace');
    expect(document.body.textContent).not.toMatch(/字幕工作台|字幕记录/);
  });

  it('shows Chinese in a Chinese browser before any setting is chosen', async () => {
    useWorker(createFakeWorker(withLocale('auto')), 'zh-CN');
    render(<WorkspaceApp />);
    expect(await screen.findByRole('heading', { level: 1, name: '字幕工作台' })).toBeTruthy();
    expect(document.title).toBe('同听 · 字幕工作台');
  });
});

describe('transcript and export dialog locale', () => {
  const repos: UiRepos = {
    favorites: { listByRecord: async () => [], set: async (_input, favorited) => favorited },
    transcripts: { listByVideo: async () => [] },
  };

  function renderTranscript() {
    render(
      <I18nProvider locale="en">
        <ToastProvider>
          <ReposProvider repos={repos}>
            <TranscriptView
              cues={[
                makeCue('a', 1_000, { sourceText: 'hello world', translatedText: '你好世界' }),
                makeCue('b', 4_000, {
                  sourceText: 'pending one',
                  translatedText: undefined,
                  translationState: 'pending',
                }),
              ]}
              source={{
                kind: 'record',
                recordId: `${VIDEO_ID}|zh-CN|en`,
                videoId: VIDEO_ID,
                title: 'Video title',
                targetLanguage: 'zh-CN',
                sourceLanguage: 'en',
                sourceMode: 'full-track',
                coverage: {
                  complete: true,
                  ranges: [{ startMs: 0, endMs: 600_000 }],
                  gaps: [],
                  durationMs: 600_000,
                },
              }}
            />
          </ReposProvider>
        </ToastProvider>
      </I18nProvider>,
    );
  }

  it('renders the list, dialog, exported header and marks in English without changing cue text', async () => {
    renderTranscript();
    expect(screen.getByPlaceholderText('Search original or translation')).toBeTruthy();
    expect(screen.getByText('Waiting for translation')).toBeTruthy();
    expect(screen.getByText('Full caption track (video length 10 min)')).toBeTruthy();
    await screen.findByText('Favorites: 0');

    fireEvent.click(screen.getByRole('button', { name: 'Export subtitles' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Actual coverage')).toBeTruthy();
    expect(within(dialog).getByRole('combobox', { name: 'Content' })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'VTT' }));
    const preview = within(dialog).getByRole('textbox', {
      name: 'Export preview',
    }) as HTMLTextAreaElement;
    expect(preview.value).toContain('NOTE Exported by Tongting');
    expect(preview.value).toContain('Title: Video title');
    expect(preview.value).toContain(
      'Content: Bilingual: translation (Simplified Chinese) + original (English)',
    );
    expect(preview.value).toContain('Coverage: Full caption track (video length 10 min)');
    // 正文与标记不随界面语言变化
    expect(preview.value).toContain('00:00:01.000 --> 00:00:03.000\n你好世界\nhello world');
    expect(preview.value).toContain('[untranslated] pending one');
    expect(within(dialog).getByText('Video title.bilingual.zh-CN.vtt')).toBeTruthy();
  });
});

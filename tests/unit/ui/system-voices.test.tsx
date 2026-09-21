// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AppError, cancelledError } from '@src/domain/errors';
import { ToastProvider } from '@src/ui/components/toast';
import { SystemVoicePicker } from '@src/ui/shared/SystemVoicePicker';
import { useVoiceList } from '@src/ui/shared/hooks';
import { deriveVoiceAvailability } from '@src/ui/state/derive';
import { UiClientProvider } from '@src/ui/state/hooks';
import type { TtsVoiceInfo } from '@src/messaging/ui-protocol';
import { makeSnapshot } from './fixtures';
import { StaticClient } from './static-client';

const VOICES: TtsVoiceInfo[] = [
  { voiceName: 'Online', lang: 'zh-CN', remote: true },
  { voiceName: 'Tingting', lang: 'zh-CN', remote: false },
  { voiceName: 'Eddy (Chinese (China mainland))', lang: 'zh-CN', remote: false },
  { voiceName: 'Meijia', lang: 'zh-TW', remote: false },
  { voiceName: 'Sinji', lang: 'zh-HK', remote: false },
  { voiceName: 'Samantha', lang: 'en-US', remote: false },
];
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function setup(
  options: {
    voiceName?: string;
    active?: boolean;
    voices?: TtsVoiceInfo[];
    preview?: () => unknown;
    persisted?: boolean;
  } = {},
) {
  const snapshot = makeSnapshot(
    {},
    { outputMode: 'subtitle-voice', audio: { voiceName: options.voiceName ?? '' } },
  );
  const client = new StaticClient(
    { connection: 'connected', snapshot, reconnectAttempts: 0 },
    {
      'tts/preview': options.preview ?? (() => ({ started: true })),
      'settings/update': () => ({ persisted: options.persisted ?? true }),
    },
  );
  const availability = deriveVoiceAvailability(snapshot, {
    status: 'ready',
    voices: options.voices ?? VOICES,
  });
  const view = render(
    <ToastProvider>
      <UiClientProvider client={client}>
        <SystemVoicePicker
          settings={snapshot.settings}
          availability={availability}
          dubbingActive={options.active ?? false}
          rate={1.2}
        />
      </UiClientProvider>
    </ToastProvider>,
  );
  return { client, ...view };
}

describe('system voice selection', () => {
  it('shows real matching voices, clear language/source labels and the same automatic choice as dubbing', async () => {
    const { client } = setup();
    const options = screen.getByLabelText('配音声音').querySelectorAll('option');
    expect([...options].map((o) => o.value)).toEqual([
      '',
      'Online',
      'Tingting',
      'Eddy (Chinese (China mainland))',
      'Meijia',
    ]);
    expect(options[1]?.textContent).toBe('Online · 普通话 · 联网声音');
    expect(options[3]?.textContent).toBe('Eddy · 普通话 · 本机声音');
    expect(screen.getByText('当前使用：').textContent).toContain('Tingting');
    fireEvent.click(screen.getByRole('button', { name: '试听' }));
    await waitFor(() =>
      expect(client.sent).toEqual([{ kind: 'tts/preview', voiceName: 'Tingting', rate: 1.2 }]),
    );
  });

  it('auditions another voice without changing the saved choice, and persists the original ID when chosen', async () => {
    const { client } = setup({ voiceName: 'Tingting' });
    fireEvent.click(screen.getByText('浏览并试听全部 4 个声音'));
    fireEvent.click(screen.getByRole('button', { name: '试听 Eddy · 普通话' }));
    await waitFor(() =>
      expect(client.sent).toEqual([
        { kind: 'tts/preview', voiceName: 'Eddy (Chinese (China mainland))', rate: 1.2 },
      ]),
    );
    expect((screen.getByLabelText('配音声音') as HTMLSelectElement).value).toBe('Tingting');
    fireEvent.click(screen.getByRole('button', { name: '使用 Eddy · 普通话' }));
    await waitFor(() =>
      expect(client.sent.at(-1)).toEqual({
        kind: 'settings/update',
        patch: { audio: { voiceName: 'Eddy (Chinese (China mainland))' } },
      }),
    );
  });

  it('explains a missing preference, previews the compatible fallback and never erases the preference', async () => {
    const { client } = setup({ voiceName: 'Removed voice' });
    expect(screen.getByText('原声音暂不可用，自动使用：').textContent).toContain('Tingting');
    expect((screen.getByLabelText('配音声音') as HTMLSelectElement).value).toBe('Removed voice');
    fireEvent.click(screen.getByRole('button', { name: '试听' }));
    await waitFor(() =>
      expect(client.sent).toEqual([{ kind: 'tts/preview', voiceName: 'Tingting', rate: 1.2 }]),
    );
  });

  it.each([{ voices: [] }, { voices: [VOICES[1]!] }])(
    'explains a short voice list and makes no external requests to populate it',
    ({ voices }) => {
      const { client } = setup({ voices });
      expect(screen.getByText(/可在系统中添加/)).toBeTruthy();
      expect((screen.getByRole('button', { name: '试听' }) as HTMLButtonElement).disabled).toBe(
        !voices.length,
      );
      expect(client.sent).toEqual([]);
    },
  );

  it('prevents preview interrupting an active dubbing session but still allows choosing the next voice', () => {
    const { client } = setup({ active: true });
    fireEvent.click(screen.getByText('浏览并试听全部 4 个声音'));
    expect(screen.getByText(/请先暂停翻译，再试听/)).toBeTruthy();
    for (const button of screen.getAllByRole('button', { name: /^试听/ }))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '使用 Meijia · 国语（台湾）' }));
    expect(client.sent).toEqual([
      { kind: 'settings/update', patch: { audio: { voiceName: 'Meijia' } } },
    ]);
  });

  it('cancels pending preview without an error toast and ignores a late failure from an earlier audition', async () => {
    let reject!: (error: unknown) => void;
    const { client } = setup({
      preview: () =>
        new Promise((_, r) => {
          reject = r;
        }),
    });
    fireEvent.click(screen.getByRole('button', { name: '试听' }));
    fireEvent.click(screen.getByRole('button', { name: '停止试听' }));
    await act(async () => reject(cancelledError()));
    expect(screen.queryByText(/试听失败/)).toBeNull();
    expect(client.sent.at(-1)).toEqual({ kind: 'tts/stop-preview' });
    expect(screen.getByRole('button', { name: '试听' }).getAttribute('aria-busy')).toBeNull();
  });

  it('shows real preview errors and failed persistence instead of claiming success', async () => {
    setup({
      preview: () => {
        throw new AppError({
          code: 'tts-test',
          category: 'tts',
          retryable: false,
          message: 'voice offline',
        });
      },
      persisted: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '试听' }));
    await screen.findByText('试听失败：voice offline');
    fireEvent.change(screen.getByLabelText('配音声音'), { target: { value: 'Tingting' } });
    await screen.findByText(/仅本次生效，保存失败/);
  });
});

describe('voice discovery refresh', () => {
  it('refreshes on OS changes and window focus, ignores stale responses and removes listeners on unmount', async () => {
    const listeners = new Set<() => void>();
    vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'addListener').mockImplementation((cb) => {
      listeners.add(cb);
    });
    vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'removeListener').mockImplementation((cb) => {
      listeners.delete(cb);
    });
    const voicesChanged = () => {
      for (const listener of listeners) listener();
    };
    let resolveOld!: (result: { voices: TtsVoiceInfo[] }) => void;
    let calls = 0;
    const snapshot = makeSnapshot();
    const client = new StaticClient(
      { connection: 'connected', snapshot, reconnectAttempts: 0 },
      {
        'tts/voices': () =>
          ++calls === 1
            ? new Promise((resolve) => {
                resolveOld = resolve;
              })
            : { voices: [VOICES[2]!] },
      },
    );
    function Probe() {
      const { state } = useVoiceList(true, 'system');
      return (
        <div>
          {state.status === 'ready' ? state.voices.map((v) => v.voiceName).join(',') : state.status}
        </div>
      );
    }
    const { unmount } = render(
      <UiClientProvider client={client}>
        <Probe />
      </UiClientProvider>,
    );
    await act(async () => {
      voicesChanged();
    });
    await screen.findByText('Eddy (Chinese (China mainland))');
    await act(async () => resolveOld({ voices: [VOICES[1]!] }));
    expect(screen.queryByText('Tingting')).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(calls).toBe(3);
    unmount();
    voicesChanged();
    window.dispatchEvent(new Event('focus'));
    expect(calls).toBe(3);
  });
});

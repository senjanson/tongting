// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '@src/domain/errors';
import type { SessionSnapshot } from '@src/domain/session';
import type { SettingsPatch } from '@src/domain/settings';
import { ToastProvider } from '@src/ui/components/toast';
import { PlaybackControls } from '@src/ui/shared/PlaybackControls';
import { sessionPhaseStatus, sourceModeShortLabel } from '@src/ui/state/derive';
import { UiClientProvider, useClientState } from '@src/ui/state/hooks';
import { makeSession, makeSnapshot } from './fixtures';
import { StaticClient } from './static-client';

afterEach(cleanup);

function ConnectedControls() {
  const { snapshot } = useClientState();
  return snapshot ? (
    <PlaybackControls settings={snapshot.settings} session={snapshot.sessions[0]} />
  ) : null;
}

function renderControls({
  session,
  settings,
  failSave,
}: {
  session?: SessionSnapshot;
  settings?: SettingsPatch;
  failSave?: boolean;
} = {}) {
  const snapshot = makeSnapshot({ sessions: session ? [session] : [] }, settings);
  const client = new StaticClient(
    { connection: 'connected', snapshot, reconnectAttempts: 0 },
    {
      'settings/update': () => {
        if (failSave)
          throw new AppError({
            code: 'disconnected',
            category: 'network',
            retryable: true,
            message: '连接已中断',
          });
        return { persisted: true };
      },
    },
  );
  render(
    <ToastProvider>
      <UiClientProvider client={client}>
        <ConnectedControls />
      </UiClientProvider>
    </ToastProvider>,
  );
  return client;
}

describe('buffered playback controls', () => {
  it('defaults to a 10 second translation buffer without claiming that a session is ready', () => {
    renderControls();
    expect(screen.getByRole('button', { name: '同步优先' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect((screen.getByLabelText('翻译缓冲') as HTMLSelectElement).value).toBe('10');
    expect(screen.getAllByRole('option').map((option) => option.getAttribute('value'))).toEqual([
      '5',
      '10',
      '20',
    ]);
    expect(screen.queryByText('翻译缓冲就绪')).toBeNull();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('sends independent mode and duration patches and preserves the user output setting', async () => {
    const client = renderControls({ settings: { outputMode: 'subtitle' } });
    fireEvent.change(screen.getByLabelText('翻译缓冲'), { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: '连续播放' }));
    await waitFor(() =>
      expect(client.sent).toEqual([
        { kind: 'settings/update', patch: { bufferSeconds: 20 } },
        { kind: 'settings/update', patch: { playbackMode: 'continuous' } },
      ]),
    );
    expect(client.state.snapshot?.settings.outputMode).toBe('subtitle');
  });

  it('uses the worker snapshot for the selected mode and hides buffer controls in continuous mode', () => {
    const client = renderControls();
    fireEvent.click(screen.getByRole('button', { name: '连续播放' }));
    // A sent command alone cannot make the UI claim the setting was applied.
    expect(screen.getByLabelText('翻译缓冲')).toBeTruthy();
    act(() =>
      client.setState({
        ...client.state,
        snapshot: makeSnapshot({}, { playbackMode: 'continuous', bufferSeconds: 20 }),
      }),
    );
    expect(screen.queryByLabelText('翻译缓冲')).toBeNull();
    expect(screen.getByRole('button', { name: '连续播放' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByText('视频连续播放，边播边译；字幕和配音可能晚于画面。')).toBeTruthy();
  });

  it('shows measured progress and explicitly identifies the system voice buffer as translated text', () => {
    renderControls({
      settings: { outputMode: 'subtitle-voice', tts: { backend: 'system' } },
      session: makeSession({
        sourceMode: 'asr-preload',
        playbackBuffer: { state: 'preparing', readyAheadMs: 3_200, targetMs: 10_000 },
      }),
    });
    expect(screen.getByText('正在缓冲翻译')).toBeTruthy();
    expect(screen.getByText('已准备 3.2 秒 / 目标 10 秒')).toBeTruthy();
    const progress = screen.getByRole('progressbar', { name: '翻译缓冲进度' });
    expect(progress.getAttribute('value')).toBe('3200');
    expect(progress.getAttribute('max')).toBe('10000');
    expect(
      screen.getByText('系统配音在字幕时间到达时朗读，缓冲进度表示已准备的译文。'),
    ).toBeTruthy();
    expect(screen.queryByText('翻译缓冲就绪')).toBeNull();
  });

  it('shows readiness only from the worker and can show preparation again after a seek', () => {
    const ready = makeSession({
      playbackBuffer: { state: 'ready', readyAheadMs: 35_000, targetMs: 10_000 },
    });
    const client = renderControls({ session: ready });
    expect(screen.getByText('翻译缓冲就绪')).toBeTruthy();
    expect(screen.getByText('已准备 35 秒 / 目标 10 秒')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('10000');
    act(() =>
      client.setState({
        ...client.state,
        snapshot: makeSnapshot({
          sessions: [
            makeSession({
              playbackBuffer: { state: 'preparing', readyAheadMs: 0, targetMs: 10_000 },
            }),
          ],
        }),
      }),
    );
    expect(screen.queryByText('翻译缓冲就绪')).toBeNull();
    expect(screen.getByText('正在缓冲翻译')).toBeTruthy();
    expect(screen.getByText('已准备 0 秒 / 目标 10 秒')).toBeTruthy();
  });

  it.each(['blocked', 'unavailable'] as const)(
    'provides an explicit continuous playback fallback when the buffer is %s',
    async (state) => {
      const client = renderControls({
        session: makeSession({
          playbackBuffer: {
            state,
            readyAheadMs: 0,
            targetMs: 10_000,
            message: '无法取得后续音频，请检查视频访问权限。',
          },
        }),
      });
      expect(screen.getByText('无法取得后续音频，请检查视频访问权限。')).toBeTruthy();
      expect(
        screen.getByText('可切换连续播放，再点击视频继续；译文和配音可能晚于画面。'),
      ).toBeTruthy();
      expect(screen.queryByText('翻译缓冲就绪')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '切换连续播放' }));
      await waitFor(() =>
        expect(client.sent).toEqual([
          { kind: 'settings/update', patch: { playbackMode: 'continuous' } },
        ]),
      );
    },
  );

  it('keeps the saved selection and reports a failed change instead of silently falling back', async () => {
    renderControls({ failSave: true });
    fireEvent.click(screen.getByRole('button', { name: '连续播放' }));
    expect(await screen.findByText('设置未生效：连接已中断')).toBeTruthy();
    expect(screen.getByRole('button', { name: '同步优先' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it.each(['paused', 'stopped'] as const)(
    'does not display stale ready status after %s',
    (desiredState) => {
      renderControls({
        session: makeSession({
          phase: desiredState === 'paused' ? 'paused' : 'idle',
          desiredState,
          playbackBuffer: { state: 'ready', readyAheadMs: 10_000, targetMs: 10_000 },
        }),
      });
      expect(screen.queryByText('翻译缓冲就绪')).toBeNull();
      expect(screen.queryByRole('progressbar')).toBeNull();
    },
  );
});

describe('buffer session labels', () => {
  it.each([
    ['preparing', '缓冲中'],
    ['blocked', '缓冲受阻'],
    ['unavailable', '无法预读'],
    ['ready', '运行中'],
  ] as const)('reports %s as %s', (state, label) => {
    expect(
      sessionPhaseStatus(
        makeSession({ playbackBuffer: { state, readyAheadMs: 0, targetMs: 10_000 } }),
      )?.label,
    ).toBe(label);
  });

  it('prioritizes paused state and actual session errors over buffer readiness', () => {
    const playbackBuffer = { state: 'ready' as const, readyAheadMs: 10_000, targetMs: 10_000 };
    expect(sessionPhaseStatus(makeSession({ phase: 'paused', playbackBuffer }))?.label).toBe(
      '翻译已暂停',
    );
    expect(
      sessionPhaseStatus(
        makeSession({
          playbackBuffer,
          error: { code: 'auth', category: 'auth', retryable: false, message: 'API Key 无效' },
        }),
      )?.label,
    ).toBe('翻译受阻');
    expect(sourceModeShortLabel('asr-preload')).toBe('音频预读');
  });
});

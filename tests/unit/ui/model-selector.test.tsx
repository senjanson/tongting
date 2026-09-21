// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelSelector } from '@src/ui/shared/ModelSelector';
import { UiClientProvider } from '@src/ui/state/hooks';
import type { ClientState, UiClient } from '@src/ui/state/client';
import { IDLE_CUES_STATE } from '@src/ui/state/cues';
import { defaultSettings, SettingsSchema } from '@src/domain/settings';
import {
  DEFAULT_TEXT_MODEL,
  recommendedTranslationModel,
  translationModelCandidates,
} from '@src/domain/translation-models';
import { makeSnapshot } from './fixtures';

afterEach(cleanup);

function harness() {
  let state: ClientState = {
    connection: 'connected',
    reconnectAttempts: 0,
    snapshot: makeSnapshot(
      {
        credential: { configured: true, generation: 1, storage: 'session' },
        hostPermission: { granted: true, origin: 'https://api.example.com' },
      },
      { provider: { baseUrl: 'https://api.example.com' } },
    ),
  };
  const listeners = new Set<() => void>();
  const pending: { resolve(value: { models: string[] }): void; reject(reason: unknown): void }[] =
    [];
  const send = vi.fn(
    () =>
      new Promise<{ models: string[] }>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  const client: UiClient = {
    mode: 'real',
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sendCommand: send as UiClient['sendCommand'],
    getCuesState: () => IDLE_CUES_STATE,
    subscribeCues: () => () => undefined,
    acquireCues: () => () => undefined,
  };
  const onChange = vi.fn();
  const view = (disabledReason?: string) => (
    <UiClientProvider client={client}>
      <ModelSelector
        snapshot={state.snapshot!}
        value="manual-model"
        onChange={onChange}
        disabledReason={disabledReason}
      />
    </UiClientProvider>
  );
  return {
    client,
    send,
    pending,
    onChange,
    view,
    emit(next: Partial<ClientState>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    snapshot: () => state.snapshot!,
  };
}

describe('shared service model selector', () => {
  it('uses only discovered text candidates, keeps custom text and marks an available recommendation', async () => {
    const h = harness();
    render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    fireEvent.click(screen.getByRole('button', { name: /模型列表/ }));
    expect(h.send).toHaveBeenCalledTimes(1);
    await act(() =>
      h.pending[0]!.resolve({
        models: [
          'gpt-image-2',
          'codex-auto-review',
          'gpt-4o-audio-preview',
          'gpt-5.4-mini',
          'gpt-5.6-luna',
          'gpt-5.6-luna',
        ],
      }),
    );
    expect(screen.queryByRole('option', { name: /image|audio|auto-review/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'gpt-5.6-luna · 字幕翻译推荐' })).toBeTruthy();
    expect((screen.getByLabelText('模型 ID（可手动填写）') as HTMLInputElement).value).toBe(
      'manual-model',
    );
    expect(h.onChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: '翻译模型' }), {
      target: { value: 'gpt-5.6-luna' },
    });
    expect(h.onChange).toHaveBeenCalledWith('gpt-5.6-luna');
    expect(screen.getByRole('button', { name: '刷新模型列表' })).toBeTruthy();
  });

  it.each(['service', 'credential', 'worker'] as const)(
    'discards a late result after %s changes',
    async (what) => {
      const h = harness();
      const rendered = render(h.view());
      fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
      const snapshot = structuredClone(h.snapshot());
      if (what === 'service') snapshot.settings.provider.baseUrl = 'https://other.example.com';
      else if (what === 'credential') snapshot.credential.generation++;
      else snapshot.workerInstanceId = 'new-worker';
      act(() => h.emit({ snapshot }));
      rendered.rerender(h.view());
      fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
      await act(() => h.pending[1]!.resolve({ models: ['gpt-6-new-service'] }));
      await act(() => h.pending[0]!.resolve({ models: ['gpt-6-old-service'] }));
      expect(screen.queryByRole('option', { name: 'gpt-6-old-service' })).toBeNull();
      expect(screen.getByRole('option', { name: 'gpt-6-new-service' })).toBeTruthy();
    },
  );

  it('invalidates A→B→A even if React renders only the final A snapshot', async () => {
    const h = harness();
    render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    const original = h.snapshot();
    const next = structuredClone(original);
    next.settings.provider.baseUrl = 'https://other.example.com';
    act(() => {
      h.emit({ snapshot: next });
      h.emit({ snapshot: original });
    });
    await act(() => h.pending[0]!.resolve({ models: ['gpt-6-stale-after-aba'] }));
    expect(screen.queryByRole('option', { name: 'gpt-6-stale-after-aba' })).toBeNull();
    expect(
      (screen.getByRole('button', { name: '获取模型列表' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it('invalidates discovery when a route draft starts and permits a new attempt after draft completion', async () => {
    const h = harness();
    const rendered = render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    rendered.rerender(h.view('先保存地址'));
    await act(() => h.pending[0]!.resolve({ models: ['gpt-6-stale-draft-model'] }));
    rendered.rerender(h.view());
    expect(
      (screen.getByRole('button', { name: '获取模型列表' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole('option', { name: 'gpt-6-stale-draft-model' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    expect(h.send).toHaveBeenCalledTimes(2);
  });

  it('shows failures without losing the custom field, permits retry, and ignores unmounted replies', async () => {
    const h = harness();
    const rendered = render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await act(() => h.pending[0]!.reject(new Error('request failed')));
    expect(screen.getByText(/模型发现失败/)).toBeTruthy();
    expect((screen.getByLabelText('模型 ID（可手动填写）') as HTMLInputElement).value).toBe(
      'manual-model',
    );
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    rendered.unmount();
    await act(() => h.pending[1]!.resolve({ models: ['late'] }));
    expect(h.onChange).not.toHaveBeenCalled();
  });

  it('invalidates pending results on reconnect even when the service and worker identity stay the same', async () => {
    const h = harness();
    render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    act(() => h.emit({ connection: 'reconnecting' }));
    expect(
      (screen.getByRole('button', { name: '获取模型列表' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => h.emit({ connection: 'connected' }));
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await act(() => h.pending[1]!.resolve({ models: ['gpt-6-current'] }));
    await act(() => h.pending[0]!.resolve({ models: ['gpt-6-disconnected'] }));
    expect(screen.getByRole('option', { name: 'gpt-6-current' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'gpt-6-disconnected' })).toBeNull();
  });

  it('keeps manual entry and refresh available when the service has no eligible models', async () => {
    const h = harness();
    render(h.view());
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await act(() => h.pending[0]!.resolve({ models: ['gpt-5.4-mini', 'gpt-image-2'] }));
    expect((screen.getByRole('combobox', { name: '翻译模型' }) as HTMLSelectElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '刷新模型列表' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    fireEvent.change(screen.getByLabelText('模型 ID（可手动填写）'), {
      target: { value: 'custom-model' },
    });
    expect(h.onChange).toHaveBeenCalledWith('custom-model');
  });
});

describe('translation model defaults and recommendations', () => {
  it('defaults new settings to Luna while preserving an explicit existing model', () => {
    expect(DEFAULT_TEXT_MODEL).toBe('gpt-5.6-luna');
    expect(defaultSettings().provider.model).toBe(DEFAULT_TEXT_MODEL);
    expect(
      SettingsSchema.parse({
        schemaVersion: defaultSettings().schemaVersion,
        provider: { model: 'user-custom-model' },
      }).provider.model,
    ).toBe('user-custom-model');
  });

  it('recommends only an available text candidate and never invents a model', () => {
    expect(recommendedTranslationModel(['gpt-5.4-mini', 'gpt-5.6-luna'])).toBe('gpt-5.6-luna');
    expect(recommendedTranslationModel(['gpt-image-2', 'unknown-text-model'])).toBeUndefined();
    expect(
      translationModelCandidates(['gpt-6', 'gpt-6', ' gpt-5.6-luna ', 'gpt-4o-realtime-preview']),
    ).toEqual(['gpt-5.6-luna', 'gpt-6']);
  });

  it('filters older, non-text and unknown models and sorts actual GPT versions numerically', () => {
    expect(
      translationModelCandidates([
        'gpt-5.5',
        'gpt-5.4-mini',
        'gpt-5.3-codex-spark',
        'gpt-4o',
        'gpt-image-2',
        'gpt-6-audio-preview',
        'codex-auto-review',
        'unknown-text-model',
        'gpt-5.60',
        'gpt-6-astra',
        'gpt-10',
        'gpt-5.6-sol',
        'gpt-5.6',
        'gpt-6',
        'gpt-5.6-luna',
      ]),
    ).toEqual([
      'gpt-5.6',
      'gpt-5.6-luna',
      'gpt-5.6-sol',
      'gpt-5.60',
      'gpt-6',
      'gpt-6-astra',
      'gpt-10',
    ]);
    expect(recommendedTranslationModel(['gpt-5.4-mini', 'gpt-5.5'])).toBeUndefined();
    expect(recommendedTranslationModel(['gpt-6', 'gpt-5.6-terra'])).toBe('gpt-5.6-terra');
  });

  it('keeps an existing older model only in the manual field without listing its name', async () => {
    const h = harness();
    render(
      <UiClientProvider client={h.client}>
        <ModelSelector snapshot={h.snapshot()} value="gpt-5.4-mini" onChange={h.onChange} />
      </UiClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: '获取模型列表' }));
    await act(() => h.pending[0]!.resolve({ models: ['gpt-5.4-mini', 'gpt-5.6-luna'] }));
    expect(screen.queryByRole('option', { name: /gpt-5.4-mini/ })).toBeNull();
    expect(screen.getByRole('option', { name: '手动输入（当前设置）' })).toBeTruthy();
    expect((screen.getByLabelText('模型 ID（可手动填写）') as HTMLInputElement).value).toBe(
      'gpt-5.4-mini',
    );
    expect(h.onChange).not.toHaveBeenCalled();
  });
});

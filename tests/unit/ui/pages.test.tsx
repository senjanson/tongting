// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { OptionsApp } from '@src/ui/options/OptionsApp';
import { PopupApp } from '@src/ui/popup/PopupApp';
import { makeSnapshot } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

let worker: FakeWorker;

function useWorker(fake: FakeWorker) {
  worker = fake;
  vi.spyOn(fakeBrowser.runtime, 'connect').mockImplementation(() => worker.port as never);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('popup', () => {
  it('shows non-YouTube state and opens the side panel synchronously inside the click', async () => {
    useWorker(createFakeWorker(makeSnapshot()));
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/', active: true });
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([tab] as never);
    const sidePanel = (browser as unknown as { sidePanel: { open: unknown } }).sidePanel;
    const open = vi.fn(() => Promise.resolve());
    const original = sidePanel.open;
    sidePanel.open = open;
    try {
      render(<PopupApp />);
      await waitFor(() => expect(screen.getByText(/不是 YouTube 视频页/)).toBeTruthy());
      await waitFor(() => expect(fakeBrowser.tabs.query).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 0));
      expect(screen.getByText('翻译服务：未检测')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /开始翻译/ })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '打开侧栏' }));
      // 同步调用（无 await 之前），以保留用户手势
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]).toEqual([{ tabId: tab.id }]);
    } finally {
      sidePanel.open = original;
    }
  });
});

describe('options page', () => {
  it('never echoes the key, shows honest storage wording and presets with real model names', async () => {
    useWorker(
      createFakeWorker(
        makeSnapshot({
          credential: { configured: true, generation: 1, storage: 'session', masked: '••••abcd' },
        }),
        { 'credentials/set': () => ({ persisted: true, storage: 'session' }) },
      ),
    );
    render(<OptionsApp />);
    const keyInput = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    expect(keyInput.type).toBe('password');
    expect(keyInput.value).toBe('');
    expect(screen.getByText(/当前 Key：••••abcd，仅保存在本次浏览器会话/)).toBeTruthy();
    expect(screen.getByText(/它不是安全保险箱/)).toBeTruthy();

    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6-astra']) {
      const preset = within(screen.getByRole('group', { name: '模型预设' }))
        .getByText(model)
        .closest('button')!;
      expect(within(preset).getByText('候选预设 · 需实测可用')).toBeTruthy();
    }

    fireEvent.change(keyInput, { target: { value: 'sk-test-not-real-0000' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '记住在本机' }));
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }));
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'credentials/set',
        apiKey: 'sk-test-not-real-0000',
        remember: true,
      }),
    );
    await waitFor(() => expect(keyInput.value).toBe(''));
    // 保存 Key 不等于连接成功
    expect(await screen.findByText(/尚未验证，请点击「检查连接」/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('sk-test-not-real-0000');
    expect(document.body.textContent).not.toMatch(/连接成功|已连接/);
  });

  it('requests host permission synchronously for the single configured origin, then notifies the worker', async () => {
    useWorker(
      createFakeWorker(
        makeSnapshot({ hostPermission: { origin: 'https://api.example.com', granted: false } }),
      ),
    );
    const request = vi
      .spyOn(fakeBrowser.permissions, 'request')
      .mockImplementation(() => Promise.resolve(true));
    render(<OptionsApp />);
    const buttons = await screen.findAllByRole('button', { name: '授予访问权限' });
    fireEvent.click(buttons[0]!);
    expect(request).toHaveBeenCalledWith({ origins: ['https://api.example.com/*'] });
    await waitFor(() => expect(worker.commands()).toContainEqual({ kind: 'permissions/changed' }));
  });

  it('sends billed audio probes only when explicitly allowed, and marks results stale after the key changes', async () => {
    const snapshot = makeSnapshot(
      {},
      {
        provider: { baseUrl: 'https://api.example.com' },
        asr: { backend: 'local' },
        tts: { backend: 'sub2api', sub2apiModel: 'tts-x' },
      },
    );
    useWorker(
      createFakeWorker(snapshot, {
        'connection/check': (command) => {
          const scope = command.kind === 'connection/check' ? command.scope : 'text';
          const items =
            scope === 'text'
              ? [
                  { key: 'auth', status: 'verified', message: '认证通过' },
                  { key: 'translation', status: 'verified', message: '翻译成功' },
                ]
              : scope === 'asr'
                ? [{ key: 'localAsr', status: 'verified', message: '本地服务就绪' }]
                : [{ key: 'tts', status: 'unknown', message: '', reasonCode: 'not-probed' }];
          return { checkedAt: Date.now(), configRevision: 1, credentialGeneration: 1, items };
        },
      }),
    );
    render(<OptionsApp />);
    expect(await screen.findByText(/可能产生少量费用/, { selector: 'div' })).toBeTruthy();
    // 只有 sub2api 后端（本例的语音合成）显示计费确认；本地识别不显示。
    expect(screen.getAllByRole('checkbox', { name: /允许实际调用 sub2api 音频接口/ })).toHaveLength(
      1,
    );

    fireEvent.click(await screen.findByRole('button', { name: '检查连接' }));
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'connection/check',
        scope: 'text',
        allowBilledAudioProbe: false,
      }),
    );
    const results = await screen.findByRole('list', { name: '连接检查结果' });
    expect(within(results).getByText(/通过 · 翻译成功/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '检查语音识别' }));
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'connection/check',
        scope: 'asr',
        allowBilledAudioProbe: false,
      }),
    );
    expect(
      within(await screen.findByRole('list', { name: '语音识别检查结果' })).getByText(
        /通过 · 本地服务就绪/,
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '检查语音合成' }));
    expect(
      within(await screen.findByRole('list', { name: '语音合成检查结果' })).getByText(
        '未检测（需要允许实际调用）',
      ),
    ).toBeTruthy();
    expect(worker.commands()).toContainEqual({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: false,
    });
    const allow = screen.getByRole('checkbox', { name: /允许实际调用 sub2api 音频接口/ });
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole('button', { name: '检查语音合成' }));
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'connection/check',
        scope: 'tts',
        allowBilledAudioProbe: true,
      }),
    );
    // 确认只对本次检查有效
    await waitFor(() =>
      expect(
        (
          screen.getByRole('checkbox', {
            name: /允许实际调用 sub2api 音频接口/,
          }) as HTMLInputElement
        ).checked,
      ).toBe(false),
    );

    // 更换 Key：凭证代数变化，旧结果不得继续显示「通过」
    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: {
          ...snapshot,
          snapshotVersion: 2,
          credential: { ...snapshot.credential, generation: 2, masked: '••••wxyz' },
        },
      });
    });
    await waitFor(() =>
      expect(screen.getAllByText(/结果已过期，请重新检查/).length).toBeGreaterThan(0),
    );
    expect(
      within(screen.getByRole('list', { name: '连接检查结果' })).queryByText(/通过/),
    ).toBeNull();
  });

  it('drops a local check result when the worker clears lastConnectionReport', async () => {
    const report = {
      checkedAt: 1,
      configRevision: 1,
      credentialGeneration: 1,
      items: [{ key: 'auth' as const, status: 'verified' as const, message: '认证通过' }],
    };
    const snapshot = makeSnapshot({ lastConnectionReport: report });
    useWorker(
      createFakeWorker(snapshot, { 'connection/check': () => ({ ...report, checkedAt: 2 }) }),
    );
    render(<OptionsApp />);
    expect(await screen.findByRole('list', { name: '连接检查结果' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));
    await waitFor(() =>
      expect(worker.commands().some((c) => c.kind === 'connection/check')).toBe(true),
    );
    act(() => {
      worker.emit({
        type: 'snapshot',
        snapshot: { ...snapshot, snapshotVersion: 3, lastConnectionReport: undefined },
      });
    });
    await waitFor(() => expect(screen.queryByRole('list', { name: '连接检查结果' })).toBeNull());
  });

  it('warns persistently when the key is kept only in worker memory', async () => {
    useWorker(
      createFakeWorker(
        makeSnapshot({
          credential: { configured: true, generation: 1, storage: 'none', masked: '••••abcd' },
        }),
      ),
    );
    render(<OptionsApp />);
    expect(
      await screen.findByText(/未保存：Key 仅在本次后台运行期间有效，可能随时丢失/),
    ).toBeTruthy();
  });

  it('keeps the grant button disabled until an edited address is saved', async () => {
    useWorker(
      createFakeWorker(
        makeSnapshot({ hostPermission: { granted: false } }, { provider: { baseUrl: '' } }),
      ),
    );
    render(<OptionsApp />);
    const input = await screen.findByLabelText('sub2api 服务地址（Base URL）');
    fireEvent.change(input, { target: { value: 'https://new.example.com' } });
    const grant = screen.getByRole('button', { name: '授予访问权限' }) as HTMLButtonElement;
    expect(grant.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'http://localhost:8080' } });
    expect(screen.getByText(/地址无效/)).toBeTruthy();
  });

  it('shows capability status as 未检测 when capabilities are missing', async () => {
    useWorker(
      createFakeWorker(
        makeSnapshot(
          {},
          { provider: { baseUrl: 'https://api.example.com' }, asr: { backend: 'local' } },
        ),
      ),
    );
    render(<OptionsApp />);
    await screen.findByLabelText('API Key');
    expect(screen.getAllByText('未检测').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('已验证');
  });
});

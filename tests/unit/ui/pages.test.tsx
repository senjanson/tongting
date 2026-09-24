// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { AppError } from '@src/domain/errors';
import type { UiToBackground } from '@src/messaging/ui-protocol';
import { OptionsApp } from '@src/ui/options/OptionsApp';
import { PopupApp } from '@src/ui/popup/PopupApp';
import { makeSnapshot } from './fixtures';
import { createFakeWorker, type FakeWorker } from './fake-worker-port';

// 界面语言跟随浏览器（快照中 uiLocale 默认 auto）：本文件的断言使用中文界面。
beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, 'getUILanguage').mockReturnValue('zh-CN');
});

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

  it('changes the target language from its row and keeps the navigation rows as named buttons', async () => {
    useWorker(createFakeWorker(makeSnapshot()));
    const tab = await fakeBrowser.tabs.create({ url: 'https://example.com/', active: true });
    vi.spyOn(fakeBrowser.tabs, 'query').mockResolvedValue([tab] as never);
    render(<PopupApp />);
    const target = (await screen.findByRole('combobox', { name: '翻译为' })) as HTMLSelectElement;
    expect(target.value).toBe(makeSnapshot().settings.targetLanguage);
    fireEvent.change(target, { target: { value: 'ja' } });
    await waitFor(() =>
      expect(worker.commands()).toContainEqual({
        kind: 'settings/update',
        patch: { targetLanguage: 'ja' },
      }),
    );
    for (const name of ['打开侧栏', '字幕工作台', '设置']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    // 服务状态是一个实时区域，标题与说明都在其中。
    const status = screen.getByText('翻译服务：未检测').closest('[role="status"]');
    expect(status?.textContent).toContain('尚未检查连接');
  });
});

describe('options page', () => {
  it('retains a key when durable saving fails and clears the draft only after a successful retry', async () => {
    let persisted = false;
    useWorker(
      createFakeWorker(makeSnapshot(), {
        'credentials/set': () => ({ persisted, storage: 'local' }),
      }),
    );
    render(<OptionsApp />);
    const key = (await screen.findByLabelText('API Key')) as HTMLInputElement;
    fireEvent.change(key, { target: { value: 'sk-fake-options-retry' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }));
    await screen.findByText('Key 未能完整保存，请重试保存后再重新加载扩展。');
    expect(key.value).toBe('sk-fake-options-retry');
    persisted = true;
    fireEvent.click(screen.getByRole('button', { name: '保存 Key' }));
    await waitFor(() => expect(key.value).toBe(''));
    expect(worker.commands().filter((command) => command.kind === 'credentials/set')).toHaveLength(
      2,
    );
  });

  it('never echoes the key and keeps the current model separate from discovered models', async () => {
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

    const model = screen.getByRole('combobox', { name: '翻译模型' }) as HTMLSelectElement;
    expect(model.value).toBe('gpt-5.6-luna');
    expect(model.disabled).toBe(true);
    expect(screen.queryByRole('group', { name: '模型预设' })).toBeNull();
    expect(screen.getByRole('button', { name: '获取模型列表' })).toBeTruthy();

    fireEvent.change(keyInput, { target: { value: 'sk-test-not-real-0000' } });
    expect((screen.getByRole('checkbox', { name: '记住在本机' }) as HTMLInputElement).checked).toBe(
      true,
    );
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

  it('sends one billed probe on a double click, clears the confirmation at click time, and blocks other checks until it finishes', async () => {
    const snapshot = makeSnapshot(
      {},
      {
        provider: { baseUrl: 'https://api.example.com' },
        asr: { backend: 'local' },
        tts: { backend: 'sub2api', sub2apiModel: 'tts-x' },
      },
    );
    const releases: (() => void)[] = [];
    useWorker(
      createFakeWorker(snapshot, {
        'connection/check': () =>
          new Promise((resolve) => {
            releases.push(() =>
              resolve({
                checkedAt: Date.now(),
                configRevision: 1,
                credentialGeneration: 1,
                items: [{ key: 'tts', status: 'verified', message: '合成成功' }],
              }),
            );
          }),
      }),
    );
    const checks = () => worker.commands().filter((c) => c.kind === 'connection/check');
    render(<OptionsApp />);
    const allow = (await screen.findByRole('checkbox', {
      name: /允许实际调用 sub2api 音频接口/,
    })) as HTMLInputElement;
    fireEvent.click(allow);
    expect(allow.checked).toBe(true);

    const tts = screen.getByRole('button', { name: '检查语音合成' }) as HTMLButtonElement;
    const text = screen.getByRole('button', { name: '检查连接' }) as HTMLButtonElement;
    const asr = screen.getByRole('button', { name: '检查语音识别' }) as HTMLButtonElement;
    fireEvent.click(tts);
    fireEvent.click(tts);
    // 计费确认在点击时即清空；本次请求仍带点击时的值。
    expect(allow.checked).toBe(false);
    await waitFor(() => expect(checks()).toHaveLength(1));
    expect(checks()[0]).toEqual({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: true,
    });
    // 进行中：本按钮显示处理中且保留焦点（不设 disabled），其他检查按钮不可用并说明原因。
    expect(tts.getAttribute('aria-busy')).toBe('true');
    expect(tts.getAttribute('aria-disabled')).toBe('true');
    expect(tts.disabled).toBe(false);
    expect(text.disabled).toBe(true);
    expect(asr.disabled).toBe(true);
    expect(screen.getAllByText('另一项检查正在进行，完成后可再检查。')).toHaveLength(2);
    fireEvent.click(text);
    fireEvent.click(asr);
    // 进行中再次勾选确认并点击：不会发出第二次（计费）检查，勾选留给下一次。
    fireEvent.click(allow);
    fireEvent.click(tts);
    await new Promise((r) => setTimeout(r, 0));
    expect(checks()).toHaveLength(1);
    expect(allow.checked).toBe(true);

    await act(async () => releases[0]!());
    expect(
      within(await screen.findByRole('list', { name: '语音合成检查结果' })).getByText(
        /通过 · 合成成功/,
      ),
    ).toBeTruthy();
    expect(text.disabled).toBe(false);
    expect(asr.disabled).toBe(false);
    expect(tts.getAttribute('aria-busy')).toBeNull();
    expect(screen.queryByText('另一项检查正在进行，完成后可再检查。')).toBeNull();

    fireEvent.click(asr);
    await waitFor(() => expect(checks()).toHaveLength(2));
    expect(checks()[1]).toEqual({
      kind: 'connection/check',
      scope: 'asr',
      allowBilledAudioProbe: false,
    });
    // 进行中勾选的确认只属于语音合成的下一次检查。
    expect(allow.checked).toBe(true);
    await act(async () => releases[1]!());
    expect(tts.disabled).toBe(false);
  });

  it('stays silent when the worker replaces a check with a newer one, but reports real failures', async () => {
    let outcome: 'ok' | 'replaced' | 'failed' = 'ok';
    useWorker(
      createFakeWorker(makeSnapshot(), {
        'connection/check': () => {
          if (outcome === 'replaced') {
            throw new AppError({
              code: 'check-replaced',
              category: 'cancelled',
              retryable: false,
              message: '已被新的检查取代。',
            });
          }
          if (outcome === 'failed') {
            throw new AppError({
              code: 'network-error',
              category: 'network',
              retryable: true,
              message: '无法连接服务。',
            });
          }
          return {
            checkedAt: 1_000,
            configRevision: 1,
            credentialGeneration: 1,
            items: [{ key: 'auth', status: 'verified', message: '认证通过' }],
          };
        },
      }),
    );
    const checks = () => worker.commands().filter((c) => c.kind === 'connection/check');
    render(<OptionsApp />);
    const button = (await screen.findByRole('button', { name: '检查连接' })) as HTMLButtonElement;
    fireEvent.click(button);
    const results = await screen.findByRole('list', { name: '连接检查结果' });
    expect(within(results).getByText(/通过 · 认证通过/)).toBeTruthy();

    outcome = 'replaced';
    fireEvent.click(button);
    await waitFor(() => expect(checks()).toHaveLength(2));
    await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
    expect(screen.queryByText(/检查失败/)).toBeNull();
    expect(
      within(screen.getByRole('list', { name: '连接检查结果' })).getByText(/通过 · 认证通过/),
    ).toBeTruthy();

    outcome = 'failed';
    fireEvent.click(button);
    expect(await screen.findByText('检查失败：无法连接服务。')).toBeTruthy();
    // 失败不清空之前的结果，按钮恢复可用。
    expect(
      within(screen.getByRole('list', { name: '连接检查结果' })).getByText(/通过 · 认证通过/),
    ).toBeTruthy();
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect(checks()).toHaveLength(3);
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

describe('settings draft ownership', () => {
  it('keeps newer text, including an ABA edit, when an older save succeeds', async () => {
    const snapshot = makeSnapshot();
    const fake = createFakeWorker(snapshot);
    let pending: { requestId: string } | undefined;
    const port = fake.port as {
      postMessage(message: UiToBackground): void;
    };
    const post = port.postMessage.bind(port);
    port.postMessage = (message) => {
      if (message.type === 'command' && message.command.kind === 'settings/update')
        pending = message;
      else post(message);
    };
    useWorker(fake);
    render(<OptionsApp />);
    const input = (await screen.findByLabelText('模型 ID（可手动填写）')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'model-first' } });
    fireEvent.click(screen.getByRole('button', { name: '保存模型' }));
    fireEvent.change(input, { target: { value: 'model-second' } });
    fireEvent.change(input, { target: { value: 'model-first' } });
    await act(async () =>
      fake.emit({
        type: 'result',
        requestId: pending!.requestId,
        ok: true,
        data: { persisted: true },
      }),
    );
    expect(input.value).toBe('model-first');
    expect((screen.getByRole('button', { name: '保存模型' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
});

it.each([
  ['API Key', '保存 Key', 'credentials/set', 'sk-test-first', 'sk-test-next'],
  ['配对令牌', '保存令牌', 'asr/set-token', 'pair-first', 'pair-next'],
  [
    'sub2api 服务地址（Base URL）',
    '保存地址',
    'settings/update',
    'https://first.example.com',
    'https://next.example.com',
  ],
  ['本地服务地址', '保存地址', 'settings/update', 'http://127.0.0.1:8766', 'http://127.0.0.1:8767'],
])(
  'preserves a newer %s draft while the earlier save completes',
  async (label, button, kind, first, next) => {
    const fake = createFakeWorker(makeSnapshot({}, { asr: { backend: 'local' } }));
    let pending: { requestId: string } | undefined;
    const port = fake.port as {
      postMessage(message: UiToBackground): void;
    };
    const post = port.postMessage.bind(port);
    port.postMessage = (message) => {
      if (message.type === 'command' && message.command.kind === kind) pending = message;
      else post(message);
    };
    useWorker(fake);
    render(<OptionsApp />);
    const input = (await screen.findByLabelText(label)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: first } });
    const saveButton =
      button === '保存地址'
        ? within(input.closest('section')!).getByRole('button', { name: button })
        : screen.getByRole('button', { name: button });
    fireEvent.click(saveButton);
    expect(pending).toBeTruthy();
    fireEvent.change(input, { target: { value: next } });
    await act(async () =>
      fake.emit({
        type: 'result',
        requestId: pending!.requestId,
        ok: true,
        data: { persisted: true, storage: 'session' },
      }),
    );
    expect(input.value).toBe(next);
    expect((saveButton as HTMLButtonElement).disabled).toBe(false);
  },
);

it('keeps credential cleanup retry available after in-memory revocation', async () => {
  useWorker(
    createFakeWorker(
      makeSnapshot(
        {
          credential: { configured: false, generation: 2, storage: 'none', cleanupPending: true },
          asrToken: { configured: false, generation: 2, storage: 'none', cleanupPending: true },
        },
        { asr: { backend: 'local' } },
      ),
    ),
  );
  render(<OptionsApp />);
  expect(await screen.findByRole('button', { name: '重试清理 Key' })).toBeTruthy();
  expect(screen.getByRole('button', { name: '重试清理令牌' })).toBeTruthy();
  expect((screen.getByRole('button', { name: '删除 Key' }) as HTMLButtonElement).disabled).toBe(
    false,
  );
});

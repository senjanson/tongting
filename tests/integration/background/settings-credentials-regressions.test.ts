/**
 * 设置与凭证回归：
 * 1. 恢复默认 / 设置回退默认值 / 设置未能保存时，不得把「不记住在本机」的凭证写入持久存储。
 * 2. 恢复默认与首次安装的默认目标语言跟随浏览器界面语言，首次默认值落盘后固定。
 * 3. 设置读取失败时不用默认值覆盖原设置；设置无法使用时快照如实暴露状态。
 * 4. 更换服务地址后回收不再使用的旧 origin 主机权限。
 */
import { describe, expect, it, vi } from 'vitest';
import { loadSecret } from '@src/background/settings-store';
import { defaultSettings, type Settings } from '@src/domain/settings';
import { AppSnapshotSchema } from '@src/messaging/ui-protocol';
import { API_KEY, configure, createHarness, MemoryArea, wait, type Harness } from './harness';

const ASR_TOKEN = 'local-token-123456';

function areasOf(h: Harness) {
  return { local: h.local, session: h.session, secureLocal: h.secureLocal };
}

function storedSettings(h: Harness): Settings {
  return h.local.data.get('settings') as Settings;
}

async function restart(h: Harness, options: { uiLanguage?: string } = {}): Promise<Harness> {
  const next = createHarness({ ...areasOf(h), ...options });
  await next.coordinator.ready;
  return next;
}

/** storage.local 的读取抛错（其他操作不受影响）。 */
function failReads(area: MemoryArea): () => void {
  const get = area.get.bind(area);
  area.get = async (keys) => {
    if (keys.includes('settings')) throw new Error('io');
    return get(keys);
  };
  return () => {
    area.get = get;
  };
}

/** 只临时保存（不记住在本机）的 API Key 与本地识别令牌。 */
async function sessionOnlyCredentials(): Promise<Harness> {
  const h = createHarness();
  await configure(h, { asr: true });
  expect(h.coordinator.settings().rememberCredentials).toBe(false);
  expect(await loadSecret(areasOf(h), 'apiKey')).toMatchObject({ storage: 'session' });
  expect(await loadSecret(areasOf(h), 'asrToken')).toMatchObject({ storage: 'session' });
  return h;
}

function expectNotOnDisk(h: Harness) {
  expect(h.secureLocal.data.has('secret.apiKey')).toBe(false);
  expect(h.secureLocal.data.has('secret.asrToken')).toBe(false);
  expect(h.local.data.has('secret.apiKey')).toBe(false);
  expect(h.local.data.has('secret.asrToken')).toBe(false);
  expect(JSON.stringify([...h.secureLocal.data.values()])).not.toContain(API_KEY);
  expect(JSON.stringify([...h.local.data.values()])).not.toContain(API_KEY);
}

describe('#1 session-only credentials never reach persistent storage', () => {
  it('settings/reset keeps the remember choice and leaves credentials in session storage', async () => {
    const h = await sessionOnlyCredentials();
    const ui = h.ui();
    const result = await ui.command({ kind: 'settings/reset' });
    expect(result).toMatchObject({ ok: true, data: { persisted: true } });
    expect(h.coordinator.settings().rememberCredentials).toBe(false);
    expect(storedSettings(h).rememberCredentials).toBe(false);
    expectNotOnDisk(h);
    expect(h.session.data.get('secret.apiKey')).toBe(API_KEY);
    expect(h.session.data.get('secret.asrToken')).toBe(ASR_TOKEN);
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.credential).toMatchObject({ configured: true, storage: 'session' });
    expect(snapshot.asrToken).toMatchObject({ configured: true, storage: 'session' });
    // 其余设置确实恢复了默认值。
    expect(h.coordinator.settings().provider.baseUrl).toBe('');
    expect(h.coordinator.settings().asr.backend).toBe('none');
  });

  it('reset also keeps a remembered choice (no move back to session storage)', async () => {
    const h = createHarness();
    const ui = h.ui();
    await ui.command({ kind: 'credentials/set', apiKey: API_KEY, remember: true });
    await ui.command({ kind: 'settings/reset' });
    expect(h.coordinator.settings().rememberCredentials).toBe(true);
    expect(await loadSecret(areasOf(h), 'apiKey')).toMatchObject({
      value: API_KEY,
      storage: 'local',
    });
  });

  it('invalid stored settings fall back to defaults without moving session-only credentials to disk', async () => {
    const h = await sessionOnlyCredentials();
    // 例如降级安装后读到更高版本写入的设置。
    h.local.data.set('settings', { ...storedSettings(h), schemaVersion: 3 });
    const next = await restart(h);
    expect(next.coordinator.settings().rememberCredentials).toBe(false);
    expect(next.coordinator.apiKey()).toBe(API_KEY);
    expectNotOnDisk(h);
    expect(next.coordinator.buildSnapshot(1).credential.storage).toBe('session');
  });

  it('an unreadable settings store does not move session-only credentials to disk', async () => {
    const h = await sessionOnlyCredentials();
    failReads(h.local);
    const next = await restart(h);
    expect(next.coordinator.settings().rememberCredentials).toBe(false);
    expect(next.coordinator.asrToken()).toBe(ASR_TOKEN);
    expectNotOnDisk(h);
  });

  it('a remember:false choice whose settings write failed is not undone at the next worker start', async () => {
    const h = createHarness();
    const ui = h.ui();
    await ui.command({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com/v1', model: 'gpt-5.6-terra' } },
    });
    expect(storedSettings(h).rememberCredentials).toBe(true);
    h.local.failWrites = true;
    const result = await ui.command({ kind: 'credentials/set', apiKey: API_KEY, remember: false });
    expect(result).toMatchObject({ ok: true, data: { persisted: false, storage: 'session' } });
    h.local.failWrites = false;
    // 磁盘上仍是旧的 rememberCredentials=true，但凭证实际只在临时存储中。
    expect(storedSettings(h).rememberCredentials).toBe(true);
    const next = await restart(h);
    expect(next.coordinator.settings().rememberCredentials).toBe(false);
    expect(next.coordinator.apiKey()).toBe(API_KEY);
    expectNotOnDisk(h);
    // 以凭证实际位置纠正后的选择落盘，磁盘与实际一致。
    expect(storedSettings(h).rememberCredentials).toBe(false);
  });

  it('a remembered credential with stale stored settings is reported as remembered', async () => {
    const h = createHarness();
    const ui = h.ui();
    await ui.command({ kind: 'credentials/set', apiKey: API_KEY, remember: false });
    h.local.data.set('settings', { ...storedSettings(h), rememberCredentials: false });
    h.local.failWrites = true;
    await ui.command({ kind: 'credentials/set', apiKey: API_KEY, remember: true });
    h.local.failWrites = false;
    const next = await restart(h);
    expect(next.coordinator.settings().rememberCredentials).toBe(true);
    expect(await loadSecret(areasOf(h), 'apiKey')).toMatchObject({ storage: 'local' });
  });

  it('still upgrades v1 settings to persistent credentials (the explicit migration path)', async () => {
    const areas = {
      local: new MemoryArea(),
      session: new MemoryArea(),
      secureLocal: new MemoryArea(),
    };
    areas.local.data.set('settings', {
      ...defaultSettings(),
      schemaVersion: 1,
      rememberCredentials: false,
    });
    areas.session.data.set('secret.apiKey', API_KEY);
    const h = createHarness(areas);
    await h.coordinator.ready;
    expect(h.coordinator.settings().rememberCredentials).toBe(true);
    expect(await loadSecret(areas, 'apiKey')).toMatchObject({ value: API_KEY, storage: 'local' });
  });
});

describe('#2 default target language follows the browser UI language', () => {
  it('settings/reset uses the UI language instead of the built-in default', async () => {
    const h = createHarness({ uiLanguage: 'en-US' });
    await h.coordinator.ready;
    expect(h.coordinator.settings().targetLanguage).toBe('en');
    await h.coordinator.handleCommand({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    await h.coordinator.handleCommand({ kind: 'settings/reset' });
    expect(h.coordinator.settings().targetLanguage).toBe('en');
    expect(storedSettings(h).targetLanguage).toBe('en');
  });

  it('persists first-install defaults so a later UI language change does not alter them', async () => {
    const h = createHarness({ uiLanguage: 'en-US' });
    await h.coordinator.ready;
    expect(storedSettings(h)).toMatchObject({ targetLanguage: 'en', schemaVersion: 2 });
    const next = await restart(h, { uiLanguage: 'ja-JP' });
    expect(next.coordinator.settings().targetLanguage).toBe('en');
  });

  it('tolerates a failed first-install write without blocking startup', async () => {
    const local = new MemoryArea();
    local.failWrites = true;
    const h = createHarness({ local, uiLanguage: 'ja-JP' });
    await h.coordinator.ready;
    expect(h.coordinator.settings().targetLanguage).toBe('ja');
    expect(local.data.has('settings')).toBe(false);
    // 用户尚未修改任何设置，不提示「设置未能保存」。
    expect(h.coordinator.buildSnapshot(1).settingsPersisted).toBe(true);
    local.failWrites = false;
    const next = await restart(h, { uiLanguage: 'ja-JP' });
    expect(storedSettings(next).targetLanguage).toBe('ja');
  });
});

describe('#3 unreadable or invalid settings are never silently overwritten', () => {
  function withSaved(patch: Partial<Settings>): Harness {
    const local = new MemoryArea();
    local.data.set('settings', { ...defaultSettings(), ...patch });
    return createHarness({ local });
  }

  it('keeps edits in memory while the stored settings cannot be read, then applies them to the original', async () => {
    const original = { targetLanguage: 'ko', style: 'concise' as const, prefetch: false };
    const h = withSaved(original);
    const restore = failReads(h.local);
    const next = await restart(h);
    const ui = next.ui();
    expect(next.coordinator.buildSnapshot(1).settingsRecovery).toBe('unreadable');
    expect(next.coordinator.settings().targetLanguage).toBe('zh-CN');

    const first = await ui.command({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 30 } },
    });
    expect(first).toMatchObject({ ok: true, data: { persisted: false } });
    expect(next.coordinator.settings().captions.fontSizePx).toBe(30);
    // 原设置没有被默认值覆盖。
    expect(storedSettings(next)).toMatchObject(original);
    expect(next.coordinator.buildSnapshot(2)).toMatchObject({
      settingsPersisted: false,
      settingsRecovery: 'unreadable',
    });

    restore();
    const second = await ui.command({ kind: 'settings/update', patch: { bufferSeconds: 20 } });
    expect(second).toMatchObject({ ok: true, data: { persisted: true } });
    const expected = { ...original, bufferSeconds: 20 };
    expect(next.coordinator.settings()).toMatchObject(expected);
    expect(next.coordinator.settings().captions.fontSizePx).toBe(30);
    expect(storedSettings(next)).toMatchObject(expected);
    expect(storedSettings(next).captions.fontSizePx).toBe(30);
    const snapshot = next.coordinator.buildSnapshot(3);
    expect(snapshot.settingsRecovery).toBeUndefined();
    expect(snapshot.settingsPersisted).toBe(true);
    expect(snapshot.settings.targetLanguage).toBe('ko');
    // 发布给界面的快照同样更新。
    await vi.waitFor(() =>
      expect(ui.lastSnapshot()).toMatchObject({
        settingsPersisted: true,
        settings: { targetLanguage: 'ko' },
      }),
    );
    expect(ui.lastSnapshot()?.settingsRecovery).toBeUndefined();
  });

  it('does not write while unreadable for credential remember changes or detected protocols either', async () => {
    const h = withSaved({ targetLanguage: 'ko', rememberCredentials: true });
    failReads(h.local);
    const next = await restart(h);
    const result = await next.coordinator.handleCommand({
      kind: 'credentials/set',
      apiKey: API_KEY,
      remember: false,
    });
    expect(result).toMatchObject({ persisted: false, storage: 'session' });
    expect(storedSettings(next)).toMatchObject({ targetLanguage: 'ko', rememberCredentials: true });
    expectNotOnDisk(next);
  });

  it('keeps the in-memory remember choice when the original settings are read back', async () => {
    const h = withSaved({ targetLanguage: 'ko', rememberCredentials: true });
    const restore = failReads(h.local);
    const next = await restart(h);
    await next.coordinator.handleCommand({
      kind: 'credentials/set',
      apiKey: API_KEY,
      remember: false,
    });
    restore();
    await next.coordinator.handleCommand({ kind: 'settings/update', patch: { prefetch: false } });
    expect(next.coordinator.settings()).toMatchObject({
      targetLanguage: 'ko',
      prefetch: false,
      rememberCredentials: false,
    });
    expect(storedSettings(next).rememberCredentials).toBe(false);
    expectNotOnDisk(next);
  });

  it('reports recovered settings in the snapshot until a successful save, keeping the backup', async () => {
    const invalid = { ...defaultSettings(), schemaVersion: 3 };
    const h = withSaved({});
    h.local.data.set('settings', invalid);
    const next = await restart(h);
    const ui = next.ui();
    await vi.waitFor(() => expect(ui.lastSnapshot()).toBeDefined());
    // 发布的快照符合协议 schema 并带有恢复状态。
    expect(AppSnapshotSchema.parse(ui.lastSnapshot()).settingsRecovery).toBe('recovered');
    expect(h.local.data.get('settings.corruptBackup')).toEqual(invalid);
    // 启动时不覆盖原数据：重启后仍能如实提示。
    expect(storedSettings(next)).toEqual(invalid);
    const again = await restart(next);
    expect(again.coordinator.buildSnapshot(1).settingsRecovery).toBe('recovered');

    await ui.command({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    expect(next.coordinator.buildSnapshot(2).settingsRecovery).toBeUndefined();
    expect(storedSettings(next).targetLanguage).toBe('ja');
    expect(h.local.data.get('settings.corruptBackup')).toEqual(invalid);
  });

  it('keeps the recovery notice when the save after recovery fails', async () => {
    const h = withSaved({});
    h.local.data.set('settings', { ...defaultSettings(), schemaVersion: 3 });
    const next = await restart(h);
    h.local.failWrites = true;
    await next.coordinator.handleCommand({ kind: 'settings/update', patch: { prefetch: false } });
    expect(next.coordinator.buildSnapshot(1)).toMatchObject({
      settingsPersisted: false,
      settingsRecovery: 'recovered',
    });
  });

  it('an explicit reset overwrites unreadable settings', async () => {
    const h = withSaved({ targetLanguage: 'ko' });
    failReads(h.local);
    const next = await restart(h, { uiLanguage: 'ja-JP' });
    const result = await next.coordinator.handleCommand({ kind: 'settings/reset' });
    expect(result).toEqual({ persisted: true });
    expect(storedSettings(next).targetLanguage).toBe('ja');
    expect(next.coordinator.buildSnapshot(1).settingsRecovery).toBeUndefined();
  });
});

describe('#4 host permissions of replaced service addresses are revoked', () => {
  async function withProvider(baseUrl = 'https://api.example.com/v1') {
    const h = createHarness();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl } },
    });
    expect(h.removedPermissions).toEqual([]);
    return h;
  }

  it('revokes the old provider origin once the new address is saved', async () => {
    const h = await withProvider();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example/v1' } },
    });
    expect(h.removedPermissions).toEqual(['https://api.example.com/*']);
  });

  it('does not revoke when only the path changes or unrelated settings change', async () => {
    const h = await withProvider();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com/gateway/v1' }, prefetch: false },
    });
    expect(h.removedPermissions).toEqual([]);
  });

  it('revokes the old local recognition origin but keeps one still used by another route', async () => {
    const h = await withProvider('http://127.0.0.1:9000');
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { asr: { localUrl: 'http://127.0.0.1:9000' } },
    });
    // 默认本地识别地址不再被任何配置使用。
    expect(h.removedPermissions).toEqual(['http://127.0.0.1:8765/*']);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com' } },
    });
    // 9000 仍被本地识别服务使用，不回收。
    expect(h.removedPermissions).toEqual(['http://127.0.0.1:8765/*']);
  });

  it('keeps a port-less grant that still covers the new address on another port', async () => {
    const h = await withProvider('https://api.example.com');
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com:8443' } },
    });
    expect(h.removedPermissions).toEqual([]);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com' } },
    });
    // 带端口的旧模式只覆盖该端口，可以回收。
    expect(h.removedPermissions).toEqual(['https://api.example.com:8443/*']);
  });

  it('settings/reset revokes the provider origin and a non-default local origin', async () => {
    const h = await withProvider();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { asr: { backend: 'local', localUrl: 'http://127.0.0.1:9100' } },
    });
    expect(h.removedPermissions).toEqual(['http://127.0.0.1:8765/*']);
    await h.coordinator.handleCommand({ kind: 'settings/reset' });
    expect(h.removedPermissions.slice(1).sort()).toEqual([
      'http://127.0.0.1:9100/*',
      'https://api.example.com/*',
    ]);
  });

  it('waits for the change to be saved before revoking, and revokes on the next successful save', async () => {
    const h = await withProvider();
    h.local.failWrites = true;
    const failed = await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example' } },
    });
    expect(failed).toEqual({ persisted: false });
    expect(h.removedPermissions).toEqual([]);
    h.local.failWrites = false;
    await h.coordinator.handleCommand({ kind: 'settings/update', patch: { prefetch: false } });
    expect(h.removedPermissions).toEqual(['https://api.example.com/*']);
  });

  it('does not revoke an old origin the user switched back to before it could be saved', async () => {
    const h = await withProvider();
    h.local.failWrites = true;
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example' } },
    });
    h.local.failWrites = false;
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com/v1' } },
    });
    expect(h.removedPermissions).toEqual(['https://api.other.example/*']);
  });

  it('revokes the original address replaced while the stored settings were unreadable', async () => {
    const local = new MemoryArea();
    local.data.set('settings', {
      ...defaultSettings(),
      provider: { ...defaultSettings().provider, baseUrl: 'https://api.example.com/v1' },
    });
    const restore = failReads(local);
    const h = createHarness({ local });
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example' } },
    });
    // 未写盘：原设置仍使用旧地址，暂不回收。
    expect(h.removedPermissions).toEqual([]);
    restore();
    await h.coordinator.handleCommand({ kind: 'settings/update', patch: { prefetch: false } });
    expect(h.coordinator.settings().provider.baseUrl).toBe('https://api.other.example');
    expect(storedSettings(h).provider.baseUrl).toBe('https://api.other.example');
    expect(h.removedPermissions).toEqual(['https://api.example.com/*']);
  });

  it('a failed removal is only logged and does not affect the saved settings', async () => {
    const h = await withProvider();
    const warnings: unknown[][] = [];
    h.deps.logger.warn = (...args: unknown[]) => void warnings.push(args);
    h.deps.permissions.remove = async () => {
      throw new Error('You cannot remove required permissions.');
    };
    const result = await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example' } },
    });
    expect(result).toEqual({ persisted: true });
    expect(storedSettings(h).provider.baseUrl).toBe('https://api.other.example');
    expect(warnings.some(([message]) => String(message).includes('permission removal'))).toBe(true);
  });

  it('publishes the permission state checked after revocation, with the browser removal event racing it', async () => {
    const granted = new Set(['https://api.example.com/*', 'https://api.other.example/*']);
    const h = createHarness();
    h.deps.permissions.contains = async (pattern) => granted.has(pattern);
    h.deps.permissions.remove = async (pattern) => {
      const removed = granted.delete(pattern);
      // 与真实 wiring 一样：permissions.onRemoved 触发 permissions/changed。
      void h.coordinator.handleCommand({ kind: 'permissions/changed' });
      return removed;
    };
    await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    content.trackData();
    await h.coordinator.idle();
    expect(h.coordinator.buildSnapshot(1).sessions[0]?.phase).toBe('running');

    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example/v1' } },
    });
    await wait(10);
    await h.coordinator.idle();
    expect([...granted]).toEqual(['https://api.other.example/*']);
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.hostPermission).toEqual({ origin: 'https://api.other.example', granted: true });
    // 回收旧地址不影响使用新地址（已授权）的会话。
    expect(snapshot.sessions[0]?.error?.code).not.toBe('host-permission-revoked');
    expect(snapshot.sessions[0]?.phase).toBe('running');
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  });

  it('revokes only after sessions handled the address change, so the stop reason stays accurate', async () => {
    const granted = new Set(['https://api.example.com/*']);
    const h = createHarness();
    h.deps.permissions.contains = async (pattern) => granted.has(pattern);
    const order: string[] = [];
    h.deps.permissions.remove = async (pattern) => {
      order.push(`remove:${h.coordinator.buildSnapshot(0).sessions[0]?.phase}`);
      const removed = granted.delete(pattern);
      void h.coordinator.handleCommand({ kind: 'permissions/changed' });
      return removed;
    };
    await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    content.trackData();
    await h.coordinator.idle();
    // 新地址尚未授权。
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.other.example/v1' } },
    });
    await wait(10);
    await h.coordinator.idle();
    // 回收时会话已按配置变化停止（或正在停止），权限事件不会再把它归因为撤回。
    expect(order).toHaveLength(1);
    expect(['remove:stopping', 'remove:error']).toContain(order[0]);
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.hostPermission).toEqual({
      origin: 'https://api.other.example',
      granted: false,
    });
    // 停止原因是「配置不可用（新地址未授权）」，而不是误报旧地址权限被撤回。
    expect(snapshot.sessions[0]?.error?.code).toBe('config-invalid-while-running');
  });
});

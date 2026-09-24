import { describe, expect, it } from 'vitest';
import {
  clearSecret,
  credentialPlacement,
  loadSecret,
  loadSettings,
  maskSecret,
  saveSecret,
  saveSettings,
} from '@src/background/settings-store';
import { defaultSettings } from '@src/domain/settings';
import { MemoryArea } from '../../integration/background/harness';

const logger = { warn: () => undefined };

describe('settings store', () => {
  it('returns defaults when nothing is stored and round-trips saved settings', async () => {
    const local = new MemoryArea();
    expect((await loadSettings(local, logger)).settings).toEqual(defaultSettings());
    const s = { ...defaultSettings(), targetLanguage: 'ja' };
    expect(await saveSettings(local, s)).toBe(true);
    expect((await loadSettings(local, logger)).settings.targetLanguage).toBe('ja');
  });

  it('keeps a backup of corrupted settings instead of silently dropping them', async () => {
    const local = new MemoryArea();
    local.data.set('settings', { schemaVersion: 1, captions: { fontSizePx: 'huge' } });
    const loaded = await loadSettings(local, logger);
    expect(loaded.status).toBe('recovered');
    expect(loaded.settings).toEqual(defaultSettings());
    expect(local.data.get('settings.corruptBackup')).toEqual({
      schemaVersion: 1,
      captions: { fontSizePx: 'huge' },
    });
  });

  it('reports a failed read as unreadable instead of pretending nothing was stored', async () => {
    const local = new MemoryArea();
    local.data.set('settings', { ...defaultSettings(), targetLanguage: 'ja' });
    local.get = async () => {
      throw new Error('io');
    };
    const loaded = await loadSettings(local, logger, 'en-US');
    expect(loaded.status).toBe('unreadable');
    expect(loaded.settings.targetLanguage).toBe('en');
  });

  it('treats invalid settings whose backup failed as unreadable and leaves the original in place', async () => {
    const local = new MemoryArea();
    const future = { ...defaultSettings(), schemaVersion: 3 };
    local.data.set('settings', future);
    local.failWrites = true;
    const loaded = await loadSettings(local, logger);
    expect(loaded.status).toBe('unreadable');
    expect(local.data.get('settings')).toEqual(future);
    expect(local.data.has('settings.corruptBackup')).toBe(false);
  });

  it('marks first-install defaults as initial so the caller can persist them', async () => {
    expect((await loadSettings(new MemoryArea(), logger, 'ja-JP')).status).toBe('initial');
    const local = new MemoryArea();
    await saveSettings(local, defaultSettings());
    expect((await loadSettings(local, logger)).status).toBe('stored');
  });

  it('migrates legacy settings without schemaVersion and fills defaults', async () => {
    const local = new MemoryArea();
    local.data.set('settings', { targetLanguage: 'ko' });
    const loaded = await loadSettings(local, logger);
    expect(loaded.settings.targetLanguage).toBe('ko');
    expect(loaded.settings.captions.bilingual).toBe(true);
  });

  it('reports failed writes as not persisted', async () => {
    const local = new MemoryArea();
    local.failWrites = true;
    expect(await saveSettings(local, defaultSettings())).toBe(false);
  });

  it('upgrades the old default to persistent credentials once, preserving all unrelated settings', async () => {
    const local = new MemoryArea();
    const old = {
      ...defaultSettings(),
      schemaVersion: 1,
      rememberCredentials: false,
      targetLanguage: 'ja',
    };
    local.data.set('settings', old);
    const loaded = await loadSettings(local, logger);
    expect(loaded).toMatchObject({
      needsPersistence: true,
      settings: { schemaVersion: 2, rememberCredentials: true, targetLanguage: 'ja' },
    });
    await saveSettings(local, { ...loaded.settings, rememberCredentials: false });
    const next = await loadSettings(local, logger);
    expect(next.settings.rememberCredentials).toBe(false);
    expect(next.needsPersistence).toBe(false);
  });
});

describe('secrets', () => {
  it('stores in session when explicitly requested, moves to secure local when remembered, and never keeps both copies', async () => {
    const areas = {
      local: new MemoryArea(),
      session: new MemoryArea(),
      secureLocal: new MemoryArea(),
    };
    expect(await saveSecret(areas, 'apiKey', 'sk-abcdefghijkl', false)).toBe(true);
    expect(await loadSecret(areas, 'apiKey')).toEqual({
      value: 'sk-abcdefghijkl',
      storage: 'session',
    });
    expect(areas.local.data.has('secret.apiKey')).toBe(false);
    await saveSecret(areas, 'apiKey', 'sk-abcdefghijkl', true);
    expect(areas.session.data.has('secret.apiKey')).toBe(false);
    // 「记住在本机」不写入内容脚本可读的 storage.local。
    expect(areas.local.data.has('secret.apiKey')).toBe(false);
    expect(areas.secureLocal.data.get('secret.apiKey')).toBe('sk-abcdefghijkl');
    expect(await loadSecret(areas, 'apiKey')).toEqual({
      value: 'sk-abcdefghijkl',
      storage: 'local',
    });
    expect(await clearSecret(areas, 'apiKey')).toBe(true);
    expect(await loadSecret(areas, 'apiKey')).toEqual({ value: undefined, storage: 'none' });
  });

  it('migrates a secret remembered by an older version out of storage.local', async () => {
    const areas = {
      local: new MemoryArea(),
      session: new MemoryArea(),
      secureLocal: new MemoryArea(),
    };
    areas.local.data.set('secret.asrToken', 'legacy-token-000001');
    expect(await loadSecret(areas, 'asrToken')).toEqual({
      value: 'legacy-token-000001',
      storage: 'local',
    });
    expect(areas.local.data.has('secret.asrToken')).toBe(false);
    expect(areas.secureLocal.data.get('secret.asrToken')).toBe('legacy-token-000001');
  });

  it('derives the remember choice from where saved credentials actually live', () => {
    const none = { value: undefined, storage: 'none' } as const;
    expect(credentialPlacement(none, none)).toBeUndefined();
    expect(credentialPlacement({ value: 'k', storage: 'local' }, none)).toBe('local');
    expect(credentialPlacement({ value: 'k', storage: 'session' }, none)).toBe('session');
    // 任一凭证仅临时保存即视为未选择记住，不能据此把它写入磁盘。
    expect(
      credentialPlacement({ value: 'k', storage: 'local' }, { value: 't', storage: 'session' }),
    ).toBe('session');
    // 未能保存（storage=none）的值不代表任何存储选择。
    expect(credentialPlacement({ value: 'k', storage: 'none' }, none)).toBeUndefined();
  });

  it('masks all but the last 4 characters and hides short secrets fully', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('••••abcd');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBeUndefined();
  });
});

describe('首次安装的默认目标语言跟随界面语言', () => {
  it('非中文界面默认英文，而不是简体中文', async () => {
    const local = new MemoryArea();
    const loaded = await loadSettings(local, logger, 'en-US');
    expect(loaded.settings.targetLanguage).toBe('en');
  });

  it('日文界面默认日文', async () => {
    expect((await loadSettings(new MemoryArea(), logger, 'ja-JP')).settings.targetLanguage).toBe(
      'ja',
    );
  });

  it('中文界面仍默认简体中文', async () => {
    expect((await loadSettings(new MemoryArea(), logger, 'zh-CN')).settings.targetLanguage).toBe(
      'zh-CN',
    );
  });

  it('不覆盖已保存的选择', async () => {
    const local = new MemoryArea();
    await saveSettings(local, { ...defaultSettings(), targetLanguage: 'ko' });
    expect((await loadSettings(local, logger, 'en-US')).settings.targetLanguage).toBe('ko');
  });
});

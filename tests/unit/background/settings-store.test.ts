import { describe, expect, it } from 'vitest';
import {
  clearSecret,
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
    expect(loaded.recoveredFromCorruption).toBe(true);
    expect(loaded.settings).toEqual(defaultSettings());
    expect(local.data.get('settings.corruptBackup')).toEqual({
      schemaVersion: 1,
      captions: { fontSizePx: 'huge' },
    });
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
});

describe('secrets', () => {
  it('stores in session by default, moves to secure local when remembered, and never keeps both copies', async () => {
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

  it('masks all but the last 4 characters and hides short secrets fully', () => {
    expect(maskSecret('sk-1234567890abcd')).toBe('••••abcd');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBeUndefined();
  });
});

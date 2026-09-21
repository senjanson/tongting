import { describe, expect, it } from 'vitest';
import {
  beginSecretRevocation,
  clearSecret,
  loadSecret,
  saveSecret,
} from '@src/background/settings-store';
import { MemoryArea } from '../../integration/background/harness';

function areas() {
  return { local: new MemoryArea(), session: new MemoryArea(), secureLocal: new MemoryArea() };
}

describe('review #6: secret authority survives partial cleanup and worker restart', () => {
  it('a late older save cannot override the separate revocation record before cleanup runs', async () => {
    const storage = areas();
    await saveSecret(storage, 'apiKey', 'initial', false);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const set = storage.session.set.bind(storage.session);
    storage.session.set = async (items) => {
      if ('secret.apiKey' in items) await gate;
      return set(items);
    };
    const oldSave = saveSecret(storage, 'apiKey', 'old-delayed', false);
    const revocation = beginSecretRevocation(storage, 'apiKey');
    await revocation.persisted;
    release();
    await oldSave;
    expect(storage.session.data.get('secret.apiKey')).toBe('old-delayed');
    expect((await loadSecret(storage, 'apiKey')).value).toBeUndefined();
    expect(await clearSecret(storage, 'apiKey', revocation)).toBe(true);
    expect(await saveSecret(storage, 'apiKey', 'new-intent', false)).toBe(true);
    expect((await loadSecret(storage, 'apiKey')).value).toBe('new-intent');
  });

  it.each(['apiKey', 'asrToken'] as const)(
    'loads only the new authority when old %s removal fails during migration',
    async (kind) => {
      const storage = areas();
      await saveSecret(storage, kind, 'old-value', false);
      storage.session.remove = async () => {
        throw new Error('remove unavailable');
      };
      expect(await saveSecret(storage, kind, 'new-value', true)).toBe(false);
      expect(await loadSecret(storage, kind)).toMatchObject({
        value: 'new-value',
        storage: 'local',
        cleanupPending: true,
      });
      storage.secureLocal.data.delete(`secret.${kind}`);
      expect((await loadSecret(storage, kind)).value).toBeUndefined();
    },
  );

  it('uses a redundant tombstone when local marker writes and secure deletion fail together', async () => {
    const storage = areas();
    await saveSecret(storage, 'apiKey', 'old-value', true);
    storage.local.failWrites = true;
    storage.secureLocal.remove = async () => {
      throw new Error('remove unavailable');
    };
    expect(await clearSecret(storage, 'apiKey')).toBe(false);
    expect(storage.secureLocal.data.get('secret.apiKey')).toBe('old-value');
    expect(await loadSecret(storage, 'apiKey')).toMatchObject({
      value: undefined,
      cleanupPending: true,
    });
  });

  it('fails closed when the authoritative marker cannot be read', async () => {
    const storage = areas();
    await saveSecret(storage, 'apiKey', 'old-value', true);
    storage.local.get = async () => {
      throw new Error('get unavailable');
    };
    expect(await loadSecret(storage, 'apiKey')).toMatchObject({
      value: undefined,
      storage: 'none',
      cleanupPending: true,
    });
  });

  it('does not recover a leftover local value after a session credential expires', async () => {
    const storage = areas();
    await saveSecret(storage, 'apiKey', 'remembered-value', true);
    storage.secureLocal.remove = async () => {
      throw new Error('remove unavailable');
    };
    expect(await saveSecret(storage, 'apiKey', 'session-value', false)).toBe(false);
    storage.session.data.clear();
    expect((await loadSecret(storage, 'apiKey')).value).toBeUndefined();
  });
});

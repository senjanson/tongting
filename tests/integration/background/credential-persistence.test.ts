import { describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@src/domain/settings';
import { clearSecret, loadSecret, saveSecret } from '@src/background/settings-store';
import { createHarness, MemoryArea } from './harness';

function oldStorage() {
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
  return areas;
}

describe('credential persistence across extension reload', () => {
  it('migrates available legacy session credentials before publishing and preserves them after session storage is cleared', async () => {
    const areas = oldStorage();
    await saveSecret(areas, 'apiKey', 'sk-legacy-fake-1234', false);
    await saveSecret(areas, 'asrToken', 'legacy-asr-fake', false);
    const h = createHarness(areas);
    await h.coordinator.ready;
    expect(h.coordinator.settings().rememberCredentials).toBe(true);
    expect(areas.local.data.get('settings')).toMatchObject({
      schemaVersion: 2,
      rememberCredentials: true,
    });
    expect(await loadSecret(areas, 'apiKey')).toMatchObject({
      value: 'sk-legacy-fake-1234',
      storage: 'local',
    });
    expect(areas.session.data.has('secret.apiKey')).toBe(false);
    expect(areas.local.data.has('secret.apiKey')).toBe(false);
    areas.session.data.clear();
    const reloaded = createHarness(areas);
    await reloaded.coordinator.ready;
    expect(reloaded.coordinator.apiKey()).toBe('sk-legacy-fake-1234');
    expect(reloaded.coordinator.asrToken()).toBe('legacy-asr-fake');
    const ui = reloaded.ui();
    await vi.waitFor(() =>
      expect(ui.lastSnapshot()?.credential).toMatchObject({
        configured: true,
        storage: 'local',
        masked: '••••1234',
      }),
    );
    expect(JSON.stringify(ui.lastSnapshot())).not.toContain('sk-legacy-fake-1234');
  });

  it('does not resurrect revoked copies during migration', async () => {
    const areas = oldStorage();
    await saveSecret(areas, 'apiKey', 'old-fake', false);
    await clearSecret(areas, 'apiKey');
    areas.session.data.set('secret.apiKey', 'leftover-fake');
    const h = createHarness(areas);
    await h.coordinator.ready;
    expect(h.coordinator.apiKey()).toBeUndefined();
    expect(areas.secureLocal.data.has('secret.apiKey')).toBe(false);
  });

  it('reports failed migration and retries when the authoritative temporary value is still available', async () => {
    const areas = oldStorage();
    await saveSecret(areas, 'apiKey', 'sk-retry-fake-5678', false);
    areas.secureLocal.failWrites = true;
    const h = createHarness(areas);
    await h.coordinator.ready;
    const ui = h.ui();
    await vi.waitFor(() =>
      expect(ui.lastSnapshot()).toMatchObject({
        settingsPersisted: false,
        credential: { configured: true, storage: 'none', cleanupPending: true },
      }),
    );
    expect(areas.session.data.get('secret.apiKey')).toBe('sk-retry-fake-5678');
    areas.secureLocal.failWrites = false;
    const retried = createHarness(areas);
    await retried.coordinator.ready;
    expect(await loadSecret(areas, 'apiKey')).toMatchObject({
      value: 'sk-retry-fake-5678',
      storage: 'local',
    });
  });

  it('keeps an explicit v2 temporary preference and never restores an expired key from an older local copy', async () => {
    const areas = oldStorage();
    areas.local.data.set('settings', { ...defaultSettings(), rememberCredentials: false });
    await saveSecret(areas, 'apiKey', 'temporary-fake', false);
    const h = createHarness(areas);
    await h.coordinator.ready;
    expect(h.coordinator.settings().rememberCredentials).toBe(false);
    expect((await loadSecret(areas, 'apiKey')).storage).toBe('session');
    areas.secureLocal.data.set('secret.apiKey', 'leftover-fake');
    areas.session.data.clear();
    const reloaded = createHarness(areas);
    await reloaded.coordinator.ready;
    expect(reloaded.coordinator.apiKey()).toBeUndefined();
    expect(reloaded.coordinator.settings().rememberCredentials).toBe(false);
  });
});

import { expect, test } from '@playwright/test';
import { launchExtension } from './helpers/extension';

test('extension loads with MV3 service worker and expected manifest', async () => {
  const ext = await launchExtension();
  try {
    type Manifest = {
      manifest_version: number;
      permissions?: string[];
      host_permissions?: string[];
      content_scripts?: { matches?: string[] }[];
    };
    const manifest = await ext.serviceWorker.evaluate(() =>
      (
        globalThis as unknown as { chrome: { runtime: { getManifest(): Manifest } } }
      ).chrome.runtime.getManifest(),
    );
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['storage', 'sidePanel', 'activeTab']),
    );
    expect(manifest.host_permissions ?? []).toEqual([]);
    expect(manifest.content_scripts?.[0]?.matches).toEqual(['https://www.youtube.com/*']);
    for (const page of ['popup.html', 'sidepanel.html', 'options.html', 'workspace.html']) {
      const p = await ext.context.newPage();
      const res = await p.goto(`chrome-extension://${ext.extensionId}/${page}`);
      expect(res?.ok()).toBe(true);
      await p.close();
    }
  } finally {
    await ext.close();
  }
});

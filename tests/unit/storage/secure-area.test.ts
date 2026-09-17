import { describe, expect, it } from 'vitest';
import { createSecureLocalArea } from '@src/storage/secure-area';

describe('secure local area (IndexedDB)', () => {
  it('stores, reads back and removes values without touching unrelated keys', async () => {
    const area = createSecureLocalArea('tongting-secure-test-1');
    await area.set({ 'secret.apiKey': 'sk-test-0000000001', 'secret.asrToken': 'tok-test-01' });
    expect(await area.get(['secret.apiKey', 'missing'])).toEqual({
      'secret.apiKey': 'sk-test-0000000001',
    });
    await area.remove(['secret.apiKey']);
    expect(await area.get(['secret.apiKey', 'secret.asrToken'])).toEqual({
      'secret.asrToken': 'tok-test-01',
    });
  });

  it('persists across separately opened areas on the same database', async () => {
    await createSecureLocalArea('tongting-secure-test-2').set({ k: 'v' });
    expect(await createSecureLocalArea('tongting-secure-test-2').get(['k'])).toEqual({ k: 'v' });
  });
});

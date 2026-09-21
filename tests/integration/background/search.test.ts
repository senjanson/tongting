import { describe, expect, it, vi } from 'vitest';
import type { SearchGenerationResult } from '@src/providers/text/search-keywords';
import { API_KEY, configure, createHarness, wait } from './harness';
import { searchRecord, deferred } from '../../fixtures/search';

async function setup() {
  const h = createHarness();
  const generate = vi.fn(async (): Promise<SearchGenerationResult> => ({
    items: searchRecord.items,
    model: searchRecord.model,
    protocol: 'responses',
  }));
  const history = {
    list: vi.fn(async () => []),
    save: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  h.deps.generateSearchKeywords = generate;
  h.deps.searchHistory = history;
  const ui = await configure(h);
  await ui.command({
    kind: 'settings/update',
    patch: { provider: { model: 'gpt-5.6-luna', protocol: 'auto' } },
  });
  return { h, ui, generate, history };
}
const command = {
  kind: 'search/generate',
  operationId: 'search-op-1',
  query: searchRecord.query,
} as const;

describe('AI search through trusted UI ports', () => {
  it('works without a video, uses saved credentials/model and keeps credentials out of results/history', async () => {
    const { h, ui, generate, history } = await setup();
    expect(await ui.command(command)).toMatchObject({
      ok: true,
      data: { persisted: true, record: { query: searchRecord.query, items: searchRecord.items } },
    });
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: API_KEY,
        model: 'gpt-5.6-luna',
        query: searchRecord.query,
      }),
    );
    await h.coordinator.idle();
    // idle() 只等待会话协调循环；协议保存与防抖快照会稍后到达。
    await vi.waitFor(() =>
      expect(ui.lastSnapshot()?.settings.provider.detectedProtocol).toBe('responses'),
    );
    expect(JSON.stringify(ui.port.sent)).not.toContain(API_KEY);
    expect(JSON.stringify(history.save.mock.calls)).not.toContain(API_KEY);
    expect(h.offscreen.requests).toHaveLength(0);
  });

  it('requires both credentials and permission before contacting the model', async () => {
    const { h, ui, generate } = await setup();
    h.permissionGranted.value = false;
    expect(await ui.command(command)).toMatchObject({
      ok: false,
      error: { category: 'permission' },
    });
    await ui.command({ kind: 'credentials/clear' });
    expect(await ui.command(command)).toMatchObject({ ok: false, error: { category: 'config' } });
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['credentials', 'provider', 'permission'] as const)(
    'cancels outstanding requests on %s changes and does not save late results',
    async (change) => {
      const { ui, generate, history } = await setup();
      const pending = deferred<SearchGenerationResult>();
      generate.mockReturnValueOnce(pending.promise);
      const task = ui.command(command);
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
      if (change === 'credentials') await ui.command({ kind: 'credentials/clear' });
      if (change === 'provider')
        await ui.command({
          kind: 'settings/update',
          patch: { provider: { model: 'gpt-5.6-terra' } },
        });
      if (change === 'permission') await ui.command({ kind: 'permissions/changed' });
      expect(await task).toMatchObject({ ok: false, error: { category: 'cancelled' } });
      pending.resolve({
        items: searchRecord.items,
        model: searchRecord.model,
        protocol: 'responses',
      });
      await wait(5);
      expect(history.save).not.toHaveBeenCalled();
    },
  );

  it('cancels owner disconnect during a permission await and never starts a request afterwards', async () => {
    const { h, ui, generate, history } = await setup();
    const permission = deferred<void>();
    h.permissionGranted.delay = permission.promise;
    ui.port.deliver({ type: 'command', requestId: 'pending', command });
    await wait(5);
    ui.port.remoteDisconnect();
    permission.resolve();
    await wait(10);
    expect(generate).not.toHaveBeenCalled();
    expect(history.save).not.toHaveBeenCalled();
  });
});

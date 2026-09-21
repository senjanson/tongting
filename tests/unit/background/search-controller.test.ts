import { describe, expect, it, vi } from 'vitest';
import { SearchController } from '@src/background/search-controller';
import type {
  SearchGenerationParams,
  SearchGenerationResult,
} from '@src/providers/text/search-keywords';
import { searchRecord, deferred } from '../../fixtures/search';

const result: SearchGenerationResult = {
  items: searchRecord.items,
  model: searchRecord.model,
  protocol: 'responses',
};
function setup() {
  const deps = {
    route: vi.fn(async () => ({
      baseUrl: 'https://api.example.com',
      apiKey: 'fake-key',
      model: searchRecord.model,
      protocol: 'auto' as const,
      reasoningEffort: 'omit' as const,
      timeoutMs: 1000,
    })),
    generate: vi.fn(async (_params: SearchGenerationParams) => result),
    history: {
      list: vi.fn(async () => [searchRecord]),
      save: vi.fn(async () => undefined),
      clear: vi.fn(async () => undefined),
    },
    detected: vi.fn(),
    now: () => 1234,
    randomId: () => 'new-search',
  };
  return { deps, controller: new SearchController(deps) };
}

describe('search ownership and cancellation', () => {
  it('returns real results even if local history cannot be saved', async () => {
    const { deps, controller } = setup();
    deps.history.save.mockRejectedValueOnce(new Error('disk full'));
    const output = await controller.generate({}, 'one', searchRecord.query);
    expect(output).toMatchObject({
      persisted: false,
      record: { query: searchRecord.query, model: result.model, items: result.items },
    });
    expect(deps.detected).toHaveBeenCalledWith('responses');
  });
  it('cancels before permission lookup returns without sending a request', async () => {
    const { deps, controller } = setup();
    const owner = {};
    const route = await deps.route();
    const pending = deferred<typeof route>();
    deps.route.mockReturnValueOnce(pending.promise);
    const task = controller.generate(owner, 'one', '教程');
    const rejected = expect(task).rejects.toMatchObject({ info: { category: 'cancelled' } });
    controller.cancel(owner);
    pending.resolve(route);
    await rejected;
    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.history.save).not.toHaveBeenCalled();
  });
  it('ignores a superseded result and stale cancel IDs, and isolates owners', async () => {
    const { deps, controller } = setup();
    const owner = {};
    const other = {};
    const first = deferred<SearchGenerationResult>();
    deps.generate.mockReturnValueOnce(first.promise);
    const old = controller.generate(owner, 'old', '旧主题');
    const rejected = expect(old).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledTimes(1));
    controller.cancel(other, 'old');
    expect(deps.generate.mock.calls[0]![0].signal.aborted).toBe(false);
    const next = controller.generate(owner, 'new', '新主题');
    controller.cancel(owner, 'old');
    await expect(next).resolves.toMatchObject({ record: { query: '新主题' } });
    first.resolve(result);
    await rejected;
    expect(deps.history.save).toHaveBeenCalledTimes(1);
  });
  it('clear aborts all active owners before deletion and prevents late saves', async () => {
    const { deps, controller } = setup();
    const pending = deferred<SearchGenerationResult>();
    deps.generate.mockReturnValue(pending.promise);
    const tasks = [{}, {}].map((owner) => controller.generate(owner, 'run', '搜索'));
    const checked = tasks.map((task) =>
      expect(task).rejects.toMatchObject({ info: { category: 'cancelled' } }),
    );
    await vi.waitFor(() => expect(deps.generate).toHaveBeenCalledTimes(2));
    await controller.clear();
    pending.resolve(result);
    await Promise.all(checked);
    expect(deps.generate.mock.calls.every(([p]) => p.signal.aborted)).toBe(true);
    expect(deps.history.save).not.toHaveBeenCalled();
    expect(deps.history.clear).toHaveBeenCalledTimes(1);
  });
  it('aborts an in-progress save without publishing a result', async () => {
    const { deps, controller } = setup();
    const owner = {};
    const save = deferred<undefined>();
    deps.history.save.mockReturnValue(save.promise);
    const task = controller.generate(owner, 'one', '教程');
    const checked = expect(task).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await vi.waitFor(() => expect(deps.history.save).toHaveBeenCalledTimes(1));
    controller.cancelAll();
    save.resolve(undefined);
    await checked;
  });
  it('bounds simultaneous owners and frees slots after cancellation', async () => {
    const { deps, controller } = setup();
    const pending = deferred<SearchGenerationResult>();
    deps.generate.mockReturnValue(pending.promise);
    const owners = [{}, {}, {}, {}];
    const tasks = owners.map((owner) =>
      controller.generate(owner, 'run', '教程').catch(() => undefined),
    );
    await expect(controller.generate({}, 'extra', '教程')).rejects.toMatchObject({
      info: { code: 'search-busy' },
    });
    controller.cancel(owners[0]!);
    deps.generate.mockResolvedValue(result);
    await expect(controller.generate({}, 'new', '新教程')).resolves.toMatchObject({
      persisted: true,
    });
    controller.cancelAll();
    pending.resolve(result);
    await Promise.all(tasks);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSecret } from '@src/background/settings-store';
import { API_KEY, configure, createHarness, FakeScheduler, wait, type Harness } from './harness';

const active: Harness[] = [];
const releases: (() => void)[] = [];
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  releases.push(resolve);
  return { promise, resolve };
}
function harness() {
  const h = createHarness();
  active.push(h);
  return h;
}
const latest = (h: Harness) => h.coordinator.buildSnapshot(1).sessions[0]!;
afterEach(async () => {
  releases.splice(0).forEach((release) => release());
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  }
});

describe.each(['responses', 'auto'] as const)(
  'atomic credential rotation with %s protocol',
  (protocol) => {
    it.each([
      { remember: false, heldWrite: 'secret', finishOldCheck: 'before-save' },
      { remember: true, heldWrite: 'settings', finishOldCheck: 'before-save' },
      { remember: true, heldWrite: 'secret', finishOldCheck: 'after-save' },
      { remember: false, heldWrite: 'secret', finishOldCheck: 'after-save' },
    ])(
      'never starts with an old key after $finishOldCheck / $heldWrite / remember=$remember',
      async ({ remember, heldWrite, finishOldCheck }) => {
        const h = harness();
        await configure(h);
        await h.coordinator.handleCommand({
          kind: 'settings/update',
          patch: { provider: { protocol } },
        });
        const c = h.content(1);
        c.hello();
        c.navigate('aaaaaaaaaaa');
        await wait(5);
        const first = deferred();
        const second = deferred();
        const storage = deferred();
        let checks = 0;
        h.deps.permissions.contains = async () => {
          checks++;
          if (checks === 1) await first.promise;
          if (checks === 2) await second.promise;
          return true;
        };
        const area = heldWrite === 'settings' ? h.local : remember ? h.secureLocal : h.session;
        const originalSet = area.set.bind(area);
        let saving = false;
        area.set = async (items) => {
          if ((heldWrite === 'settings' ? 'settings' : 'secret.apiKey') in items) {
            saving = true;
            await storage.promise;
          }
          return originalSet(items);
        };
        await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
        await vi.waitFor(() => expect(checks).toBe(1), { interval: 5 });
        const oldSession = latest(h).identity.sessionId;
        const save = h.coordinator.handleCommand({
          kind: 'credentials/set',
          apiKey: 'new-key-for-rotation',
          remember,
        });
        await vi.waitFor(() => expect(saving).toBe(true), { interval: 5 });
        expect(h.coordinator.apiKey()).toBe(API_KEY);
        if (finishOldCheck === 'before-save') {
          first.resolve();
          await vi.waitFor(() => expect(c.requestKinds()).toContain('captions/load-track'), {
            interval: 5,
          });
          // 存储等待期间不能先发布新代数，再以旧 Key 启动第二个会话。
          expect(checks).toBe(1);
          expect(latest(h).identity.sessionId).toBe(oldSession);
        }
        const requestsBeforeCommit = c
          .requestKinds()
          .filter((kind) => kind === 'captions/load-track').length;
        storage.resolve();
        await save;
        expect(h.coordinator.apiKey()).toBe('new-key-for-rotation');
        await vi.waitFor(() => expect(checks).toBe(2), { interval: 5 });
        expect(latest(h).identity.sessionId).not.toBe(oldSession);
        first.resolve(); // 旧权限检查晚到也不能重新激活旧会话。
        second.resolve();
        await vi.waitFor(
          () =>
            expect(c.requestKinds().filter((kind) => kind === 'captions/load-track')).toHaveLength(
              requestsBeforeCommit + 1,
            ),
          { interval: 5 },
        );
        c.trackData();
        await h.coordinator.idle();
        expect(latest(h).phase).toBe('running');
        const live = FakeScheduler.all.filter((scheduler) => !scheduler.disposed);
        expect(live).toHaveLength(1);
        expect(live[0]!.provider.config.apiKey).toBe('new-key-for-rotation');
        expect(await loadSecret(h.deps.storage, 'apiKey')).toMatchObject({
          value: 'new-key-for-rotation',
          storage: remember ? 'local' : 'session',
        });
      },
    );
  },
);

describe('credential rotation completion and failure', () => {
  it('updates the running provider before waiting for the separate ASR-token migration', async () => {
    const h = harness();
    await configure(h, { asr: true });
    const c = h.content(1);
    c.hello();
    c.navigate('aaaaaaaaaaa');
    await wait(5);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.waitFor(() => expect(c.requestKinds()).toContain('captions/load-track'), {
      interval: 5,
    });
    c.trackData();
    await h.coordinator.idle();
    const sessionId = latest(h).identity.sessionId;
    const scheduler = FakeScheduler.all.at(-1)!;
    const storage = deferred();
    let migrating = false;
    const set = h.secureLocal.set.bind(h.secureLocal);
    h.secureLocal.set = async (items) => {
      if ('secret.asrToken' in items) {
        migrating = true;
        await storage.promise;
      }
      return set(items);
    };
    const save = h.coordinator.handleCommand({
      kind: 'credentials/set',
      apiKey: 'rotated-before-asr-migration',
      remember: true,
    });
    await vi.waitFor(() => expect(migrating).toBe(true), { interval: 5 });
    expect(scheduler.provider.config.apiKey).toBe('rotated-before-asr-migration');
    expect(scheduler.disposed).toBe(false);
    expect(latest(h).identity.sessionId).toBe(sessionId);
    storage.resolve();
    await save;
    expect((await loadSecret(h.deps.storage, 'asrToken')).storage).toBe('local');
  });

  it('uses the new in-memory key even if persistence fails and reports it as unsaved', async () => {
    const h = harness();
    await configure(h);
    const c = h.content(1);
    c.hello();
    c.navigate('aaaaaaaaaaa');
    await wait(5);
    const permission = deferred();
    let checks = 0;
    h.deps.permissions.contains = async () => {
      if (++checks === 1) await permission.promise;
      return true;
    };
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.waitFor(() => expect(checks).toBe(1), { interval: 5 });
    h.secureLocal.failWrites = true;
    expect(
      await h.coordinator.handleCommand({
        kind: 'credentials/set',
        apiKey: 'memory-only-new-key',
        remember: true,
      }),
    ).toMatchObject({ persisted: false });
    permission.resolve();
    await vi.waitFor(() => expect(c.requestKinds()).toContain('captions/load-track'), {
      interval: 5,
    });
    c.trackData();
    await h.coordinator.idle();
    expect(FakeScheduler.all.at(-1)!.provider.config.apiKey).toBe('memory-only-new-key');
    expect(h.coordinator.buildSnapshot(1).credential).toMatchObject({
      configured: true,
      storage: 'none',
      cleanupPending: true,
    });
    expect(latest(h).phase).toBe('running');
  });
});

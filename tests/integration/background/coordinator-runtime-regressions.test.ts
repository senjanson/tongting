/**
 * 协调器运行期回归：收敛轮次保护、连接检查的取代与作废、无关设置变化的误判、
 * 超长能力说明导致快照回退。每个场景都驱动真实 Coordinator，并检查实际副作用与快照。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_MESSAGE_MAX,
  clampCapabilityFields,
  parseCapabilityMatrix,
  truncateText,
} from '@src/domain/capability';
import { cancelledError } from '@src/domain/errors';
import { ConnectionReportSchema, type ConnectionReport } from '@src/messaging/ui-protocol';
import type { SearchGenerationResult } from '@src/providers/text/search-keywords';
import type { TextConnectionCheckResult } from '@src/providers/text/connection-check';
import { configure, createHarness, FakeScheduler, MemoryArea, wait, type Harness } from './harness';
import { deferred, searchRecord } from '../../fixtures/search';

const active: Harness[] = [];
function harness(options?: Parameters<typeof createHarness>[0]) {
  const h = createHarness(options);
  active.push(h);
  return h;
}

afterEach(async () => {
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  }
});

type Scope = 'text' | 'asr' | 'tts' | 'all';
const check = (h: Harness, scope: Scope) =>
  h.coordinator.handleCommand({
    kind: 'connection/check',
    scope,
    allowBilledAudioProbe: false,
  }) as Promise<ConnectionReport>;
/** 保留拒绝原因，便于断言错误码。 */
const settle = <T>(promise: Promise<T>) => promise.catch((error: unknown) => error);

function videoId(i: number) {
  return `vid${String(i).padStart(8, '0')}`;
}

describe('converge round guard', () => {
  it('keeps translating after rapid video switching while every start is still pending', async () => {
    const h = harness();
    await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate(videoId(0));
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    // 每个视频都停在「等待字幕轨道」阶段就切到下一个（快速刷 Shorts / 播放列表连续下一个）。
    for (let i = 1; i <= 24; i++) {
      content.navigate(videoId(i));
      await wait(15);
    }
    content.trackData();
    await h.coordinator.idle();
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.sessions[0]).toMatchObject({
      identity: { videoId: videoId(24) },
      phase: 'running',
      desiredState: 'running',
    });
    expect(snapshot.sessions[0]?.error).toBeUndefined();
    // 被取代的启动都已释放资源，只有最后一个视频的调度器仍在工作。
    expect(FakeScheduler.all.length).toBeGreaterThan(20);
    expect(FakeScheduler.all.slice(0, -1).every((s) => s.disposed)).toBe(true);
    expect(FakeScheduler.all.at(-1)!.disposed).toBe(false);
  });

  it('still stops a start that is cancelled over and over with nothing changing', async () => {
    const h = harness();
    await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    const contains = h.deps.permissions.contains;
    let attempts = 0;
    h.deps.permissions.contains = async () => {
      attempts++;
      throw cancelledError('internal');
    };
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    expect(attempts).toBeGreaterThan(1);
    expect(attempts).toBeLessThanOrEqual(16);
    expect(h.coordinator.buildSnapshot(1).sessions[0]).toMatchObject({
      phase: 'error',
      desiredState: 'stopped',
      error: { code: 'start-retry-exhausted' },
    });
    // 新的「开始翻译」是新意图，拥有自己的轮次，不受上一次耗尽影响。
    h.deps.permissions.contains = contains;
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    content.trackData();
    await h.coordinator.idle();
    expect(h.coordinator.buildSnapshot(2).sessions[0]).toMatchObject({
      phase: 'running',
      desiredState: 'running',
    });
    expect(h.coordinator.buildSnapshot(2).sessions[0]?.error).toBeUndefined();
  });
});

describe('connection check replacement', () => {
  it('runs non-overlapping checks in parallel without discarding or mixing results', async () => {
    const h = harness();
    await configure(h, { asr: true });
    const gate = deferred<void>();
    h.deps.runTextConnectionCheck = async () => {
      await gate.promise;
      return {
        items: [{ key: 'auth', status: 'verified', message: '认证通过' }],
        detectedProtocol: 'responses',
      };
    };
    const text = settle(check(h, 'text'));
    await wait(10);
    const asr = await check(h, 'asr');
    expect(asr.items).toEqual([expect.objectContaining({ key: 'localAsr', status: 'verified' })]);
    gate.resolve();
    const textReport = (await text) as ConnectionReport;
    expect(textReport.items).toEqual([
      expect.objectContaining({ key: 'auth', status: 'verified' }),
    ]);
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.capabilities.auth?.status).toBe('verified');
    expect(snapshot.capabilities.localAsr?.status).toBe('verified');
    // 报告按完成顺序记录最后一次检查，且只含该次检查自己的项。
    expect(snapshot.lastConnectionReport?.items.map((i) => i.key)).toEqual(['auth']);
  });

  it.each([
    ['resolves', false],
    ['rejects on abort', true],
  ] as const)(
    'reports check-replaced when a newer same-scope check takes over (old call %s)',
    async (_label, rejectOnAbort) => {
      const h = harness();
      await configure(h);
      const first = deferred<void>();
      let calls = 0;
      h.deps.runTextConnectionCheck = ({ signal }) => {
        calls++;
        if (calls > 1)
          return Promise.resolve({
            items: [{ key: 'auth', status: 'verified', message: '新结果' }],
            detectedProtocol: 'responses',
          });
        return new Promise<TextConnectionCheckResult>((resolve, reject) => {
          if (rejectOnAbort)
            signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
          void first.promise.then(() =>
            resolve({ items: [{ key: 'auth', status: 'failed', message: '旧结果' }] }),
          );
        });
      };
      const older = settle(check(h, 'text'));
      await wait(10);
      const newer = await check(h, 'text');
      first.resolve();
      expect(await older).toMatchObject({
        info: {
          code: 'check-replaced',
          category: 'cancelled',
          message: '本次检查已被新的检查取代。',
        },
      });
      expect(newer.items[0]).toMatchObject({ status: 'verified', message: '新结果' });
      await wait(10);
      // 迟到的旧结果不会覆盖新结果。
      expect(h.coordinator.buildSnapshot(1).capabilities.auth).toMatchObject({
        status: 'verified',
        message: '新结果',
      });
    },
  );

  it.each([
    ['all', 'asr'],
    ['asr', 'all'],
    ['all', 'all'],
  ] as const)('a %s check is replaced by a later %s check', async (firstScope, secondScope) => {
    const h = harness();
    await configure(h, { asr: true });
    const gate = deferred<void>();
    let gated = true;
    const health = h.deps.checkLocalAsrHealth;
    h.deps.checkLocalAsrHealth = async (url, signal) => {
      if (gated) {
        gated = false;
        await gate.promise;
      }
      return health(url, signal);
    };
    const older = settle(check(h, firstScope));
    await wait(10);
    const newer = await check(h, secondScope);
    gate.resolve();
    expect(await older).toMatchObject({ info: { code: 'check-replaced' } });
    expect(newer.items.some((i) => i.key === 'localAsr')).toBe(true);
  });

  it('keeps check-superseded for a real configuration change', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred<void>();
    h.deps.runTextConnectionCheck = async () => {
      await gate.promise;
      return { items: [{ key: 'model', status: 'verified', message: '旧模型可用' }] };
    };
    const pending = settle(check(h, 'text'));
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { model: 'gpt-5.6-luna' } },
    });
    gate.resolve();
    expect(await pending).toMatchObject({ info: { code: 'check-superseded' } });
    expect(h.coordinator.buildSnapshot(1).capabilities.model).toBeUndefined();
  });
});

describe('unrelated changes are not configuration changes', () => {
  it.each(['caption style', 'Alt+C toggle'] as const)(
    'keeps a model list fetched across a %s change',
    async (change) => {
      const h = harness();
      await configure(h);
      const gate = deferred<void>();
      h.deps.discoverModels = async () => {
        await gate.promise;
        return ['gpt-5.6-terra', 'gpt-5.6-luna'];
      };
      const pending = settle(h.coordinator.handleCommand({ kind: 'models/discover' }));
      await wait(10);
      if (change === 'caption style')
        await h.coordinator.handleCommand({
          kind: 'settings/update',
          patch: { captions: { fontSizePx: 30 } },
        });
      else await h.coordinator.toggleCaptions();
      gate.resolve();
      expect(await pending).toEqual({ models: ['gpt-5.6-terra', 'gpt-5.6-luna'] });
    },
  );

  it('discards a model list when the service address really changes', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred<void>();
    h.deps.discoverModels = async () => {
      await gate.promise;
      return ['gpt-5.6-terra'];
    };
    const pending = settle(h.coordinator.handleCommand({ kind: 'models/discover' }));
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://other.example.com/v1' } },
    });
    gate.resolve();
    expect(await pending).toMatchObject({ info: { code: 'discovery-superseded' } });
  });

  it.each(['model choice', 'pairing token'] as const)(
    'keeps an in-flight model list across a %s change',
    async (change) => {
      const h = harness();
      await configure(h);
      const gate = deferred<void>();
      h.deps.discoverModels = ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
          void gate.promise.then(() => resolve(['gpt-5.6-terra', 'gpt-5.6-luna']));
        });
      const pending = settle(h.coordinator.handleCommand({ kind: 'models/discover' }));
      await wait(10);
      if (change === 'model choice')
        await h.coordinator.handleCommand({
          kind: 'settings/update',
          patch: { provider: { model: 'gpt-5.6-luna' } },
        });
      else await h.coordinator.handleCommand({ kind: 'asr/set-token', token: 'pair-token-test' });
      gate.resolve();
      expect(await pending).toEqual({ models: ['gpt-5.6-terra', 'gpt-5.6-luna'] });
    },
  );

  it.each(['recognition setting', 'pairing token'] as const)(
    'keeps a text check across a %s change',
    async (change) => {
      const h = harness();
      await configure(h);
      const gate = deferred<void>();
      h.deps.runTextConnectionCheck = ({ signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(cancelledError()), { once: true });
          void gate.promise.then(() =>
            resolve({ items: [{ key: 'model', status: 'verified', message: '模型可用' }] }),
          );
        });
      const pending = settle(check(h, 'text'));
      await wait(10);
      if (change === 'recognition setting')
        await h.coordinator.handleCommand({
          kind: 'settings/update',
          patch: { asr: { segmentMs: 8_000 } },
        });
      else await h.coordinator.handleCommand({ kind: 'asr/set-token', token: 'pair-token-test' });
      gate.resolve();
      expect(await pending).toMatchObject({ items: [{ key: 'model', status: 'verified' }] });
      expect(h.coordinator.buildSnapshot(1).capabilities.model?.status).toBe('verified');
    },
  );

  it('still supersedes a combined check when a recognition setting changes', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred<void>();
    h.deps.runTextConnectionCheck = async () => {
      await gate.promise;
      return { items: [{ key: 'model', status: 'verified', message: '模型可用' }] };
    };
    const pending = settle(check(h, 'all'));
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { asr: { segmentMs: 8_000 } },
    });
    gate.resolve();
    expect(await pending).toMatchObject({ info: { code: 'check-superseded' } });
  });

  it('tells an older model discovery that a newer one replaced it', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred<void>();
    let calls = 0;
    h.deps.discoverModels = async ({ signal }) => {
      if (++calls === 1) {
        await new Promise<void>((_, reject) =>
          signal.addEventListener('abort', () => reject(cancelledError()), { once: true }),
        );
      }
      await gate.promise;
      return ['gpt-5.6-terra'];
    };
    const older = settle(h.coordinator.handleCommand({ kind: 'models/discover' }));
    await wait(10);
    const newer = h.coordinator.handleCommand({ kind: 'models/discover' });
    gate.resolve();
    expect(await older).toMatchObject({
      info: { code: 'discovery-replaced', category: 'cancelled' },
    });
    expect(await newer).toEqual({ models: ['gpt-5.6-terra'] });
  });

  it('accepts a check that finishes after a session start detected the protocol', async () => {
    const h = harness();
    const ui = h.ui();
    await ui.command({
      kind: 'settings/update',
      patch: {
        playbackMode: 'continuous',
        provider: {
          baseUrl: 'https://api.example.com/v1',
          protocol: 'auto',
          model: 'gpt-5.6-terra',
        },
      },
    });
    await ui.command({ kind: 'credentials/set', apiKey: 'sk-test-unit-000000', remember: false });
    const gate = deferred<void>();
    let calls = 0;
    h.deps.runTextConnectionCheck = async () => {
      // 第一次是用户点的检查（慢）；之后是会话启动时的协议探测（立即返回）。
      if (++calls === 1) await gate.promise;
      return {
        items: [{ key: 'translation', status: 'verified', message: '翻译可用' }],
        detectedProtocol: 'responses',
      };
    };
    const pending = settle(check(h, 'text'));
    await wait(10);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.waitFor(() =>
      expect(h.coordinator.settings().provider.detectedProtocol).toBe('responses'),
    );
    gate.resolve();
    const report = (await pending) as ConnectionReport;
    expect(report.items[0]).toMatchObject({ key: 'translation', status: 'verified' });
    expect(h.coordinator.buildSnapshot(1).capabilities.translation?.status).toBe('verified');
  });

  it('keeps a check across a glossary edit and stamps it with the current revision', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred<void>();
    h.deps.runTextConnectionCheck = async () => {
      await gate.promise;
      return { items: [{ key: 'auth', status: 'verified', message: '认证通过' }] };
    };
    const pending = settle(check(h, 'text'));
    await wait(10);
    const before = h.coordinator.configRevision();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { glossary: [{ source: 'Anna', target: '安娜' }] },
    });
    expect(h.coordinator.configRevision()).toBeGreaterThan(before);
    gate.resolve();
    const report = (await pending) as ConnectionReport;
    // 术语表不影响连接检查：结果有效，且不会在界面上立刻显示为「已过期」。
    expect(report.configRevision).toBe(h.coordinator.configRevision());
    expect(h.coordinator.buildSnapshot(1).capabilities.auth?.configRevision).toBe(
      h.coordinator.configRevision(),
    );
  });

  it('does not cancel an AI search when an unrelated setting changes during its permission check', async () => {
    const h = harness();
    const generate = vi.fn(async (): Promise<SearchGenerationResult> => ({
      items: searchRecord.items,
      model: searchRecord.model,
      protocol: 'responses',
    }));
    h.deps.generateSearchKeywords = generate;
    h.deps.searchHistory = {
      list: async () => [],
      save: async () => undefined,
      clear: async () => undefined,
    };
    await configure(h);
    const gate = deferred<void>();
    h.permissionGranted.delay = gate.promise;
    const pending = settle(
      h.coordinator.handleCommand({
        kind: 'search/generate',
        operationId: 'search-op-1',
        query: searchRecord.query,
      }),
    );
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 30 } },
    });
    h.permissionGranted.delay = undefined;
    gate.resolve();
    expect(await pending).toMatchObject({ record: { query: searchRecord.query } });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe('capability message limits', () => {
  it('truncates a long local recognition description instead of emptying the snapshot', async () => {
    const h = harness();
    await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    content.trackData();
    await h.coordinator.idle();
    h.deps.checkLocalAsrHealth = async () => ({
      status: 'ok',
      ready: true,
      model: 'm'.repeat(200),
      device: 'd'.repeat(100),
    });
    const report = await check(h, 'asr');
    expect(ConnectionReportSchema.safeParse(report).success).toBe(true);
    const message = report.items[0]!.message;
    expect(message.length).toBeLessThanOrEqual(CAPABILITY_MESSAGE_MAX);
    expect(message).toContain('配对令牌将在首次识别时验证');
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.capabilities.localAsr?.status).toBe('verified');
    expect(snapshot.lastConnectionReport?.items[0]?.key).toBe('localAsr');
  });

  it('truncates a long service error message and reason code', async () => {
    const h = harness();
    await configure(h, { asr: true });
    h.deps.checkLocalAsrHealth = async () => ({
      status: 'error',
      ready: false,
      error: {
        code: 'asr-error',
        category: 'asr',
        retryable: true,
        message: '服务错误'.repeat(200),
      },
    });
    const report = await check(h, 'asr');
    expect(ConnectionReportSchema.safeParse(report).success).toBe(true);
    expect(report.items[0]!.message.length).toBeLessThanOrEqual(CAPABILITY_MESSAGE_MAX);
    expect(h.coordinator.buildSnapshot(1).capabilities.localAsr?.status).toBe('failed');
  });

  it('drops only invalid capability entries loaded after a worker restart', async () => {
    const session = new MemoryArea();
    const valid = { status: 'verified', configRevision: 0, message: '认证通过' };
    session.data.set('capabilities', {
      auth: valid,
      localAsr: { status: 'verified', configRevision: 0, message: 'x'.repeat(400) },
      tts: { status: 'bogus', configRevision: 0 },
      notACapability: valid,
    });
    const h = harness({ session });
    await h.coordinator.ready;
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.capabilities).toEqual({ auth: valid });
    // 清理后的结果写回，下次重启不再读到非法项。
    await vi.waitFor(() => expect(session.data.get('capabilities')).toEqual({ auth: valid }));
  });

  it('drops an invalid in-memory capability without clearing sessions and pages', async () => {
    const h = harness();
    await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    content.trackData();
    await h.coordinator.idle();
    await check(h, 'tts');
    const internals = h.coordinator as unknown as { capabilities: Record<string, unknown> };
    internals.capabilities.tts = { status: 'verified', configRevision: -1 };
    const snapshot = h.coordinator.buildSnapshot(1);
    expect(snapshot.sessions).toHaveLength(1);
    expect(snapshot.pages).toHaveLength(1);
    expect(snapshot.capabilities.tts).toBeUndefined();
    expect(snapshot.capabilities.systemTts?.status).toBe('verified');
  });

  it('truncates by UTF-16 length without splitting surrogate pairs', () => {
    expect(truncateText('short', 10)).toBe('short');
    const emoji = '😀'.repeat(10);
    const cut = truncateText(emoji, 6);
    expect(cut.length).toBeLessThanOrEqual(6);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).toBe('😀😀…');
    expect(
      clampCapabilityFields({
        status: 'failed' as const,
        configRevision: 0,
        message: 'a'.repeat(500),
        reasonCode: 'r'.repeat(100),
        latencyMs: -5,
      }),
    ).toEqual({
      status: 'failed',
      configRevision: 0,
      message: `${'a'.repeat(CAPABILITY_MESSAGE_MAX - 1)}…`,
      reasonCode: 'r'.repeat(80),
      latencyMs: undefined,
    });
    expect(parseCapabilityMatrix(null)).toEqual({ matrix: {}, dropped: 0 });
    expect(parseCapabilityMatrix([1, 2])).toEqual({ matrix: {}, dropped: 0 });
  });
});

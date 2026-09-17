import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OffscreenToBackgroundSchema,
  type MediaAnchor,
  type OffscreenEvent,
  type OffscreenToBackground,
} from '@src/messaging/offscreen-protocol';
import { PORT_OFFSCREEN } from '@src/messaging/ports';
import type { CaptureSession, CaptureStartRequest } from '@src/audio/offscreen/capture-session';
import {
  createOffscreenHost,
  type OffscreenHostDeps,
  type PortLike,
} from '@src/audio/offscreen/host';
import type { TtsPlayer } from '@src/audio/offscreen/tts-player';
import { OFFSCREEN_WAKE_TYPE } from '@src/audio/offscreen/wake';
import { deferred } from './fakes';

class FakePort implements PortLike {
  readonly sent: OffscreenToBackground[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  disconnected = false;
  constructor(readonly name: string) {}
  postMessage(message: unknown) {
    if (this.disconnected) throw new Error('disconnected');
    const parsed = OffscreenToBackgroundSchema.safeParse(message);
    expect(parsed.success).toBe(true);
    this.sent.push(message as OffscreenToBackground);
  }
  disconnect() {
    this.disconnected = true;
  }
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.messageListeners.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disconnectListeners.push(fn) };
  deliver(message: unknown) {
    for (const l of this.messageListeners) l(message);
  }
  /** 模拟 worker 挂起/重启导致端口断开。 */
  drop() {
    this.disconnected = true;
    for (const l of this.disconnectListeners) l();
  }
  replies() {
    return this.sent.filter(
      (m): m is Extract<OffscreenToBackground, { type: 'reply' }> => m.type === 'reply',
    );
  }
  events() {
    return this.sent
      .filter((m): m is Extract<OffscreenToBackground, { type: 'event' }> => m.type === 'event')
      .map((m) => m.event);
  }
}

const anchor: MediaAnchor = {
  epochMs: 0,
  mediaTimeMs: 0,
  playbackRate: 1,
  paused: false,
  seeking: false,
  buffering: false,
  ad: false,
  discontinuityId: 0,
};

function startReq(leaseId: string, ttl = 10_000): CaptureStartRequest {
  return {
    kind: 'capture/start',
    leaseId,
    owner: { sessionId: 'session-0001', tabId: 3, epoch: 0 },
    leaseTtlMs: ttl,
    streamId: 'sid',
    asr: { backend: 'local', baseUrl: 'http://127.0.0.1:8765', token: 't' },
    language: 'auto',
    segmentMs: 5000,
    originalVolume: 1,
    anchor,
  };
}

function fakeSession(
  req: CaptureStartRequest,
  hooks: { emit(e: OffscreenEvent): void; onEnded(reason: string): void },
) {
  let state: CaptureSession['state'] = 'requesting';
  let stopPromise: Promise<unknown> | null = null;
  const startGate = deferred<void>();
  const s = {
    leaseId: req.leaseId,
    get state() {
      return state;
    },
    get isStopping() {
      return stopPromise !== null;
    },
    activeTracks: 1,
    pendingRequests: 0,
    asrBacklogMs: 0,
    audioContextState: 'running',
    asrState: () => 'running',
    startGate,
    startPromise: null as Promise<{ sampleRate: number }> | null,
    // 与真实 CaptureSession 一致：start 只执行一次，重复调用返回同一 promise
    start: vi.fn(() => {
      s.startPromise ??= (async () => {
        await startGate.promise;
        if (stopPromise) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
        state = 'active';
        hooks.emit({
          kind: 'capture/started',
          leaseId: req.leaseId,
          owner: req.owner,
          sampleRate: 48000,
        });
        return { sampleRate: 48000 };
      })();
      return s.startPromise;
    }),
    stop: vi.fn((reason: string) => {
      stopPromise ??= (async () => {
        // 真实释放（track.stop、ctx.close）是异步的：延迟完成
        await new Promise((r) => setTimeout(r, 5));
        state = 'ended';
        s.activeTracks = 0;
        hooks.emit({
          kind: 'capture/ended',
          leaseId: req.leaseId,
          owner: req.owner,
          reason: reason as 'stopped',
        });
        hooks.onEnded(reason);
        return { released: [], failed: [] };
      })();
      return stopPromise;
    }),
    setEpoch: vi.fn(),
    setRecognition: vi.fn(),
    setOriginalGain: vi.fn(),
    addAnchor: vi.fn(),
    diagnostics: vi.fn(() => ({})),
  };
  return s;
}

function setup(overrides: Partial<OffscreenHostDeps> = {}) {
  const ports: FakePort[] = [];
  const sessions: ReturnType<typeof fakeSession>[] = [];
  let wakeListener: Parameters<OffscreenHostDeps['onRuntimeMessage']>[0] | null = null;
  const tts = {
    busy: false,
    pendingRequests: 0,
    state: 'idle',
    contextState: () => 'none',
    play: vi.fn(),
    stop: vi.fn(() => false),
    clearCache: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  let id = 0;
  const host = createOffscreenHost({
    connect: (name) => {
      const p = new FakePort(name);
      ports.push(p);
      return p;
    },
    onRuntimeMessage: (l) => {
      wakeListener = l;
      return () => {
        wakeListener = null;
      };
    },
    runtimeId: 'ext-id',
    extensionOrigin: 'chrome-extension://ext-id',
    createCaptureSession: (req, hooks) => {
      const s = fakeSession(req, hooks);
      sessions.push(s);
      return s as unknown as CaptureSession;
    },
    createTtsPlayer: () => tts as unknown as TtsPlayer,
    now: () => Date.now(),
    randomId: (p = '') => `${p}${++id}`,
    ...overrides,
  });
  const request = (port: FakePort, request: unknown, requestId = `r${++id}`) => {
    port.deliver({ type: 'request', requestId, request });
    return requestId;
  };
  return { host, ports, sessions, tts, request, wake: () => wakeListener };
}

describe('offscreen host', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('connects on start and sends hello with real status', () => {
    const { host, ports } = setup();
    host.start();
    expect(ports).toHaveLength(1);
    expect(ports[0]!.name).toBe(PORT_OFFSCREEN);
    expect(ports[0]!.sent[0]).toMatchObject({
      type: 'hello',
      protocolVersion: 1,
      status: { lease: null, resources: { capture: 'none', activeTracks: 0 } },
    });
  });

  it('starts capture under a lease, answers status, and stops idempotently', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    const rid = request(port, startReq('lease-aaaa-1'));
    await vi.advanceTimersByTimeAsync(10);
    expect(host.status().resources.capture).toBe('requesting');
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === rid)).toMatchObject({
      ok: true,
      data: { sampleRate: 48000 },
    });
    expect(host.status().lease?.leaseId).toBe('lease-aaaa-1');
    // 同一租约重复 start 不重复捕获
    request(port, startReq('lease-aaaa-1'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions).toHaveLength(1);
    const stop1 = request(port, { kind: 'capture/stop', leaseId: 'lease-aaaa-1', reason: 'user' });
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === stop1)).toMatchObject({
      ok: true,
      data: { stopped: true, activeTracks: 0 },
    });
    const stop2 = request(port, { kind: 'capture/stop', leaseId: 'lease-aaaa-1', reason: 'user' });
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === stop2)).toMatchObject({
      ok: true,
      data: { stopped: false },
    });
    expect(host.status()).toMatchObject({ lease: null, resources: { capture: 'none' } });
    expect(port.events().map((e) => e.kind)).toEqual(['capture/started', 'capture/ended']);
  });

  it('T10/T14: stop arriving during start replies after release and start fails', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    const startId = request(port, startReq('lease-bbbb-1'));
    await vi.advanceTimersByTimeAsync(10);
    const stopId = request(port, { kind: 'capture/stop', leaseId: 'lease-bbbb-1', reason: 'user' });
    await vi.advanceTimersByTimeAsync(10);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === stopId)).toMatchObject({
      ok: true,
      data: { stopped: true },
    });
    expect(port.replies().find((r) => r.requestId === startId)).toMatchObject({ ok: false });
    expect(host.status().lease).toBeNull();
    // 之后可以用新租约重新开始（不会因 busy 丢弃新意图）
    request(port, startReq('lease-bbbb-2'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions).toHaveLength(2);
  });

  it('supersedes an existing capture when a different lease starts', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port, startReq('lease-cccc-1'));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    request(port, startReq('lease-cccc-2'));
    await vi.advanceTimersByTimeAsync(10);
    expect(sessions[0]!.stop).toHaveBeenCalledWith('superseded');
    expect(host.status().lease?.leaseId).toBe('lease-cccc-2');
  });

  it('rejects lease-scoped requests with a mismatched lease', async () => {
    const { host, ports, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    const rid = request(port, { kind: 'capture/set-epoch', leaseId: 'lease-none-1', epoch: 3 });
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === rid)).toMatchObject({
      ok: false,
      error: { code: 'lease-mismatch' },
    });
  });

  it('T21: stops capture and playback when the lease is not renewed', async () => {
    const { host, ports, sessions, tts, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port, startReq('lease-dddd-1', 10_000));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(6_000);
    const renewAt = Date.now();
    const renew = request(port, { kind: 'lease/renew', leaseId: 'lease-dddd-1', ttlMs: 10_000 });
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === renew)).toMatchObject({
      ok: true,
      data: { expiresAtEpochMs: renewAt + 10_000 },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sessions[0]!.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessions[0]!.stop).toHaveBeenCalledWith(
      'lease-expired',
      expect.objectContaining({ code: 'lease-expired' }),
    );
    expect(tts.stop).toHaveBeenCalled();
    expect(host.status().lease).toBeNull();
  });

  it('T21: after worker restart, the orphan lease is shortened to the handshake grace period', async () => {
    const { host, ports, sessions, request } = setup({ handshakeGraceMs: 5_000 });
    host.start();
    const port1 = ports[0]!;
    port1.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port1, startReq('lease-eeee-1', 60_000));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    port1.drop();
    // 有租约 → 退避重连
    await vi.advanceTimersByTimeAsync(250);
    expect(ports).toHaveLength(2);
    const port2 = ports[1]!;
    expect(port2.sent[0]).toMatchObject({
      type: 'hello',
      status: { lease: { leaseId: 'lease-eeee-1' } },
    });
    port2.deliver({ type: 'welcome', workerInstanceId: 'wk2' });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sessions[0]!.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sessions[0]!.stop).toHaveBeenCalledWith('lease-expired', expect.anything());
  });

  it('new worker can adopt the lease by renewing within the grace period', async () => {
    const { host, ports, sessions, request } = setup({ handshakeGraceMs: 5_000 });
    host.start();
    ports[0]!.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(ports[0]!, startReq('lease-ffff-1', 60_000));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    ports[0]!.drop();
    await vi.advanceTimersByTimeAsync(250);
    ports[1]!.deliver({ type: 'welcome', workerInstanceId: 'wk2' });
    request(ports[1]!, { kind: 'lease/renew', leaseId: 'lease-ffff-1', ttlMs: 30_000 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessions[0]!.stop).not.toHaveBeenCalled();
  });

  it('does not reconnect when idle (no keep-alive loop) and reconnects on wake', async () => {
    const { host, ports, wake } = setup();
    host.start();
    ports[0]!.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    ports[0]!.drop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ports).toHaveLength(1);
    const respond = vi.fn();
    const worker = { id: 'ext-id', url: 'chrome-extension://ext-id/background.js' };
    wake()!({ type: 'other' }, worker, respond);
    wake()!({ type: OFFSCREEN_WAKE_TYPE }, { ...worker, id: 'someone-else' }, respond);
    // 来自标签页（例如内容脚本）或非扩展 origin 的发送方被拒绝
    wake()!({ type: OFFSCREEN_WAKE_TYPE }, { ...worker, tab: { id: 3 } }, respond);
    wake()!(
      { type: OFFSCREEN_WAKE_TYPE },
      { id: 'ext-id', url: 'https://www.youtube.com/watch?v=x' },
      respond,
    );
    wake()!({ type: OFFSCREEN_WAKE_TYPE }, { id: 'ext-id' }, respond);
    expect(ports).toHaveLength(1);
    expect(respond).not.toHaveBeenCalled();
    wake()!({ type: OFFSCREEN_WAKE_TYPE }, worker, respond);
    expect(ports).toHaveLength(2);
    expect(respond).toHaveBeenCalledWith({ ok: true });
  });

  it('stops cloud TTS when the worker port disconnects', () => {
    const { host, ports, tts } = setup();
    host.start();
    ports[0]!.drop();
    expect(tts.stop).toHaveBeenCalled();
  });

  it('buffers asr results while disconnected and flushes them after welcome', async () => {
    const emitted: { emit(e: OffscreenEvent): void }[] = [];
    const { host, ports, sessions, request } = setup({
      createCaptureSession: (req, hooks) => {
        emitted.push(hooks);
        const s = fakeSession(req, hooks);
        sessions.push(s);
        return s as unknown as CaptureSession;
      },
    });
    host.start();
    ports[0]!.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(ports[0]!, startReq('lease-gggg-1', 60_000));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    ports[0]!.drop();
    emitted[0]!.emit({
      kind: 'asr/result',
      leaseId: 'lease-gggg-1',
      owner: { sessionId: 'session-0001', tabId: 3, epoch: 0 },
      segmentId: 'seg1:0',
      startMs: 0,
      endMs: 1000,
      endEstimated: false,
      text: 'hi',
      final: true,
      revision: 0,
    });
    emitted[0]!.emit({
      kind: 'asr/status',
      leaseId: 'lease-gggg-1',
      owner: { sessionId: 'session-0001', tabId: 3, epoch: 0 },
      state: 'running',
      backlogMs: 0,
    });
    await vi.advanceTimersByTimeAsync(250);
    const port2 = ports[1]!;
    expect(port2.events()).toHaveLength(0);
    port2.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    expect(port2.events().map((e) => e.kind)).toEqual(['asr/result']);
  });

  it('ignores malformed messages and dispatches tts requests', async () => {
    const { host, ports, tts, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    port.deliver({ type: 'request', requestId: 'x', request: { kind: 'capture/start' } });
    port.deliver('garbage');
    expect(port.replies()).toHaveLength(0);
    const play = request(port, {
      kind: 'tts/play',
      utteranceId: 'u1',
      owner: { sessionId: 'session-0001', tabId: 3, epoch: 0 },
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-not-real',
      model: 'tts-model',
      voice: 'v',
      text: '你好',
      speed: 1,
      volume: 1,
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(tts.play).toHaveBeenCalledTimes(1);
    expect(port.replies().find((r) => r.requestId === play)).toMatchObject({
      ok: true,
      data: { accepted: true },
    });
    // 回复中不回传凭证
    expect(JSON.stringify(port.sent)).not.toContain('sk-test-not-real');
    const stop = request(port, { kind: 'tts/stop', utteranceId: 'u1' });
    await vi.advanceTimersByTimeAsync(10);
    expect(tts.stop).toHaveBeenCalledWith('u1');
    expect(port.replies().find((r) => r.requestId === stop)).toMatchObject({
      ok: true,
      data: { stopped: false },
    });
  });

  it('dispose releases capture and player', async () => {
    const { host, ports, sessions, tts, request } = setup();
    host.start();
    ports[0]!.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(ports[0]!, startReq('lease-hhhh-1'));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const disposing = host.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await disposing;
    expect(sessions[0]!.stop).toHaveBeenCalled();
    expect(tts.dispose).toHaveBeenCalled();
    expect(ports[0]!.disconnected).toBe(true);
  });

  it('review#4: stop for a pending lease during superseding cancels that start (no session is created)', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port, startReq('lease-old-00001'));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const startNew = request(port, startReq('lease-new-00002'));
    // 旧会话 stop 尚未完成（延迟 5 ms）时，新租约已同步登记
    expect(host.status()).toMatchObject({
      lease: { leaseId: 'lease-new-00002' },
      resources: { capture: 'requesting' },
    });
    const stopId = request(port, {
      kind: 'capture/stop',
      leaseId: 'lease-new-00002',
      reason: 'user',
    });
    await vi.advanceTimersByTimeAsync(20);
    expect(port.replies().find((r) => r.requestId === stopId)).toMatchObject({
      ok: true,
      data: { stopped: true, cancelledStart: true },
    });
    expect(port.replies().find((r) => r.requestId === startNew)).toMatchObject({
      ok: false,
      error: { category: 'cancelled' },
    });
    expect(sessions).toHaveLength(1);
    expect(host.status()).toMatchObject({
      lease: null,
      resources: { capture: 'none', activeTracks: 0 },
    });
  });

  it('review#4: several starts during one superseding await leave no orphan; lease expiry and dispose cover all sessions', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port, startReq('lease-old-00001'));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    const a = request(port, startReq('lease-aaa-00002'));
    const b = request(port, startReq('lease-bbb-00003'));
    await vi.advanceTimersByTimeAsync(20);
    // aaa 被 bbb 作废，从未创建会话
    expect(sessions.map((x) => x.leaseId)).toEqual(['lease-old-00001', 'lease-bbb-00003']);
    expect(port.replies().find((r) => r.requestId === a)).toMatchObject({
      ok: false,
      error: { category: 'cancelled' },
    });
    sessions[1]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    expect(port.replies().find((r) => r.requestId === b)).toMatchObject({ ok: true });
    expect(sessions[0]!.stop).toHaveBeenCalledWith('superseded');
    expect(host.status()).toMatchObject({
      lease: { leaseId: 'lease-bbb-00003' },
      resources: { capture: 'active', activeTracks: 1 },
    });
    // 租约过期：当前会话停止
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sessions[1]!.stop).toHaveBeenCalledWith('lease-expired', expect.anything());
    expect(host.status()).toMatchObject({
      lease: null,
      resources: { capture: 'none', activeTracks: 0 },
    });
    const disposing = host.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await disposing;
  });

  it('dispose stops sessions that are still stopping or starting', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    ports[0]!.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(ports[0]!, startReq('lease-ddd-00001'));
    await vi.advanceTimersByTimeAsync(10);
    // 仍在 start 中
    const disposing = host.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await disposing;
    expect(sessions[0]!.stop).toHaveBeenCalled();
    expect(host.diagnostics().sessions).toBe(0);
  });

  it('buffers anchors and settings sent for a pending lease and applies them when the session is created', async () => {
    const { host, ports, sessions, request } = setup();
    host.start();
    const port = ports[0]!;
    port.deliver({ type: 'welcome', workerInstanceId: 'wk1' });
    request(port, startReq('lease-old-00001'));
    await vi.advanceTimersByTimeAsync(0);
    sessions[0]!.startGate.resolve();
    await vi.advanceTimersByTimeAsync(10);
    request(port, startReq('lease-eee-00002'));
    const renew = request(port, { kind: 'lease/renew', leaseId: 'lease-eee-00002', ttlMs: 30_000 });
    request(port, {
      kind: 'timeline/anchor',
      leaseId: 'lease-eee-00002',
      anchor: { ...anchor, discontinuityId: 5 },
    });
    request(port, { kind: 'capture/set-epoch', leaseId: 'lease-eee-00002', epoch: 4 });
    await vi.advanceTimersByTimeAsync(0);
    expect(port.replies().find((r) => r.requestId === renew)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(20);
    expect(sessions[1]!.addAnchor).toHaveBeenCalledWith(
      expect.objectContaining({ discontinuityId: 5 }),
    );
    expect(sessions[1]!.setEpoch).toHaveBeenCalledWith(4);
    const disposing = host.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await disposing;
  });
});

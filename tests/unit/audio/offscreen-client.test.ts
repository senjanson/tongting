import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Browser } from 'wxt/browser';
import {
  BackgroundToOffscreenSchema,
  type BackgroundToOffscreen,
  type OffscreenStatus,
} from '@src/messaging/offscreen-protocol';
import { PORT_OFFSCREEN } from '@src/messaging/ports';
import { createOffscreenClient, type OffscreenClientDeps } from '@src/audio/offscreen-client';

function status(p: Partial<OffscreenStatus> = {}): OffscreenStatus {
  return {
    offscreenInstanceId: 'off1',
    lease: null,
    resources: { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 },
    audioContextState: 'none',
    ttsPlaying: false,
    ...p,
  };
}

class WorkerSidePort {
  name = PORT_OFFSCREEN;
  sender = { id: 'ext', url: 'chrome-extension://ext/offscreen.html' };
  readonly sent: BackgroundToOffscreen[] = [];
  private msg: ((m: unknown) => void)[] = [];
  private disc: (() => void)[] = [];
  disconnected = false;
  /** 自动应答：返回 undefined 表示不应答。 */
  responder: ((req: Extract<BackgroundToOffscreen, { type: 'request' }>) => unknown) | null = null;
  onMessage = { addListener: (fn: (m: unknown) => void) => void this.msg.push(fn) };
  onDisconnect = { addListener: (fn: () => void) => void this.disc.push(fn) };
  postMessage(m: unknown) {
    expect(BackgroundToOffscreenSchema.safeParse(m).success).toBe(true);
    this.sent.push(m as BackgroundToOffscreen);
    const message = m as BackgroundToOffscreen;
    if (message.type === 'request' && this.responder) {
      const reply = this.responder(message);
      if (reply !== undefined) queueMicrotask(() => this.deliver(reply));
    }
  }
  disconnect = vi.fn(() => {
    this.disconnected = true;
  });
  deliver(m: unknown) {
    for (const l of this.msg) l(m);
  }
  drop() {
    for (const l of this.disc) l();
  }
  hello(s = status()) {
    this.deliver({ type: 'hello', protocolVersion: 1, status: s });
  }
}

function setup(over: Partial<OffscreenClientDeps> = {}) {
  let docExists = false;
  const ports: WorkerSidePort[] = [];
  const statusRef = { current: status() };
  const hasDocument = vi.fn(async () => docExists);
  const createDocument = vi.fn(async () => {
    docExists = true;
    // 模拟文档加载后连接并发送 hello
    setTimeout(() => {
      const p = new WorkerSidePort();
      p.responder = (req) => ({
        type: 'reply',
        requestId: req.requestId,
        ok: true,
        data: req.request.kind === 'status' ? statusRef.current : { ok: 1 },
      });
      ports.push(p);
      client.handlePort(p as unknown as Browser.runtime.Port);
      p.hello(statusRef.current);
    }, 50);
  });
  const client = createOffscreenClient({
    hasDocument,
    createDocument,
    closeDocument: vi.fn(async () => {
      docExists = false;
    }),
    sendWake: vi.fn(async () => undefined),
    verifyPort: (port) =>
      (port as unknown as WorkerSidePort).sender.url.endsWith('/offscreen.html'),
    randomId: (() => {
      let n = 0;
      return (p = '') => `${p}${++n}`;
    })(),
    logger: { warn: vi.fn(), info: vi.fn() },
    helloTimeoutMs: 1_000,
    defaultRequestTimeoutMs: 500,
    ...over,
  });
  return {
    client,
    ports,
    statusRef,
    createDocument,
    hasDocument,
    setDoc: (v: boolean) => (docExists = v),
  };
}

describe('offscreen client', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('deduplicates concurrent ensure() and creates the document once', async () => {
    const { client, ports, createDocument, hasDocument } = setup();
    const a = client.ensure();
    const b = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await expect(a).resolves.toMatchObject({ offscreenInstanceId: 'off1' });
    await expect(b).resolves.toMatchObject({ offscreenInstanceId: 'off1' });
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent[0]).toEqual({
      type: 'welcome',
      workerInstanceId: client.workerInstanceId,
    });
    expect(createDocument).toHaveBeenCalledTimes(1);
    expect(hasDocument).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(true);
    // 已连接后再次 ensure 不再查询/创建文档
    await client.ensure();
    expect(createDocument).toHaveBeenCalledTimes(1);
  });

  it('wakes an existing document instead of creating another', async () => {
    const sendWake = vi.fn(async () => undefined);
    const createDocument = vi.fn(async () => undefined);
    const { client, setDoc } = setup({ sendWake, createDocument });
    setDoc(true);
    const p = client.ensure();
    await vi.advanceTimersByTimeAsync(10);
    expect(sendWake).toHaveBeenCalled();
    expect(createDocument).not.toHaveBeenCalled();
    const port = new WorkerSidePort();
    port.responder = (req) => ({
      type: 'reply',
      requestId: req.requestId,
      ok: true,
      data: status(),
    });
    client.handlePort(port as unknown as Browser.runtime.Port);
    port.hello();
    await vi.advanceTimersByTimeAsync(10);
    await expect(p).resolves.toMatchObject({ lease: null });
  });

  it('fails clearly when a new document never says hello', async () => {
    const { client } = setup({ createDocument: vi.fn(async () => undefined) });
    const p = client.ensure();
    const assertion = expect(p).rejects.toMatchObject({ info: { code: 'offscreen-unresponsive' } });
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;
  });

  it('maps createDocument failure to a visible error (T22)', async () => {
    const { client } = setup({
      createDocument: vi.fn(async () => {
        throw new Error('Offscreen API unavailable');
      }),
    });
    await expect(client.ensure()).rejects.toMatchObject({
      info: { code: 'offscreen-create-failed', category: 'audio' },
    });
  });

  it('times out requests and cleans them up; replies after timeout are ignored', async () => {
    const { client, ports } = setup();
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    ports[0]!.responder = () => undefined;
    const p = client.request({ kind: 'status' }, 300);
    const assertion = expect(p).rejects.toMatchObject({
      info: { code: 'offscreen-timeout', category: 'timeout' },
    });
    await vi.advanceTimersByTimeAsync(301);
    await assertion;
    const req = ports[0]!.sent.filter((m) => m.type === 'request').at(-1) as Extract<
      BackgroundToOffscreen,
      { type: 'request' }
    >;
    ports[0]!.deliver({ type: 'reply', requestId: req.requestId, ok: true, data: 1 });
  });

  it('rejects pending requests when the port disconnects (worker ↔ offscreen)', async () => {
    const { client, ports } = setup();
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    ports[0]!.responder = () => undefined;
    const p = client.request({
      kind: 'capture/set-recognition',
      leaseId: 'lease-0000-1',
      enabled: false,
    });
    ports[0]!.drop();
    await expect(p).rejects.toMatchObject({ info: { code: 'offscreen-disconnected' } });
    expect(client.isConnected()).toBe(false);
  });

  it('propagates error replies as AppError and validates outgoing requests', async () => {
    const { client, ports } = setup();
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    ports[0]!.responder = (req) => ({
      type: 'reply',
      requestId: req.requestId,
      ok: false,
      error: { code: 'lease-mismatch', category: 'capture', retryable: false, message: 'x' },
    });
    await expect(
      client.request({ kind: 'lease/renew', leaseId: 'lease-0000-1', ttlMs: 10_000 }),
    ).rejects.toMatchObject({ info: { code: 'lease-mismatch' } });
    const sentBefore = ports[0]!.sent.length;
    await expect(
      client.request({ kind: 'lease/renew', leaseId: 'short', ttlMs: 10 } as never),
    ).rejects.toMatchObject({ info: { code: 'offscreen-bad-request' } });
    expect(ports[0]!.sent.length).toBe(sentBefore);
  });

  it('stop requests without a document are idempotent and do not create one', async () => {
    const createDocument = vi.fn(async () => undefined);
    const { client } = setup({ createDocument });
    await expect(
      client.request({ kind: 'capture/stop', leaseId: 'lease-0000-1', reason: 'x' }),
    ).resolves.toEqual({ stopped: false, reason: 'no-document' });
    await expect(client.request({ kind: 'tts/stop' })).resolves.toMatchObject({ stopped: false });
    await expect(
      client.request({ kind: 'lease/renew', leaseId: 'lease-0000-1', ttlMs: 10_000 }),
    ).rejects.toMatchObject({ info: { code: 'offscreen-missing' } });
    await expect(client.queryStatus()).resolves.toBeNull();
    expect(createDocument).not.toHaveBeenCalled();
  });

  it('delivers validated events and hello notifications; bad messages are dropped', async () => {
    const { client, ports } = setup();
    const events: string[] = [];
    const hellos: OffscreenStatus[] = [];
    client.onEvent(() => {
      throw new Error('listener bug');
    });
    const off = client.onEvent((e) => events.push(e.kind));
    client.onHello((s) => hellos.push(s));
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    expect(hellos).toHaveLength(1);
    ports[0]!.deliver({
      type: 'event',
      event: { kind: 'tts/event', utteranceId: 'u', event: 'start' },
    });
    ports[0]!.deliver({
      type: 'event',
      event: { kind: 'tts/event', utteranceId: 'u', event: 'bogus' },
    });
    ports[0]!.deliver({ type: 'hello', protocolVersion: 99, status: status() });
    expect(events).toEqual(['tts/event']);
    off();
    ports[0]!.deliver({
      type: 'event',
      event: { kind: 'tts/event', utteranceId: 'u', event: 'end' },
    });
    expect(events).toEqual(['tts/event']);
  });

  it('closeIfIdle keeps a busy document and closes an idle one', async () => {
    const closeDocument = vi.fn(async () => undefined);
    const { client, statusRef } = setup({ closeDocument });
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    statusRef.current = status({
      lease: {
        leaseId: 'lease-0000-1',
        owner: { sessionId: 'session-0001', tabId: 1, epoch: 0 },
        expiresAtEpochMs: 1,
      },
      resources: {
        capture: 'active',
        asr: 'running',
        tts: 'idle',
        activeTracks: 1,
        pendingRequests: 0,
      },
    });
    await expect(client.closeIfIdle()).resolves.toBe(false);
    statusRef.current = status({ ttsPlaying: true });
    await expect(client.closeIfIdle()).resolves.toBe(false);
    expect(closeDocument).not.toHaveBeenCalled();
    statusRef.current = status();
    await expect(client.closeIfIdle()).resolves.toBe(true);
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(client.isConnected()).toBe(false);
  });

  it('closeIfIdle does not close while a capture/start is being prepared', async () => {
    const closeDocument = vi.fn(async () => undefined);
    const { client, ports } = setup({ closeDocument });
    const start = client.request({
      kind: 'capture/start',
      leaseId: 'lease-0000-1',
      owner: { sessionId: 'session-0001', tabId: 1, epoch: 0 },
      leaseTtlMs: 10_000,
      streamId: 's',
      asr: { backend: 'local', baseUrl: 'http://127.0.0.1:8765', token: 't' },
      language: 'auto',
      segmentMs: 5_000,
      originalVolume: 1,
      anchor: {
        epochMs: 0,
        mediaTimeMs: 0,
        playbackRate: 1,
        paused: false,
        seeking: false,
        buffering: false,
        ad: false,
        discontinuityId: 0,
      },
    });
    const closing = client.closeIfIdle();
    await vi.advanceTimersByTimeAsync(100);
    await expect(closing).resolves.toBe(false);
    await expect(start).resolves.toEqual({ ok: 1 });
    expect(closeDocument).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
  });

  it('rejects unverified ports and replaces an older port', async () => {
    const { client, ports } = setup();
    const bad = new WorkerSidePort();
    bad.sender = { id: 'ext', url: 'chrome-extension://ext/popup.html' };
    client.handlePort(bad as unknown as Browser.runtime.Port);
    expect(bad.disconnect).toHaveBeenCalled();
    const ensure = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await ensure;
    ports[0]!.responder = () => undefined;
    const pending = client.request({ kind: 'status' }, 5_000);
    const replacement = new WorkerSidePort();
    client.handlePort(replacement as unknown as Browser.runtime.Port);
    await expect(pending).rejects.toMatchObject({ info: { code: 'offscreen-reconnected' } });
    expect(ports[0]!.disconnect).toHaveBeenCalled();
    // 旧端口的迟到消息被忽略
    ports[0]!.hello(status({ offscreenInstanceId: 'stale' }));
    expect(client.lastHello()).toBeNull();
  });

  const ttsPlay = {
    kind: 'tts/play' as const,
    utteranceId: 'dub-1~1',
    owner: { sessionId: 'session-0001', tabId: 1, epoch: 0 },
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    text: '你好',
    speed: 1,
    volume: 1,
  };
  const requestKinds = (port: WorkerSidePort) =>
    port.sent
      .filter((m) => m.type === 'request')
      .map((m) => (m as { request: { kind: string } }).request.kind);

  it('review#3: while the document is being created, tts/stop waits and is sent after the play it cancels', async () => {
    const { client, ports } = setup();
    const playP = client.request(ttsPlay);
    const stopP = client.request({ kind: 'tts/stop', utteranceId: ttsPlay.utteranceId });
    await vi.advanceTimersByTimeAsync(100);
    await expect(stopP).resolves.not.toMatchObject({ reason: 'no-document' });
    await playP;
    expect(requestKinds(ports[0]!)).toEqual(['tts/play', 'tts/stop']);
  });

  it('review#3: document exists but not connected: requests keep call order', async () => {
    const { client, setDoc } = setup({
      sendWake: vi.fn(async () => {
        setTimeout(() => {
          if (wakePorts.length) return;
          const p = new WorkerSidePort();
          p.responder = (req) => ({
            type: 'reply',
            requestId: req.requestId,
            ok: true,
            data: req.request.kind === 'status' ? status() : {},
          });
          wakePorts.push(p);
          wakeClient.handlePort(p as unknown as Browser.runtime.Port);
          p.hello();
        }, 30);
      }),
    });
    const wakePorts: WorkerSidePort[] = [];
    const wakeClient = client;
    setDoc(true);
    const playP = client.request(ttsPlay);
    const stopP = client.request({ kind: 'tts/stop', utteranceId: ttsPlay.utteranceId });
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([playP, stopP]);
    expect(requestKinds(wakePorts[0]!)).toEqual(['tts/play', 'tts/stop']);
  });

  it('onConnectionLost: port disconnect, document missing and instance change are signalled; intentional close is not', async () => {
    const { client, ports, statusRef, setDoc } = setup();
    const lost: Array<{ reason: string; previousInstanceId?: string; instanceId?: string }> = [];
    client.onConnectionLost((info) => lost.push(info));
    const e1 = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await e1;
    ports[0]!.drop();
    expect(lost).toEqual([{ reason: 'port-disconnected', previousInstanceId: 'off1' }]);
    // 文档已被浏览器销毁：下一次创建前报告 document-missing；新实例握手报告 instance-changed
    setDoc(false);
    statusRef.current = status({ offscreenInstanceId: 'off2' });
    const e2 = client.ensure();
    await vi.advanceTimersByTimeAsync(100);
    await e2;
    expect(lost.map((l) => l.reason)).toEqual(['port-disconnected', 'document-missing']);
    // 同一文档重连但实例变化（例如文档被重建后才连上）
    ports[1]!.hello(status({ offscreenInstanceId: 'off3' }));
    expect(lost.at(-1)).toEqual({
      reason: 'instance-changed',
      previousInstanceId: 'off2',
      instanceId: 'off3',
    });
    const count = lost.length;
    statusRef.current = status({ offscreenInstanceId: 'off3' });
    await expect(client.closeIfIdle()).resolves.toBe(true);
    expect(lost).toHaveLength(count);
  });
});

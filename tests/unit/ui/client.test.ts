import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import { PORT_UI } from '@src/messaging/ports';
import type { UiToBackground } from '@src/messaging/ui-protocol';
import { BackgroundClient, type PortLike } from '@src/ui/state/client';
import { makeCue, makeSnapshot } from './fixtures';

class FakePort implements PortLike {
  readonly sent: UiToBackground[] = [];
  disconnected = false;
  throwOnPost = false;
  private messageListeners = new Set<(m: unknown) => void>();
  private disconnectListeners = new Set<() => void>();
  onMessage = {
    addListener: (cb: (m: unknown) => void) => void this.messageListeners.add(cb),
    removeListener: (cb: (m: unknown) => void) => void this.messageListeners.delete(cb),
  };
  onDisconnect = {
    addListener: (cb: () => void) => void this.disconnectListeners.add(cb),
    removeListener: (cb: () => void) => void this.disconnectListeners.delete(cb),
  };
  postMessage(message: unknown) {
    if (this.throwOnPost) throw new Error('Attempting to use a disconnected port object');
    this.sent.push(message as UiToBackground);
  }
  disconnect() {
    this.disconnected = true;
  }
  /** worker → UI */
  emit(message: unknown) {
    for (const cb of [...this.messageListeners]) cb(message);
  }
  /** 模拟 worker 被回收或重启导致端口断开 */
  drop() {
    for (const cb of [...this.disconnectListeners]) cb();
  }
  commands() {
    return this.sent.filter(
      (m): m is Extract<UiToBackground, { type: 'command' }> => m.type === 'command',
    );
  }
}

let ports: FakePort[];
let client: BackgroundClient;

function lastPort(): FakePort {
  return ports[ports.length - 1]!;
}

beforeEach(() => {
  vi.useFakeTimers();
  ports = [];
  client = new BackgroundClient({
    surface: 'sidepanel',
    connect: (name) => {
      expect(name).toBe(PORT_UI);
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    handshakeTimeoutMs: 5_000,
    reconnectDelaysMs: [100, 500],
  });
  client.start();
});

afterEach(() => {
  client.stop();
  vi.useRealTimers();
});

describe('BackgroundClient connection', () => {
  it('subscribes on connect and becomes connected on the first valid snapshot', () => {
    expect(lastPort().sent[0]).toEqual({
      type: 'subscribe',
      protocolVersion: 1,
      surface: 'sidepanel',
    });
    expect(client.getState().connection).toBe('connecting');
    lastPort().emit({ type: 'snapshot', snapshot: { bogus: true } });
    expect(client.getState().connection).toBe('connecting');
    lastPort().emit({ type: 'snapshot', snapshot: makeSnapshot({ snapshotVersion: 3 }) });
    expect(client.getState()).toMatchObject({ connection: 'connected', reconnectAttempts: 0 });
    lastPort().emit({ type: 'snapshot', snapshot: makeSnapshot({ snapshotVersion: 2 }) });
    expect(client.getState().snapshot?.snapshotVersion).toBe(3);
  });

  it('reconnects after the port drops, shows reconnecting, and accepts a restarted worker sequence', () => {
    const first = lastPort();
    first.emit({ type: 'snapshot', snapshot: makeSnapshot({ snapshotVersion: 30 }) });
    first.drop();
    expect(client.getState().connection).toBe('reconnecting');
    expect(client.getState().snapshot?.snapshotVersion).toBe(30); // 保留最后状态并提示正在重连
    vi.advanceTimersByTime(100);
    expect(ports).toHaveLength(2);
    // 旧端口的迟到消息被忽略
    first.emit({ type: 'snapshot', snapshot: makeSnapshot({ snapshotVersion: 31 }) });
    expect(client.getState().snapshot?.snapshotVersion).toBe(30);
    lastPort().emit({
      type: 'snapshot',
      snapshot: makeSnapshot({ snapshotVersion: 1, workerInstanceId: 'worker-b' }),
    });
    expect(client.getState()).toMatchObject({ connection: 'connected' });
    expect(client.getState().snapshot?.workerInstanceId).toBe('worker-b');
  });

  it('reconnects when no snapshot arrives before the handshake timeout', () => {
    vi.advanceTimersByTime(5_000);
    expect(ports[0]!.disconnected).toBe(true);
    vi.advanceTimersByTime(100);
    expect(ports).toHaveLength(2);
  });

  it('retries when connect itself throws', () => {
    client.stop();
    let attempts = 0;
    const flaky = new BackgroundClient({
      surface: 'popup',
      connect: () => {
        attempts++;
        if (attempts === 1) throw new Error('Extension context invalidated');
        const port = new FakePort();
        ports.push(port);
        return port;
      },
      reconnectDelaysMs: [50],
    });
    flaky.start();
    expect(flaky.getState().connection).toBe('connecting');
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);
    flaky.stop();
  });
});

describe('BackgroundClient commands', () => {
  beforeEach(() => {
    lastPort().emit({ type: 'snapshot', snapshot: makeSnapshot() });
  });

  it('sends the original command (no schema defaults) with requestId and resolves validated results', async () => {
    const promise = client.sendCommand({
      kind: 'settings/update',
      patch: { targetLanguage: 'ja' },
    });
    const [command] = lastPort().commands();
    expect(command?.command).toEqual({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    expect(command?.requestId).toMatch(/^ui/);
    lastPort().emit({
      type: 'result',
      requestId: command!.requestId,
      ok: true,
      data: { persisted: false },
    });
    await expect(promise).resolves.toEqual({ persisted: false });
  });

  it('rejects with the worker error message when ok=false', async () => {
    const promise = client.sendCommand({ kind: 'session/start', tabId: 1 });
    const [command] = lastPort().commands();
    lastPort().emit({
      type: 'result',
      requestId: command!.requestId,
      ok: false,
      error: {
        code: 'no-key',
        category: 'config',
        retryable: false,
        message: '请先在设置中填写 API Key。',
      },
    });
    await expect(promise).rejects.toMatchObject({
      info: { message: '请先在设置中填写 API Key。' },
    });
  });

  it('rejects results that do not match the expected shape', async () => {
    const promise = client.sendCommand({ kind: 'tts/voices' });
    const [command] = lastPort().commands();
    lastPort().emit({
      type: 'result',
      requestId: command!.requestId,
      ok: true,
      data: { voices: 'nope' },
    });
    await expect(promise).rejects.toMatchObject({ info: { code: 'ui-invalid-result' } });
  });

  it('times out, and ignores a late result', async () => {
    const promise = client.sendCommand({ kind: 'session/pause', tabId: 1 }, { timeoutMs: 1_000 });
    const [command] = lastPort().commands();
    vi.advanceTimersByTime(1_000);
    await expect(promise).rejects.toMatchObject({ info: { code: 'ui-command-timeout' } });
    expect(() =>
      lastPort().emit({
        type: 'result',
        requestId: command!.requestId,
        ok: true,
        data: { accepted: true },
      }),
    ).not.toThrow();
  });

  it('fails pending commands with an unknown-outcome error when the port disconnects', async () => {
    const promise = client.sendCommand({ kind: 'session/stop', tabId: 1 });
    lastPort().drop();
    await expect(promise).rejects.toMatchObject({ info: { code: 'ui-port-disconnected' } });
  });

  it('refuses to send while not connected instead of queueing stale intent', async () => {
    lastPort().drop();
    await expect(client.sendCommand({ kind: 'session/start', tabId: 1 })).rejects.toBeInstanceOf(
      AppError,
    );
    vi.advanceTimersByTime(100);
    expect(lastPort().commands()).toHaveLength(0);
  });

  it('validates outgoing commands', async () => {
    await expect(
      client.sendCommand({ kind: 'tts/preview', rate: 99 } as never),
    ).rejects.toMatchObject({ info: { code: 'ui-invalid-command' } });
    expect(lastPort().commands()).toHaveLength(0);
  });
});

describe('BackgroundClient cues subscription', () => {
  it('subscribes, applies full + delta, releases, and resubscribes after reconnect', () => {
    lastPort().emit({ type: 'snapshot', snapshot: makeSnapshot() });
    const release = client.acquireCues('session-00000001');
    expect(lastPort().sent.at(-1)).toEqual({
      type: 'cues/subscribe',
      sessionId: 'session-00000001',
    });
    expect(client.getCuesState().status).toBe('loading');

    lastPort().emit({
      type: 'cues',
      sessionId: 'session-00000001',
      cueVersion: 2,
      full: true,
      cues: [makeCue('a', 0)],
    });
    lastPort().emit({
      type: 'cues',
      sessionId: 'session-00000001',
      cueVersion: 3,
      full: false,
      cues: [makeCue('b', 5_000)],
    });
    expect(client.getCuesState().cues.map((c) => c.id)).toEqual(['a', 'b']);

    lastPort().drop();
    vi.advanceTimersByTime(100);
    expect(lastPort().sent).toEqual([
      { type: 'subscribe', protocolVersion: 1, surface: 'sidepanel' },
      { type: 'cues/subscribe', sessionId: 'session-00000001' },
    ]);
    expect(client.getCuesState()).toMatchObject({ status: 'loading' });
    lastPort().emit({
      type: 'cues',
      sessionId: 'session-00000001',
      cueVersion: 0,
      full: true,
      cues: [makeCue('c', 0)],
    });
    expect(client.getCuesState().cues.map((c) => c.id)).toEqual(['c']);

    // 换视频：新会话订阅会替换旧会话，旧会话的消息被忽略
    const releaseNew = client.acquireCues('session-00000002');
    expect(lastPort().sent.at(-1)).toEqual({
      type: 'cues/subscribe',
      sessionId: 'session-00000002',
    });
    lastPort().emit({
      type: 'cues',
      sessionId: 'session-00000001',
      cueVersion: 9,
      full: true,
      cues: [makeCue('old', 0)],
    });
    expect(client.getCuesState()).toMatchObject({
      sessionId: 'session-00000002',
      status: 'loading',
    });

    releaseNew();
    expect(lastPort().sent.at(-1)).toEqual({
      type: 'cues/subscribe',
      sessionId: 'session-00000001',
    });
    release();
    expect(lastPort().sent.at(-1)).toEqual({ type: 'cues/subscribe', sessionId: null });
    expect(client.getCuesState().status).toBe('idle');
  });
});

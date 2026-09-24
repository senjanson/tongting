import { describe, expect, it, vi } from 'vitest';
import {
  CONTENT_PROTOCOL_VERSION,
  type ContentToBackground,
} from '@src/messaging/content-protocol';
import { createPortClient, type PortLike } from '@src/youtube/port-client';

class FakePort implements PortLike {
  sent: unknown[] = [];
  disconnected = false;
  private msgListeners = new Set<(m: unknown) => void>();
  private discListeners = new Set<() => void>();
  onMessage = {
    addListener: (cb: (m: unknown) => void) => void this.msgListeners.add(cb),
    removeListener: (cb: (m: unknown) => void) => void this.msgListeners.delete(cb),
  };
  onDisconnect = {
    addListener: (cb: () => void) => void this.discListeners.add(cb),
    removeListener: (cb: () => void) => void this.discListeners.delete(cb),
  };
  postMessage(msg: unknown) {
    if (this.disconnected) throw new Error('Attempting to use a disconnected port object');
    this.sent.push(msg);
  }
  disconnect() {
    this.disconnected = true;
  }
  receive(msg: unknown) {
    for (const l of [...this.msgListeners]) l(msg);
  }
  remoteDisconnect() {
    this.disconnected = true;
    for (const l of [...this.discListeners]) l();
  }
}

const hello: ContentToBackground = {
  type: 'hello',
  protocolVersion: CONTENT_PROTOCOL_VERSION,
  pageInstanceId: 'pg-12345678',
  url: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
};
const video: ContentToBackground = {
  type: 'page/video',
  navigationId: 1,
  videoId: 'AAAAAAAAAAA',
  isLive: false,
  isShorts: false,
};
const welcome = {
  type: 'welcome',
  protocolVersion: CONTENT_PROTOCOL_VERSION,
  workerInstanceId: 'w1',
  locale: 'zh-CN',
};

function setup(overrides: Partial<Parameters<typeof createPortClient>[0]> = {}) {
  const ports: FakePort[] = [];
  const timers: Array<{ fn: () => void; at: number; id: number; cleared: boolean }> = [];
  let now = 0;
  let nextId = 1;
  const received: unknown[] = [];
  const client = createPortClient({
    connect: () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    buildHello: () => hello,
    buildSnapshot: () => [video],
    onMessage: (m) => received.push(m),
    isContextValid: () => true,
    setTimeout: (fn, ms) => {
      const t = { fn, at: now + ms, id: nextId++, cleared: false };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    now: () => now,
    random: () => 0.5,
    ...overrides,
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) {
      if (!t.cleared && t.at <= now) {
        t.cleared = true;
        t.fn();
      }
    }
  };
  return { client, ports, received, advance, timers };
}

describe('port client (on-demand reconnect)', () => {
  it('does not connect until there is something meaningful to send, then sends hello → snapshot → queued', () => {
    const { client, ports } = setup();
    expect(client.send(video, { wake: false })).toBe(false);
    expect(ports).toHaveLength(0);
    const visible: ContentToBackground = {
      type: 'captions/visible',
      navigationId: 1,
      videoId: 'AAAAAAAAAAA',
      text: 'hi',
      mediaTimeMs: 1,
      sampledAtEpochMs: 2,
    };
    client.send(visible, { wake: true });
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent.map((m) => (m as { type: string }).type)).toEqual([
      'hello',
      'page/video',
      'captions/visible',
    ]);
    expect(client.generation).toBe(1);
  });

  it('stays disconnected after a welcomed connection is closed by the worker (no keep-alive loop)', () => {
    const { client, ports, advance } = setup();
    client.wake();
    ports[0]!.receive(welcome);
    expect(client.welcomed).toBe(true);
    ports[0]!.remoteDisconnect();
    advance(120_000);
    expect(ports).toHaveLength(1);
    expect(client.connected).toBe(false);
    // 下一次有意义的事件才重新连接，并重新发送完整状态。
    client.send(
      {
        type: 'player/state',
        navigationId: 1,
        reason: 'play',
        state: {
          videoId: 'AAAAAAAAAAA',
          currentTimeMs: 0,
          paused: false,
          buffering: false,
          seeking: false,
          ended: false,
          playbackRate: 1,
          ad: false,
          volume: 1,
          muted: false,
          isLive: false,
          isShorts: false,
          fullscreen: false,
          sampledAtEpochMs: 1,
        },
      },
      { wake: true },
    );
    expect(ports).toHaveLength(2);
    expect(ports[1]!.sent.map((m) => (m as { type: string }).type)).toEqual([
      'hello',
      'page/video',
    ]);
    expect(client.generation).toBe(2);
  });

  it('retries with bounded exponential backoff when the worker never welcomes, then stops until the next wake', () => {
    const { client, ports, advance } = setup({ maxAutoRetries: 3, baseBackoffMs: 100 });
    client.wake();
    for (let i = 0; i < 10; i++) {
      ports[ports.length - 1]!.remoteDisconnect();
      advance(10_000);
    }
    expect(ports.length).toBe(4); // 首次 + 3 次自动重试
    advance(1_000_000);
    expect(ports.length).toBe(4);
    client.wake();
    advance(1_000_000);
    expect(ports.length).toBe(5);
  });

  it('drops replies bound to an old connection generation', () => {
    const { client, ports } = setup();
    client.wake();
    ports[0]!.receive(welcome);
    const gen = client.generation;
    ports[0]!.remoteDisconnect();
    client.wake();
    const reply: ContentToBackground = { type: 'reply', requestId: 'r1', ok: true };
    expect(client.send(reply, { wake: false, generation: gen })).toBe(false);
    expect(ports[1]!.sent.some((m) => (m as { type: string }).type === 'reply')).toBe(false);
    expect(client.send(reply, { wake: false, generation: client.generation })).toBe(true);
  });

  it('validates incoming and outgoing messages', () => {
    const { client, ports, received } = setup();
    client.wake();
    ports[0]!.receive({
      type: 'request',
      requestId: 'x',
      request: { kind: 'evil/fetch', url: 'https://evil.example' },
    });
    ports[0]!.receive({
      type: 'session/cues',
      sessionId: 's',
      epoch: -1,
      cueVersion: 0,
      full: true,
      cues: [],
    });
    ports[0]!.receive(welcome);
    expect(received).toEqual([welcome]);
    expect(client.stats.invalidIncoming).toBe(2);
    expect(
      client.send({ type: 'page/video', navigationId: -1 } as unknown as ContentToBackground, {
        wake: true,
      }),
    ).toBe(false);
    expect(client.stats.invalidOutgoing).toBe(1);
  });

  it('disposes on invalid extension context instead of reconnecting', () => {
    let valid = true;
    const onContextInvalid = vi.fn();
    const { client, ports } = setup({ isContextValid: () => valid, onContextInvalid });
    client.wake();
    valid = false;
    ports[0]!.remoteDisconnect();
    expect(onContextInvalid).toHaveBeenCalledTimes(1);
    client.wake();
    expect(ports).toHaveLength(1);
  });

  it('handles connect() throwing and posting on a dead port', () => {
    let fail = true;
    const { client, ports, advance } = setup({
      connect: () => {
        if (fail) throw new Error('Could not establish connection');
        const p = new FakePort();
        ports.push(p);
        return p;
      },
      baseBackoffMs: 100,
    });
    client.wake();
    expect(client.connected).toBe(false);
    fail = false;
    advance(1_000);
    expect(client.connected).toBe(true);
    ports[0]!.disconnected = true; // 端口已死但尚未收到 onDisconnect
    expect(client.send(video, { wake: false })).toBe(false);
    expect(client.connected).toBe(false);
  });

  it('keeps only the latest unsolicited message while disconnected and sends it after the snapshot', () => {
    const { client, ports } = setup();
    const data = (n: number): ContentToBackground => ({
      type: 'captions/track-data',
      navigationId: 1,
      videoId: 'AAAAAAAAAAA',
      track: { trackKey: `.k${n}`, languageCode: 'en', label: 'en', kind: 'manual' },
      format: 'json3',
      cues: [],
      complete: true,
      rejectedCount: 0,
    });
    client.send(data(1), { wake: false, keepLatest: true });
    client.send(data(2), { wake: false, keepLatest: true });
    expect(ports).toHaveLength(0);
    client.wake();
    const sent = ports[0]!.sent as Array<{ type: string; track?: { trackKey: string } }>;
    expect(sent.map((m) => m.type)).toEqual(['hello', 'page/video', 'captions/track-data']);
    expect(sent[2]!.track!.trackKey).toBe('.k2');
  });

  it('resync re-sends the snapshot when connected and connects when not', () => {
    const { client, ports } = setup();
    client.resync();
    expect(ports).toHaveLength(1);
    ports[0]!.receive(welcome);
    client.resync();
    expect(ports).toHaveLength(1);
    expect(ports[0]!.sent.map((m) => (m as { type: string }).type)).toEqual([
      'hello',
      'page/video',
      'page/video',
    ]);
  });
});

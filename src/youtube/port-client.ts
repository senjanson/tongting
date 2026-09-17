/**
 * 内容脚本 ↔ service worker 长连接客户端（按需连接）。
 *
 * - 断开后不立即重连，避免把 worker 变成「断开→唤醒」的保活循环（计划 §5.2）。
 *   只有调用方以 wake=true 发送有意义的内容（视频事件、导航、字幕数据、回复、会话中播放的 tick）时才连接；
 *   wake=false 的消息在断开时直接丢弃，因为重连后会重新发送完整快照。
 * - 连接后先发 hello，再发调用方提供的当前完整状态（page/video、captions/tracks、player/state），然后发送排队消息。
 * - 未收到 welcome 就断开视为失败：指数退避（含抖动）后仅在仍有待发送意图时重试，连续失败达到上限后停止自动重试，
 *   等待下一次 wake。收到 welcome 后断开（worker 空闲回收）不自动重连。
 * - 收发都用 content-protocol 的 zod schema 校验。回复与字幕数据绑定连接代际，旧连接的请求不在新连接上回复。
 */
import {
  BackgroundToContentSchema,
  ContentToBackgroundSchema,
  type BackgroundToContent,
  type ContentToBackground,
} from '../messaging/content-protocol';

export interface PortEventLike<T extends (...args: never[]) => void> {
  addListener(cb: T): void;
  removeListener(cb: T): void;
}

export interface PortLike {
  postMessage(msg: unknown): void;
  disconnect(): void;
  onMessage: PortEventLike<(msg: unknown) => void>;
  onDisconnect: PortEventLike<() => void>;
}

export interface PortClientOptions {
  connect(): PortLike;
  buildHello(): ContentToBackground;
  /** 连接建立后要发送的当前完整状态（幂等）。 */
  buildSnapshot(): ContentToBackground[];
  onMessage(msg: BackgroundToContent, generation: number): void;
  onConnectionChange?(state: { connected: boolean; generation: number; welcomed: boolean }): void;
  /** 扩展上下文是否仍有效（browser.runtime.id 存在）。 */
  isContextValid(): boolean;
  onContextInvalid?(): void;
  /** 在 onDisconnect 中读取 runtime.lastError，避免未检查错误告警。 */
  readLastError?(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  now?(): number;
  random?(): number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  maxAutoRetries?: number;
  maxQueue?: number;
}

export interface SendOptions {
  /** 断开时是否为此消息建立连接。 */
  wake: boolean;
  /** 仅在该连接代际仍然有效时发送（用于回复 worker 请求）。 */
  generation?: number;
  /** 断开时只保留最新一份（例如主动 track-data），重连并发送快照后补发。 */
  keepLatest?: boolean;
}

export interface PortClient {
  send(msg: ContentToBackground, opts: SendOptions): boolean;
  /** 在有待发送意图时建立连接（例如需要同步完整状态）。 */
  wake(): void;
  /** 收到唤醒：未连接则连接（连接时发送 hello + 快照）；已连接则重发快照。 */
  resync(): void;
  readonly connected: boolean;
  readonly welcomed: boolean;
  readonly generation: number;
  readonly stats: {
    invalidOutgoing: number;
    invalidIncoming: number;
    failures: number;
    connects: number;
  };
  dispose(): void;
}

/** 这些消息依赖连接代际或属于增量数据，断开时需要排队；状态类消息由快照覆盖，不排队。 */
const QUEUEABLE = new Set<ContentToBackground['type']>(['captions/visible', 'captions/error']);

export function createPortClient(opts: PortClientOptions): PortClient {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const baseBackoff = opts.baseBackoffMs ?? 500;
  const maxBackoff = opts.maxBackoffMs ?? 30_000;
  const maxAutoRetries = opts.maxAutoRetries ?? 6;
  const maxQueue = opts.maxQueue ?? 50;

  let port: PortLike | null = null;
  let generation = 0;
  let welcomed = false;
  let failures = 0;
  let nextAllowedAt = 0;
  let retryTimer: unknown;
  let wantConnection = false;
  let disposed = false;
  let queue: ContentToBackground[] = [];
  let latest: ContentToBackground | undefined;
  const stats = { invalidOutgoing: 0, invalidIncoming: 0, failures: 0, connects: 0 };

  const validOutgoing = (msg: ContentToBackground): boolean => {
    const r = ContentToBackgroundSchema.safeParse(msg);
    if (!r.success) stats.invalidOutgoing++;
    return r.success;
  };

  const rawPost = (msg: ContentToBackground): boolean => {
    if (!port) return false;
    try {
      port.postMessage(msg);
      return true;
    } catch {
      handleDisconnect();
      return false;
    }
  };

  const clearRetry = () => {
    if (retryTimer !== undefined) opts.clearTimeout(retryTimer);
    retryTimer = undefined;
  };

  const invalidate = () => {
    dispose();
    opts.onContextInvalid?.();
  };

  const onMessage = (raw: unknown) => {
    if (disposed) return;
    const r = BackgroundToContentSchema.safeParse(raw);
    if (!r.success) {
      stats.invalidIncoming++;
      return;
    }
    if (r.data.type === 'welcome') {
      welcomed = true;
      failures = 0;
      nextAllowedAt = 0;
      wantConnection = false;
      opts.onConnectionChange?.({ connected: true, generation, welcomed: true });
    }
    try {
      opts.onMessage(r.data, generation);
    } catch {
      /* 处理器异常不能断开连接 */
    }
  };

  function handleDisconnect() {
    if (!port) return;
    try {
      opts.readLastError?.();
    } catch {
      /* ignore */
    }
    const old = port;
    port = null;
    try {
      old.onMessage.removeListener(onMessage);
      old.onDisconnect.removeListener(handleDisconnect);
    } catch {
      /* ignore */
    }
    const wasWelcomed = welcomed;
    welcomed = false;
    opts.onConnectionChange?.({ connected: false, generation, welcomed: false });
    if (disposed) return;
    if (!opts.isContextValid()) {
      invalidate();
      return;
    }
    if (wasWelcomed) {
      // worker 空闲回收或主动断开：保持断开，等下一次有意义的发送。
      return;
    }
    failures++;
    stats.failures++;
    const delay =
      Math.min(maxBackoff, baseBackoff * 2 ** Math.min(failures - 1, 16)) * (0.8 + random() * 0.4);
    nextAllowedAt = now() + delay;
    if ((wantConnection || queue.length) && failures <= maxAutoRetries) scheduleConnect();
  }

  function scheduleConnect() {
    if (disposed || port || retryTimer !== undefined) return;
    const wait = Math.max(0, nextAllowedAt - now());
    if (wait === 0) {
      connectNow();
      return;
    }
    retryTimer = opts.setTimeout(() => {
      retryTimer = undefined;
      connectNow();
    }, wait);
  }

  function connectNow() {
    if (disposed || port) return;
    if (!opts.isContextValid()) {
      invalidate();
      return;
    }
    let p: PortLike;
    try {
      p = opts.connect();
    } catch {
      if (!opts.isContextValid()) {
        invalidate();
        return;
      }
      failures++;
      stats.failures++;
      nextAllowedAt = now() + Math.min(maxBackoff, baseBackoff * 2 ** Math.min(failures - 1, 16));
      if (failures <= maxAutoRetries) scheduleConnect();
      return;
    }
    port = p;
    generation++;
    stats.connects++;
    welcomed = false;
    p.onMessage.addListener(onMessage);
    p.onDisconnect.addListener(handleDisconnect);
    opts.onConnectionChange?.({ connected: true, generation, welcomed: false });
    const hello = opts.buildHello();
    if (!validOutgoing(hello) || !rawPost(hello)) return;
    for (const msg of opts.buildSnapshot()) {
      if (!port) return;
      if (validOutgoing(msg)) rawPost(msg);
    }
    if (latest && port) {
      const msg = latest;
      latest = undefined;
      rawPost(msg);
    }
    const pending = queue;
    queue = [];
    for (const msg of pending) {
      if (!port) {
        queue.push(msg);
        continue;
      }
      rawPost(msg);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearRetry();
    queue = [];
    const old = port;
    port = null;
    if (old) {
      try {
        old.onMessage.removeListener(onMessage);
        old.onDisconnect.removeListener(handleDisconnect);
        old.disconnect();
      } catch {
        /* 上下文可能已失效 */
      }
    }
  }

  const requestConnection = () => {
    wantConnection = true;
    if (failures > maxAutoRetries) {
      // 自动重试已停止：新的有意义事件重新开始一轮（仍遵守退避时间）。
      failures = maxAutoRetries;
    }
    scheduleConnect();
  };

  return {
    get connected() {
      return port !== null;
    },
    get welcomed() {
      return welcomed;
    },
    get generation() {
      return generation;
    },
    get stats() {
      return { ...stats };
    },
    send(msg, sendOpts) {
      if (disposed) return false;
      if (sendOpts.generation !== undefined && (sendOpts.generation !== generation || !port))
        return false;
      if (!validOutgoing(msg)) return false;
      if (port) return rawPost(msg);
      if (sendOpts.keepLatest) latest = msg;
      if (!sendOpts.wake) return false;
      if (QUEUEABLE.has(msg.type)) {
        queue.push(msg);
        if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
      }
      requestConnection();
      return false;
    },
    wake() {
      if (disposed || port) return;
      requestConnection();
    },
    resync() {
      if (disposed) return;
      if (!port) {
        requestConnection();
        return;
      }
      for (const msg of opts.buildSnapshot()) {
        if (!port) return;
        if (validOutgoing(msg)) rawPost(msg);
      }
    },
    dispose,
  };
}

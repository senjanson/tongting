/**
 * worker 侧 offscreen 客户端（实现 ./types.ts 的 OffscreenClient）。
 *
 * 集成方式（由会话协调器负责）：
 * - worker 统一监听 runtime.onConnect；对 name === PORT_OFFSCREEN 且 verifySender(..., 'offscreen') 通过的端口
 *   调用 client.handlePort(port)。本模块不注册全局 onConnect。
 * - ensure()：并发去重（在途 promise + runtime.getContexts 核对），不存在时以 USER_MEDIA + AUDIO_PLAYBACK 创建文档，
 *   等待 offscreen 的 hello；文档已存在但未连接时发送唤醒消息让其重连。
 * - request()：未连接期间所有请求按调用顺序排队（T15：tts/stop 不会先于它要取消的 tts/play 送达或被丢弃）。
 *   只有 capture/start 与 tts/play 会创建文档；文档正在创建/握手时，其他请求（含 stop）等待连接后按序发送；
 *   只有确认文档不存在且没有创建在进行时，capture/stop、tts/stop 才直接返回 { stopped: false, reason: 'no-document' }。
 * - onConnectionLost()：端口断开、文档消失、握手发现 offscreenInstanceId 变化时通知订阅方。
 * - closeIfIdle()：核对真实状态，无租约、无捕获、无播放、无在途/排队的创建请求时才关闭文档。
 */
import { browser, type Browser } from 'wxt/browser';
import { AppError } from '../domain/errors';
import {
  OffscreenRequestSchema,
  OffscreenStatusSchema,
  OffscreenToBackgroundSchema,
  type OffscreenEvent,
  type OffscreenRequest,
  type OffscreenStatus,
} from '../messaging/offscreen-protocol';
import {
  OFFSCREEN_PAGE,
  PORT_OFFSCREEN,
  randomId as defaultRandomId,
  verifySender,
} from '../messaging/ports';
import type { OffscreenClient, OffscreenRequestOf } from './types';
import { OFFSCREEN_WAKE_TYPE } from './offscreen/wake';
import { getLocale, t } from '../i18n';

type TimerHandle = unknown;

export interface OffscreenClientDeps {
  hasDocument(): Promise<boolean>;
  createDocument(): Promise<void>;
  closeDocument(): Promise<void>;
  sendWake(): Promise<void>;
  verifyPort(port: Browser.runtime.Port): boolean;
  now(): number;
  randomId(prefix?: string): string;
  setTimer(fn: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  logger: Pick<Console, 'warn' | 'info'>;
  helloTimeoutMs: number;
  defaultRequestTimeoutMs: number;
}

export type OffscreenConnectionLostReason =
  'port-disconnected' | 'document-missing' | 'instance-changed';

export interface OffscreenConnectionLost {
  reason: OffscreenConnectionLostReason;
  /** 之前握手时的 offscreen 实例。 */
  previousInstanceId?: string;
  /** instance-changed 时的新实例。 */
  instanceId?: string;
}

export interface OffscreenClientHandle extends OffscreenClient {
  handlePort(port: Browser.runtime.Port): void;
  isConnected(): boolean;
  readonly workerInstanceId: string;
  lastHello(): OffscreenStatus | null;
  /**
   * 连接丢失信号：端口断开（worker ↔ offscreen）、发现文档已不存在、或重新握手时 offscreenInstanceId 变化
   * （文档被销毁重建，旧资源全部丢失）。主动 closeIfIdle 关闭不触发。
   */
  onConnectionLost(listener: (info: OffscreenConnectionLost) => void): () => void;
}

const CREATING_KINDS = new Set<OffscreenRequest['kind']>(['capture/start', 'tts/play']);
const STOP_KINDS = new Set<OffscreenRequest['kind']>(['capture/stop', 'tts/stop']);

const DEFAULT_TIMEOUTS: Partial<Record<OffscreenRequest['kind'], number>> = {
  'capture/start': 20_000,
  'capture/stop': 10_000,
  'tts/play': 10_000,
};

function offscreenError(code: string, message: string, retryable = true): AppError {
  return new AppError({ code, category: 'internal', retryable, message });
}

export function defaultOffscreenClientDeps(): OffscreenClientDeps {
  const offscreenUrl = browser.runtime.getURL(OFFSCREEN_PAGE);
  return {
    async hasDocument() {
      const runtime = browser.runtime as unknown as {
        getContexts?: (filter: {
          contextTypes: string[];
          documentUrls?: string[];
        }) => Promise<unknown[]>;
      };
      if (typeof runtime.getContexts === 'function') {
        const contexts = await runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [offscreenUrl],
        });
        return contexts.length > 0;
      }
      const offscreen = browser.offscreen as unknown as { hasDocument?: () => Promise<boolean> };
      return (await offscreen.hasDocument?.()) ?? false;
    },
    async createDocument() {
      await browser.offscreen.createDocument({
        url: OFFSCREEN_PAGE,
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'] as Browser.offscreen.CreateParameters['reasons'],
        justification: '捕获用户正在观看的标签页音频用于识别，并回放原声与翻译配音。',
      });
    },
    async closeDocument() {
      await browser.offscreen.closeDocument();
    },
    async sendWake() {
      await browser.runtime.sendMessage({ type: OFFSCREEN_WAKE_TYPE });
    },
    verifyPort(port) {
      const origin = browser.runtime.getURL('/');
      return (
        port.name === PORT_OFFSCREEN &&
        verifySender(port.sender, 'offscreen', browser.runtime.id, origin) !== null
      );
    },
    now: () => Date.now(),
    randomId: defaultRandomId,
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    logger: console,
    helloTimeoutMs: 5_000,
    defaultRequestTimeoutMs: 5_000,
  };
}

interface Pending {
  kind: OffscreenRequest['kind'];
  resolve(data: unknown): void;
  reject(error: AppError): void;
  timer: TimerHandle;
}

interface Outgoing {
  req: OffscreenRequest;
  timeoutMs: number;
  resolve(data: unknown): void;
  reject(error: unknown): void;
}

export function createOffscreenClient(
  overrides: Partial<OffscreenClientDeps> = {},
): OffscreenClientHandle {
  const deps: OffscreenClientDeps = { ...defaultOffscreenClientDepsSafe(), ...overrides };
  const workerInstanceId = deps.randomId('wk');

  let port: Browser.runtime.Port | null = null;
  let hello: OffscreenStatus | null = null;
  let lastInstanceId: string | undefined;
  let ensureInflight: Promise<OffscreenStatus> | null = null;
  let lifecycle: Promise<unknown> = Promise.resolve();
  let creatingRequests = 0;
  let closingIntentionally = false;
  const pending = new Map<string, Pending>();
  const outbox: Outgoing[] = [];
  let pumping = false;
  const helloWaiters = new Set<(status: OffscreenStatus) => void>();
  const eventListeners = new Set<(event: OffscreenEvent) => void>();
  const helloListeners = new Set<(status: OffscreenStatus) => void>();
  const lostListeners = new Set<(info: OffscreenConnectionLost) => void>();

  const notifyLost = (info: OffscreenConnectionLost) => {
    for (const l of Array.from(lostListeners)) {
      try {
        l(info);
      } catch (error) {
        deps.logger.warn('[offscreen-client] onConnectionLost 监听器出错', error);
      }
    }
  };

  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lifecycle.then(fn, fn);
    lifecycle = run.catch(() => undefined);
    return run;
  };

  const rejectAll = (error: AppError) => {
    for (const [id, p] of pending) {
      deps.clearTimer(p.timer);
      pending.delete(id);
      p.reject(error);
    }
  };

  const detach = (target: Browser.runtime.Port, reason: string) => {
    if (port !== target) return;
    port = null;
    hello = null;
    rejectAll(
      offscreenError(
        'offscreen-disconnected',
        t('background.offscreen.disconnectedReason', { reason }),
      ),
    );
    if (!closingIntentionally)
      notifyLost({ reason: 'port-disconnected', previousInstanceId: lastInstanceId });
  };

  const onMessage = (target: Browser.runtime.Port, raw: unknown) => {
    if (port !== target) return;
    const parsed = OffscreenToBackgroundSchema.safeParse(raw);
    if (!parsed.success) {
      deps.logger.warn('[offscreen-client] 丢弃无效消息');
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'hello': {
        hello = message.status;
        const previous = lastInstanceId;
        lastInstanceId = message.status.offscreenInstanceId;
        try {
          target.postMessage({ type: 'welcome', workerInstanceId, locale: getLocale() });
        } catch {
          detach(target, 'welcome-failed');
          return;
        }
        if (previous !== undefined && previous !== lastInstanceId) {
          notifyLost({
            reason: 'instance-changed',
            previousInstanceId: previous,
            instanceId: lastInstanceId,
          });
        }
        for (const waiter of Array.from(helloWaiters)) waiter(message.status);
        helloWaiters.clear();
        for (const l of Array.from(helloListeners)) {
          try {
            l(message.status);
          } catch (error) {
            deps.logger.warn('[offscreen-client] onHello 监听器出错', error);
          }
        }
        void pump();
        return;
      }
      case 'reply': {
        const p = pending.get(message.requestId);
        if (!p) return;
        pending.delete(message.requestId);
        deps.clearTimer(p.timer);
        if (message.ok) p.resolve(message.data);
        else p.reject(new AppError(message.error));
        return;
      }
      case 'event': {
        for (const l of Array.from(eventListeners)) {
          try {
            l(message.event);
          } catch (error) {
            deps.logger.warn('[offscreen-client] onEvent 监听器出错', error);
          }
        }
        return;
      }
    }
  };

  const waitForHello = (timeoutMs: number): Promise<OffscreenStatus> => {
    if (port && hello) return Promise.resolve(hello);
    return new Promise((resolve, reject) => {
      const waiter = (status: OffscreenStatus) => {
        deps.clearTimer(timer);
        resolve(status);
      };
      const timer = deps.setTimer(() => {
        helloWaiters.delete(waiter);
        reject(offscreenError('offscreen-unresponsive', t('background.offscreen.unresponsive')));
      }, timeoutMs);
      helloWaiters.add(waiter);
    });
  };

  const sendNow = (request: OffscreenRequest, timeoutMs: number): Promise<unknown> => {
    const target = port;
    if (!target || !hello)
      return Promise.reject(
        offscreenError('offscreen-disconnected', t('background.offscreen.notConnected')),
      );
    const requestId = deps.randomId('q');
    return new Promise((resolve, reject) => {
      const timer = deps.setTimer(() => {
        pending.delete(requestId);
        reject(
          new AppError({
            code: 'offscreen-timeout',
            category: 'timeout',
            retryable: true,
            message: t('background.offscreen.timeout', { kind: request.kind }),
          }),
        );
      }, timeoutMs);
      pending.set(requestId, { kind: request.kind, resolve, reject, timer });
      try {
        target.postMessage({ type: 'request', requestId, request, locale: getLocale() });
      } catch {
        deps.clearTimer(timer);
        pending.delete(requestId);
        detach(target, 'post-failed');
        reject(offscreenError('offscreen-disconnected', t('background.offscreen.disconnected')));
      }
    });
  };

  const doEnsure = async (): Promise<OffscreenStatus> => {
    if (port && hello) return hello;
    let exists = await deps.hasDocument();
    if (!exists) {
      if (lastInstanceId !== undefined && !closingIntentionally) {
        notifyLost({ reason: 'document-missing', previousInstanceId: lastInstanceId });
        lastInstanceId = undefined;
      }
      try {
        await deps.createDocument();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/single offscreen|already/i.test(message)) {
          exists = true;
        } else {
          throw new AppError(
            {
              code: 'offscreen-create-failed',
              category: 'audio',
              retryable: true,
              message: t('background.offscreen.createFailed'),
              detail: message.slice(0, 200),
            },
            { cause: error },
          );
        }
      }
    }
    if (exists && !port) await deps.sendWake().catch(() => undefined);
    try {
      return await waitForHello(deps.helloTimeoutMs);
    } catch (error) {
      if (!exists) throw error;
      await deps.sendWake().catch(() => undefined);
      try {
        return await waitForHello(Math.min(2_000, deps.helloTimeoutMs));
      } catch {
        deps.logger.warn('[offscreen-client] offscreen 无响应，关闭后重建');
        await deps.closeDocument().catch(() => undefined);
        await deps.createDocument();
        return await waitForHello(deps.helloTimeoutMs);
      }
    }
  };

  const ensureConnected = (): Promise<OffscreenStatus> => {
    if (port && hello) return Promise.resolve(hello);
    ensureInflight ??= serialize(doEnsure).finally(() => {
      ensureInflight = null;
    });
    return ensureInflight;
  };

  const settleWithoutDocument = (item: Outgoing, error: unknown) => {
    if (STOP_KINDS.has(item.req.kind)) item.resolve({ stopped: false, reason: 'no-document' });
    else item.reject(error);
  };

  /** 按调用顺序发送排队请求；未连接时由队首决定如何建立连接。 */
  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (outbox.length > 0) {
        const head = outbox[0]!;
        if (port && hello) {
          outbox.shift();
          sendNow(head.req, head.timeoutMs).then(head.resolve, head.reject);
          continue;
        }
        if (CREATING_KINDS.has(head.req.kind) || ensureInflight) {
          try {
            await ensureConnected();
          } catch (error) {
            // 创建/握手失败：当前排队的请求都无法送达。
            for (const item of outbox.splice(0)) settleWithoutDocument(item, error);
          }
          continue;
        }
        const exists = await deps.hasDocument().catch(() => false);
        if ((port && hello) || ensureInflight) continue;
        if (!exists) {
          outbox.shift();
          settleWithoutDocument(
            head,
            offscreenError('offscreen-missing', t('background.offscreen.missing'), false),
          );
          continue;
        }
        await deps.sendWake().catch(() => undefined);
        try {
          await waitForHello(Math.min(3_000, deps.helloTimeoutMs));
        } catch (error) {
          if (!(port && hello)) {
            outbox.shift();
            settleWithoutDocument(head, error);
          }
        }
      }
    } finally {
      pumping = false;
    }
  };

  const client: OffscreenClientHandle = {
    workerInstanceId,
    handlePort(incoming) {
      if (!deps.verifyPort(incoming)) {
        deps.logger.warn('[offscreen-client] 拒绝来源不符的 offscreen 端口');
        try {
          incoming.disconnect();
        } catch {
          // ignore
        }
        return;
      }
      const previous = port;
      if (previous && previous !== incoming) {
        port = null;
        hello = null;
        rejectAll(offscreenError('offscreen-reconnected', t('background.offscreen.reconnected')));
        try {
          previous.disconnect();
        } catch {
          // ignore
        }
      }
      port = incoming;
      hello = null;
      incoming.onMessage.addListener((message: unknown) => onMessage(incoming, message));
      incoming.onDisconnect.addListener(() => detach(incoming, 'port-closed'));
    },
    isConnected() {
      return !!port && !!hello;
    },
    lastHello() {
      return hello;
    },
    onConnectionLost(listener) {
      lostListeners.add(listener);
      return () => lostListeners.delete(listener);
    },
    async ensure() {
      await ensureConnected();
      return OffscreenStatusSchema.parse(await client.request({ kind: 'status' }));
    },
    async queryStatus() {
      if (!(port && hello) && !ensureInflight && !(await deps.hasDocument())) return null;
      try {
        const data = await client.request({ kind: 'status' });
        return OffscreenStatusSchema.parse(data);
      } catch (error) {
        if (!(await deps.hasDocument())) return null;
        throw error;
      }
    },
    request<K extends OffscreenRequest['kind']>(
      request: OffscreenRequestOf<K>,
      timeoutMs?: number,
    ): Promise<unknown> {
      const parsed = OffscreenRequestSchema.safeParse(request);
      if (!parsed.success) {
        return Promise.reject(
          new AppError({
            code: 'offscreen-bad-request',
            category: 'internal',
            retryable: false,
            message: t('background.offscreen.badRequest'),
          }),
        );
      }
      const req = parsed.data;
      const timeout = timeoutMs ?? DEFAULT_TIMEOUTS[req.kind] ?? deps.defaultRequestTimeoutMs;
      const creating = CREATING_KINDS.has(req.kind);
      if (creating) creatingRequests++;
      const done = <T>(p: Promise<T>) =>
        creating
          ? p.finally(() => {
              creatingRequests--;
            })
          : p;
      if (port && hello && outbox.length === 0) return done(sendNow(req, timeout));
      return done(
        new Promise((resolve, reject) => {
          outbox.push({ req, timeoutMs: timeout, resolve, reject });
          void pump();
        }),
      );
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    onHello(listener) {
      helloListeners.add(listener);
      return () => helloListeners.delete(listener);
    },
    closeIfIdle() {
      return serialize(async () => {
        if (creatingRequests > 0 || outbox.length > 0) return false;
        if (!(await deps.hasDocument())) return false;
        let status: OffscreenStatus | null;
        try {
          if (!(port && hello)) {
            await deps.sendWake().catch(() => undefined);
            await waitForHello(2_000);
          }
          status = OffscreenStatusSchema.parse(
            await sendNow({ kind: 'status' }, deps.defaultRequestTimeoutMs),
          );
        } catch {
          status = null;
        }
        if (status) {
          const r = status.resources;
          const busy =
            status.lease !== null ||
            status.ttsPlaying ||
            r.pendingRequests > 0 ||
            r.activeTracks > 0 ||
            r.capture === 'requesting' ||
            r.capture === 'active' ||
            r.capture === 'stopping';
          if (busy) return false;
        }
        if (creatingRequests > 0 || outbox.length > 0) return false;
        // 无响应的文档无法核对也无法被控制：关闭它是释放孤立资源的唯一可靠方式。
        const target = port;
        closingIntentionally = true;
        try {
          await deps.closeDocument();
          if (target) detach(target, 'closed');
          lastInstanceId = undefined;
        } finally {
          closingIntentionally = false;
        }
        return true;
      });
    },
  };
  return client;
}

/** 在非扩展环境（单测未注入依赖）中访问 browser 可能抛错，这里延迟到真正需要时再报错。 */
function defaultOffscreenClientDepsSafe(): OffscreenClientDeps {
  try {
    return defaultOffscreenClientDeps();
  } catch {
    const unavailable = async () => {
      throw offscreenError(
        'offscreen-api-unavailable',
        t('background.offscreen.apiUnavailable'),
        false,
      );
    };
    return {
      hasDocument: unavailable,
      createDocument: unavailable,
      closeDocument: unavailable,
      sendWake: unavailable,
      verifyPort: () => false,
      now: () => Date.now(),
      randomId: defaultRandomId,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      logger: console,
      helloTimeoutMs: 5_000,
      defaultRequestTimeoutMs: 5_000,
    };
  }
}

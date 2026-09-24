/**
 * 扩展页面与 service worker 的连接客户端。
 *
 * - 通过 PORT_UI 长连接订阅快照；只接受更新的快照（见 snapshot.ts）。
 * - 端口断开（含 worker 被回收或重启）后自动重连，重连期间状态为 reconnecting，
 *   直到新端口收到第一份快照才回到 connected。
 * - 命令带 requestId、超时与结果校验；端口断开时在途命令立即以「结果未知」失败，
 *   迟到的结果被忽略。未连接时拒绝发送，不在后台排队以免执行过期意图。
 * - 字幕订阅同一时刻只有一个会话（协议限制）；重连后自动重新订阅并等待完整基线。
 * - 客户端自行生成的错误文案使用当前页面语言（页面根组件通过 setLocale 同步）。
 */
import { AppError, type AppErrorInfo } from '../../domain/errors';
import { t } from '../../i18n';
import { PORT_UI, randomId } from '../../messaging/ports';
import {
  UI_PROTOCOL_VERSION,
  UiCommandSchema,
  type AppSnapshot,
  type UiCommand,
  type UiCommandResultMap,
  type UiSurface,
  type UiToBackground,
} from '../../messaging/ui-protocol';
import {
  applyCuesMessage,
  IDLE_CUES_STATE,
  resyncCuesState,
  subscribeCuesState,
  type CuesState,
} from './cues';
import { commandTimeoutMs, UI_COMMAND_RESULT_SCHEMAS } from './results';
import { parseBackgroundMessage, shouldAcceptSnapshot } from './snapshot';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface ClientState {
  connection: ConnectionStatus;
  snapshot: AppSnapshot | null;
  /** 连续重连次数（收到快照后清零）。 */
  reconnectAttempts: number;
}

export type ResultOf<C extends UiCommand> = UiCommandResultMap[C['kind']];

export interface CommandOptions {
  timeoutMs?: number;
}

/** UI 组件使用的统一客户端接口；真实模式与演示模式各有实现。 */
export interface UiClient {
  readonly mode: 'real' | 'demo';
  getState(): ClientState;
  subscribe(listener: () => void): () => void;
  sendCommand<C extends UiCommand>(command: C, options?: CommandOptions): Promise<ResultOf<C>>;
  getCuesState(): CuesState;
  subscribeCues(listener: () => void): () => void;
  /** 订阅某会话字幕，返回释放函数。 */
  acquireCues(sessionId: string): () => void;
}

/** 与 chrome.runtime.Port 兼容的最小接口，便于测试注入。 */
export interface PortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(cb: (message: unknown) => void): void;
    removeListener(cb: (message: unknown) => void): void;
  };
  onDisconnect: { addListener(cb: () => void): void; removeListener(cb: () => void): void };
}

export interface BackgroundClientOptions {
  surface: UiSurface;
  connect: (name: string) => PortLike;
  /** 连接后等待首份快照的时间，超时视为连接失败并重连。 */
  handshakeTimeoutMs?: number;
  reconnectDelaysMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface PendingCommand {
  kind: UiCommand['kind'];
  port: PortLike;
  resolve(data: unknown): void;
  reject(error: AppError): void;
  timer: unknown;
}

const DEFAULT_RECONNECT_DELAYS = [250, 1_000, 2_000, 5_000] as const;

export function notConnectedError(): AppError {
  return new AppError({
    code: 'ui-not-connected',
    category: 'internal',
    retryable: true,
    message: t('common.client.notConnected'),
  });
}

function disconnectedDuringCommandError(): AppError {
  return new AppError({
    code: 'ui-port-disconnected',
    category: 'internal',
    retryable: true,
    message: t('common.client.disconnected'),
  });
}

function timeoutError(ms: number): AppError {
  return new AppError({
    code: 'ui-command-timeout',
    category: 'timeout',
    retryable: true,
    message: t('common.client.timeout', { seconds: Math.round(ms / 1000) }),
  });
}

function invalidResultError(): AppError {
  return new AppError({
    code: 'ui-invalid-result',
    category: 'format',
    retryable: false,
    message: t('common.client.invalidResult'),
  });
}

function invalidCommandError(): AppError {
  return new AppError({
    code: 'ui-invalid-command',
    category: 'config',
    retryable: false,
    message: t('common.client.invalidCommand'),
  });
}

/** 把任意异常转为可展示的错误文案（不包含堆栈）。 */
export function errorMessageOf(error: unknown): string {
  if (error instanceof AppError) return error.info.message;
  return t('common.client.failed');
}

export function errorInfoOf(error: unknown): AppErrorInfo | undefined {
  return error instanceof AppError ? error.info : undefined;
}

export class BackgroundClient implements UiClient {
  readonly mode = 'real' as const;

  private state: ClientState = { connection: 'connecting', snapshot: null, reconnectAttempts: 0 };
  private cuesState: CuesState = IDLE_CUES_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly cuesListeners = new Set<() => void>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly cueRefs = new Map<string, number>();
  private cueOrder: string[] = [];

  private port: PortLike | null = null;
  private portCleanup: (() => void) | null = null;
  private started = false;
  private reconnectTimer: unknown = null;
  private handshakeTimer: unknown = null;
  /** 当前端口是否已收到快照。 */
  private portReady = false;

  private readonly handshakeTimeoutMs: number;
  private readonly reconnectDelays: readonly number[];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: BackgroundClientOptions) {
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 8_000;
    this.reconnectDelays = options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  // ---------------------------------------------------------------- 生命周期

  start(): void {
    if (this.started) return;
    this.started = true;
    this.open();
  }

  /** 停止连接（页面卸载或 React 严格模式清理）；可再次 start。 */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clearReconnect();
    this.closePort(disconnectedDuringCommandError());
  }

  getState = (): ClientState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getCuesState = (): CuesState => this.cuesState;

  subscribeCues = (listener: () => void): (() => void) => {
    this.cuesListeners.add(listener);
    return () => this.cuesListeners.delete(listener);
  };

  // ---------------------------------------------------------------- 命令

  sendCommand<C extends UiCommand>(command: C, options: CommandOptions = {}): Promise<ResultOf<C>> {
    const port = this.port;
    if (!port || this.state.connection !== 'connected') {
      return Promise.reject(notConnectedError());
    }
    const parsed = UiCommandSchema.safeParse(command);
    if (!parsed.success) {
      return Promise.reject(invalidCommandError());
    }
    const kind = parsed.data.kind;
    const timeoutMs = options.timeoutMs ?? commandTimeoutMs(kind);
    const requestId = randomId('ui');
    return new Promise<ResultOf<C>>((resolve, reject) => {
      const timer = this.setTimer(() => {
        if (this.pending.delete(requestId)) reject(timeoutError(timeoutMs));
      }, timeoutMs);
      this.pending.set(requestId, {
        kind,
        port,
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      // 发送原始命令而非解析结果：SettingsPatchSchema 解析时会补默认值，发送解析结果会把未修改的设置重置。
      if (!this.post(port, { type: 'command', requestId, command })) {
        const entry = this.pending.get(requestId);
        if (entry) {
          this.pending.delete(requestId);
          this.clearTimer(entry.timer);
          reject(disconnectedDuringCommandError());
        }
      }
    });
  }

  // ---------------------------------------------------------------- 字幕订阅

  acquireCues(sessionId: string): () => void {
    this.cueRefs.set(sessionId, (this.cueRefs.get(sessionId) ?? 0) + 1);
    this.cueOrder = [...this.cueOrder.filter((id) => id !== sessionId), sessionId];
    this.updateCueSubscription();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.cueRefs.get(sessionId) ?? 1) - 1;
      if (count <= 0) {
        this.cueRefs.delete(sessionId);
        this.cueOrder = this.cueOrder.filter((id) => id !== sessionId);
      } else {
        this.cueRefs.set(sessionId, count);
      }
      this.updateCueSubscription();
    };
  }

  /** 最近一次申请且仍被持有的会话为当前订阅。 */
  private desiredCueSession(): string | null {
    return this.cueOrder[this.cueOrder.length - 1] ?? null;
  }

  private updateCueSubscription(): void {
    const desired = this.desiredCueSession();
    if (desired === this.cuesState.sessionId) return;
    this.setCuesState(desired ? subscribeCuesState(desired) : IDLE_CUES_STATE);
    if (this.port) this.post(this.port, { type: 'cues/subscribe', sessionId: desired });
  }

  // ---------------------------------------------------------------- 端口

  private open(): void {
    if (!this.started || this.port) return;
    let port: PortLike;
    try {
      port = this.options.connect(PORT_UI);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    this.portReady = false;

    const onMessage = (raw: unknown) => {
      if (this.port !== port) return;
      this.handleMessage(port, raw);
    };
    const onDisconnect = () => {
      if (this.port !== port) return;
      this.closePort(disconnectedDuringCommandError());
      this.scheduleReconnect();
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    this.portCleanup = () => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
    };

    this.handshakeTimer = this.setTimer(() => {
      if (this.port === port && !this.portReady) {
        this.closePort(disconnectedDuringCommandError());
        this.scheduleReconnect();
      }
    }, this.handshakeTimeoutMs);

    const subscribed = this.post(port, {
      type: 'subscribe',
      protocolVersion: UI_PROTOCOL_VERSION,
      surface: this.options.surface,
    });
    const desired = this.desiredCueSession();
    if (subscribed && desired) {
      this.setCuesState(
        this.cuesState.sessionId === desired
          ? resyncCuesState(this.cuesState)
          : subscribeCuesState(desired),
      );
      this.post(port, { type: 'cues/subscribe', sessionId: desired });
    }
  }

  private post(port: PortLike, message: UiToBackground): boolean {
    try {
      port.postMessage(message);
      return true;
    } catch {
      if (this.port === port) {
        this.closePort(disconnectedDuringCommandError());
        this.scheduleReconnect();
      }
      return false;
    }
  }

  private closePort(pendingError: AppError): void {
    const port = this.port;
    if (this.handshakeTimer !== null) {
      this.clearTimer(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    this.portCleanup?.();
    this.portCleanup = null;
    this.port = null;
    this.portReady = false;
    if (port) {
      try {
        port.disconnect();
      } catch {
        // 端口已关闭
      }
    }
    for (const [requestId, entry] of this.pending) {
      if (port && entry.port !== port) continue;
      this.pending.delete(requestId);
      this.clearTimer(entry.timer);
      entry.reject(pendingError);
    }
    if (this.state.connection === 'connected') {
      this.setState({ ...this.state, connection: 'reconnecting' });
    }
    if (this.cuesState.status === 'ready') {
      this.setCuesState(resyncCuesState(this.cuesState));
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.started || this.reconnectTimer !== null) return;
    const attempt = this.state.reconnectAttempts;
    const delay = this.reconnectDelays[Math.min(attempt, this.reconnectDelays.length - 1)] ?? 5_000;
    this.setState({
      ...this.state,
      connection: this.state.snapshot ? 'reconnecting' : 'connecting',
      reconnectAttempts: attempt + 1,
    });
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private handleMessage(port: PortLike, raw: unknown): void {
    const message = parseBackgroundMessage(raw);
    if (!message) return;
    switch (message.type) {
      case 'snapshot': {
        if (!this.portReady) {
          this.portReady = true;
          if (this.handshakeTimer !== null) {
            this.clearTimer(this.handshakeTimer);
            this.handshakeTimer = null;
          }
        }
        const snapshot = shouldAcceptSnapshot(this.state.snapshot, message.snapshot)
          ? message.snapshot
          : this.state.snapshot;
        if (
          snapshot !== this.state.snapshot ||
          this.state.connection !== 'connected' ||
          this.state.reconnectAttempts
        ) {
          this.setState({ connection: 'connected', snapshot, reconnectAttempts: 0 });
        }
        return;
      }
      case 'cues': {
        const next = applyCuesMessage(this.cuesState, message);
        if (next !== this.cuesState) this.setCuesState(next);
        return;
      }
      case 'result': {
        const entry = this.pending.get(message.requestId);
        if (!entry || entry.port !== port) return;
        this.pending.delete(message.requestId);
        this.clearTimer(entry.timer);
        if (!message.ok) {
          entry.reject(new AppError(message.error));
          return;
        }
        const schema = UI_COMMAND_RESULT_SCHEMAS[entry.kind];
        const data = schema.safeParse(message.data);
        if (data.success) entry.resolve(data.data);
        else entry.reject(invalidResultError());
        return;
      }
    }
  }

  private setState(next: ClientState): void {
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }

  private setCuesState(next: CuesState): void {
    this.cuesState = next;
    for (const listener of [...this.cuesListeners]) listener();
  }
}

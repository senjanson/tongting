/**
 * offscreen 文档主控：端口连接/重连、请求分发、租约与资源状态。
 *
 * 连接：
 * - 启动即连接 PORT_OFFSCREEN 并发送 hello（真实资源状态）。
 * - 端口断开（worker 挂起/重启）：立即停止云端配音并清空合成缓存；仍持有捕获时按退避重连，重连后发送 hello；
 *   空闲时不重连（避免反复唤醒 worker 形成空保活），等待 worker 的唤醒消息。
 * - 唤醒消息只接受来自本扩展、sender.url 属于扩展 origin 且不来自标签页（sender.tab 为空）的发送方。
 * - 收到 welcome 且 workerInstanceId 与之前不同（worker 已重启）时，把租约到期时间缩短到握手宽限期内，
 *   新 worker 必须显式 lease/renew，否则孤立资源自行停止（T21）。
 *
 * 捕获（T10/T14/T24）：
 * - capture/start 收到时同步登记为「当前租约 + 待启动」，并让更早的待启动请求作废；启动步骤串行执行
 *   （先停止旧会话，再创建新会话）。
 * - capture/stop 不排队：命中待启动租约时取消这次启动（不会创建会话）；命中已创建会话时立即停止并等待真实释放。
 * - 所有未结束的会话都在集合中：租约检查、status 汇总与 dispose 覆盖全部会话，停止中的旧会话不会变成孤立捕获。
 *
 * 凭证随请求到达，只传给识别/合成客户端，不写日志、不回传。
 */
import { AppError, cancelledError, toAppErrorInfo, type AppErrorInfo } from '../../domain/errors';
import {
  BackgroundToOffscreenSchema,
  OFFSCREEN_PROTOCOL_VERSION,
  type MediaAnchor,
  type OffscreenEvent,
  type OffscreenRequest,
  type OffscreenStatus,
  type OffscreenToBackground,
} from '../../messaging/offscreen-protocol';
import { PORT_OFFSCREEN } from '../../messaging/ports';
import type {
  CaptureDiagnostics,
  CaptureEndReason,
  CaptureSession,
  CaptureStartRequest,
} from './capture-session';
import type { TtsPlayer } from './tts-player';
import { OffscreenWakeSchema } from './wake';

type TimerHandle = unknown;

export interface PortLike {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (message: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

export interface WakeSender {
  id?: string;
  url?: string;
  tab?: unknown;
}

export interface OffscreenHostDeps {
  connect(name: string): PortLike;
  onRuntimeMessage(
    listener: (
      message: unknown,
      sender: WakeSender,
      sendResponse: (response: unknown) => void,
    ) => boolean | void,
  ): () => void;
  runtimeId: string;
  /** 扩展 origin，例如 chrome-extension://<id>（用于校验唤醒消息发送方）。 */
  extensionOrigin: string;
  createCaptureSession(
    req: CaptureStartRequest,
    hooks: { emit(event: OffscreenEvent): void; onEnded(reason: CaptureEndReason): void },
  ): CaptureSession;
  /** 由 host 注入事件发送函数后创建配音播放器。 */
  createTtsPlayer(emit: (event: OffscreenEvent) => void): TtsPlayer;
  now(): number;
  randomId(prefix?: string): string;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  logger?: Pick<Console, 'warn' | 'info'>;
  handshakeGraceMs?: number;
  leaseCheckIntervalMs?: number;
  outboxLimit?: number;
}

interface Lease {
  leaseId: string;
  owner: CaptureStartRequest['owner'];
  expiresAtEpochMs: number;
}

interface PendingStart {
  req: CaptureStartRequest;
  cancelled: 'stopped' | 'superseded' | 'lease-expired' | 'disposed' | null;
  session: CaptureSession | null;
  anchors: MediaAnchor[];
  epoch?: number;
  recognition?: boolean;
  gain?: { gain: number; rampMs: number };
  promise?: Promise<unknown>;
}

export interface OffscreenHost {
  start(): void;
  status(): OffscreenStatus;
  diagnostics(): {
    connected: boolean;
    workerInstanceId?: string;
    capture?: CaptureDiagnostics;
    sessions: number;
    reconnects: number;
    lastEnded?: {
      leaseId: string;
      audioContextState: string;
      activeTracks: number;
      pendingRequests: number;
      at: number;
      capture?: CaptureDiagnostics;
    };
  };
  dispose(): Promise<void>;
}

function leaseMismatch(): AppErrorInfo {
  return new AppError({
    code: 'lease-mismatch',
    category: 'capture',
    retryable: false,
    message: '音频捕获租约已失效或不属于当前会话，需要重新开始。',
  }).info;
}

export function isTrustedWakeSender(
  sender: WakeSender,
  runtimeId: string,
  extensionOrigin: string,
): boolean {
  if (sender.id !== runtimeId || sender.tab || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return `${url.protocol}//${url.host}` === extensionOrigin.replace(/\/$/, '');
  } catch {
    return false;
  }
}

export function createOffscreenHost(deps: OffscreenHostDeps): OffscreenHost {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const graceMs = deps.handshakeGraceMs ?? 10_000;
  const outboxLimit = deps.outboxLimit ?? 50;
  const instanceId = deps.randomId('off');

  let port: PortLike | null = null;
  let welcomed = false;
  let workerInstanceId: string | undefined;
  let reconnectTimer: TimerHandle | null = null;
  let reconnectAttempt = 0;
  let reconnects = 0;
  let leaseTimer: TimerHandle | null = null;
  /** 当前租约（待启动或运行中）。 */
  let lease: Lease | null = null;
  const pendingStarts = new Map<string, PendingStart>();
  /** 所有未结束的捕获会话（含停止中的旧会话）。 */
  const sessions = new Set<CaptureSession>();
  let startChain: Promise<unknown> = Promise.resolve();
  let disposed = false;
  let removeWakeListener: (() => void) | null = null;
  const outbox: { event: OffscreenEvent; at: number }[] = [];
  let ttsPlayer: TtsPlayer | null = null;
  let lastEnded: ReturnType<OffscreenHost['diagnostics']>['lastEnded'];
  const tts = (): TtsPlayer => (ttsPlayer ??= deps.createTtsPlayer((event) => emit(event)));

  const currentSession = (): CaptureSession | null => {
    if (!lease) return null;
    for (const s of sessions) if (s.leaseId === lease.leaseId && !s.isStopping) return s;
    return null;
  };

  const hasResources = () => !!lease || sessions.size > 0 || pendingStarts.size > 0 || tts().busy;

  const status = (): OffscreenStatus => {
    const player = tts();
    const cur = currentSession();
    const all = Array.from(sessions);
    let capture: OffscreenStatus['resources']['capture'] = 'none';
    if (cur) {
      const st = cur.state;
      capture =
        st === 'requesting' || st === 'active' || st === 'stopping' || st === 'error'
          ? st
          : 'ended';
    } else if (lease && pendingStarts.has(lease.leaseId)) capture = 'requesting';
    else if (all.length > 0) capture = 'stopping';
    const withCtx = cur ?? all.find((s) => s.audioContextState !== 'none');
    const ctxState =
      withCtx && withCtx.audioContextState !== 'none'
        ? withCtx.audioContextState
        : player.contextState();
    return {
      offscreenInstanceId: instanceId,
      lease: lease
        ? { leaseId: lease.leaseId, owner: lease.owner, expiresAtEpochMs: lease.expiresAtEpochMs }
        : null,
      resources: {
        capture,
        asr: cur ? cur.asrState() : 'idle',
        tts: player.state === 'speaking' ? 'speaking' : player.state === 'error' ? 'error' : 'idle',
        activeTracks: all.reduce((n, s) => n + s.activeTracks, 0),
        pendingRequests: all.reduce((n, s) => n + s.pendingRequests, 0) + player.pendingRequests,
        ...(cur ? { asrBacklogMs: cur.asrBacklogMs } : {}),
      },
      audioContextState: ctxState,
      ttsPlaying: player.busy,
    };
  };

  const post = (message: OffscreenToBackground): boolean => {
    if (!port) return false;
    try {
      port.postMessage(message);
      return true;
    } catch {
      return false;
    }
  };

  const emit = (event: OffscreenEvent) => {
    if (port && welcomed && post({ type: 'event', event })) return;
    if (event.kind === 'asr/result' || event.kind === 'capture/ended') {
      outbox.push({ event, at: deps.now() });
      while (outbox.length > outboxLimit) outbox.shift();
    }
  };

  const flushOutbox = () => {
    const cutoff = deps.now() - 30_000;
    while (outbox.length > 0 && port && welcomed) {
      const item = outbox.shift()!;
      if (item.at < cutoff) continue;
      post({ type: 'event', event: item.event });
    }
  };

  const clearLeaseTimer = () => {
    if (leaseTimer !== null) {
      clearTimer(leaseTimer);
      leaseTimer = null;
    }
  };

  const scheduleLeaseCheck = () => {
    clearLeaseTimer();
    if (disposed || (!lease && sessions.size === 0)) return;
    leaseTimer = setTimer(() => {
      leaseTimer = null;
      checkLeases();
    }, deps.leaseCheckIntervalMs ?? 1_000);
  };

  const expiredError = (): AppErrorInfo => ({
    code: 'lease-expired',
    category: 'capture',
    retryable: true,
    message: '后台长时间没有确认音频会话，已自动停止捕获。',
    at: deps.now(),
  });

  const checkLeases = () => {
    if (lease && deps.now() >= lease.expiresAtEpochMs) {
      deps.logger?.warn('[offscreen] 租约到期未续，停止捕获与播放');
      const expired = lease;
      lease = null;
      tts().stop();
      const pending = pendingStarts.get(expired.leaseId);
      if (pending) pending.cancelled = 'lease-expired';
    }
    // 不属于当前租约、且未在停止中的会话都是孤立会话：一律停止。
    for (const s of sessions) {
      if (s.isStopping) continue;
      if (!lease || s.leaseId !== lease.leaseId) {
        void s.stop(lease ? 'superseded' : 'lease-expired', lease ? undefined : expiredError());
      }
    }
    scheduleLeaseCheck();
  };

  const onSessionEnded = (ended: CaptureSession) => {
    if (!sessions.delete(ended)) return;
    lastEnded = {
      leaseId: ended.leaseId,
      audioContextState: ended.audioContextState,
      activeTracks: ended.activeTracks,
      pendingRequests: ended.pendingRequests,
      at: deps.now(),
      capture: ended.diagnostics(),
    };
    if (lease && lease.leaseId === ended.leaseId && !pendingStarts.has(ended.leaseId)) lease = null;
    if (!lease && sessions.size === 0) clearLeaseTimer();
  };

  const reply = (
    requestId: string,
    result: { ok: true; data?: unknown } | { ok: false; error: AppErrorInfo },
  ) => {
    if (result.ok) post({ type: 'reply', requestId, ok: true, data: result.data });
    else post({ type: 'reply', requestId, ok: false, error: result.error });
  };

  /** 当前租约对应的会话或待启动记录；不匹配时抛 lease-mismatch。 */
  const target = (
    leaseId: string,
  ): { session: CaptureSession | null; pending: PendingStart | null } => {
    if (!lease || lease.leaseId !== leaseId) throw new AppError(leaseMismatch());
    const session = currentSession();
    if (session && session.leaseId === leaseId) return { session, pending: null };
    const pending = pendingStarts.get(leaseId);
    if (pending && !pending.cancelled) return { session: null, pending };
    throw new AppError(leaseMismatch());
  };

  const runStart = async (pending: PendingStart): Promise<unknown> => {
    const { req } = pending;
    const check = () => {
      if (pending.cancelled) throw cancelledError(`capture-start-${pending.cancelled}`);
    };
    check();
    // 先停止其他全部会话（旧租约），等待真实释放。
    const others = Array.from(sessions).filter((s) => s.leaseId !== req.leaseId);
    await Promise.allSettled(others.map((s) => s.stop('superseded')));
    check();
    const holder: { session?: CaptureSession } = {};
    const session = deps.createCaptureSession(req, {
      emit,
      onEnded: () => {
        if (holder.session) onSessionEnded(holder.session);
      },
    });
    holder.session = session;
    sessions.add(session);
    pending.session = session;
    pendingStarts.delete(req.leaseId);
    // 应用待启动期间到达的锚点与设置。
    for (const a of pending.anchors) session.addAnchor(a);
    if (pending.epoch !== undefined) session.setEpoch(pending.epoch);
    scheduleLeaseCheck();
    try {
      const r = await session.start();
      if (pending.recognition === false) session.setRecognition(false);
      if (pending.gain) session.setOriginalGain(pending.gain.gain, pending.gain.rampMs);
      return r;
    } catch (error) {
      await session.stop('error');
      onSessionEnded(session);
      throw error;
    }
  };

  const handleCaptureStart = (req: CaptureStartRequest): Promise<unknown> => {
    // 同一租约重复 start：复用同一次启动，不重复捕获。
    const existingPending = pendingStarts.get(req.leaseId);
    if (
      lease?.leaseId === req.leaseId &&
      existingPending &&
      !existingPending.cancelled &&
      existingPending.promise
    ) {
      return existingPending.promise;
    }
    const cur = currentSession();
    if (cur && cur.leaseId === req.leaseId)
      return cur.start().then((r) => ({ ...r, reused: true }));
    // 新租约：同步登记为当前租约，更早的待启动请求作废。
    for (const p of pendingStarts.values()) p.cancelled ??= 'superseded';
    lease = {
      leaseId: req.leaseId,
      owner: { ...req.owner },
      expiresAtEpochMs: deps.now() + req.leaseTtlMs,
    };
    const pending: PendingStart = { req, cancelled: null, session: null, anchors: [] };
    pendingStarts.set(req.leaseId, pending);
    // 旧租约的会话立即开始停止（即使这次启动随后被取消，旧捕获也不会继续运行）。
    for (const s of sessions)
      if (s.leaseId !== req.leaseId && !s.isStopping) void s.stop('superseded');
    scheduleLeaseCheck();
    const run = startChain.then(() => runStart(pending));
    startChain = run.catch(() => undefined);
    pending.promise = run.finally(() => {
      if (pendingStarts.get(req.leaseId) === pending) pendingStarts.delete(req.leaseId);
      if (pending.cancelled && lease?.leaseId === req.leaseId && !currentSession()) lease = null;
    });
    return pending.promise;
  };

  const handleCaptureStop = async (leaseId: string): Promise<unknown> => {
    const pending = pendingStarts.get(leaseId);
    if (pending && !pending.session) {
      pending.cancelled ??= 'stopped';
      pendingStarts.delete(leaseId);
      if (lease?.leaseId === leaseId) lease = null;
      return { stopped: true, activeTracks: 0, cancelledStart: true };
    }
    const matches = Array.from(sessions).filter((s) => s.leaseId === leaseId);
    if (matches.length === 0) return { stopped: false };
    if (lease?.leaseId === leaseId) lease = null;
    await Promise.allSettled(matches.map((s) => s.stop('stopped')));
    for (const s of matches) onSessionEnded(s);
    return { stopped: true, activeTracks: matches.reduce((n, s) => n + s.activeTracks, 0) };
  };

  const dispatch = async (request: OffscreenRequest): Promise<unknown> => {
    switch (request.kind) {
      case 'status':
        return status();
      case 'capture/start':
        return handleCaptureStart(request);
      case 'capture/stop':
        return handleCaptureStop(request.leaseId);
      case 'capture/set-epoch': {
        const t = target(request.leaseId);
        if (t.session) t.session.setEpoch(request.epoch);
        else t.pending!.epoch = request.epoch;
        lease!.owner = { ...lease!.owner, epoch: request.epoch };
        return { epoch: request.epoch };
      }
      case 'capture/set-recognition': {
        const t = target(request.leaseId);
        if (t.session) t.session.setRecognition(request.enabled);
        else t.pending!.recognition = request.enabled;
        return { enabled: request.enabled };
      }
      case 'audio/original-gain': {
        const t = target(request.leaseId);
        if (t.session && t.session.state === 'active')
          t.session.setOriginalGain(request.gain, request.rampMs);
        else if (t.session)
          throw new AppError({
            code: 'capture-not-active',
            category: 'capture',
            retryable: false,
            message: '音频捕获未在运行',
          });
        else t.pending!.gain = { gain: request.gain, rampMs: request.rampMs };
        return { gain: request.gain };
      }
      case 'timeline/anchor': {
        const t = target(request.leaseId);
        if (t.session) t.session.addAnchor(request.anchor);
        else if (t.pending!.anchors.length < 50) t.pending!.anchors.push(request.anchor);
        return { accepted: true };
      }
      case 'lease/renew': {
        target(request.leaseId);
        lease!.expiresAtEpochMs = deps.now() + request.ttlMs;
        scheduleLeaseCheck();
        return { expiresAtEpochMs: lease!.expiresAtEpochMs };
      }
      case 'tts/play':
        tts().play(request);
        return { accepted: true };
      case 'tts/stop':
        return { stopped: tts().stop(request.utteranceId) };
    }
  };

  const onPortMessage = (raw: unknown) => {
    const parsed = BackgroundToOffscreenSchema.safeParse(raw);
    if (!parsed.success) {
      deps.logger?.warn('[offscreen] 丢弃无效消息');
      return;
    }
    const message = parsed.data;
    if (message.type === 'welcome') {
      if (
        workerInstanceId !== undefined &&
        workerInstanceId !== message.workerInstanceId &&
        lease
      ) {
        lease.expiresAtEpochMs = Math.min(lease.expiresAtEpochMs, deps.now() + graceMs);
        scheduleLeaseCheck();
      }
      workerInstanceId = message.workerInstanceId;
      welcomed = true;
      reconnectAttempt = 0;
      flushOutbox();
      return;
    }
    const { requestId, request } = message;
    dispatch(request).then(
      (data) => reply(requestId, { ok: true, data }),
      (error: unknown) => reply(requestId, { ok: false, error: toAppErrorInfo(error) }),
    );
  };

  const scheduleReconnect = () => {
    if (reconnectTimer !== null || disposed) return;
    const delays = [200, 1_000, 2_000, 5_000];
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)]!;
    reconnectAttempt++;
    reconnectTimer = setTimer(() => {
      reconnectTimer = null;
      if (!port && !disposed) connect();
    }, delay);
  };

  const onPortDisconnect = (disconnected: PortLike) => {
    if (port !== disconnected) return;
    port = null;
    welcomed = false;
    // 没有 worker 就没有配音同步控制：立即停止云端配音并释放合成缓存。
    tts().stop();
    tts().clearCache();
    if (!disposed && (lease || sessions.size > 0 || pendingStarts.size > 0)) scheduleReconnect();
  };

  const connect = () => {
    if (port || disposed) return;
    let p: PortLike;
    try {
      p = deps.connect(PORT_OFFSCREEN);
    } catch {
      if (hasResources()) scheduleReconnect();
      return;
    }
    port = p;
    welcomed = false;
    reconnects++;
    p.onMessage.addListener(onPortMessage);
    p.onDisconnect.addListener(() => onPortDisconnect(p));
    post({ type: 'hello', protocolVersion: OFFSCREEN_PROTOCOL_VERSION, status: status() });
  };

  return {
    start() {
      if (disposed) return;
      removeWakeListener ??= deps.onRuntimeMessage((message, sender, sendResponse) => {
        if (!OffscreenWakeSchema.safeParse(message).success) return;
        if (!isTrustedWakeSender(sender, deps.runtimeId, deps.extensionOrigin)) return;
        connect();
        sendResponse({ ok: true });
      });
      connect();
    },
    status,
    diagnostics() {
      return {
        connected: !!port && welcomed,
        workerInstanceId,
        capture: currentSession()?.diagnostics(),
        sessions: sessions.size,
        reconnects,
        lastEnded,
      };
    },
    async dispose() {
      disposed = true;
      clearLeaseTimer();
      if (reconnectTimer !== null) clearTimer(reconnectTimer);
      reconnectTimer = null;
      removeWakeListener?.();
      removeWakeListener = null;
      for (const p of pendingStarts.values()) p.cancelled ??= 'disposed';
      pendingStarts.clear();
      lease = null;
      const all = Array.from(sessions);
      await Promise.allSettled([...all.map((s) => s.stop('stopped')), tts().dispose()]);
      for (const s of all) onSessionEnded(s);
      const p = port;
      port = null;
      try {
        p?.disconnect();
      } catch {
        // ignore
      }
    },
  };
}

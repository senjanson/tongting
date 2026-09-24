/**
 * 识别请求队列（offscreen 内）。
 *
 * - 串行发送（并发 1），避免本地服务 429 与乱序结果。
 * - 有界积压（T32）：排队 + 在途音频总时长超过 maxBacklogMs 时丢弃最旧的排队分段，计入 droppedMs（积压丢弃）。
 * - 失败丢弃（重试耗尽、单段格式错误、看门狗超时）单独计入 droppedFailedMs，并使状态显示为 error/unavailable，
 *   不会被误报成「只是慢」。
 * - 单请求看门狗：客户端超时之外再加宽限；到期仍未结束则中止请求、按超时失败处理，避免卡死的请求阻塞并发 1 的队列。
 * - reset()（epoch 变化/暂停识别/停止）：中止在途请求、清空排队、世代号递增；旧世代的结果与错误一律丢弃。
 * - 可重试错误有界退避并优先遵守 Retry-After；超时/网络/5xx 单段最多 maxAttempts 次；
 *   429 与模型加载中不消耗该段重试次数（只受积压上限约束）；不可重试的凭证/权限/不支持错误阻断队列直到 reset。
 * - latency 与 realtimeFactor 为实测值：请求往返耗时、往返耗时 / 音频时长（指数平滑）。
 */
import { AppError, toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import type { AsrTranscription } from '../providers/asr/types';
import { encodeWavPcm16 } from './wav';
import { t } from '../i18n';

export interface RecognitionSegment {
  id: string;
  samples: Float32Array;
  sampleRate: number;
  startEpochMs: number;
  endEpochMs: number;
  discontinuityId: number;
}

export interface RecognitionResult {
  segment: RecognitionSegment;
  transcription: AsrTranscription;
  latencyMs: number;
}

export type AsrQueueState = 'idle' | 'loading' | 'running' | 'backlogged' | 'error' | 'unavailable';

export interface AsrQueueStatus {
  state: AsrQueueState;
  backlogMs: number;
  queued: number;
  inFlight: boolean;
  lastLatencyMs?: number;
  realtimeFactor?: number;
  /** 积压上限导致的丢弃。 */
  droppedMs: number;
  droppedSegments: number;
  /** 失败导致的丢弃。 */
  droppedFailedMs: number;
  failedSegments: number;
  lastError?: AppErrorInfo;
}

type TimerHandle = unknown;

export interface RecognitionQueueOptions {
  transcribe(
    wav: ArrayBuffer,
    options: { language: string; signal: AbortSignal; timeoutMs: number },
  ): Promise<AsrTranscription>;
  language: string;
  onResult(result: RecognitionResult): void;
  onStatus?(status: AsrQueueStatus): void;
  onError?(error: AppErrorInfo): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  encodeWav?: (samples: Float32Array, sampleRate: number) => ArrayBuffer;
  maxBacklogMs?: number;
  backlogWarnMs?: number;
  requestTimeoutMs?: number;
  /** 看门狗在 requestTimeoutMs 之外额外等待的时间。 */
  watchdogGraceMs?: number;
  maxAttempts?: number;
  maxRetryDelayMs?: number;
  /** 失败丢弃后多长时间内状态保持 error/unavailable（除非期间成功）。 */
  failureStateMs?: number;
}

interface Entry {
  segment: RecognitionSegment;
  durationMs: number;
  attempts: number;
}

const BLOCKING_CATEGORIES = new Set(['auth', 'permission', 'quota', 'config', 'unsupported']);
const UNAVAILABLE_CODES = new Set([
  'asr-local-unreachable',
  'asr-local-model-unavailable',
  'asr-local-unavailable',
]);

export class RecognitionQueue {
  private readonly o: Required<Omit<RecognitionQueueOptions, 'onStatus' | 'onError'>> &
    Pick<RecognitionQueueOptions, 'onStatus' | 'onError'>;
  private queue: Entry[] = [];
  private inFlight: {
    entry: Entry;
    controller: AbortController;
    startedAt: number;
    generation: number;
    watchdog: TimerHandle;
  } | null = null;
  private generation = 0;
  private enabled = true;
  private disposed = false;
  private blocked: { state: 'error' | 'unavailable'; error: AppErrorInfo } | null = null;
  private retryTimer: TimerHandle | null = null;
  private waitingState: 'loading' | 'unavailable' | null = null;
  private consecutiveFailures = 0;
  private consecutiveFormatFailures = 0;
  private lastErrorCode: string | undefined;
  private lastError: AppErrorInfo | undefined;
  private lastLatencyMs: number | undefined;
  private realtimeFactor: number | undefined;
  private droppedMs = 0;
  private droppedSegments = 0;
  private droppedFailedMs = 0;
  private failedSegments = 0;
  private lastBacklogDropAt = -Infinity;
  private failure: { at: number; state: 'error' | 'unavailable' } | null = null;
  private lastStatusKey = '';

  constructor(options: RecognitionQueueOptions) {
    this.o = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      encodeWav: encodeWavPcm16,
      maxBacklogMs: 30_000,
      backlogWarnMs: 12_000,
      requestTimeoutMs: 30_000,
      watchdogGraceMs: 5_000,
      maxAttempts: 2,
      maxRetryDelayMs: 15_000,
      failureStateMs: 15_000,
      ...options,
    };
  }

  get pendingRequests(): number {
    return this.inFlight ? 1 : 0;
  }

  get currentGeneration(): number {
    return this.generation;
  }

  setLanguage(language: string): void {
    this.o.language = language;
  }

  backlogMs(): number {
    let total = this.inFlight ? this.inFlight.entry.durationMs : 0;
    for (const e of this.queue) total += e.durationMs;
    return total;
  }

  status(): AsrQueueStatus {
    return {
      state: this.state(),
      backlogMs: this.backlogMs(),
      queued: this.queue.length,
      inFlight: !!this.inFlight,
      lastLatencyMs: this.lastLatencyMs,
      realtimeFactor: this.realtimeFactor,
      droppedMs: this.droppedMs,
      droppedSegments: this.droppedSegments,
      droppedFailedMs: this.droppedFailedMs,
      failedSegments: this.failedSegments,
      lastError: this.lastError,
    };
  }

  private state(): AsrQueueState {
    if (this.blocked) return this.blocked.state;
    if (this.retryTimer !== null && this.waitingState) return this.waitingState;
    if (this.failure && this.o.now() - this.failure.at < this.o.failureStateMs)
      return this.failure.state;
    if (this.backlogMs() > this.o.backlogWarnMs || this.o.now() - this.lastBacklogDropAt < 10_000)
      return 'backlogged';
    if (this.inFlight || this.queue.length > 0) return 'running';
    return 'idle';
  }

  /** 加入分段；返回是否接受。 */
  enqueue(segment: RecognitionSegment): boolean {
    if (this.disposed || !this.enabled || this.blocked) return false;
    const durationMs = (segment.samples.length / segment.sampleRate) * 1000;
    this.queue.push({ segment, durationMs, attempts: 0 });
    this.enforceBound();
    this.pump();
    this.notify();
    return true;
  }

  private enforceBound(): void {
    while (this.backlogMs() > this.o.maxBacklogMs && this.queue.length > 1) {
      const dropped = this.queue.shift()!;
      this.droppedMs += dropped.durationMs;
      this.droppedSegments++;
      this.lastBacklogDropAt = this.o.now();
    }
  }

  private abortInFlight(): void {
    const current = this.inFlight;
    if (!current) return;
    this.inFlight = null;
    this.o.clearTimer(current.watchdog);
    try {
      current.controller.abort();
    } catch {
      // 继续清理
    }
  }

  /** 中止在途请求、清空排队并使旧结果失效（epoch 变化、暂停识别）。 */
  reset(): void {
    this.generation++;
    this.abortInFlight();
    this.queue = [];
    this.clearRetryTimer();
    this.blocked = null;
    this.waitingState = null;
    this.failure = null;
    this.consecutiveFailures = 0;
    this.consecutiveFormatFailures = 0;
    this.lastErrorCode = undefined;
    this.notify(true);
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    if (!enabled) this.reset();
    this.enabled = enabled;
    this.notify(true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.enabled = false;
    this.disposed = true;
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      try {
        this.o.clearTimer(this.retryTimer);
      } catch {
        // ignore
      }
      this.retryTimer = null;
    }
  }

  private notify(force = false): void {
    if (!this.o.onStatus) return;
    const s = this.status();
    const key = `${s.state}|${s.queued}|${s.inFlight}|${s.droppedSegments}|${s.failedSegments}|${s.lastError?.code ?? ''}`;
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    try {
      this.o.onStatus(s);
    } catch {
      // 监听器错误不影响队列
    }
  }

  private reportError(info: AppErrorInfo): void {
    this.lastError = info;
    if (info.code === this.lastErrorCode) return;
    this.lastErrorCode = info.code;
    try {
      this.o.onError?.(info);
    } catch {
      // ignore
    }
  }

  private pump(): void {
    if (this.disposed || !this.enabled || this.inFlight || this.blocked || this.retryTimer !== null)
      return;
    const entry = this.queue.shift();
    if (!entry) {
      this.notify();
      return;
    }
    const generation = this.generation;
    const controller = new AbortController();
    const startedAt = this.o.now();
    let wav: ArrayBuffer;
    try {
      wav = this.o.encodeWav(entry.segment.samples, entry.segment.sampleRate);
    } catch (error) {
      this.dropFailed(entry, 'error');
      this.reportError(
        toAppErrorInfo(error, {
          code: 'asr-encode-failed',
          category: 'audio',
          message: t('background.recognition.encodeFailed'),
        }),
      );
      this.pump();
      return;
    }
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      const current = this.inFlight;
      if (generation !== this.generation || !current || current.controller !== controller) return;
      this.o.clearTimer(current.watchdog);
      this.inFlight = null;
      fn();
    };
    const watchdog = this.o.setTimer(() => {
      // 客户端超时没有生效（例如响应体卡住）：强制中止并按超时失败处理。
      settle(() => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
        this.handleFailure(
          entry,
          new AppError({
            code: 'asr-request-watchdog',
            category: 'timeout',
            retryable: true,
            message: t('background.recognition.stalled'),
          }).info,
        );
      });
    }, this.o.requestTimeoutMs + this.o.watchdogGraceMs);
    this.inFlight = { entry, controller, startedAt, generation, watchdog };
    this.notify();
    let promise: Promise<AsrTranscription>;
    try {
      promise = this.o.transcribe(wav, {
        language: this.o.language,
        signal: controller.signal,
        timeoutMs: this.o.requestTimeoutMs,
      });
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (transcription) =>
        settle(() => {
          const latency = Math.max(0, this.o.now() - startedAt);
          this.lastLatencyMs = latency;
          if (entry.durationMs > 0) {
            const rtf = latency / entry.durationMs;
            this.realtimeFactor =
              this.realtimeFactor === undefined ? rtf : this.realtimeFactor * 0.7 + rtf * 0.3;
          }
          this.consecutiveFailures = 0;
          this.consecutiveFormatFailures = 0;
          this.waitingState = null;
          this.failure = null;
          this.lastErrorCode = undefined;
          this.lastError = undefined;
          try {
            this.o.onResult({ segment: entry.segment, transcription, latencyMs: latency });
          } catch {
            // 结果消费方错误不阻断队列
          }
          this.pump();
          this.notify();
        }),
      (error: unknown) =>
        settle(() =>
          this.handleFailure(
            entry,
            toAppErrorInfo(error, {
              code: 'asr-failed',
              category: 'asr',
              message: t('background.recognition.failed'),
            }),
          ),
        ),
    );
  }

  private dropFailed(entry: Entry, state: 'error' | 'unavailable'): void {
    this.droppedFailedMs += entry.durationMs;
    this.failedSegments++;
    this.failure = { at: this.o.now(), state };
  }

  private failureStateOf(info: AppErrorInfo): 'error' | 'unavailable' {
    return info.category === 'network' || UNAVAILABLE_CODES.has(info.code)
      ? 'unavailable'
      : 'error';
  }

  private handleFailure(entry: Entry, info: AppErrorInfo): void {
    if (info.category === 'cancelled') {
      this.dropFailed(entry, 'error');
      this.pump();
      this.notify();
      return;
    }
    this.reportError(info);
    if (BLOCKING_CATEGORIES.has(info.category)) {
      this.dropFailed(entry, info.category === 'unsupported' ? 'unavailable' : 'error');
      for (const e of this.queue)
        this.dropFailed(e, info.category === 'unsupported' ? 'unavailable' : 'error');
      this.queue = [];
      this.blocked = {
        state: info.category === 'unsupported' ? 'unavailable' : 'error',
        error: info,
      };
      this.notify(true);
      return;
    }
    if (!info.retryable) {
      // 单段格式错误（例如 413）：丢弃该段继续；连续多次则阻断。
      this.dropFailed(entry, 'error');
      this.consecutiveFormatFailures++;
      if (this.consecutiveFormatFailures >= 3) {
        for (const e of this.queue) this.dropFailed(e, 'error');
        this.queue = [];
        this.blocked = { state: 'error', error: info };
        this.notify(true);
        return;
      }
      this.pump();
      this.notify(true);
      return;
    }
    // 服务繁忙（429）或模型加载中不是该分段本身的失败：不消耗重试次数，留在队首等待退避。
    const busy = info.category === 'rate-limit' || info.code === 'asr-local-model-loading';
    if (!busy) entry.attempts++;
    if (entry.attempts < this.o.maxAttempts) this.queue.unshift(entry);
    else this.dropFailed(entry, this.failureStateOf(info));
    this.enforceBound();
    const backoff = Math.min(this.o.maxRetryDelayMs, 1000 * 2 ** this.consecutiveFailures);
    this.consecutiveFailures++;
    const delay = Math.min(this.o.maxRetryDelayMs, info.retryAfterMs ?? backoff);
    this.waitingState =
      info.code === 'asr-local-model-loading'
        ? 'loading'
        : this.failureStateOf(info) === 'unavailable'
          ? 'unavailable'
          : null;
    const generation = this.generation;
    this.retryTimer = this.o.setTimer(() => {
      this.retryTimer = null;
      if (generation !== this.generation) return;
      this.pump();
      this.notify();
    }, delay);
    this.notify(true);
  }
}

/**
 * offscreen 中的一次标签页音频捕获会话。
 *
 * 处理图：
 *   MediaStreamSource ─┬─→ 原声 GainNode → destination        （恢复标签页原声；捕获后标签页本地输出被静音）
 *                      └─→ AudioWorkletNode（PCM tap）         （识别分支，位于原声增益之前，ducking 不影响识别）
 *
 * 识别链路：worklet 块 → 下混（worklet 内）→ 流式重采样到 16 kHz（实际输入采样率来自 AudioContext）
 *   → 分段（静音边界/有界长度）→ 等待锚点稳定 → 按时间轴断点拆分/丢弃 → 有界识别队列 → 结果映射为媒体时间 → asr/result。
 *
 * 生命周期：
 * - start 的每个 await 之后核对是否已请求停止；迟到的 getUserMedia 流立即停止全部 tracks（T14）。
 * - track ended / 权限撤回 → stop('track-ended') → capture/ended（T25）。
 * - 各资源独立释放入口，单个失败不影响其他（T26）；stop 可重复调用。
 */
import type { EpochClockSource } from '../../domain/clock';
import { AppError, cancelledError, toAppErrorInfo, type AppErrorInfo } from '../../domain/errors';
import type {
  AsrRoute,
  MediaAnchor,
  MediaOwner,
  OffscreenEvent,
  OffscreenRequest,
} from '../../messaging/offscreen-protocol';
import type { AsrProvider, AsrSegmentResult } from '../../providers/asr/types';
import { releaseAll, stopAllTracks, type ReleaseReport } from '../cleanup';
import { createContextClock, type ContextClock } from '../context-clock';
import { ASR_SAMPLE_RATE, rms, toDbfs } from '../pcm';
import {
  RecognitionQueue,
  type AsrQueueStatus,
  type RecognitionResult,
} from '../recognition-queue';
import { StreamingResampler } from '../resampler';
import { PcmSegmenter, type PcmSegment } from '../segmenter';
import { MediaTimeline, type DropReason } from '../timeline';
import { PCM_TAP_PROCESSOR_NAME } from './constants';
import { t as tr } from '../../i18n';

export type CaptureStartRequest = Extract<OffscreenRequest, { kind: 'capture/start' }>;
export type CaptureEndReason = 'stopped' | 'track-ended' | 'lease-expired' | 'error' | 'superseded';
export type CaptureState = 'requesting' | 'active' | 'stopping' | 'ended' | 'error';

type TimerHandle = unknown;

export interface CaptureSessionDeps {
  getUserMedia(constraints: MediaStreamConstraints): Promise<MediaStream>;
  createAudioContext(): AudioContext;
  createWorkletNode(
    ctx: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ): AudioWorkletNode;
  workletUrl: string;
  createAsrProvider(route: AsrRoute): AsrProvider;
  emit(event: OffscreenEvent): void;
  onEnded?(reason: CaptureEndReason): void;
  /** 跨文档 epoch 毫秒（Date.now() 基准，domain/clock.ts 的 epochNowMs）。 */
  now(): number;
  /** 可注入的 epoch/performance 时钟源（测试用），默认全局 Date.now 与 performance。 */
  clock?: EpochClockSource;
  randomId(prefix: string): string;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  logger?: Pick<Console, 'warn'>;
  tuning?: Partial<CaptureTuning>;
}

export interface CaptureTuning {
  /** 分段完成后等待迟到锚点的时间。 */
  anchorSettleMs: number;
  statusHeartbeatMs: number;
  maxBacklogMs: number;
  backlogWarnMs: number;
  requestTimeoutMs: number;
  chunkFrames: number;
  /** 疑似静音幻觉过滤：noSpeechProb 高于该值且 avgLogprob 低于 -1 时丢弃。 */
  noSpeechThreshold: number;
  minPieceMs: number;
  /** 「有信号但持续被判为静音」达到该时长时上报 asr-input-quiet。 */
  quietNoticeMs: number;
}

const DEFAULT_TUNING: CaptureTuning = {
  anchorSettleMs: 300,
  statusHeartbeatMs: 5_000,
  maxBacklogMs: 30_000,
  backlogWarnMs: 12_000,
  requestTimeoutMs: 30_000,
  chunkFrames: 2048,
  noSpeechThreshold: 0.6,
  minPieceMs: 800,
  quietNoticeMs: 15_000,
};

export interface CaptureDiagnostics {
  sampleRate?: number;
  chunks: number;
  lastChunkDbfs?: number;
  maxChunkDbfs?: number;
  clockSource: ContextClock['source'];
  segmentsQueued: number;
  segmentsDiscarded: { silent: number; tooShort: number };
  timelineDroppedMs: Record<DropReason, number>;
  resultsEmitted: number;
  resultsDropped: number;
  /** 有信号（> -70 dBFS）但被判为无语音而未送识别的时长。 */
  quietInputMs: number;
  /** 数字静音（≤ -70 dBFS）时长，例如浏览器/标签页静音。 */
  digitalSilenceMs: number;
  clockResets: number;
  contextStateChanges: string[];
  /** 实际 track.readyState（保留引用，释放后仍可核对）。 */
  trackReadyStates: string[];
}

function captureError(error: unknown): AppError {
  const name = error instanceof DOMException || error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new AppError(
      {
        code: 'capture-permission-denied',
        category: 'capture',
        retryable: false,
        message: tr('background.offscreen.captureDenied'),
        detail: name,
      },
      { cause: error },
    );
  }
  return new AppError(
    {
      code: 'capture-failed',
      category: 'capture',
      retryable: true,
      message: tr('background.offscreen.captureFailed'),
      detail: name || undefined,
    },
    { cause: error },
  );
}

export class CaptureSession {
  readonly leaseId: string;
  private ownerValue: MediaOwner;
  private readonly req: CaptureStartRequest;
  private readonly deps: CaptureSessionDeps;
  private readonly tuning: CaptureTuning;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;

  private stateValue: CaptureState = 'requesting';
  private stopReason: CaptureEndReason | null = null;
  private stopError: AppErrorInfo | undefined;
  private startPromise: Promise<{ sampleRate: number }> | null = null;
  private stopPromise: Promise<ReleaseReport> | null = null;
  private startedEmitted = false;
  private endedEmitted = false;

  private stream: MediaStream | null = null;
  private trackListeners: Array<{ track: MediaStreamTrack; fn: () => void }> = [];
  /** 获得过的全部 track（含迟到被停止的流），释放后仍保留引用，用于报告真实 readyState。 */
  private tracks: MediaStreamTrack[] = [];
  private quietRunMs = 0;
  private quietNotified = false;
  private ctxStateListener: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private originalGain: number;
  private tap: AudioWorkletNode | null = null;
  private clock: ContextClock | null = null;
  private resampler: StreamingResampler | null = null;
  private segmenter: PcmSegmenter;
  private readonly timeline: MediaTimeline;
  private queue: RecognitionQueue | null = null;
  private asrInitError: AppErrorInfo | undefined;

  private recognitionEnabled = true;
  private generation = 0;
  /** 16 kHz 样本 0 对应的输入帧号（自最近一次重置）。 */
  private baseFrame: number | null = null;
  private expectedFrame: number | null = null;
  private readonly planTimers = new Set<TimerHandle>();
  private statusTimer: TimerHandle | null = null;
  private lastStatusKey = '';

  private readonly diag: CaptureDiagnostics = {
    chunks: 0,
    clockSource: 'none',
    segmentsQueued: 0,
    segmentsDiscarded: { silent: 0, tooShort: 0 },
    timelineDroppedMs: { 'no-anchor': 0, ad: 0, 'not-playing': 0, 'too-short': 0 },
    resultsEmitted: 0,
    resultsDropped: 0,
    quietInputMs: 0,
    digitalSilenceMs: 0,
    clockResets: 0,
    contextStateChanges: [],
    trackReadyStates: [],
  };

  constructor(req: CaptureStartRequest, deps: CaptureSessionDeps) {
    this.req = req;
    this.originalGain = req.originalVolume;
    this.leaseId = req.leaseId;
    this.ownerValue = { ...req.owner };
    this.deps = deps;
    this.tuning = { ...DEFAULT_TUNING, ...deps.tuning };
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.segmenter = new PcmSegmenter({ sampleRate: ASR_SAMPLE_RATE, segmentMs: req.segmentMs });
    this.timeline = new MediaTimeline({ minPieceMs: this.tuning.minPieceMs });
    this.timeline.add(req.anchor);
  }

  get owner(): MediaOwner {
    return this.ownerValue;
  }

  get state(): CaptureState {
    return this.stateValue;
  }

  get isStopping(): boolean {
    return this.stopReason !== null;
  }

  /** 实际 readyState 为 live 的 track 数（释放后仍核对真实状态，stop 抛错时不会误报 0）。 */
  get activeTracks(): number {
    let n = 0;
    for (const t of this.tracks) {
      try {
        if (t.readyState === 'live') n++;
      } catch {
        // 忽略
      }
    }
    return n;
  }

  get pendingRequests(): number {
    return this.queue?.pendingRequests ?? 0;
  }

  get asrBacklogMs(): number {
    return this.queue?.backlogMs() ?? 0;
  }

  get audioContextState(): 'none' | 'running' | 'suspended' | 'closed' {
    if (!this.ctx) return 'none';
    const s = this.ctx.state as string;
    return s === 'running' || s === 'closed' ? s : 'suspended';
  }

  diagnostics(): CaptureDiagnostics {
    return {
      ...this.diag,
      clockSource: this.clock?.source ?? 'none',
      clockResets: this.clock?.resets ?? 0,
      contextStateChanges: [...this.diag.contextStateChanges],
      trackReadyStates: this.tracks.map((t) => String(t.readyState)),
      segmentsDiscarded: { ...this.diag.segmentsDiscarded },
      timelineDroppedMs: { ...this.diag.timelineDroppedMs },
    };
  }

  asrState(): 'idle' | 'loading' | 'running' | 'backlogged' | 'error' | 'unavailable' {
    if (this.asrInitError) return 'error';
    if (!this.queue || this.stateValue !== 'active' || !this.recognitionEnabled) return 'idle';
    const s = this.queue.status().state;
    return s === 'idle' ? 'running' : s;
  }

  start(): Promise<{ sampleRate: number }> {
    this.startPromise ??= this.doStart();
    return this.startPromise;
  }

  private assertNotStopped(): void {
    if (this.stopReason !== null) throw cancelledError('capture-stopped-during-start');
  }

  private async doStart(): Promise<{ sampleRate: number }> {
    const constraints = {
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.req.streamId } },
      video: false,
    } as unknown as MediaStreamConstraints;
    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia(constraints);
    } catch (error) {
      if (this.stopReason !== null) throw cancelledError('capture-stopped-during-start');
      this.stateValue = 'error';
      throw captureError(error);
    }
    if (this.stopReason !== null) {
      // 停止请求先于流到达：迟到的流立即停止，不进入运行态（T14）。
      this.retainTracks(stream);
      stopAllTracks(stream);
      throw cancelledError('capture-stopped-during-start');
    }
    this.stream = stream;
    this.retainTracks(stream);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      await this.releaseResources();
      this.stateValue = 'error';
      throw new AppError({
        code: 'capture-no-audio',
        category: 'capture',
        retryable: true,
        message: tr('background.offscreen.noAudioTrack'),
      });
    }
    for (const track of audioTracks) {
      const fn = () => this.onTrackEnded();
      track.addEventListener('ended', fn);
      this.trackListeners.push({ track, fn });
    }

    try {
      const ctx = this.deps.createAudioContext();
      this.ctx = ctx;
      if (ctx.state === 'suspended') await ctx.resume();
      this.assertNotStopped();
      await ctx.audioWorklet.addModule(this.deps.workletUrl);
      this.assertNotStopped();
      const source = ctx.createMediaStreamSource(stream);
      this.source = source;
      const gain = ctx.createGain();
      gain.gain.value = this.originalGain;
      this.gainNode = gain;
      source.connect(gain);
      gain.connect(ctx.destination);
      const tap = this.deps.createWorkletNode(ctx, PCM_TAP_PROCESSOR_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCountMode: 'max',
        processorOptions: { chunkFrames: this.tuning.chunkFrames },
      });
      this.tap = tap;
      tap.port.onmessage = (event: MessageEvent) => this.onChunk(event.data);
      source.connect(tap);
      this.clock = createContextClock({
        getOutputTimestamp:
          typeof ctx.getOutputTimestamp === 'function' ? () => ctx.getOutputTimestamp() : undefined,
        currentTime: () => ctx.currentTime,
        baseLatency: () => ctx.baseLatency,
        outputLatency: () => ctx.outputLatency,
        clock: this.deps.clock,
      });
      this.ctxStateListener = () => this.onContextStateChange();
      ctx.addEventListener?.('statechange', this.ctxStateListener);
      this.resampler = new StreamingResampler(ctx.sampleRate, ASR_SAMPLE_RATE);
      this.diag.sampleRate = ctx.sampleRate;
    } catch (error) {
      if (this.stopReason !== null) throw cancelledError('capture-stopped-during-start');
      await this.releaseResources();
      this.stateValue = 'error';
      throw new AppError(
        {
          code: 'capture-audio-graph-failed',
          category: 'audio',
          retryable: true,
          message: tr('background.offscreen.audioSetupFailed'),
        },
        { cause: error },
      );
    }

    this.initRecognition();
    this.stateValue = 'active';
    this.startedEmitted = true;
    const sampleRate = this.ctx!.sampleRate;
    this.deps.emit({
      kind: 'capture/started',
      leaseId: this.leaseId,
      owner: this.owner,
      sampleRate,
    });
    this.emitStatus(true);
    this.scheduleHeartbeat();
    return { sampleRate };
  }

  private initRecognition(): void {
    try {
      const provider = this.deps.createAsrProvider(this.req.asr);
      this.queue = new RecognitionQueue({
        transcribe: (wav, options) => provider.transcribe(wav, options),
        language: this.req.language,
        onResult: (result) => this.onResult(result),
        onStatus: () => this.emitStatus(false),
        onError: (error) => this.emitAsrError(error),
        now: this.deps.now,
        setTimer: this.setTimer,
        clearTimer: this.clearTimer,
        maxBacklogMs: this.tuning.maxBacklogMs,
        backlogWarnMs: this.tuning.backlogWarnMs,
        requestTimeoutMs: this.tuning.requestTimeoutMs,
      });
    } catch (error) {
      // 识别配置无效不影响原声回放；上报错误并保持捕获。
      this.asrInitError = toAppErrorInfo(error, {
        code: 'asr-init-failed',
        category: 'config',
        message: tr('background.offscreen.asrConfigInvalid'),
      });
      this.emitAsrError(this.asrInitError);
    }
  }

  private emitAsrError(error: AppErrorInfo): void {
    if (this.stateValue !== 'active' && this.stateValue !== 'requesting') return;
    this.deps.emit({ kind: 'asr/error', leaseId: this.leaseId, owner: this.owner, error });
  }

  private retainTracks(stream: MediaStream): void {
    try {
      for (const t of stream.getTracks()) if (!this.tracks.includes(t)) this.tracks.push(t);
    } catch {
      // 忽略
    }
  }

  /**
   * AudioContext 状态变化（系统睡眠、设备切换、被浏览器挂起、意外关闭）：
   * 时钟偏移作废并重建；挂起时收尾当前分段并尝试恢复；非本会话主动关闭则停止捕获并报告。
   */
  private onContextStateChange(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const state = String(ctx.state);
    this.diag.contextStateChanges.push(state);
    if (this.diag.contextStateChanges.length > 20) this.diag.contextStateChanges.shift();
    this.clock?.reset();
    if (this.stopReason !== null || this.stateValue !== 'active') return;
    if (state === 'closed') {
      void this.stop('error', {
        code: 'audio-context-closed',
        category: 'audio',
        retryable: true,
        message: tr('background.offscreen.contextClosed'),
        at: this.deps.now(),
      });
      return;
    }
    if (state !== 'running') {
      this.flushPipeline();
      ctx.resume().catch(() => undefined);
    }
    this.emitStatus(true);
  }

  private onTrackEnded(): void {
    if (this.stopReason !== null) return;
    this.stopError = {
      code: 'capture-track-ended',
      category: 'capture',
      retryable: true,
      message: tr('background.offscreen.captureEnded'),
      at: this.deps.now(),
    };
    void this.stop('track-ended');
  }

  private onChunk(data: unknown): void {
    if (this.stateValue !== 'active' || !this.clock || !this.resampler) return;
    const msg = data as { type?: unknown; frame?: unknown; samples?: unknown } | null;
    if (
      !msg ||
      msg.type !== 'pcm' ||
      typeof msg.frame !== 'number' ||
      !(msg.samples instanceof Float32Array)
    )
      return;
    const samples = msg.samples;
    const frame = msg.frame;
    this.diag.chunks++;
    const db = toDbfs(rms(samples));
    this.diag.lastChunkDbfs = db;
    this.diag.maxChunkDbfs = Math.max(this.diag.maxChunkDbfs ?? -120, db);
    this.clock.sample();
    if (!this.recognitionEnabled || !this.queue) return;
    if (this.expectedFrame !== null && frame !== this.expectedFrame) {
      // 帧号不连续（上下文暂停/丢块）：收尾当前分段，从新帧重新建立映射。
      this.flushPipeline();
    }
    if (this.baseFrame === null) {
      this.baseFrame = frame;
      this.resampler.reset();
      this.segmenter.reset(0);
    }
    const out = this.resampler.process(samples);
    this.expectedFrame = frame + samples.length;
    this.handleSegments(this.segmenter.push(out));
  }

  private flushPipeline(): void {
    if (this.resampler && this.baseFrame !== null) {
      const tail = this.resampler.flush();
      const segs = this.segmenter.push(tail);
      this.handleSegments(segs.concat(this.segmenter.flush()));
    }
    this.baseFrame = null;
    this.expectedFrame = null;
  }

  private sampleToEpochMs(sample16k: number): number {
    const sr = this.ctx?.sampleRate ?? ASR_SAMPLE_RATE;
    const contextTime = (this.baseFrame ?? 0) / sr + sample16k / ASR_SAMPLE_RATE;
    return this.clock!.contextTimeToEpochMs(contextTime);
  }

  private epochMsToSample(epochMs: number): number {
    const sr = this.ctx?.sampleRate ?? ASR_SAMPLE_RATE;
    const contextTime = this.clock!.epochMsToContextTime(epochMs);
    return (contextTime - (this.baseFrame ?? 0) / sr) * ASR_SAMPLE_RATE;
  }

  private handleSegments(segments: PcmSegment[]): void {
    for (const seg of segments) {
      if (seg.discard === 'silent') {
        this.diag.segmentsDiscarded.silent++;
        this.noteQuiet(seg.rmsDbfs, (seg.samples.length / ASR_SAMPLE_RATE) * 1000);
        continue;
      }
      if (seg.discard === 'too-short') {
        this.diag.segmentsDiscarded.tooShort++;
        continue;
      }
      this.quietRunMs = 0;
      this.quietNotified = false;
      const startEpochMs = this.sampleToEpochMs(seg.startSample);
      const endEpochMs = this.sampleToEpochMs(seg.endSample);
      const generation = this.generation;
      const timer = this.setTimer(() => {
        this.planTimers.delete(timer);
        if (
          generation !== this.generation ||
          this.stateValue !== 'active' ||
          !this.recognitionEnabled
        )
          return;
        this.planAndEnqueue(seg, startEpochMs, endEpochMs);
      }, this.tuning.anchorSettleMs);
      this.planTimers.add(timer);
    }
  }

  /** 有信号但持续判为无语音：计数，并在播放中持续超过阈值时上报一次 asr-input-quiet。 */
  private noteQuiet(rmsDbfs: number, ms: number): void {
    if (rmsDbfs <= -70) {
      this.diag.digitalSilenceMs += ms;
      return;
    }
    this.diag.quietInputMs += ms;
    const latest = this.timeline.latest();
    if (!latest || latest.paused || latest.ad || latest.buffering || latest.seeking) return;
    this.quietRunMs += ms;
    if (this.quietRunMs >= this.tuning.quietNoticeMs && !this.quietNotified) {
      this.quietNotified = true;
      this.emitAsrError({
        code: 'asr-input-quiet',
        category: 'audio',
        retryable: true,
        message: tr('background.offscreen.inputQuiet'),
        at: this.deps.now(),
      });
      this.emitStatus(true);
    }
  }

  private planAndEnqueue(seg: PcmSegment, startEpochMs: number, endEpochMs: number): void {
    if (!this.queue) return;
    const total = seg.samples.length;
    const spanMs = Math.max(1, endEpochMs - startEpochMs);
    for (const piece of this.timeline.plan({ startEpochMs, endEpochMs })) {
      if (piece.disposition === 'drop') {
        this.diag.timelineDroppedMs[piece.reason] += piece.endEpochMs - piece.startEpochMs;
        continue;
      }
      const from = Math.max(
        0,
        Math.min(total, Math.round(((piece.startEpochMs - startEpochMs) / spanMs) * total)),
      );
      const to = Math.max(
        from,
        Math.min(total, Math.round(((piece.endEpochMs - startEpochMs) / spanMs) * total)),
      );
      if (((to - from) / ASR_SAMPLE_RATE) * 1000 < this.tuning.minPieceMs) {
        this.diag.timelineDroppedMs['too-short'] += piece.endEpochMs - piece.startEpochMs;
        continue;
      }
      const accepted = this.queue.enqueue({
        id: this.deps.randomId('seg'),
        samples: seg.samples.slice(from, to),
        sampleRate: ASR_SAMPLE_RATE,
        startEpochMs: piece.startEpochMs,
        endEpochMs: piece.endEpochMs,
        discontinuityId: piece.discontinuityId,
      });
      if (accepted) this.diag.segmentsQueued++;
    }
    this.timeline.prune(this.deps.now() - 180_000);
  }

  private onResult({ segment, transcription }: RecognitionResult): void {
    if (this.stateValue !== 'active' || !this.recognitionEnabled) return;
    const durationMs = (segment.samples.length / segment.sampleRate) * 1000;
    // 无语音结果（text 与 segments 均为空）直接丢弃，不发出结果也不上报语言。
    if (!transcription.text.trim() && transcription.segments.every((s) => !s.text.trim())) return;
    const hasTiming = transcription.segments.length > 0;
    const parts: AsrSegmentResult[] = hasTiming
      ? transcription.segments
      : transcription.text.trim()
        ? [{ startMs: 0, endMs: durationMs, text: transcription.text }]
        : [];
    parts.forEach((part, index) => {
      const text = part.text.trim();
      if (!text) return;
      if (
        part.noSpeechProb !== undefined &&
        part.noSpeechProb > this.tuning.noSpeechThreshold &&
        (part.avgLogprob === undefined || part.avgLogprob < -1)
      ) {
        this.diag.resultsDropped++;
        return;
      }
      const relStart = Math.max(0, Math.min(durationMs, part.startMs));
      const relEnd = Math.max(relStart, Math.min(durationMs, part.endMs));
      const mapped = this.timeline.map(
        {
          startEpochMs: segment.startEpochMs + relStart,
          endEpochMs: segment.startEpochMs + relEnd,
        },
        segment.discontinuityId,
        { timingEstimated: !hasTiming },
      );
      if (!mapped.ok) {
        this.diag.resultsDropped++;
        return;
      }
      const language =
        transcription.language && transcription.language.length <= 20
          ? transcription.language
          : undefined;
      this.diag.resultsEmitted++;
      this.deps.emit({
        kind: 'asr/result',
        leaseId: this.leaseId,
        owner: this.owner,
        segmentId: `${segment.id}:${index}`.slice(0, 120),
        startMs: mapped.startMs,
        endMs: mapped.endMs,
        endEstimated: mapped.endEstimated,
        text: text.slice(0, 4_000),
        ...(language ? { language } : {}),
        final: true,
        revision: 0,
      });
    });
  }

  private statusSnapshot(): AsrQueueStatus | undefined {
    return this.queue?.status();
  }

  private emitStatus(force: boolean): void {
    if (this.stateValue !== 'active') return;
    const q = this.statusSnapshot();
    const state = this.asrState();
    const backlogMs = q?.backlogMs ?? 0;
    const activeTracks = this.activeTracks;
    const key = `${state}|${Math.round(backlogMs / 1000)}|${q?.droppedSegments ?? 0}|${q?.failedSegments ?? 0}|${q?.lastLatencyMs ?? ''}|${this.quietNotified}|${activeTracks}`;
    if (!force && key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.deps.emit({
      kind: 'asr/status',
      leaseId: this.leaseId,
      owner: this.owner,
      state,
      backlogMs,
      activeTracks,
      ...(q?.lastLatencyMs !== undefined ? { lastLatencyMs: q.lastLatencyMs } : {}),
      ...(q?.realtimeFactor !== undefined ? { realtimeFactor: q.realtimeFactor } : {}),
      ...(q && q.droppedMs > 0 ? { droppedMs: q.droppedMs } : {}),
      ...(q && q.droppedFailedMs > 0 ? { droppedFailedMs: q.droppedFailedMs } : {}),
      ...(this.diag.quietInputMs > 0 ? { quietInputMs: this.diag.quietInputMs } : {}),
    });
  }

  private scheduleHeartbeat(): void {
    if (this.statusTimer !== null) this.clearTimer(this.statusTimer);
    this.statusTimer = this.setTimer(() => {
      this.statusTimer = null;
      if (this.stateValue !== 'active') return;
      this.emitStatus(true);
      this.scheduleHeartbeat();
    }, this.tuning.statusHeartbeatMs);
  }

  private clearPlans(): void {
    for (const t of this.planTimers) this.clearTimer(t);
    this.planTimers.clear();
  }

  private resetPipeline(): void {
    this.generation++;
    this.clearPlans();
    this.segmenter.reset(0);
    this.resampler?.reset();
    this.baseFrame = null;
    this.expectedFrame = null;
  }

  /** 跳转/换视频/改语言：丢弃旧缓冲与在途识别，之后结果使用新 epoch。 */
  setEpoch(epoch: number): void {
    this.ownerValue = { ...this.ownerValue, epoch };
    this.resetPipeline();
    this.queue?.reset();
    this.emitStatus(true);
  }

  /** 暂停/恢复识别，原声路径保持。 */
  setRecognition(enabled: boolean): void {
    this.recognitionEnabled = enabled;
    this.resetPipeline();
    this.queue?.setEnabled(enabled);
    this.emitStatus(true);
  }

  /**
   * 视频自然结束：收尾分段器中已缓冲的音频，等待锚点确认与识别队列排空，让结尾几秒也能识别。
   * 结束之后的音频按已收到的暂停锚点丢弃。超时、停止或识别被阻断时返回，不无限等待。
   * @returns 是否在期限内排空。
   */
  async drain(timeoutMs: number): Promise<boolean> {
    const queue = this.queue;
    if (this.stateValue !== 'active' || !queue || !this.recognitionEnabled) return true;
    const deadline = this.deps.now() + timeoutMs;
    this.flushPipeline();
    // 刚切出的分段要等 anchorSettleMs 后才按时间线入队。
    await new Promise<void>((resolve) => this.setTimer(resolve, this.tuning.anchorSettleMs + 20));
    if (this.stateValue !== 'active' || this.queue !== queue) return false;
    return Promise.race([
      queue.whenIdle().then(() => true),
      new Promise<boolean>((resolve) =>
        this.setTimer(() => resolve(false), Math.max(0, deadline - this.deps.now())),
      ),
    ]);
  }

  setOriginalGain(gain: number, rampMs: number): void {
    const target = Math.min(1, Math.max(0, gain));
    if (this.stateValue === 'requesting' && !this.isStopping) {
      this.originalGain = target;
      return;
    }
    if (!this.ctx || !this.gainNode || this.stateValue !== 'active') {
      throw new AppError({
        code: 'capture-not-active',
        category: 'capture',
        retryable: false,
        message: tr('background.offscreen.notRunning'),
      });
    }
    const param = this.gainNode.gain;
    const t = this.ctx.currentTime;
    this.originalGain = target;
    param.cancelScheduledValues(t);
    param.setValueAtTime(param.value, t);
    if (rampMs > 0) param.linearRampToValueAtTime(target, t + rampMs / 1000);
    else param.setValueAtTime(target, t);
  }

  addAnchor(anchor: MediaAnchor): void {
    const { boundary } = this.timeline.add(anchor);
    if (!boundary || this.stateValue !== 'active' || this.baseFrame === null || !this.clock) return;
    const idx = this.epochMsToSample(anchor.epochMs);
    if (idx > this.segmenter.bufferStartSample) this.handleSegments(this.segmenter.cutAt(idx));
  }

  /** 停止并释放全部资源；可重复调用，返回同一个结果。 */
  stop(reason: CaptureEndReason, error?: AppErrorInfo): Promise<ReleaseReport> {
    if (this.stopPromise) return this.stopPromise;
    this.stopReason = reason;
    if (error) this.stopError = error;
    if (this.stateValue !== 'error') this.stateValue = 'stopping';
    this.stopPromise = (async () => {
      const report = await this.releaseResources();
      if (report.failed.length > 0) {
        this.deps.logger?.warn(
          '[offscreen] 部分音频资源释放失败',
          report.failed.map((f) => f.name),
        );
      }
      this.stateValue = 'ended';
      if (this.startedEmitted && !this.endedEmitted) {
        this.endedEmitted = true;
        this.deps.emit({
          kind: 'capture/ended',
          leaseId: this.leaseId,
          owner: this.owner,
          reason,
          ...(this.stopError ? { error: this.stopError } : {}),
        });
      }
      try {
        this.deps.onEnded?.(reason);
      } catch {
        // ignore
      }
      return report;
    })();
    return this.stopPromise;
  }

  private releaseResources(): Promise<ReleaseReport> {
    const stream = this.stream;
    const listeners = this.trackListeners;
    const ctx = this.ctx;
    const tap = this.tap;
    const source = this.source;
    const gain = this.gainNode;
    const queue = this.queue;
    this.stream = null;
    this.trackListeners = [];
    this.tap = null;
    this.source = null;
    this.gainNode = null;
    this.queue = null;
    return releaseAll([
      [
        'status-timer',
        () => {
          if (this.statusTimer !== null) this.clearTimer(this.statusTimer);
          this.statusTimer = null;
        },
      ],
      ['plan-timers', () => this.clearPlans()],
      ['asr-queue', queue ? () => queue.dispose() : null],
      [
        'worklet-port',
        tap
          ? () => {
              tap.port.onmessage = null;
              try {
                tap.port.postMessage({ type: 'stop' });
              } finally {
                tap.port.close();
              }
            }
          : null,
      ],
      ['worklet-node', tap ? () => tap.disconnect() : null],
      ['source-node', source ? () => source.disconnect() : null],
      ['gain-node', gain ? () => gain.disconnect() : null],
      [
        'track-listeners',
        listeners.length
          ? () => {
              for (const { track, fn } of listeners) {
                try {
                  track.removeEventListener('ended', fn);
                } catch {
                  // 继续
                }
              }
            }
          : null,
      ],
      ['tracks', stream ? () => void stopAllTracks(stream) : null],
      [
        'audio-context-listener',
        ctx && this.ctxStateListener
          ? () => {
              ctx.removeEventListener?.('statechange', this.ctxStateListener!);
              this.ctxStateListener = null;
            }
          : null,
      ],
      [
        'audio-context',
        ctx
          ? async () => {
              if (ctx.state !== 'closed') await ctx.close();
            }
          : null,
      ],
    ]);
  }
}

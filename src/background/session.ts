/**
 * 单个翻译会话（一个标签页中的一次视频观看）。
 *
 * 生命周期由协调器的 reconcile 循环驱动：start() 获取资源（每个 await 后核对意图），
 * stop() 幂等释放全部资源（单项失败不阻止其余清理）。
 *
 * 不变量：只有当前 (sessionId, epoch, configRevision) 的结果可以修改字幕或触发配音。
 */
import { MAX_MEDIA_TIME_MS, mergeRanges, type Cue, type SubtitleCoverage } from '../domain/cue';
import { AppError, cancelledError, toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import { findTargetLanguage, isSameLanguage } from '../domain/languages';
import type {
  CaptionTrackInfo,
  PlayerState,
  ResourceState,
  SessionIdentity,
  SessionPhase,
  SessionSnapshot,
  SourceMode,
} from '../domain/session';
import type { Settings } from '../domain/settings';
import type { AsrCueAssembler, IncrementalCaptionAssembler } from '../captions/types';
import type { DisplayCue } from '../messaging/content-protocol';
import type { z } from 'zod';
import type {
  ContentCaptionTrackDataSchema,
  ContentVisibleCaptionSchema,
} from '../messaging/content-protocol';
import type { AsrRoute, MediaAnchor, OffscreenEvent } from '../messaging/offscreen-protocol';
import type { TextProvider, TextProviderConfig } from '../providers/text/types';
import type { DubbingController, TtsEngine } from '../providers/tts/types';
import { transcriptRecordId, RECORD_SCHEMA_VERSION, type TranscriptRecord } from '../storage/db';
import type {
  CueTranslationUpdate,
  TranslationConfig,
  TranslationScheduler,
} from '../translation/types';
import type { CoordinatorDeps } from './deps';
import type { PageState } from './pages';

type TrackData = z.infer<typeof ContentCaptionTrackDataSchema>;
type VisibleCaption = z.infer<typeof ContentVisibleCaptionSchema>;

export interface SessionTimings {
  leaseTtlMs: number;
  leaseRenewMs: number;
  /** 单次续租失败后的重试间隔。 */
  leaseRetryMs: number;
  /** 内容脚本最坏情况：等待播放器元数据约 6s + 加载轨道约 9s。 */
  trackLoadTimeoutMs: number;
  /**
   * 等待页面确认字幕可用性的上限。目标是「约 13 s 内就绪的播放器都能拿到轨道」：
   * 内容脚本在会话 starting 期间每 500 ms 请求一次播放器数据，上限在 13 s 之上留 1 s 余量，
   * 覆盖轮询相位与消息往返，避免播放器恰在 13 s 前就绪时以毫秒之差误报。
   */
  tracksWaitMs: number;
  /** 停止流程中每个等待步骤的上限。 */
  stopStepTimeoutMs: number;
  transcriptSaveDebounceMs: number;
}

export const DEFAULT_SESSION_TIMINGS: SessionTimings = {
  leaseTtlMs: 30_000,
  leaseRenewMs: 10_000,
  leaseRetryMs: 2_000,
  trackLoadTimeoutMs: 20_000,
  tracksWaitMs: 14_000,
  stopStepTimeoutMs: 5_000,
  transcriptSaveDebounceMs: 2_000,
};

const CONTENT_PATCH_DELAY_MS = 80;
/** 运行中接受页面主动推送轨道切换的上限与最小间隔。 */
const MAX_UNSOLICITED_TRACK_SWITCHES = 3;
const MIN_UNSOLICITED_SWITCH_INTERVAL_MS = 5_000;
const SEEK_JUMP_THRESHOLD_MS = 2_500;
const NOTICE_MAX = 300;

/** 截断到 schema 上限，避免快照因单个字段越界而被整体拒收。 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function clipError(error: AppErrorInfo): AppErrorInfo {
  return {
    ...error,
    code: clip(error.code, 80),
    message: clip(error.message, 500),
    detail: error.detail === undefined ? undefined : clip(error.detail, 500),
  };
}

/** 在 ms 内未完成则 reject（原 promise 继续运行，但调用方不再等待）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface SessionHost {
  deps: CoordinatorDeps;
  settings(): Settings;
  apiKey(): string | undefined;
  asrToken(): string | undefined;
  /** 按配置复用 provider 实例（配置与凭证相同则返回同一实例）。 */
  textProvider(config: TextProviderConfig): TextProvider;
  configRevision(): number;
  page(tabId: number): PageState | undefined;
  publish(): void;
  emitUiCues(
    sessionId: string,
    patch: { cueVersion: number; full: boolean; cues: Cue[]; removedIds?: string[] },
  ): void;
  /** 保存协议自动检测结果。 */
  saveDetectedProtocol(protocol: 'responses' | 'chat'): void;
  /** 运行中出现需要结束会话的错误（捕获结束、凭证删除等）。 */
  onFatal(session: TranslationSession, error: AppErrorInfo): void;
  persistRecords(): void;
  /** 识别路由指纹（后端、地址、模型、凭证代数），变化时需重新获取捕获。 */
  asrRouteKey(): string;
}

export interface StartControl {
  /** 用户意图、页面身份与启动时配置仍然有效。 */
  stillWanted(): boolean;
  /** worker 重启后恢复：沿用旧 sessionId 并尝试接管 offscreen 租约。 */
  recovery?: { leaseId?: string };
}

export interface SessionNotice {
  code: string;
  message: string;
  level: 'info' | 'warning' | 'error';
}

function emptyResources(): ResourceState {
  return { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 };
}

export class TranslationSession {
  readonly identity: SessionIdentity;
  readonly navigationId: number;
  readonly startedAt: number;
  phase: SessionPhase = 'starting';
  outputMode: Settings['outputMode'];
  targetLanguage: string;
  sourceMode: SourceMode = 'none';
  sourceTrack?: CaptionTrackInfo;
  sourceKey = 'pending';
  detectedSourceLanguage?: string;
  notice?: SessionNotice;
  error?: AppErrorInfo;
  resources: ResourceState = emptyResources();
  cueVersion = 0;
  updatedAt: number;

  private readonly cues = new Map<string, Cue>();
  private sortedCache: Cue[] | null = null;
  private scheduler?: TranslationScheduler;
  private dubbing?: DubbingController;
  private dubbingUnsub?: () => void;
  private schedulerUnsub?: () => void;
  private incremental?: IncrementalCaptionAssembler;
  private asrAssembler?: AsrCueAssembler;
  capture?: {
    leaseId: string;
    state: 'starting' | 'active' | 'stopping';
    renewTimer?: ReturnType<typeof setInterval>;
  };
  private trackWaiter?: {
    trackKey: string;
    resolve(data: TrackData): void;
    reject(error: AppError): void;
  };
  private tracksWaiter?: () => void;
  private stopPromise?: Promise<void>;
  private stopResolvers: (() => void)[] = [];
  private stopped = false;
  private lastPlayer?: PlayerState;
  private discontinuityId = 0;
  private duckActive = false;
  private duckSeq = 0;
  private unsolicitedSwitches = 0;
  private lastUnsolicitedSwitchAt = -Infinity;
  private endedPaused = false;
  private contentPatch = new Map<string, DisplayCue>();
  private contentPatchTimer?: ReturnType<typeof setTimeout>;
  private transcriptTimer?: ReturnType<typeof setTimeout>;
  private transcriptWrite: Promise<void> = Promise.resolve();
  private recordId: string;
  private asrBacklogNotified = false;
  private stopping = false;
  /** 当前可中止的启动/恢复/刷新操作。 */
  private opAbort?: AbortController;
  private lastRenewOkAt = 0;
  private renewRetryTimer?: ReturnType<typeof setTimeout>;
  /** 获取捕获时的识别路由指纹。 */
  captureRouteKey?: string;
  /** 识别路由配置已变化，需要释放并按新路由重新获取捕获。 */
  needsCaptureRefresh = false;
  private backfill = false;
  /** 最近一次翻译失败；之后有任一字幕翻译成功则清除。 */
  private lastTranslationFailure?: AppErrorInfo;
  /** 配置变化导致无法在会话内切换（例如需重新检测协议），需要以新会话重启。 */
  restartRequested = false;

  constructor(
    private readonly host: SessionHost,
    init: {
      sessionId: string;
      tabId: number;
      documentId: string;
      videoId: string;
      navigationId: number;
    },
  ) {
    const settings = host.settings();
    this.identity = {
      sessionId: init.sessionId,
      tabId: init.tabId,
      documentId: init.documentId,
      videoId: init.videoId,
      epoch: 0,
      configRevision: host.configRevision(),
    };
    this.navigationId = init.navigationId;
    this.outputMode = settings.outputMode;
    this.targetLanguage = settings.targetLanguage;
    this.startedAt = host.deps.now();
    this.updatedAt = this.startedAt;
    this.recordId = transcriptRecordId(init.videoId, this.targetLanguage, this.sourceKey);
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  private get timings(): SessionTimings {
    return { ...DEFAULT_SESSION_TIMINGS, ...this.host.deps.timings };
  }

  /** 中止进行中的启动/恢复操作（意图变化、导航、断开时由协调器调用）。 */
  abortPending(reason: string): void {
    const op = this.opAbort;
    if (!op || op.signal.aborted) return;
    op.abort(cancelledError(reason));
    this.trackWaiter?.reject(cancelledError(reason));
    this.trackWaiter = undefined;
    this.tracksWaiter?.();
  }

  private beginOp(control: StartControl): { signal: AbortSignal; check: () => void } {
    this.opAbort?.abort(cancelledError('superseded'));
    const op = new AbortController();
    this.opAbort = op;
    const check = () => {
      if (op.signal.aborted || !control.stillWanted() || this.isStopping)
        throw cancelledError('operation superseded');
    };
    return { signal: op.signal, check };
  }

  /** 让等待中的 promise 在操作被中止时立即 reject。 */
  private abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelledError('aborted'));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(cancelledError('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener('abort', onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(e);
        },
      );
    });
  }

  /** 会话资源全部释放后 resolve；可在 stop() 调用前等待。 */
  whenStopped(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise((resolve) => this.stopResolvers.push(resolve));
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  async start(control: StartControl): Promise<void> {
    const { deps } = this.host;
    // 启动期间设置或凭证若变化，control.stillWanted() 返回 false，由协调器以最新配置重新启动。
    const settings = this.host.settings();
    const { signal, check } = this.beginOp(control);

    const startPage = this.host.page(this.identity.tabId);
    if (startPage?.isLive) {
      throw new AppError({
        code: 'live-unsupported',
        category: 'unsupported',
        retryable: false,
        message: '暂不支持直播：直播的字幕与音频时间轴尚未验证。请在普通录播视频上使用。',
      });
    }
    if (startPage?.isShorts) {
      this.notice = {
        code: 'shorts-unverified',
        message: 'Shorts 页面尚未经过验证，字幕位置与时间可能不准确。',
        level: 'info',
      };
    }

    const providerConfig = await this.resolveProviderConfig(settings, check, signal);
    check();
    const provider = this.host.textProvider(providerConfig);
    this.scheduler = deps.createTranslationScheduler(
      { provider, cache: deps.translationCache },
      this.translationConfig(settings),
      this.schedulerIdentity(),
    );
    this.schedulerUnsub = this.scheduler.onUpdate((updates) =>
      this.applyTranslationUpdates(updates),
    );
    if (settings.outputMode === 'subtitle-voice') this.setupDubbing(settings);

    const page = this.host.page(this.identity.tabId);
    if (!page) throw cancelledError('page gone');

    let sourceReady = false;
    // 恢复的会话持有识别捕获租约（原来就是语音识别来源）：直接接管租约，不再等待字幕轨道，避免租约在接管前到期。
    const adoptLease = !!control.recovery?.leaseId && settings.sourceStrategy !== 'captions-only';
    const triedCaptions = settings.sourceStrategy !== 'asr-only' && !adoptLease;
    if (triedCaptions) {
      sourceReady = await this.tryCaptionSource(settings, check, signal);
    }
    check();
    if (!sourceReady) {
      // 等待上限内页面仍未确认字幕可用性：不能断言「视频没有字幕」，也不在无识别服务时误报。
      const captionsOnly = settings.sourceStrategy === 'captions-only';
      if (
        triedCaptions &&
        this.captionsNotReady() &&
        (captionsOnly || settings.asr.backend === 'none')
      ) {
        throw new AppError({
          code: 'captions-not-ready',
          category: 'captions',
          retryable: true,
          message: captionsOnly
            ? '页面字幕接入尚未就绪（播放器可能仍在加载），暂时读取不到字幕。请稍后重试。'
            : '页面字幕接入尚未就绪（播放器可能仍在加载），且尚未配置语音识别服务。请稍后重试；视频可继续正常播放。',
        });
      }
      if (captionsOnly) {
        throw new AppError({
          code: 'captions-unavailable',
          category: 'captions',
          retryable: false,
          message:
            '此视频没有可读取的字幕。可在设置中把字幕来源改为「缺失时识别语音」并配置语音识别服务。',
        });
      }
      await this.startAsrSource(settings, check, signal, control.recovery?.leaseId);
    }
    check();
    this.opAbort = undefined;
    this.phase = 'running';
    this.touch();
  }

  private async resolveProviderConfig(
    settings: Settings,
    check: () => void,
    signal: AbortSignal,
  ): Promise<TextProviderConfig> {
    const { deps } = this.host;
    const p = settings.provider;
    const configError = (code: string, message: string) =>
      new AppError({ code, category: 'config', retryable: false, message });
    if (!p.baseUrl)
      throw configError('missing-base-url', '尚未配置 sub2api 服务地址，请先在设置页填写。');
    const normalized = deps.normalizeBaseUrl(p.baseUrl);
    if (!normalized.ok) throw new AppError(normalized.error);
    const apiKey = this.host.apiKey();
    if (!apiKey)
      throw configError(
        'missing-api-key',
        '尚未填写 API Key，请在设置页填写（默认只保存在本次浏览器会话）。',
      );
    if (!p.model) throw configError('missing-model', '尚未选择翻译模型。');
    const granted = await this.abortable(
      signal,
      deps.permissions.contains(normalized.originPattern),
    );
    check();
    if (!granted) {
      throw new AppError({
        code: 'host-permission-missing',
        category: 'permission',
        retryable: false,
        message: '尚未授予访问 sub2api 服务地址的权限，请在设置页点击「授予访问权限」。',
      });
    }
    let protocol: 'responses' | 'chat';
    if (p.protocol !== 'auto') {
      protocol = p.protocol;
    } else if (p.detectedProtocol) {
      protocol = p.detectedProtocol;
    } else {
      const report = await this.abortable(
        signal,
        deps.runTextConnectionCheck({ provider: p, apiKey, hasHostPermission: true, signal }),
      );
      check();
      if (!report.detectedProtocol) {
        const failed = report.items.find(
          (i) => i.status === 'failed' || i.status === 'unsupported',
        );
        throw new AppError({
          code: failed?.reasonCode ?? 'protocol-detect-failed',
          category: 'config',
          retryable: true,
          message:
            failed?.message ?? '无法自动确定接口协议，请在设置页「检查连接」或手动选择协议。',
        });
      }
      protocol = report.detectedProtocol;
      this.host.saveDetectedProtocol(protocol);
    }
    return {
      baseUrl: normalized.baseUrl,
      apiKey,
      protocol,
      model: p.model,
      reasoningEffort: p.reasoningEffort,
      streaming: p.streaming,
    };
  }

  private translationConfig(settings: Settings): TranslationConfig {
    return {
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      style: settings.style,
      glossary: settings.glossary,
      prefetch: settings.prefetch,
      useCache: settings.cacheTranslations,
      timeoutMs: settings.provider.timeoutMs,
    };
  }

  private schedulerIdentity() {
    return {
      sessionId: this.identity.sessionId,
      epoch: this.identity.epoch,
      configRevision: this.identity.configRevision,
      sourceKey: `${this.identity.videoId}:${this.sourceKey}`,
    };
  }

  private async tryCaptionSource(
    settings: Settings,
    check: () => void,
    signal: AbortSignal,
  ): Promise<boolean> {
    let page = this.host.page(this.identity.tabId);
    if (!page) throw cancelledError('page gone');
    if (page.captionsAvailability === 'unknown') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          this.tracksWaiter = undefined;
          resolve();
        }, this.timings.tracksWaitMs);
        this.tracksWaiter = () => {
          clearTimeout(timer);
          this.tracksWaiter = undefined;
          resolve();
        };
      });
      check();
      page = this.host.page(this.identity.tabId);
      if (!page) throw cancelledError('page gone');
    }
    const track = chooseTrack(page.tracks, settings.sourceLanguage, settings.targetLanguage);
    if (!track) return false;

    const loaded = new Promise<TrackData>((resolve, reject) => {
      this.trackWaiter = { trackKey: track.trackKey, resolve, reject };
    });
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutTimer = setTimeout(
        () =>
          reject(
            new AppError({
              code: 'track-load-timeout',
              category: 'captions',
              retryable: true,
              message: '读取字幕轨道超时',
            }),
          ),
        this.timings.trackLoadTimeoutMs,
      );
    });
    page.conn
      .request(
        {
          kind: 'captions/load-track',
          videoId: this.identity.videoId,
          trackKey: track.trackKey,
          preferredLanguage: track.languageCode,
        },
        this.timings.trackLoadTimeoutMs,
        this.navigationId,
      )
      .catch((error: unknown) =>
        this.trackWaiter?.reject(new AppError(externalCaptionError(error))),
      );
    try {
      const data = await this.abortable(signal, Promise.race([loaded, timeout])).finally(() =>
        clearTimeout(timeoutTimer),
      );
      check();
      await this.applyTrack(data);
      return true;
    } catch {
      // 是否「被新意图取代」只由 check() 判定；页面带来的 cancelled 类错误按字幕读取失败处理。
      check();
      this.trackWaiter = undefined;
      // 完整轨道不可读：退回仅读取当前显示字幕（覆盖有限）。
      const ok = await this.abortable(
        signal,
        page.conn
          .request(
            { kind: 'captions/observe-visible', videoId: this.identity.videoId, enable: true },
            10_000,
            this.navigationId,
          )
          .then(() => true)
          .catch(() => false),
      );
      check();
      if (!ok) return false;
      this.sourceMode = 'incremental-captions';
      this.sourceTrack = track;
      // 增量来源每个会话只覆盖观看到的片段：按会话区分记录，避免下一个会话覆盖。
      this.sourceKey = `visible:${track.trackKey}:${this.identity.sessionId}`;
      this.detectedSourceLanguage = track.languageCode || undefined;
      this.incremental = this.host.deps.createIncrementalCaptionAssembler({
        idPrefix: `${this.identity.videoId}:visible:${this.identity.sessionId}`,
        sourceLanguage: track.languageCode || 'und',
        targetLanguage: this.targetLanguage,
      });
      this.recordId = transcriptRecordId(
        this.identity.videoId,
        this.targetLanguage,
        this.sourceKey,
      );
      this.scheduler?.setCues([], this.schedulerIdentity());
      this.notice = {
        code: 'incremental-captions',
        message:
          '无法读取完整字幕轨道，改为读取播放器当前显示的字幕：只覆盖已播放部分，且需保持 YouTube 字幕开启。',
        level: 'warning',
      };
      return true;
    }
  }

  private async startAsrSource(
    settings: Settings,
    check: () => void,
    signal: AbortSignal,
    recoveryLeaseId?: string,
  ): Promise<void> {
    const { deps } = this.host;
    const route = await this.resolveAsrRoute(settings, check, signal);
    check();
    this.sourceMode = 'asr';
    this.sourceKey = `asr:${this.identity.sessionId}`;
    this.recordId = transcriptRecordId(this.identity.videoId, this.targetLanguage, this.sourceKey);
    this.asrAssembler = deps.createAsrCueAssembler({
      idPrefix: `${this.identity.videoId}:asr:${this.identity.sessionId}`,
      targetLanguage: this.targetLanguage,
    });
    this.scheduler?.setCues([], this.schedulerIdentity());

    if (recoveryLeaseId) {
      const status = await this.abortable(
        signal,
        deps.offscreen.queryStatus().catch(() => null),
      );
      check();
      if (
        status?.lease?.leaseId === recoveryLeaseId &&
        status.lease.owner.sessionId === this.identity.sessionId
      ) {
        this.capture = { leaseId: recoveryLeaseId, state: 'active' };
        this.resources.capture = 'active';
        this.captureRouteKey = this.host.asrRouteKey();
        await this.abortable(
          signal,
          deps.offscreen.request({
            kind: 'lease/renew',
            leaseId: recoveryLeaseId,
            ttlMs: this.timings.leaseTtlMs,
          }),
        );
        await this.abortable(
          signal,
          deps.offscreen.request({
            kind: 'capture/set-epoch',
            leaseId: recoveryLeaseId,
            epoch: this.identity.epoch,
          }),
        );
        check();
        this.startLeaseRenewal();
        return;
      }
    }

    await this.acquireCapture(settings, route, check, signal);
  }

  /** 获取标签页音频捕获并在 offscreen 启动识别；停止/暂停后恢复时也走这里。 */
  private async acquireCapture(
    settings: Settings,
    route: AsrRoute,
    check: () => void,
    signal: AbortSignal,
  ): Promise<void> {
    const { deps } = this.host;
    const routeKey = this.host.asrRouteKey();
    this.resources.capture = 'requesting';
    this.host.publish();
    let streamId: string;
    try {
      streamId = await this.abortable(
        signal,
        deps.tabCapture.getMediaStreamId(this.identity.tabId),
      );
    } catch (error) {
      check();
      this.resources.capture = 'error';
      throw new AppError(
        {
          code: 'capture-not-allowed',
          category: 'capture',
          retryable: true,
          message:
            '无法捕获此标签页的声音。请在该 YouTube 标签页点击浏览器工具栏中的「同听」图标（或按快捷键 Alt+T）后重试。',
          detail: error instanceof Error ? error.message.slice(0, 160) : undefined,
        },
        { cause: error },
      );
    }
    // stream ID 未被消费时自然失效；取消后不再使用。
    check();
    await this.abortable(signal, deps.offscreen.ensure());
    check();
    const leaseId = deps.randomId('lease');
    // 先登记租约再发送请求：若 start 在途时被停止，stop 会按 leaseId 释放迟到成功的捕获。
    this.capture = { leaseId, state: 'starting' };
    this.captureRouteKey = routeKey;
    await this.abortable(
      signal,
      deps.offscreen.request(
        {
          kind: 'capture/start',
          leaseId,
          owner: this.mediaOwner(),
          leaseTtlMs: this.timings.leaseTtlMs,
          streamId,
          asr: route,
          language: settings.sourceLanguage,
          segmentMs: settings.asr.segmentMs,
          originalVolume: settings.audio.originalVolume,
          anchor: this.currentAnchor(),
        },
        20_000,
      ),
    );
    check();
    this.capture.state = 'active';
    this.resources.capture = 'active';
    this.startLeaseRenewal();
    // 获取期间用户调整了原声音量：按最新值补发一次。
    const latest = this.host.settings().audio;
    if (latest.originalVolume !== settings.audio.originalVolume) {
      deps.offscreen
        .request({ kind: 'audio/original-gain', leaseId, gain: latest.originalVolume, rampMs: 100 })
        .catch(() => undefined);
    }
  }

  /** 等待结束后页面仍未确认字幕可用性（播放器数据未就绪），不能断言「视频没有字幕」。 */
  private captionsNotReady(): boolean {
    return this.host.page(this.identity.tabId)?.captionsAvailability === 'unknown';
  }

  private async resolveAsrRoute(
    settings: Settings,
    check: () => void,
    signal: AbortSignal,
  ): Promise<AsrRoute> {
    const { deps } = this.host;
    const configError = (code: string, message: string) =>
      new AppError({ code, category: 'config', retryable: false, message });
    if (settings.asr.backend === 'none') {
      throw configError(
        'asr-not-configured',
        '此视频没有可读取的字幕，且尚未配置语音识别服务。请在设置页「识别与播放」中配置后重试。视频可继续正常播放。',
      );
    }
    if (settings.asr.backend === 'local') {
      const normalized = deps.normalizeBaseUrl(settings.asr.localUrl);
      // 只允许 127.0.0.1：服务只监听 IPv4，localhost 可能解析到被其他进程占用的 ::1，导致令牌与音频泄露。
      if (!normalized.ok || !/^http:\/\/127\.0\.0\.1(:\d+)?$/.test(normalized.origin)) {
        throw configError(
          'asr-local-url-invalid',
          '本地识别服务地址无效，只允许 http://127.0.0.1:<端口>。',
        );
      }
      const token = this.host.asrToken();
      if (!token) throw configError('asr-token-missing', '尚未填写本地识别服务的配对令牌。');
      const granted = await this.abortable(
        signal,
        deps.permissions.contains(normalized.originPattern),
      );
      check();
      if (!granted) {
        throw new AppError({
          code: 'asr-host-permission-missing',
          category: 'permission',
          retryable: false,
          message: '尚未授予访问本地识别服务的权限，请在设置页点击「授予访问权限」。',
        });
      }
      return { backend: 'local', baseUrl: normalized.baseUrl, token };
    }
    const normalized = deps.normalizeBaseUrl(settings.provider.baseUrl);
    const apiKey = this.host.apiKey();
    if (!normalized.ok || !apiKey)
      throw configError('asr-sub2api-config', 'sub2api 服务地址或 Key 未配置。');
    if (!settings.asr.sub2apiModel)
      throw configError('asr-model-missing', '尚未填写 sub2api 语音识别模型。');
    return {
      backend: 'sub2api',
      baseUrl: normalized.baseUrl,
      apiKey,
      model: settings.asr.sub2apiModel,
    };
  }

  /**
   * 定期续租。单次失败在 TTL 余量内短间隔重试；只有 offscreen 明确报告租约不存在，
   * 或距上次成功续租已接近 TTL 时才判定音频组件丢失。
   */
  private startLeaseRenewal(): void {
    const capture = this.capture;
    if (!capture) return;
    const { leaseTtlMs, leaseRenewMs, leaseRetryMs } = this.timings;
    this.lastRenewOkAt = this.host.deps.now();
    if (capture.renewTimer) clearInterval(capture.renewTimer);
    const renew = () => {
      if (this.capture !== capture || capture.state !== 'active' || this.isStopping) return;
      this.host.deps.offscreen
        .request(
          { kind: 'lease/renew', leaseId: capture.leaseId, ttlMs: leaseTtlMs },
          Math.min(5_000, leaseRenewMs),
        )
        .then(() => {
          this.lastRenewOkAt = this.host.deps.now();
        })
        .catch((error: unknown) => {
          if (this.capture !== capture || this.isStopping) return;
          const info = toAppErrorInfo(error, { category: 'audio' });
          // 租约不存在、或 offscreen 文档已不存在：捕获必然已丢失，立即判定。
          const leaseGone = /lease/i.test(info.code) || info.code === 'offscreen-missing';
          const overdue =
            this.host.deps.now() - this.lastRenewOkAt >
            leaseTtlMs - Math.min(5_000, leaseTtlMs / 3);
          if (!leaseGone && !overdue) {
            if (this.renewRetryTimer) clearTimeout(this.renewRetryTimer);
            this.renewRetryTimer = setTimeout(renew, leaseRetryMs);
            return;
          }
          this.host.onFatal(this, {
            ...info,
            code: 'offscreen-lost',
            category: 'audio',
            message: '音频处理组件意外中断，已停止语音识别。请重新开始翻译。',
            retryable: true,
          });
        });
    };
    capture.renewTimer = setInterval(renew, leaseRenewMs);
  }

  private setupDubbing(settings: Settings): void {
    const { deps } = this.host;
    let engine: TtsEngine | undefined;
    if (settings.tts.backend === 'system') engine = deps.systemTts;
    else if (settings.tts.backend === 'sub2api') {
      engine = deps.createSub2apiTtsEngine({
        offscreen: deps.offscreen,
        getRoute: () => {
          const s = this.host.settings();
          const n = deps.normalizeBaseUrl(s.provider.baseUrl);
          const key = this.host.apiKey();
          if (!n.ok || !key || !s.tts.sub2apiModel) return null;
          return {
            baseUrl: n.baseUrl,
            apiKey: key,
            model: s.tts.sub2apiModel,
            voice: s.tts.sub2apiVoice,
          };
        },
        getOwner: () => (this.isStopping ? null : this.mediaOwner()),
      });
    }
    if (!engine) {
      this.notice = {
        code: 'tts-disabled',
        message: '未启用语音合成服务，当前仅显示字幕。',
        level: 'warning',
      };
      return;
    }
    this.dubbing = deps.createDubbingController({ engine, now: deps.now });
    this.dubbing.setConfig(this.dubbingConfig(settings));
    this.dubbingUnsub = this.dubbing.onEvent((event) => {
      if (this.isStopping) return;
      if (event.type === 'speaking') this.setDuck(true);
      else if (event.type === 'idle') this.setDuck(false);
      else if (event.type === 'error') {
        this.setDuck(false);
        this.notice = {
          code: 'tts-error',
          message: clip(`配音出错：${event.error.message}`, NOTICE_MAX),
          level: 'warning',
        };
      }
      this.host.publish();
    });
  }

  private dubbingConfig(settings: Settings) {
    const lang = findTargetLanguage(settings.targetLanguage)?.code ?? settings.targetLanguage;
    return {
      enabled: settings.outputMode === 'subtitle-voice',
      lang,
      voiceName: settings.audio.voiceName || undefined,
      rate: settings.audio.rate,
      volume: settings.audio.dubVolume,
      pauseWithVideo: settings.pauseDubWithVideo,
    };
  }

  private setDuck(active: boolean): void {
    const settings = this.host.settings();
    const want = active && settings.audio.duckOriginal;
    if (this.capture?.state === 'active') {
      const gain = settings.audio.originalVolume * (want ? settings.audio.duckLevel : 1);
      this.host.deps.offscreen
        .request({ kind: 'audio/original-gain', leaseId: this.capture.leaseId, gain, rampMs: 150 })
        .catch(() => undefined);
      this.duckActive = want;
      return;
    }
    if (this.duckActive === want) return;
    this.duckActive = want;
    const seq = ++this.duckSeq;
    const page = this.host.page(this.identity.tabId);
    if (!page || page.documentId !== this.identity.documentId) return;
    page.conn
      .request(
        {
          kind: 'player/duck',
          videoId: this.identity.videoId,
          active: want,
          level: settings.audio.duckLevel,
        },
        3_000,
        this.navigationId,
      )
      .then((reply) => {
        // 页面判定用户已手动调整音量（或未能应用）：同步为未降低，之后的朗读会重新请求 ducking（T17）。
        const r = reply as { applied?: boolean } | undefined;
        if (seq === this.duckSeq && r?.applied === false) this.duckActive = false;
      })
      .catch(() => {
        if (seq === this.duckSeq) this.duckActive = false;
      });
  }

  // ---------------------------------------------------------------------------
  // 暂停 / 恢复 / 停止
  // ---------------------------------------------------------------------------

  /**
   * 暂停翻译（§8.6）：取消翻译/合成任务、清空待播放队列、释放音频捕获；保留已确认字幕。
   * 释放捕获后标签页原声由浏览器恢复正常输出。
   */
  async pause(): Promise<void> {
    if (this.phase !== 'running') return;
    this.phase = 'pausing';
    this.scheduler?.pause();
    this.bumpEpoch();
    this.setDuck(false);
    this.touch();
    if (this.capture) await this.releaseCapture('paused');
    if (this.isStopping) return;
    this.phase = 'paused';
    this.touch();
  }

  /**
   * 继续翻译。语音识别模式需要重新获取标签页捕获，可能因缺少用户调用（activeTab）而失败，
   * 此时抛出错误、保持暂停，由协调器展示下一步。
   */
  async resume(control: StartControl): Promise<void> {
    if (this.phase !== 'paused') return;
    const { signal, check } = this.beginOp(control);
    if (this.sourceMode === 'asr' && !this.capture) {
      this.phase = 'starting';
      this.touch();
      try {
        const settings = this.host.settings();
        const route = await this.resolveAsrRoute(settings, check, signal);
        check();
        await this.acquireCapture(settings, route, check, signal);
      } catch (error) {
        if (!this.isStopping) {
          if (this.capture) await this.releaseCapture('resume-failed');
          this.phase = 'paused';
          this.touch();
        }
        throw error;
      }
    }
    this.opAbort = undefined;
    this.needsCaptureRefresh = false;
    this.phase = 'running';
    this.error = undefined;
    this.scheduler?.resume();
    if (this.lastPlayer) this.feedPlayer(this.lastPlayer, 'tick');
    this.refeedDubbing();
    this.touch();
  }

  /**
   * 识别路由（后端、地址、模型、凭证）变化：释放旧捕获（中止旧凭证的在途识别），按新路由重新获取。
   * 无法获取（配置不可用或需要用户调用扩展）时保持暂停并抛出错误。
   */
  async refreshCapture(control: StartControl): Promise<void> {
    if (this.phase !== 'running' || this.sourceMode !== 'asr') {
      this.needsCaptureRefresh = false;
      return;
    }
    this.needsCaptureRefresh = false;
    this.phase = 'pausing';
    this.scheduler?.pause();
    this.bumpEpoch();
    this.setDuck(false);
    this.touch();
    await this.releaseCapture('route-changed');
    if (this.isStopping) return;
    this.phase = 'paused';
    await this.resume(control);
  }

  /** 释放标签页捕获（幂等）。请求失败时依赖 offscreen 租约到期自行停止。 */
  private async releaseCapture(reason: string): Promise<void> {
    const capture = this.capture;
    if (!capture) return;
    this.capture = undefined;
    this.captureRouteKey = undefined;
    capture.state = 'stopping';
    if (capture.renewTimer) clearInterval(capture.renewTimer);
    if (this.renewRetryTimer) {
      clearTimeout(this.renewRetryTimer);
      this.renewRetryTimer = undefined;
    }
    this.resources.capture = 'stopping';
    try {
      const result = await this.host.deps.offscreen.request(
        { kind: 'capture/stop', leaseId: capture.leaseId, reason },
        8_000,
      );
      this.resources.capture = 'none';
      // 释放后不再有 asr/status 心跳：按 offscreen 回报的真实 live 音轨数更新（未回报视为 0）。
      const tracks = (result as { activeTracks?: unknown } | undefined)?.activeTracks;
      this.resources.activeTracks =
        typeof tracks === 'number' && Number.isInteger(tracks) && tracks >= 0 ? tracks : 0;
    } catch (error) {
      this.resources.capture = 'error';
      this.host.deps.logger.warn(
        '[tongting] capture/stop failed; lease expiry will release',
        error instanceof Error ? error.name : 'unknown',
      );
    }
    this.resources.asr = 'idle';
    this.resources.asrBacklogMs = undefined;
    await withTimeout(
      this.host.deps.offscreen.closeIfIdle(),
      this.timings.stopStepTimeoutMs,
      'closeIfIdle',
    ).catch(() => false);
  }

  stop(reason: string): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    // 同步置位：doStop 同步段中触发的回调也必须看到「正在停止」。
    this.stopping = true;
    this.abortPending(reason);
    this.stopPromise = this.doStop(reason);
    return this.stopPromise;
  }

  private async doStop(reason: string): Promise<void> {
    const { deps } = this.host;
    const prevPhase = this.phase;
    this.phase = 'stopping';
    const safe = (label: string, fn: () => void) => {
      try {
        fn();
      } catch (error) {
        deps.logger.warn(
          `[tongting] cleanup failed: ${label}`,
          error instanceof Error ? error.name : 'unknown',
        );
      }
    };
    // 先释放调度器再递增 epoch：避免 setEpoch 在停止过程中发起新的翻译请求。
    safe('scheduler-unsub', () => this.schedulerUnsub?.());
    safe('scheduler', () => this.scheduler?.dispose());
    this.bumpEpoch();
    this.host.publish();
    safe('track-waiter', () => this.trackWaiter?.reject(cancelledError(reason)));
    this.trackWaiter = undefined;
    safe('tracks-waiter', () => this.tracksWaiter?.());
    safe('dubbing-unsub', () => this.dubbingUnsub?.());
    safe('dubbing', () => this.dubbing?.dispose());
    safe('duck', () => this.setDuck(false));
    if (this.contentPatchTimer) clearTimeout(this.contentPatchTimer);
    await this.releaseCapture(reason);
    if (this.incremental) {
      const page = this.host.page(this.identity.tabId);
      if (page && page.documentId === this.identity.documentId) {
        page.conn
          .request(
            { kind: 'captions/observe-visible', videoId: this.identity.videoId, enable: false },
            3_000,
            this.navigationId,
          )
          .catch(() => undefined);
      }
    }
    if (this.transcriptTimer) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = undefined;
      if (prevPhase !== 'starting' || this.cues.size > 0) this.queueTranscriptWrite();
    }
    await withTimeout(this.transcriptWrite, this.timings.stopStepTimeoutMs, 'transcript').catch(
      (error: unknown) => {
        deps.logger.warn(
          '[tongting] transcript flush did not finish during stop',
          error instanceof Error ? error.message : 'unknown',
        );
      },
    );
    await withTimeout(
      deps.offscreen.closeIfIdle(),
      this.timings.stopStepTimeoutMs,
      'closeIfIdle',
    ).catch(() => false);
    this.phase = 'idle';
    this.stopped = true;
    this.resources = {
      ...emptyResources(),
      capture: this.resources.capture === 'error' ? 'error' : 'none',
    };
    for (const resolve of this.stopResolvers.splice(0)) resolve();
  }

  // ---------------------------------------------------------------------------
  // 输入事件
  // ---------------------------------------------------------------------------

  onTracksChanged(): void {
    // 播放器初始化较慢时，页面会先上报 availability=unknown 的空轨道列表：继续等待（最多 tracksWaitMs），
    // 不能据此判定「无字幕」而误入语音识别分支。
    const page = this.host.page(this.identity.tabId);
    if (page && page.captionsAvailability !== 'unknown') this.tracksWaiter?.();
  }

  onCaptionError(error: AppErrorInfo): void {
    // 元数据暂时读取失败不结束轨道列表等待（内容脚本会退避重试）；只让正在进行的轨道加载失败。
    this.trackWaiter?.reject(new AppError(error));
  }

  async onTrackData(data: TrackData): Promise<void> {
    if (
      this.isStopping ||
      data.videoId !== this.identity.videoId ||
      data.navigationId !== this.navigationId
    )
      return;
    if (this.trackWaiter) {
      // 只接受正在等待的轨道；等待期间页面顺带捕获的其他轨道正文不作为结果。
      if (data.track.trackKey !== this.trackWaiter.trackKey) return;
      const waiter = this.trackWaiter;
      this.trackWaiter = undefined;
      waiter.resolve(data);
      return;
    }
    if (this.phase === 'starting') return;
    // 运行中轨道变化（用户在播放器切换了字幕语言等）：旧来源任务失效，切换到新轨道（T34）。
    if (this.sourceMode === 'asr') return;
    if (this.sourceTrack?.trackKey === data.track.trackKey && this.sourceMode === 'full-track')
      return;
    // 页面主动推送的轨道必须属于该视频已上报的轨道列表，并限制切换频率，避免被页面反复触发重新翻译（计费）。
    const tracks = this.host.page(this.identity.tabId)?.tracks ?? [];
    if (!tracks.some((t) => t.trackKey === data.track.trackKey)) return;
    const now = this.host.deps.now();
    if (
      this.unsolicitedSwitches >= MAX_UNSOLICITED_TRACK_SWITCHES ||
      now - this.lastUnsolicitedSwitchAt < MIN_UNSOLICITED_SWITCH_INTERVAL_MS
    ) {
      return;
    }
    this.unsolicitedSwitches++;
    this.lastUnsolicitedSwitchAt = now;
    if (this.incremental) {
      const page = this.host.page(this.identity.tabId);
      page?.conn
        .request(
          { kind: 'captions/observe-visible', videoId: this.identity.videoId, enable: false },
          3_000,
          this.navigationId,
        )
        .catch(() => undefined);
      this.incremental = undefined;
      if (this.notice?.code === 'incremental-captions') this.notice = undefined;
    }
    this.bumpEpoch();
    await this.applyTrack(data);
  }

  private async applyTrack(data: TrackData): Promise<void> {
    const units = this.host.deps.buildCueUnits(data.cues, {
      sourceLanguage: data.track.languageCode || 'und',
      targetLanguage: this.targetLanguage,
      idPrefix: `${this.identity.videoId}:${data.track.trackKey}`,
      source: 'caption-track',
      autoGenerated: data.track.kind === 'asr',
    });
    this.sourceMode = data.complete ? 'full-track' : 'incremental-captions';
    // 新轨道由调度器重新开始；补译开关按新来源是否完整决定是否保留。
    if (!data.complete) this.backfill = false;
    this.sourceTrack = data.track;
    this.sourceKey = `track:${data.track.trackKey}`;
    this.detectedSourceLanguage = data.track.languageCode || undefined;
    this.recordId = transcriptRecordId(this.identity.videoId, this.targetLanguage, this.sourceKey);
    this.cues.clear();
    for (const cue of units) this.cues.set(cue.id, this.markSameLanguage(cue));
    this.sortedCache = null;
    this.cueVersion++;
    this.pushFullCues();
    this.dubbing?.invalidate(this.identity.epoch);
    this.scheduler?.setCues(this.sortedCues(), this.schedulerIdentity());
    this.scheduler?.setBackfill(this.backfill);
    if (this.lastPlayer) this.feedPlayer(this.lastPlayer, 'tick');
    this.refeedDubbing();
    this.touch();
  }

  private markSameLanguage(cue: Cue): Cue {
    if (isSameLanguage(cue.sourceLanguage, this.targetLanguage)) {
      return { ...cue, translationState: 'skipped', translatedText: undefined };
    }
    return cue;
  }

  onVisibleCaption(sample: VisibleCaption): void {
    if (!this.incremental || this.phase !== 'running') return;
    if (sample.videoId !== this.identity.videoId || sample.navigationId !== this.navigationId)
      return;
    const { upserts, removedIds } = this.incremental.push({
      text: sample.text,
      mediaTimeMs: sample.mediaTimeMs,
    });
    this.upsertCues(upserts, removedIds);
  }

  onOffscreenEvent(event: OffscreenEvent): void {
    if (event.kind === 'tts/event' || event.kind === 'status') return;
    if (!this.capture || event.leaseId !== this.capture.leaseId) return;
    switch (event.kind) {
      case 'capture/started':
        this.resources.capture = 'active';
        break;
      case 'capture/ended':
        if (this.isStopping) break;
        this.resources.capture = 'ended';
        this.host.onFatal(this, {
          code: `capture-${event.reason}`,
          category: 'capture',
          retryable: true,
          message:
            event.reason === 'lease-expired'
              ? '音频捕获因后台失联而自动停止，请重新开始翻译。'
              : '标签页音频捕获已结束（可能是权限被撤回或页面音频不可用），已停止语音识别。请重新开始翻译。',
          detail: event.error?.message,
          at: this.host.deps.now(),
        });
        break;
      case 'asr/result': {
        if (
          event.owner.sessionId !== this.identity.sessionId ||
          event.owner.epoch !== this.identity.epoch
        )
          return;
        if (this.phase !== 'running' || !this.asrAssembler) return;
        if (event.language) this.detectedSourceLanguage = event.language;
        const { upserts, removedIds } = this.asrAssembler.push({
          segmentId: event.segmentId,
          startMs: event.startMs,
          endMs: event.endMs,
          endEstimated: event.endEstimated,
          text: event.text,
          language: event.language,
          final: event.final,
          revision: event.revision,
        });
        this.upsertCues(upserts, removedIds);
        break;
      }
      case 'asr/status':
        if (event.owner.sessionId !== this.identity.sessionId) return;
        this.resources.asr = event.state;
        this.resources.asrBacklogMs = event.backlogMs;
        if (event.activeTracks !== undefined) this.resources.activeTracks = event.activeTracks;
        if (event.state === 'backlogged' && !this.asrBacklogNotified) {
          this.asrBacklogNotified = true;
          this.notice = {
            code: 'asr-backlog',
            message:
              '语音识别速度跟不上播放，已跳过部分音频。可暂停视频等待，或在本地识别服务中换用更小的模型。',
            level: 'warning',
          };
        } else if ((event.state === 'error' || event.state === 'unavailable') && !this.notice) {
          // 识别请求失败导致的丢段：与「速度跟不上」区分提示。
          this.notice = {
            code: 'asr-failing',
            message:
              event.state === 'unavailable'
                ? '语音识别服务暂不可用（模型未就绪或服务繁忙），部分音频未能识别。'
                : '部分音频识别失败，已跳过。请检查语音识别服务状态。',
            level: 'warning',
          };
        } else if (
          event.state === 'running' &&
          (this.notice?.code === 'asr-backlog' || this.notice?.code === 'asr-failing')
        ) {
          this.asrBacklogNotified = false;
          this.notice = undefined;
        }
        this.host.publish();
        break;
      case 'asr/error':
        if (event.owner.sessionId !== this.identity.sessionId) return;
        if (event.error.code === 'asr-input-quiet') {
          // 仅提示：有声音输入但音量过低，全部被判为静音。
          this.notice = {
            code: 'asr-input-quiet',
            message: clip(event.error.message, NOTICE_MAX),
            level: 'warning',
          };
          this.host.publish();
          break;
        }
        this.resources.asr = 'error';
        this.error = event.error;
        this.host.publish();
        break;
    }
  }

  private upsertCues(upserts: Cue[], removedIds: string[]): void {
    if (upserts.length === 0 && removedIds.length === 0) return;
    const changed: Cue[] = [];
    for (const raw of upserts) {
      const prev = this.cues.get(raw.id);
      let cue = this.markSameLanguage({ ...raw, targetLanguage: this.targetLanguage });
      // 同一修订、同一原文（例如增量来源只延长结束时间或由 interim 转为 final）：保留翻译状态与译文，
      // 包括进行中与失败状态，避免界面回退为「待翻译」或重复翻译。
      if (prev && prev.revision === cue.revision && prev.sourceText === cue.sourceText) {
        cue = {
          ...cue,
          translatedText: prev.translatedText,
          translationState: prev.translationState,
          translationKey: prev.translationKey,
          translationError: prev.translationError,
        };
      }
      this.cues.set(cue.id, cue);
      changed.push(cue);
    }
    for (const id of removedIds) this.cues.delete(id);
    this.sortedCache = null;
    this.cueVersion++;
    if (removedIds.length) this.scheduler?.removeCues(removedIds);
    this.scheduler?.upsertCues(changed);
    this.queueContentPatch(changed, removedIds);
    this.host.emitUiCues(this.identity.sessionId, {
      cueVersion: this.cueVersion,
      full: false,
      cues: changed,
      removedIds,
    });
    // 已有译文的字幕后转为 final（或 final 字幕仅调整时间）时，也交给配音控制器。
    if (this.dubbing && this.phase === 'running' && !this.endedPaused) {
      const ready = changed.filter((c) => c.stability === 'final' && c.translationState === 'done');
      if (ready.length) this.dubbing.upsertCues(ready);
    }
    this.scheduleTranscriptSave();
    this.touch();
  }

  onPlayerState(state: PlayerState, reason: string): void {
    const prev = this.lastPlayer;
    this.lastPlayer = state;
    if (this.isStopping) return;
    let seek = reason === 'seeked';
    // 时间轴断点只由媒体时间的变化决定；调音量、全屏等事件不切断识别片段。
    let discontinuity = seek || reason === 'seeking' || reason === 'video-replaced';
    if (prev) {
      if (!seek) {
        const elapsed = Math.max(0, state.sampledAtEpochMs - prev.sampledAtEpochMs);
        const expected =
          prev.paused || prev.buffering || prev.ad
            ? prev.currentTimeMs
            : prev.currentTimeMs + elapsed * prev.playbackRate;
        if (
          !prev.ad &&
          !state.ad &&
          Math.abs(state.currentTimeMs - expected) > SEEK_JUMP_THRESHOLD_MS + elapsed * 0.1
        ) {
          seek = true;
          discontinuity = true;
        }
      }
      if (
        prev.paused !== state.paused ||
        prev.playbackRate !== state.playbackRate ||
        prev.ad !== state.ad ||
        prev.buffering !== state.buffering ||
        prev.seeking !== state.seeking ||
        prev.ended !== state.ended ||
        prev.videoId !== state.videoId
      ) {
        discontinuity = true;
      }
    }
    if (discontinuity) this.discontinuityId++;
    let refeed = false;
    if (seek && this.phase === 'running') {
      refeed = true;
      // 先告知调度器新播放位置，再递增 epoch：否则 setEpoch 会按旧位置立即发起请求。
      if (!this.endedPaused) {
        this.scheduler?.setPlayhead({
          mediaTimeMs: state.currentTimeMs,
          playing: !state.paused && !state.buffering && !state.ad && !state.ended,
          playbackRate: state.playbackRate,
        });
      }
      this.bumpEpoch();
      if (this.incremental) {
        const flushed = this.incremental.flush(prev?.currentTimeMs ?? state.currentTimeMs);
        this.upsertCues(flushed.upserts, flushed.removedIds);
      }
    }
    // 视频结束：停止配音与在途请求；再次播放时恢复（识别捕获需重新开始）。
    if (state.ended && !this.endedPaused && this.phase === 'running') {
      this.endedPaused = true;
      this.scheduler?.pause();
      this.dubbing?.invalidate(this.identity.epoch);
      this.setDuck(false);
      if (this.sourceMode === 'asr') {
        this.host.onFatal(this, {
          code: 'video-ended',
          category: 'youtube',
          retryable: true,
          message: '视频已结束，已停止音频捕获与识别。',
          at: this.host.deps.now(),
        });
        return;
      }
    } else if (!state.ended && this.endedPaused) {
      this.endedPaused = false;
      if (this.phase === 'running') this.scheduler?.resume();
      refeed = true;
    }
    this.feedPlayer(state, reason);
    if (refeed) this.refeedDubbing();
  }

  /**
   * 配音控制器 invalidate 会清空待朗读字幕：会话仍在运行时，把当前全部已完成的 final 字幕重新交给控制器
   * （跳转、继续、视频结束后重播、换轨、改配置）。必须在控制器拿到最新播放器状态之后调用，避免按旧位置开始朗读。
   */
  private refeedDubbing(): void {
    if (!this.dubbing || this.phase !== 'running' || this.endedPaused || this.isStopping) return;
    const ready = this.sortedCues().filter(
      (c) => c.stability === 'final' && c.translationState === 'done',
    );
    if (ready.length) this.dubbing.upsertCues(ready);
  }

  private feedPlayer(state: PlayerState, reason: string): void {
    if (this.phase === 'running' && !this.endedPaused) {
      this.scheduler?.setPlayhead({
        mediaTimeMs: state.currentTimeMs,
        playing: !state.paused && !state.buffering && !state.ad && !state.ended,
        playbackRate: state.playbackRate,
      });
      this.dubbing?.onPlayer(state, reason);
    }
    if (this.capture?.state === 'active') {
      this.host.deps.offscreen
        .request(
          { kind: 'timeline/anchor', leaseId: this.capture.leaseId, anchor: this.currentAnchor() },
          3_000,
        )
        .catch(() => undefined);
    }
  }

  private currentAnchor(): MediaAnchor {
    const s = this.lastPlayer ?? this.host.page(this.identity.tabId)?.player;
    return {
      epochMs: s?.sampledAtEpochMs ?? this.host.deps.now(),
      mediaTimeMs: s?.currentTimeMs ?? 0,
      playbackRate: s?.playbackRate ?? 1,
      paused: s?.paused ?? true,
      seeking: s?.seeking ?? false,
      buffering: s?.buffering ?? false,
      ad: s?.ad ?? false,
      discontinuityId: this.discontinuityId,
    };
  }

  // ---------------------------------------------------------------------------
  // 设置变化
  // ---------------------------------------------------------------------------

  /** 译文相关配置变化：取消旧任务，清空旧译文，用新配置重新翻译（T13）。 */
  onTranslationConfigChanged(
    settings: Settings,
    configRevision: number,
    provider: TextProvider,
  ): void {
    if (this.isStopping) return;
    this.identity.configRevision = configRevision;
    const targetChanged = settings.targetLanguage !== this.targetLanguage;
    this.targetLanguage = settings.targetLanguage;
    this.bumpEpoch();
    for (const [id, cue] of this.cues) {
      this.cues.set(
        id,
        this.markSameLanguage({
          ...cue,
          targetLanguage: this.targetLanguage,
          translatedText: undefined,
          translationKey: undefined,
          translationError: undefined,
          translationState: 'pending',
        }),
      );
    }
    this.sortedCache = null;
    this.cueVersion++;
    if (targetChanged) {
      this.recordId = transcriptRecordId(
        this.identity.videoId,
        this.targetLanguage,
        this.sourceKey,
      );
      if (this.asrAssembler) {
        this.asrAssembler = this.host.deps.createAsrCueAssembler({
          idPrefix: `${this.identity.videoId}:asr:${this.identity.sessionId}:${configRevision}`,
          targetLanguage: this.targetLanguage,
        });
      }
    }
    this.dubbing?.invalidate(this.identity.epoch);
    this.dubbing?.setConfig(this.dubbingConfig(settings));
    this.scheduler?.setConfig(this.translationConfig(settings), configRevision, provider);
    this.scheduler?.setCues(this.sortedCues(), this.schedulerIdentity());
    if (this.phase === 'paused') this.scheduler?.pause();
    this.refeedDubbing();
    this.pushFullCues();
    this.touch();
  }

  onNonTranslationSettingsChanged(prev: Settings, next: Settings): void {
    if (this.isStopping) return;
    if (this.dubbing) this.dubbing.setConfig(this.dubbingConfig(next));
    if (
      this.capture?.state === 'active' &&
      (prev.audio.originalVolume !== next.audio.originalVolume ||
        prev.audio.duckOriginal !== next.audio.duckOriginal)
    ) {
      const gain =
        next.audio.originalVolume *
        (this.duckActive && next.audio.duckOriginal ? next.audio.duckLevel : 1);
      this.host.deps.offscreen
        .request({ kind: 'audio/original-gain', leaseId: this.capture.leaseId, gain, rampMs: 100 })
        .catch(() => undefined);
    }
    if (prev.outputMode !== next.outputMode) {
      this.outputMode = next.outputMode;
      if (next.outputMode === 'subtitle-voice' && !this.dubbing) {
        this.setupDubbing(next);
        const created = this.dubbing as DubbingController | undefined;
        if (this.lastPlayer && this.phase === 'running' && !this.endedPaused)
          created?.onPlayer(this.lastPlayer, 'tick');
        this.refeedDubbing();
      } else if (next.outputMode === 'subtitle' && this.dubbing) {
        this.dubbingUnsub?.();
        this.dubbing.dispose();
        this.dubbing = undefined;
        this.dubbingUnsub = undefined;
        this.setDuck(false);
        if (this.notice?.code === 'tts-disabled' || this.notice?.code === 'tts-error')
          this.notice = undefined;
      }
    }
    this.touch();
  }

  /** 预取、缓存、超时等只影响调度、不影响译文内容的设置：不清空译文，不递增 configRevision。 */
  onSchedulingSettingsChanged(settings: Settings, provider: TextProvider): void {
    if (this.isStopping || !this.scheduler) return;
    this.scheduler.setConfig(
      this.translationConfig(settings),
      this.identity.configRevision,
      provider,
    );
    if (this.phase === 'paused') this.scheduler.pause();
  }

  retryFailed(): number {
    return this.scheduler?.retryFailed() ?? 0;
  }

  /** 全片补译只适用于完整字幕轨道；增量字幕与语音识别没有「全片」可译。 */
  setBackfill(enabled: boolean): void {
    if (this.isStopping) return;
    if (enabled && this.sourceMode !== 'full-track') {
      throw new AppError({
        code: 'backfill-unsupported',
        category: 'unsupported',
        retryable: false,
        message: '只有读取到完整字幕轨道时才能翻译全片；当前字幕来源只覆盖已播放的部分。',
      });
    }
    this.backfill = enabled;
    this.scheduler?.setBackfill(enabled);
    this.touch();
  }

  // ---------------------------------------------------------------------------
  // 翻译结果
  // ---------------------------------------------------------------------------

  private applyTranslationUpdates(updates: CueTranslationUpdate[]): void {
    if (this.isStopping) return;
    const changed: Cue[] = [];
    let latestError: AppErrorInfo | undefined;
    for (const u of updates) {
      if (u.partial) continue;
      const cue = this.cues.get(u.cueId);
      if (!cue || cue.revision !== u.cueRevision) continue;
      let next: Cue;
      if (u.state === 'done') {
        if (!u.translatedText) continue;
        next = {
          ...cue,
          translationState: 'done',
          translatedText: u.translatedText,
          translationKey: u.translationKey,
          translationError: undefined,
        };
        this.lastTranslationFailure = undefined;
      } else if (u.state === 'failed') {
        next = { ...cue, translationState: 'failed', translationError: u.error };
        latestError = u.error;
        this.lastTranslationFailure = u.error;
      } else if (u.state === 'skipped') {
        next = { ...cue, translationState: 'skipped', translatedText: undefined };
      } else if (u.state === 'pending') {
        if (cue.translationState !== 'running') continue;
        next = { ...cue, translationState: 'pending' };
      } else {
        next = { ...cue, translationState: 'running' };
      }
      this.cues.set(next.id, next);
      changed.push(next);
    }
    if (changed.length === 0) return;
    this.sortedCache = null;
    this.cueVersion++;
    if (latestError && ['auth', 'permission', 'quota', 'config'].includes(latestError.category)) {
      this.error = latestError;
    } else if (
      !latestError &&
      this.error &&
      ['auth', 'permission', 'quota', 'rate-limit', 'network', 'timeout', 'server'].includes(
        this.error.category,
      )
    ) {
      if (changed.some((c) => c.translationState === 'done')) this.error = undefined;
    }
    this.queueContentPatch(changed, []);
    this.host.emitUiCues(this.identity.sessionId, {
      cueVersion: this.cueVersion,
      full: false,
      cues: changed,
    });
    const ready = changed.filter((c) => c.translationState === 'done' && c.stability === 'final');
    if (ready.length && this.phase === 'running' && !this.endedPaused)
      this.dubbing?.upsertCues(ready);
    this.scheduleTranscriptSave();
    this.touch();
  }

  // ---------------------------------------------------------------------------
  // 推送与持久化
  // ---------------------------------------------------------------------------

  sortedCues(): Cue[] {
    if (!this.sortedCache) {
      this.sortedCache = [...this.cues.values()].sort(
        (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
      );
    }
    return this.sortedCache;
  }

  private queueContentPatch(changed: Cue[], removedIds: string[]): void {
    for (const c of changed) this.contentPatch.set(c.id, toDisplayCue(c));
    if (removedIds.length) {
      // 删除需要立即以全量方式同步，避免增量顺序问题。
      this.pushFullCues();
      return;
    }
    if (this.contentPatchTimer) return;
    this.contentPatchTimer = setTimeout(() => {
      this.contentPatchTimer = undefined;
      if (this.contentPatch.size === 0 || this.isStopping) return;
      const cues = [...this.contentPatch.values()];
      this.contentPatch.clear();
      this.sendToContent({
        type: 'session/cues',
        sessionId: this.identity.sessionId,
        epoch: this.identity.epoch,
        cueVersion: this.cueVersion,
        full: false,
        cues,
      });
    }, CONTENT_PATCH_DELAY_MS);
  }

  pushFullCues(): void {
    this.contentPatch.clear();
    if (this.contentPatchTimer) {
      clearTimeout(this.contentPatchTimer);
      this.contentPatchTimer = undefined;
    }
    const cues = this.sortedCues();
    this.sendToContent({
      type: 'session/cues',
      sessionId: this.identity.sessionId,
      epoch: this.identity.epoch,
      cueVersion: this.cueVersion,
      full: true,
      cues: cues.map(toDisplayCue),
    });
    this.host.emitUiCues(this.identity.sessionId, {
      cueVersion: this.cueVersion,
      full: true,
      cues,
    });
  }

  pushSessionState(): void {
    this.sendToContent({
      type: 'session/state',
      session: {
        sessionId: this.identity.sessionId,
        epoch: this.identity.epoch,
        videoId: this.identity.videoId,
        phase: this.phase,
        outputMode: this.outputMode,
        sourceMode: this.sourceMode,
        statusText: this.statusText(),
      },
    });
  }

  /** 覆盖层状态文字；「同听 · 」前缀由覆盖层添加。 */
  private statusText(): string | undefined {
    if (this.error) return clip(this.error.message, 40);
    switch (this.phase) {
      case 'starting':
        return '正在准备';
      case 'paused':
        return '翻译已暂停';
      case 'running': {
        const notice = this.translationNotice();
        if (notice?.code === 'translation-blocked') return '翻译已停止，详见侧栏';
        if (notice?.code === 'translation-rate-limited') return '服务限流，稍后自动重试';
        if (notice?.code === 'translation-failing') return '部分字幕翻译失败，正在重试';
        return this.sourceMode === 'asr' ? '语音识别翻译中' : '翻译中';
      }
      default:
        return undefined;
    }
  }

  /** 调度器层面的持续故障（阻断、限流、连续失败）提升为会话级提示，不只体现在逐条字幕上。 */
  private translationNotice(): SessionSnapshot['notice'] {
    const stats = this.scheduler?.stats();
    if (!stats) return undefined;
    if (stats.blockedError) {
      return {
        code: 'translation-blocked',
        message: `已停止发送翻译请求：${stats.blockedError.message}`,
        level: 'error',
      };
    }
    const now = this.host.deps.now();
    if (stats.rateLimitedUntil && stats.rateLimitedUntil > now) {
      const seconds = Math.ceil((stats.rateLimitedUntil - now) / 1000);
      return {
        code: 'translation-rate-limited',
        message: `服务限流，约 ${seconds} 秒后自动重试。`,
        level: 'warning',
      };
    }
    if (this.lastTranslationFailure) {
      return {
        code: 'translation-failing',
        message: `部分字幕翻译失败：${this.lastTranslationFailure.message}`,
        level: 'warning',
      };
    }
    return undefined;
  }

  private sendToContent(message: Parameters<PageState['conn']['send']>[0]): void {
    const page = this.host.page(this.identity.tabId);
    if (
      !page ||
      page.documentId !== this.identity.documentId ||
      page.navigationId !== this.navigationId
    )
      return;
    page.conn.send(message);
  }

  private scheduleTranscriptSave(): void {
    if (this.transcriptTimer || this.isStopping) return;
    this.transcriptTimer = setTimeout(() => {
      this.transcriptTimer = undefined;
      this.queueTranscriptWrite();
    }, this.timings.transcriptSaveDebounceMs);
  }

  private queueTranscriptWrite(): void {
    if (this.sourceMode === 'none' || this.cues.size === 0) return;
    const recordId = this.recordId;
    const cues = this.sortedCues();
    const page = this.host.page(this.identity.tabId);
    const snapshot = {
      coverage: this.coverage(),
      sourceMode: this.sourceMode,
      sourceKey: this.sourceKey,
      sourceLabel: this.sourceTrack?.label,
      sourceLanguage: this.detectedSourceLanguage ?? 'und',
      title: page?.title,
      channel: page?.channel,
      durationMs: page?.durationMs,
    };
    const { deps } = this.host;
    this.transcriptWrite = this.transcriptWrite
      .then(async () => {
        const existing = await deps.transcripts.getTranscript(recordId).catch(() => undefined);
        const now = deps.now();
        const merged = mergeTranscriptCues(existing, cues, this.identity.sessionId);
        const record: TranscriptRecord = {
          schemaVersion: RECORD_SCHEMA_VERSION,
          recordId,
          videoId: this.identity.videoId,
          title: snapshot.title ?? existing?.title,
          channel: snapshot.channel ?? existing?.channel,
          targetLanguage: this.targetLanguage,
          sourceLanguage: snapshot.sourceLanguage,
          sourceMode: snapshot.sourceMode,
          sourceKey: snapshot.sourceKey,
          sourceLabel: snapshot.sourceLabel,
          lastSessionId: this.identity.sessionId,
          cues: merged,
          coverage: snapshot.coverage,
          durationMs: snapshot.durationMs ?? existing?.durationMs,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        await deps.transcripts.putTranscript(record);
      })
      .catch((error: unknown) => {
        deps.logger.warn(
          '[tongting] transcript save failed',
          error instanceof Error ? error.name : 'unknown',
        );
        this.notice = {
          code: 'transcript-save-failed',
          message: '字幕记录保存失败，本次字幕仅保留在内存中。',
          level: 'warning',
        };
        this.host.publish();
      });
  }

  coverage(): SubtitleCoverage {
    const cues = this.sortedCues();
    const durationMs = this.host.page(this.identity.tabId)?.durationMs;
    if (this.sourceMode === 'full-track') {
      const first = cues[0];
      const last = cues[cues.length - 1];
      return {
        complete: true,
        ranges: first && last ? [{ startMs: first.startMs, endMs: last.endMs }] : [],
        gaps: [],
        durationMs: durationMs ? Math.min(Math.round(durationMs), MAX_MEDIA_TIME_MS) : undefined,
      };
    }
    return {
      complete: false,
      ranges: mergeRanges(
        cues.map((c) => ({ startMs: c.startMs, endMs: c.endMs })),
        1_500,
      ),
      gaps: [],
      durationMs: durationMs ? Math.min(Math.round(durationMs), MAX_MEDIA_TIME_MS) : undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------------

  snapshot(): SessionSnapshot {
    const stats = this.scheduler?.stats() ?? {
      total: this.cues.size,
      done: 0,
      pending: 0,
      running: 0,
      failed: 0,
    };
    const dub = this.dubbing?.stats();
    const resources: ResourceState = {
      ...this.resources,
      tts: dub ? mapDubState(dub.state) : this.resources.tts,
      dubBacklog: dub?.backlog,
    };
    let notice = this.notice ?? (this.phase === 'running' ? this.translationNotice() : undefined);
    if (!notice && dub?.state === 'unavailable') {
      notice = {
        code: 'tts-unavailable',
        message: dub.lastError?.message ?? '当前目标语言没有可用的配音声音，已降级为仅字幕。',
        level: 'warning',
      };
    }
    const page = this.host.page(this.identity.tabId);
    return {
      identity: { ...this.identity },
      phase: this.phase,
      desiredState: 'running',
      outputMode: this.outputMode,
      targetLanguage: this.targetLanguage,
      sourceMode: this.sourceMode,
      sourceTrack: this.sourceTrack,
      detectedSourceLanguage: this.detectedSourceLanguage,
      player: this.lastPlayer ?? page?.player,
      coverage: this.sourceMode === 'none' ? undefined : this.coverage(),
      translation: stats,
      resources,
      notice: notice
        ? { ...notice, code: clip(notice.code, 80), message: clip(notice.message, NOTICE_MAX) }
        : undefined,
      error: this.error ? clipError(this.error) : undefined,
      cueVersion: this.cueVersion,
      recordId: this.sourceMode === 'none' ? undefined : this.recordId,
      backfill: this.backfill || undefined,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
    };
  }

  setError(error: AppErrorInfo): void {
    this.error = error;
    this.phase = 'error';
  }

  mediaOwner() {
    return {
      sessionId: this.identity.sessionId,
      tabId: this.identity.tabId,
      epoch: this.identity.epoch,
    };
  }

  private bumpEpoch(): void {
    this.identity.epoch++;
    // 先重置本地 running 状态，再通知调度器：setEpoch 期间同步开始的新请求发出的 running 不被覆盖。
    this.resetRunningCues();
    this.scheduler?.setEpoch(this.identity.epoch);
    this.dubbing?.invalidate(this.identity.epoch);
    if (this.capture && this.capture.state !== 'stopping') {
      this.host.deps.offscreen
        .request({
          kind: 'capture/set-epoch',
          leaseId: this.capture.leaseId,
          epoch: this.identity.epoch,
        })
        .catch(() => undefined);
    }
    this.asrAssembler?.reset();
  }

  /**
   * 调度器不会发出「回到待翻译」事件：暂停或 epoch 变化后被中止的请求对应的 cue 仍停留在 running。
   * 在本地重置为 pending；仍在进行的相关请求完成后会以 done 覆盖。
   */
  private resetRunningCues(): void {
    const reset: Cue[] = [];
    for (const cue of this.cues.values()) {
      if (cue.translationState !== 'running') continue;
      const next: Cue = { ...cue, translationState: 'pending' };
      this.cues.set(cue.id, next);
      reset.push(next);
    }
    if (reset.length === 0 || this.isStopping) return;
    this.sortedCache = null;
    this.cueVersion++;
    this.queueContentPatch(reset, []);
    this.host.emitUiCues(this.identity.sessionId, {
      cueVersion: this.cueVersion,
      full: false,
      cues: reset,
    });
  }

  private touch(): void {
    this.updatedAt = this.host.deps.now();
    this.pushSessionState();
    this.host.publish();
    this.host.persistRecords();
  }
}

function mapDubState(state: string): ResourceState['tts'] {
  switch (state) {
    case 'speaking':
      return 'speaking';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    case 'unavailable':
      return 'unavailable';
    default:
      return 'idle';
  }
}

export function toDisplayCue(c: Cue): DisplayCue {
  return {
    id: c.id,
    revision: c.revision,
    startMs: c.startMs,
    endMs: c.endMs,
    sourceText: c.sourceText,
    translatedText: c.translatedText,
    translationState: c.translationState,
    stability: c.stability,
  };
}

/**
 * 选择字幕轨道：用户指定源语言优先；否则人工字幕优先于自动字幕；
 * 与目标语言相同的轨道排在最后（避免无意义翻译）。
 */
export function chooseTrack(
  tracks: readonly CaptionTrackInfo[],
  sourceLanguage: string,
  targetLanguage: string,
): CaptionTrackInfo | undefined {
  const usable = tracks.filter((t) => t.kind !== 'translated');
  if (usable.length === 0) return undefined;
  const score = (t: CaptionTrackInfo) => {
    let s = 0;
    if (sourceLanguage !== 'auto' && isSameLanguage(t.languageCode, sourceLanguage)) s += 100;
    if (t.kind === 'manual') s += 20;
    if (t.isDefault) s += 10;
    if (isSameLanguage(t.languageCode, targetLanguage)) s -= 50;
    return s;
  };
  return [...usable].sort((a, b) => score(b) - score(a))[0];
}

/**
 * 写入字幕记录时合并：当前会话尚未翻译的条目，若旧记录中同 id、同原文、同目标语言已有译文，
 * 且该译文的翻译配置指纹与当前会话一致（或来自同一会话，例如 worker 重启后恢复），则保留旧译文。
 * 模型、风格、术语等变化后的旧译文不会被标成当前结果。
 */
export function mergeTranscriptCues(
  existing: Pick<TranscriptRecord, 'cues' | 'lastSessionId'> | undefined,
  current: readonly Cue[],
  sessionId: string,
): Cue[] {
  if (!existing?.cues.length) return [...current];
  const currentKey = current.find(
    (c) => c.translationState === 'done' && c.translationKey,
  )?.translationKey;
  const sameSession = existing.lastSessionId === sessionId;
  const old = new Map(existing.cues.map((c) => [c.id, c]));
  return current.map((c) => {
    if (c.translatedText || c.translationState === 'skipped') return c;
    const prev = old.get(c.id);
    if (
      !prev?.translatedText ||
      prev.sourceText !== c.sourceText ||
      prev.targetLanguage !== c.targetLanguage
    )
      return c;
    const keyMatches = currentKey ? prev.translationKey === currentKey : sameSession;
    if (!keyMatches) return c;
    return {
      ...c,
      translatedText: prev.translatedText,
      translationKey: prev.translationKey,
      translationState: 'done',
    };
  });
}

/** 页面（内容脚本）带回的错误一律视为字幕读取失败；是否被新意图取代只由协调器判定。 */
function externalCaptionError(error: unknown): AppErrorInfo {
  const info = toAppErrorInfo(error, { category: 'captions' });
  return info.category === 'cancelled' ? { ...info, category: 'captions', retryable: true } : info;
}

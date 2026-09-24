/**
 * YouTube 页面接入总控（ISOLATED world 内容脚本）。
 *
 * 组合：导航识别 → 播放器适配器 → MAIN world 桥客户端 → 字幕来源 → 覆盖层 / 原生字幕隐藏 / ducking → 端口客户端。
 *
 * 生命周期与异步边界：
 * - 每次导航：中止上一导航的所有请求等待、恢复旧视频的 ducking 与原生字幕、停止当前显示字幕观察，再上报新视频；
 * - worker 请求在 await 之后重新核对 navigationId / videoId / 连接代际，迟到结果不写入新视频、不在新连接上回复；
 * - 扩展上下文失效（ctx.onInvalidated 或 runtime.id 消失）时释放全部监听器、observer、定时器、覆盖层与样式，可重复调用。
 */
import { cancelledError, toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import type { CaptionSettings } from '../domain/settings';
import type { PlayerState } from '../domain/session';
import { getLocale, resolveLocale, setLocale, type Locale } from '../i18n';
import {
  CONTENT_PROTOCOL_VERSION,
  type BackgroundToContent,
  type ContentRequest,
  type ContentToBackground,
} from '../messaging/content-protocol';
import { randomId } from '../messaging/ports';
import { createBridgeClient } from './bridge-client';
import { createCaptionSource } from './caption-source';
import { createDuckController } from './ducking';
import { createPlaybackBufferController } from './playback-buffer';
import { youtubeError, youtubeErrorInfo } from './errors';
import { createNativeCaptionHider } from './native-captions';
import { createNavigationTracker, watchNavigation, type NavigationState } from './navigation';
import { createCaptionOverlay } from './overlay/overlay';
import type { OverlaySession } from './overlay/cue-store';
import {
  createPlayerAdapter,
  epochNow,
  PLAYER_MAX_TIME_MS,
  type ContentPlayerReason,
  type PlayerAdapter,
} from './player-adapter';
import { createPortClient, type PortLike } from './port-client';
import { isAdShowing } from './selectors';
import { createVisibleCaptionObserver } from './visible-captions';

export interface YoutubeContentDeps {
  win: Window & typeof globalThis;
  doc: Document;
  connect(): PortLike;
  /** 扩展上下文是否仍有效：只看 browser.runtime.id，不依赖页面可伪造的事件。 */
  isContextValid(): boolean;
  /**
   * 注册唤醒监听（runtime.onMessage）。回调只应在消息通过 isContentWakeMessage、
   * sender.id === runtime.id 且没有 sender.tab 时调用。返回注销函数。
   */
  onWakeMessage?(cb: () => void): () => void;
  readLastError?(): void;
  /** 注册上下文失效回调（WXT ctx.onInvalidated）。 */
  onInvalidated(cb: () => void): void;
  pageInstanceId: string;
  /**
   * 浏览器界面语言（browser.i18n.getUILanguage()）。收到 worker 下发的界面语言前按它显示覆盖层文案；
   * 省略时保持当前语言。
   */
  uiLanguage?: string;
  timings?: Partial<ControllerTimings>;
}

export interface ControllerTimings {
  /** 导航后向桥请求播放器元数据的时间点（ms）。 */
  metadataRequestSchedule: number[];
  /** 收到 welcome 后等待 session/state 的时间；超时视为 worker 端没有会话。 */
  welcomeSessionTimeoutMs: number;
  /** 会话存在时检查覆盖层是否被页面重绘移除的间隔。 */
  overlayCheckMs: number;
  passiveTrackThrottleMs: number;
  playerPollMs: number;
  navigationPollMs: number;
  /**
   * worker 会话处于 starting（正在等待字幕轨道）而元数据仍为空时，按固定间隔重新请求播放器数据；
   * 播放器晚于重试计划完成初始化时也能在会话等待上限内拿到轨道。每次导航最多请求 limit 次。
   */
  startingMetadataPollMs: number;
  startingMetadataPollLimit: number;
}

const DEFAULT_TIMINGS: ControllerTimings = {
  metadataRequestSchedule: [0, 300, 1_000, 2_500, 5_000, 10_000],
  welcomeSessionTimeoutMs: 5_000,
  overlayCheckMs: 1_000,
  passiveTrackThrottleMs: 10_000,
  playerPollMs: 500,
  navigationPollMs: 500,
  startingMetadataPollMs: 500,
  startingMetadataPollLimit: 60,
};

export interface YoutubeContentController {
  readonly disposed: boolean;
  /** 诊断信息（不含字幕原文）。 */
  debug(): {
    navigationId: number;
    videoId: string | null;
    connected: boolean;
    overlayMounted: boolean;
    sessionId: string | null;
    availability: string;
    visibleObserving: boolean;
  };
  dispose(): void;
}

type ReplyBody = { ok: true; data?: unknown } | { ok: false; error: AppErrorInfo };

export function startYoutubeContent(deps: YoutubeContentDeps): YoutubeContentController {
  const { win, doc } = deps;
  const timings: ControllerTimings = { ...DEFAULT_TIMINGS, ...deps.timings };
  if (deps.uiLanguage !== undefined) setLocale(resolveLocale('auto', deps.uiLanguage));
  const setT = (fn: () => void, ms: number) => win.setTimeout(fn, ms);
  const clearT = (id: unknown) => win.clearTimeout(id as number);

  let disposed = false;
  const tracker = createNavigationTracker(win.location.href);
  let nav: NavigationState = tracker.current;
  let session: OverlaySession | null = null;
  let settings: CaptionSettings | null = null;
  let navAbort = new AbortController();
  let metadataTimers: number[] = [];
  let welcomeTimer: number | undefined;
  let sessionConfirmed = true;
  let adapter: PlayerAdapter | null = null;
  let suppressMetadataEvents = false;
  let metadataBackoffMs = 1_000;
  let nextMetadataRequestAt = 0;
  let startingPollTimer: number | undefined;
  let startingPolls = 0;
  /** 主动切轨限频；窗口内保留最后一个选择。 */
  let lastPassiveSendAt = -Infinity;
  let pendingPassiveTrack: string | undefined;
  let passiveTimer: number | undefined;
  let passiveRevision = 0;
  let passiveLoading = false;
  let lastResyncAt = -Infinity;
  let resyncTimer: number | undefined;
  /** 本导航内最近一次发给 worker 的轨道 key，以及仍在进行的 load-track 请求数。 */
  let lastSentTrackKey: string | undefined;
  let loadsInFlight = 0;
  let loadRevision = 0;

  const duck = createDuckController();
  const hider = createNativeCaptionHider(doc);
  const overlay = createCaptionOverlay({ doc, win });
  const playbackBuffer = createPlaybackBufferController({
    getVideo: () => adapter?.video ?? null,
    // 广告是页面事实：每次评估实时读取播放器状态。适配器只在变化时发出一次 ad-start，
    // welcome / 会话清空触发的 reset 之后不会补发，不能只靠事件记录。
    isAdShowing: () => isAdShowing(adapter?.root ?? null),
  });

  const captions = createCaptionSource({
    bridge: {
      loadTrack: (cmd) => bridge.loadTrack(cmd),
      restoreCaptions: (cmd) => bridge.restoreCaptions(cmd),
      requestPlayerResponse: (videoId) => bridge.requestPlayerResponse(videoId),
      requestReplay: (videoId) => bridge.requestReplay(videoId),
    },
    origin: win.location.origin,
    newId: () => randomId('cmd'),
    setTimeout: setT,
    clearTimeout: clearT,
    onMetadata: (meta) => {
      if (disposed || suppressMetadataEvents) return;
      if (meta) {
        clearMetadataTimers();
        updateStartingPoll();
        bridge.requestCaptionSelection(meta.videoId);
        send(buildVideoMessage(), hasSession());
      }
      sendTracks();
    },
    shouldKeepNativeCaptions: () => sessionActive(),
    onPassiveBody: (info) => onPassiveBody(info.trackKey),
  });

  const bridge = createBridgeClient(win, {
    onCaptionSelection: (m) => captions.handleCaptionSelection(m),
    onCaptionsChanged: (m) => {
      captions.handleCaptionsChanged(m);
      updateNativeHiding();
    },
    onPlayerResponse: (m) => captions.handlePlayerResponse(m),
    onPlayerResponseMissing: (m) => captions.handlePlayerResponseMissing(m),
    onTimedtext: (m) => captions.handleTimedtext(m),
    onCommandResult: (m) => {
      captions.handleCommandResult(m);
      updateNativeHiding();
    },
  });

  // ---------------------------------------------------------------------------
  // 消息构造
  // ---------------------------------------------------------------------------

  const buildVideoMessage = (): ContentToBackground => {
    const meta = captions.metadata;
    return {
      type: 'page/video',
      navigationId: nav.navigationId,
      videoId: nav.videoId,
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
      ...(meta?.channel !== undefined ? { channel: meta.channel } : {}),
      ...(meta?.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      isLive: meta?.isLive ?? nav.kind === 'live',
      isShorts: nav.kind === 'shorts',
    };
  };

  const buildTracksMessage = (): ContentToBackground | null => {
    if (!nav.videoId) return null;
    return {
      type: 'captions/tracks',
      navigationId: nav.navigationId,
      videoId: nav.videoId,
      availability: captions.availability,
      tracks: captions.metadata?.tracks ?? [],
    };
  };

  const buildPlayerState = (
    reason: ContentPlayerReason,
  ): Extract<ContentToBackground, { type: 'player/state' }> | null => {
    const snap = adapter?.snapshot();
    if (!snap) return null;
    const meta = captions.metadata;
    const state: PlayerState = {
      videoId: nav.videoId,
      ...(meta?.title !== undefined ? { title: meta.title } : {}),
      ...(meta?.channel !== undefined ? { channel: meta.channel } : {}),
      currentTimeMs: snap.currentTimeMs,
      ...(snap.durationMs !== undefined
        ? { durationMs: snap.durationMs }
        : meta?.durationMs !== undefined
          ? { durationMs: meta.durationMs }
          : {}),
      paused: snap.paused,
      buffering: snap.buffering,
      seeking: snap.seeking,
      ended: snap.ended,
      playbackRate: snap.playbackRate,
      ad: snap.ad,
      volume: snap.volume,
      muted: snap.muted,
      isLive: meta?.isLive ?? nav.kind === 'live',
      isShorts: nav.kind === 'shorts',
      fullscreen: snap.fullscreen,
      sampledAtEpochMs: snap.sampledAtEpochMs,
    };
    return { type: 'player/state', navigationId: nav.navigationId, state, reason };
  };

  const sessionActive = () => !!session && session.videoId === nav.videoId;
  const hasSession = () => session !== null;

  // ---------------------------------------------------------------------------
  // 端口
  // ---------------------------------------------------------------------------

  const port = createPortClient({
    connect: deps.connect,
    buildHello: () => ({
      type: 'hello',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      pageInstanceId: deps.pageInstanceId,
      url: win.location.href.slice(0, 2_000),
    }),
    buildSnapshot: () => {
      const msgs: ContentToBackground[] = [buildVideoMessage()];
      const tracks = buildTracksMessage();
      if (tracks) msgs.push(tracks);
      const ps = buildPlayerState('tick');
      if (ps) msgs.push(ps);
      return msgs;
    },
    onMessage: (msg, generation) => handleWorkerMessage(msg, generation),
    isContextValid: deps.isContextValid,
    onContextInvalid: () => dispose(),
    readLastError: deps.readLastError,
    setTimeout: setT,
    clearTimeout: clearT,
  });

  function send(msg: ContentToBackground | null, wake: boolean): boolean {
    if (disposed || !msg) return false;
    return port.send(msg, { wake });
  }

  function sendTracks() {
    send(buildTracksMessage(), hasSession());
  }

  function sendPlayerState(reason: ContentPlayerReason) {
    const msg = buildPlayerState(reason);
    if (!msg) return;
    switch (reason) {
      case 'tick':
        // 播放中的 tick 只在本页会话活跃时发送（也只在此时唤醒 worker），避免空闲保活。
        if (!sessionActive() || msg.state.paused) return;
        send(msg, true);
        return;
      default:
        // 只有存在会话时才为播放器事件唤醒 worker；无会话时仅在已连接时顺带发送。
        send(msg, hasSession());
    }
  }

  // ---------------------------------------------------------------------------
  // 页面状态联动
  // ---------------------------------------------------------------------------

  function updateNativeHiding() {
    if (disposed) return;
    // 是否接管显示与是否曾切换 YouTube 的开关是两件事：缓存命中也必须避免两层字幕重叠。
    const shouldHide = sessionActive() && (settings?.enabled ?? true);
    hider.set(adapter?.root ?? null, shouldHide);
  }

  const visible = createVisibleCaptionObserver({
    setTimeout: setT,
    clearTimeout: clearT,
    onText: (text, info) => {
      if (disposed || !nav.videoId) return;
      const v = adapter?.video;
      if (!v || isAdShowing(adapter?.root ?? null)) return;
      if (info.heartbeat && v.paused) return; // 暂停时媒体时间不前进，心跳无意义
      const t = Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 1000) : 0;
      send(
        {
          type: 'captions/visible',
          navigationId: nav.navigationId,
          videoId: nav.videoId,
          text,
          mediaTimeMs: Math.min(Math.max(0, t), PLAYER_MAX_TIME_MS),
          sampledAtEpochMs: epochNow(),
        },
        true,
      );
    },
  });

  function applySession(next: OverlaySession | null) {
    const changedSession = !!session && session.sessionId !== next?.sessionId;
    session = next;
    overlay.setSession(next);
    playbackBuffer.update(
      next?.playbackBuffer && next.videoId === nav.videoId
        ? {
            sessionId: next.sessionId,
            epoch: next.epoch,
            videoId: next.videoId,
            enabled: true,
            // starting 阶段闸门同样生效；worker 在 starting 与 running 期间都会为跳转递增 epoch。
            active: next.phase === 'starting' || next.phase === 'running',
            ...next.playbackBuffer,
          }
        : null,
    );
    if (!next || changedSession) {
      loadRevision++;
      clearPassiveIntent();
      lastSentTrackKey = undefined;
      lastPassiveSendAt = -Infinity;
      visible.disable();
      duck.releaseCurrent();
      captions.restoreNativeCaptions();
    }
    if (next?.videoId === nav.videoId && nav.videoId) bridge.requestCaptionSelection(nav.videoId);
    updateNativeHiding();
    updateStartingPoll();
  }

  function startingPollWanted(): boolean {
    return (
      !disposed &&
      session?.phase === 'starting' &&
      session.videoId === nav.videoId &&
      !captions.metadata &&
      startingPolls < timings.startingMetadataPollLimit
    );
  }

  /** 会话等待字幕轨道期间的固定间隔元数据请求（不走指数退避）。 */
  function updateStartingPoll() {
    if (!startingPollWanted()) {
      if (startingPollTimer !== undefined) win.clearInterval(startingPollTimer);
      startingPollTimer = undefined;
      return;
    }
    if (startingPollTimer !== undefined) return;
    startingPollTimer = win.setInterval(() => {
      if (!startingPollWanted() || !nav.videoId) {
        updateStartingPoll();
        return;
      }
      startingPolls += 1;
      bridge.requestPlayerResponse(nav.videoId);
    }, timings.startingMetadataPollMs);
  }

  function clearMetadataTimers() {
    for (const t of metadataTimers) win.clearTimeout(t);
    metadataTimers = [];
  }

  function scheduleMetadataRequests() {
    clearMetadataTimers();
    const videoId = nav.videoId;
    const navigationId = nav.navigationId;
    if (!videoId) return;
    const schedule = timings.metadataRequestSchedule;
    schedule.forEach((ms, i) => {
      metadataTimers.push(
        win.setTimeout(() => {
          if (disposed || nav.navigationId !== navigationId || captions.metadata) return;
          bridge.requestPlayerResponse(videoId);
          if (i === schedule.length - 1) {
            // 最后一次请求后再等一会儿仍无数据：告知 worker 页面字幕接入未就绪（可用性保持 unknown）。
            metadataTimers.push(
              win.setTimeout(() => {
                if (disposed || nav.navigationId !== navigationId || captions.metadata) return;
                send(
                  {
                    type: 'captions/error',
                    navigationId,
                    videoId,
                    error: youtubeErrorInfo('captions-bridge-unavailable'),
                  },
                  hasSession(),
                );
              }, 2_000),
            );
          }
        }, ms),
      );
    });
  }

  function onNavigate(next: NavigationState, initial = false) {
    if (disposed) return;
    const hadSession = session !== null;
    loadRevision++;
    nav = next;
    navAbort.abort();
    navAbort = new AbortController();
    if (!initial) {
      // 旧视频的副作用先恢复；本地会话清空（A→B→A、同视频重新进入都不沿用旧会话），由 worker 重新下发。
      duck.releaseCurrent();
      visible.disable();
      captions.restoreNativeCaptions();
      if (session) applySession(null);
    }
    lastSentTrackKey = undefined;
    clearPassiveIntent();
    lastPassiveSendAt = -Infinity;
    metadataBackoffMs = 1_000;
    nextMetadataRequestAt = 0;
    startingPolls = 0;
    updateStartingPoll();
    suppressMetadataEvents = true;
    try {
      captions.setNavigation({ navigationId: nav.navigationId, videoId: nav.videoId });
    } finally {
      suppressMetadataEvents = false;
    }
    overlay.setPageVideoId(nav.videoId);
    updateNativeHiding();
    // 顺序：page/video → captions/tracks → player/state。
    send(buildVideoMessage(), hadSession);
    send(buildTracksMessage(), hadSession);
    adapter?.scan();
    scheduleMetadataRequests();
  }

  /** 元数据仍为空时，在播放器事件、会话变化、请求到达时再次向桥请求（指数退避）。 */
  function requestMetadataSoon() {
    if (disposed || !nav.videoId || captions.metadata) return;
    const now = Date.now();
    if (now < nextMetadataRequestAt) return;
    nextMetadataRequestAt = now + metadataBackoffMs;
    metadataBackoffMs = Math.min(30_000, metadataBackoffMs * 2);
    bridge.requestPlayerResponse(nav.videoId);
  }

  /** 唤醒：有界节流（2 秒内最多一次，窗口内的后续唤醒合并为一次尾随重放）。 */
  function onWake() {
    if (disposed) return;
    const now = Date.now();
    const wait = lastResyncAt + 2_000 - now;
    if (wait <= 0) {
      lastResyncAt = now;
      port.resync();
      return;
    }
    if (resyncTimer !== undefined) return;
    resyncTimer = win.setTimeout(() => {
      resyncTimer = undefined;
      lastResyncAt = Date.now();
      if (!disposed) port.resync();
    }, wait);
  }

  /**
   * 用户在播放器中切换字幕语言（T34）：页面自己请求到另一条轨道的正文时，若本页会话正使用字幕来源，
   * 主动发送该轨道数据，由 worker 决定是否切换。同听自己发起的加载进行中时不触发。
   */
  function onPassiveBody(trackKey: string | undefined) {
    if (disposed || !trackKey || !nav.videoId || !sessionActive()) return;
    if (lastSentTrackKey === undefined && !visible.enabled) return;
    if (pendingPassiveTrack !== trackKey) {
      pendingPassiveTrack = trackKey;
      passiveRevision++;
    }
    sendPassiveIntent();
  }

  function clearPassiveIntent() {
    if (passiveTimer !== undefined) win.clearTimeout(passiveTimer);
    passiveTimer = undefined;
    pendingPassiveTrack = undefined;
    passiveRevision++;
  }

  function sendPassiveIntent() {
    if (disposed || !sessionActive() || !nav.videoId || !pendingPassiveTrack) return;
    if (loadsInFlight > 0 || passiveLoading) return;
    if (pendingPassiveTrack === lastSentTrackKey) {
      clearPassiveIntent();
      return;
    }
    const wait = lastPassiveSendAt + timings.passiveTrackThrottleMs - Date.now();
    if (wait > 0) {
      if (passiveTimer === undefined)
        passiveTimer = win.setTimeout(() => {
          passiveTimer = undefined;
          sendPassiveIntent();
        }, wait);
      return;
    }
    const trackKey = pendingPassiveTrack;
    passiveLoading = true;
    const revision = passiveRevision;
    lastPassiveSendAt = Date.now();
    const navigationId = nav.navigationId;
    const signal = navAbort.signal;
    void captions
      .loadTrack({ trackKey }, signal)
      .then((loaded) => {
        if (
          disposed ||
          revision !== passiveRevision ||
          !sessionActive() ||
          signal.aborted ||
          nav.navigationId !== navigationId ||
          loaded.videoId !== nav.videoId
        )
          return;
        if (loadsInFlight > 0 || loaded.track.trackKey === lastSentTrackKey) return;
        // 断开时只保留最新一份，重连后补发。
        port.send(
          {
            type: 'captions/track-data',
            navigationId,
            videoId: loaded.videoId,
            track: loaded.track,
            format: loaded.format,
            cues: loaded.cues,
            complete: loaded.complete,
            rejectedCount: loaded.rejectedCount,
          },
          { wake: true, keepLatest: true },
        );
        lastSentTrackKey = loaded.track.trackKey;
        if (revision === passiveRevision) pendingPassiveTrack = undefined;
      })
      // 暂时取不到正文也保留选择；下一限频窗口重试，停止/新意图会清除它。
      .catch(() => undefined)
      .finally(() => {
        passiveLoading = false;
        sendPassiveIntent();
      });
  }

  // ---------------------------------------------------------------------------
  // worker 消息
  // ---------------------------------------------------------------------------

  /** worker 按设置确定的界面语言：覆盖层状态标签与页面侧错误提示随之切换。 */
  function applyLocale(locale: Locale) {
    if (locale === getLocale()) return;
    setLocale(locale);
    overlay.render();
  }

  function handleWorkerMessage(msg: BackgroundToContent, generation: number) {
    if (disposed) return;
    switch (msg.type) {
      case 'welcome': {
        applyLocale(msg.locale);
        playbackBuffer.reset();
        // worker 可能重启过：字幕版本基线重建，会话以随后到达的 session/state 为准。
        overlay.resetVersionBaseline();
        sessionConfirmed = false;
        if (welcomeTimer !== undefined) win.clearTimeout(welcomeTimer);
        welcomeTimer = win.setTimeout(() => {
          welcomeTimer = undefined;
          if (disposed || sessionConfirmed || port.generation !== generation) return;
          if (session) applySession(null);
        }, timings.welcomeSessionTimeoutMs);
        return;
      }
      case 'display/settings':
        applyLocale(msg.locale);
        settings = msg.captions;
        overlay.setSettings(msg.captions);
        updateNativeHiding();
        return;
      case 'session/state':
        sessionConfirmed = true;
        applySession(msg.session);
        requestMetadataSoon();
        return;
      case 'session/cues':
        overlay.applyCues(msg);
        return;
      case 'request':
        void handleRequest(msg.requestId, msg.request, generation, msg.navigationId);
        return;
    }
  }

  async function handleRequest(
    requestId: string,
    req: ContentRequest,
    generation: number,
    requestNavigationId?: number,
  ): Promise<void> {
    const reply = (body: ReplyBody) => {
      if (disposed) return;
      port.send({ type: 'reply', requestId, ...body } as ContentToBackground, {
        wake: false,
        generation,
      });
    };
    const signal = navAbort.signal;
    try {
      // worker 发起请求时认为的导航与当前不一致：不执行。
      if (requestNavigationId !== undefined && requestNavigationId !== nav.navigationId) {
        throw youtubeError('stale-video');
      }
      if (req.kind === 'captions/load-track' || req.kind === 'captions/observe-visible') {
        requestMetadataSoon();
      }
      switch (req.kind) {
        case 'player/query': {
          const tracks = captions.metadata?.tracks ?? [];
          reply({
            ok: true,
            data: {
              video: buildVideoMessage(),
              state: buildPlayerState('tick')?.state ?? null,
              captions: { availability: captions.availability, tracks },
              visibleObserving: visible.enabled,
              nativeCaptionsHidden: hider.hiddenRoot !== null,
            },
          });
          return;
        }
        case 'player/seek': {
          if (req.videoId !== nav.videoId) throw youtubeError('stale-video');
          const v = adapter?.video;
          if (!v) throw youtubeError('player-unavailable');
          if (isAdShowing(adapter?.root ?? null)) throw youtubeError('ad-playing');
          let t = req.timeMs / 1000;
          if (Number.isFinite(v.duration) && v.duration > 0)
            t = Math.min(t, Math.max(0, v.duration - 0.05));
          playbackBuffer.userIntent('seek');
          v.currentTime = t;
          reply({ ok: true, data: { timeMs: Math.round(t * 1000) } });
          return;
        }
        case 'player/duck': {
          if (req.videoId !== nav.videoId) throw youtubeError('stale-video');
          const v = adapter?.video;
          if (!v) throw youtubeError('player-unavailable');
          const outcome = req.release
            ? duck.release(v)
            : req.originalVolume !== undefined
              ? duck.configure(v, req.originalVolume, req.active ? req.level : 1)
              : req.active
                ? duck.duck(v, req.level)
                : duck.release(v);
          if (!outcome.applied && outcome.reason === 'error') throw youtubeError('duck-failed');
          reply({ ok: true, data: outcome });
          return;
        }
        case 'captions/observe-visible': {
          if (req.videoId !== nav.videoId) throw youtubeError('stale-video');
          if (req.enable) visible.enable(adapter?.root ?? null);
          else visible.disable();
          updateNativeHiding();
          reply({
            ok: true,
            data: { enabled: visible.enabled, nativeCaptionsPresent: visible.snapshot().present },
          });
          return;
        }
        case 'captions/load-track': {
          if (req.videoId !== nav.videoId) throw youtubeError('stale-video');
          clearPassiveIntent(); // 后到的明确来源选择优先于之前等待中的原生轨道通知。
          const revision = ++loadRevision;
          const navigationId = nav.navigationId;
          loadsInFlight++;
          let loaded;
          try {
            loaded = await captions.loadTrack(
              {
                ...(req.trackKey !== undefined ? { trackKey: req.trackKey } : {}),
                ...(req.preferredLanguage !== undefined
                  ? { preferredLanguage: req.preferredLanguage }
                  : {}),
              },
              signal,
            );
          } finally {
            loadsInFlight--;
            // 本请求先提交 lastSentTrackKey；随后再合并等待期间的最后选择。
            queueMicrotask(sendPassiveIntent);
          }
          if (disposed) return;
          if (revision !== loadRevision) throw cancelledError('caption selection superseded');
          if (
            signal.aborted ||
            nav.navigationId !== navigationId ||
            loaded.navigationId !== navigationId ||
            loaded.videoId !== nav.videoId
          ) {
            throw youtubeError('navigation-changed');
          }
          updateNativeHiding();
          const sent = port.send(
            {
              type: 'captions/track-data',
              navigationId,
              videoId: loaded.videoId,
              track: loaded.track,
              format: loaded.format,
              cues: loaded.cues,
              complete: loaded.complete,
              rejectedCount: loaded.rejectedCount,
            },
            { wake: false, generation },
          );
          if (!sent) return; // 连接已换代：旧请求不再回复
          lastSentTrackKey = loaded.track.trackKey;
          reply({
            ok: true,
            data: {
              trackKey: loaded.track.trackKey,
              cueCount: loaded.cues.length,
              complete: loaded.complete,
              format: loaded.format,
              rejectedCount: loaded.rejectedCount,
            },
          });
          return;
        }
      }
    } catch (e) {
      if (disposed) return;
      const error = signal.aborted
        ? youtubeErrorInfo('navigation-changed')
        : toAppErrorInfo(e, { code: 'internal', category: 'youtube' });
      reply({ ok: false, error });
    }
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  adapter = createPlayerAdapter({
    doc,
    win,
    getPageKind: () => nav.kind,
    pollMs: timings.playerPollMs,
    onChromeChange: () => overlay.updateLayout(),
    onEvent: (e) => {
      if (disposed) return;
      playbackBuffer.onMediaEvent(e.reason);
      if (e.reason === 'video-replaced' || e.reason === 'play' || e.domEvent === 'loadedmetadata') {
        requestMetadataSoon();
      }
      if (e.reason === 'video-replaced') {
        overlay.bind(e.root, e.video);
        duck.attach(e.video);
        visible.setRoot(e.root);
        updateNativeHiding();
      } else if (e.reason === 'volumechange' && e.video) {
        duck.onVolumeChange(e.video);
      } else if (e.reason === 'ad-start' || e.reason === 'ad-end') {
        overlay.setAd(e.reason === 'ad-start');
      } else if (e.reason === 'fullscreen') {
        overlay.updateLayout();
      }
      // 适配器构造期间 adapter 变量尚未赋值，初始状态在构造完成后统一上报。
      if (adapter) sendPlayerState(e.reason);
    },
  });
  overlay.bind(adapter.root, adapter.video);
  duck.attach(adapter.video);
  visible.setRoot(adapter.root);
  overlay.setAd(isAdShowing(adapter.root));

  const stopNavigation = watchNavigation({
    win,
    doc,
    tracker,
    pollMs: timings.navigationPollMs,
    onNavigate: (n) => onNavigate(n),
  });
  onNavigate(nav, true);
  if (adapter.video) sendPlayerState('video-replaced');

  const overlayTimer = win.setInterval(() => {
    if (disposed) return;
    // 扩展真正失效（runtime.id 消失）时清理；不依赖页面可伪造的 WXT 启动事件。
    if (!deps.isContextValid()) {
      dispose();
      return;
    }
    if (session && !overlay.mounted) overlay.render();
    // YouTube 可从自己的缓存切轨而不再请求 timedtext；读取选择不触发网络或切换开关。
    if (sessionActive() && nav.videoId && loadsInFlight === 0 && !passiveLoading)
      bridge.requestCaptionSelection(nav.videoId);
  }, timings.overlayCheckMs);

  const lifecycleAbort = new AbortController();
  // Record native toggle intent before its handler changes the video. This also
  // invalidates an in-flight automatic play when the user explicitly pauses.
  const playerIntent = (event: Event) => {
    const target = event.target as Element | null;
    if (!event.isTrusted || !adapter?.video || !target) return;
    if (target.closest?.('input, textarea, [contenteditable="true"]')) return;
    const keyboard = event instanceof KeyboardEvent;
    if (keyboard && ![' ', 'k', 'K'].includes(event.key)) return;
    if (!keyboard && !target.closest?.('.ytp-play-button, video')) return;
    if (keyboard && !adapter.root?.contains(target) && target !== doc.body) return;
    playbackBuffer.userIntent(adapter.video.paused ? 'play' : 'pause');
  };
  doc.addEventListener('click', playerIntent, { capture: true, signal: lifecycleAbort.signal });
  doc.addEventListener('keydown', playerIntent, { capture: true, signal: lifecycleAbort.signal });
  doc.addEventListener(
    'visibilitychange',
    () => {
      if (doc.visibilityState === 'visible') requestMetadataSoon();
    },
    { signal: lifecycleAbort.signal },
  );
  const stopWake = deps.onWakeMessage?.(() => onWake());

  function dispose() {
    if (disposed) return;
    // 先恢复页面副作用（需要桥与播放器仍可用），再释放资源；单项失败不影响其余清理。
    const steps: Array<() => void> = [
      () => duck.releaseCurrent(),
      () => captions.restoreNativeCaptions(),
    ];
    for (const step of steps) {
      try {
        step();
      } catch {
        /* continue */
      }
    }
    disposed = true;
    const releases: Array<() => void> = [
      () => playbackBuffer.dispose(),
      () => navAbort.abort(),
      () => clearMetadataTimers(),
      () => clearPassiveIntent(),
      () => updateStartingPoll(),
      () => {
        if (welcomeTimer !== undefined) win.clearTimeout(welcomeTimer);
      },
      () => win.clearInterval(overlayTimer),
      () => lifecycleAbort.abort(),
      () => stopWake?.(),
      () => {
        if (resyncTimer !== undefined) win.clearTimeout(resyncTimer);
      },
      () => stopNavigation(),
      () => port.dispose(),
      () => adapter?.dispose(),
      () => visible.dispose(),
      () => overlay.destroy(),
      () => hider.dispose(),
      () => captions.dispose(),
      () => bridge.dispose(),
    ];
    for (const release of releases) {
      try {
        release();
      } catch {
        /* continue */
      }
    }
  }

  deps.onInvalidated(dispose);

  return {
    get disposed() {
      return disposed;
    },
    debug() {
      return {
        navigationId: nav.navigationId,
        videoId: nav.videoId,
        connected: port.connected,
        overlayMounted: overlay.mounted,
        sessionId: session?.sessionId ?? null,
        availability: captions.availability,
        visibleObserving: visible.enabled,
      };
    },
    dispose,
  };
}

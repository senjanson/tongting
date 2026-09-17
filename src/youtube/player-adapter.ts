/**
 * 播放器适配器：找到 #movie_player（或 Shorts 播放器）内实际的 HTMLVideoElement，监听媒体事件，
 * 检测 video 元素替换（旧监听器全部卸载，T37）、广告、控制栏显隐与全屏。
 *
 * 事件立即回调；播放中通过 timeupdate 节流约 1s 产生 'tick'。播放器与 video 的发现依赖轮询（默认 500ms），
 * 不在整个文档上挂 MutationObserver。
 */
import type { ContentToBackground } from '../messaging/content-protocol';
import { epochNowMs, type EpochClockSource } from '../domain/clock';
import {
  areControlsHidden,
  findPlayerRoot,
  findVideo,
  isAdShowing,
  isPlayerFullscreen,
} from './selectors';
import type { PageKind } from './video-id';

/** 与 content-protocol 的 player/state reason 枚举一致。 */
export type ContentPlayerReason = Extract<ContentToBackground, { type: 'player/state' }>['reason'];

export interface MediaSnapshot {
  currentTimeMs: number;
  durationMs?: number;
  paused: boolean;
  buffering: boolean;
  seeking: boolean;
  ended: boolean;
  playbackRate: number;
  ad: boolean;
  volume: number;
  muted: boolean;
  fullscreen: boolean;
  sampledAtEpochMs: number;
}

export interface PlayerAdapterEvent {
  reason: ContentPlayerReason;
  video: HTMLVideoElement | null;
  root: HTMLElement | null;
  /** 原始 DOM 事件类型（诊断用）。 */
  domEvent?: string;
}

export interface PlayerAdapterOptions {
  doc: Document;
  win: Window;
  getPageKind(): PageKind;
  onEvent(e: PlayerAdapterEvent): void;
  /** 控制栏显隐变化（用于覆盖层偏移）。 */
  onChromeChange?(): void;
  pollMs?: number;
  tickMs?: number;
  now?(): number;
}

export interface PlayerAdapter {
  readonly video: HTMLVideoElement | null;
  readonly root: HTMLElement | null;
  /** 立即重新扫描播放器与 video。 */
  scan(): void;
  snapshot(): MediaSnapshot | null;
  dispose(): void;
}

const MEDIA_EVENTS: Record<string, ContentPlayerReason | null> = {
  play: 'play',
  pause: 'pause',
  seeking: 'seeking',
  seeked: 'seeked',
  ratechange: 'ratechange',
  waiting: 'waiting',
  playing: 'playing',
  ended: 'ended',
  volumechange: 'volumechange',
  emptied: 'video-replaced',
  loadedmetadata: 'tick',
  timeupdate: null, // 节流为 tick
};

/** PlayerState.currentTimeMs 的协议上限（31 天）。 */
export const PLAYER_MAX_TIME_MS = 31 * 24 * 3600 * 1000;

/**
 * 跨文档可比较的采样时间（Date.now() 基准，见 domain/clock.ts）。
 * 不使用 performance.timeOrigin + now()：系统睡眠后不同文档的 performance 时钟会偏离。
 */
export function epochNow(source?: EpochClockSource): number {
  return source ? epochNowMs(source) : epochNowMs();
}

export function readMediaSnapshot(
  video: HTMLVideoElement,
  root: HTMLElement | null,
  doc: Document,
  waiting: boolean,
  sampledAtEpochMs: number,
): MediaSnapshot {
  const t = Number.isFinite(video.currentTime) ? video.currentTime * 1000 : 0;
  const d = video.duration;
  const durationMs =
    Number.isFinite(d) && d >= 0 && d * 1000 <= 1000 * 3600 * 1000
      ? Math.round(d * 1000)
      : undefined;
  const rate =
    Number.isFinite(video.playbackRate) && video.playbackRate > 0 ? video.playbackRate : 1;
  const volume = Number.isFinite(video.volume) ? video.volume : 1;
  return {
    currentTimeMs: Math.min(Math.max(0, Math.round(t)), PLAYER_MAX_TIME_MS),
    durationMs,
    paused: !!video.paused,
    buffering: !video.paused && !video.ended && (waiting || video.readyState < 3),
    seeking: !!video.seeking,
    ended: !!video.ended,
    playbackRate: Math.min(16, Math.max(0.0625, rate)),
    ad: isAdShowing(root),
    volume: Math.min(1, Math.max(0, volume)),
    muted: !!video.muted,
    fullscreen: isPlayerFullscreen(doc, root),
    sampledAtEpochMs,
  };
}

export function createPlayerAdapter(opts: PlayerAdapterOptions): PlayerAdapter {
  const { doc, win } = opts;
  const pollMs = opts.pollMs ?? 500;
  const tickMs = opts.tickMs ?? 1_000;
  const now = opts.now ?? (() => epochNow());

  let root: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;
  let videoAbort: AbortController | null = null;
  let rootObserver: MutationObserver | null = null;
  let waiting = false;
  let lastTickAt = 0;
  let lastAd = false;
  let lastControlsHidden = false;
  let lastFullscreen = false;
  let disposed = false;

  const emit = (reason: ContentPlayerReason, domEvent?: string) => {
    if (disposed) return;
    try {
      opts.onEvent({ reason, video, root, domEvent });
    } catch {
      /* 回调异常不影响适配器 */
    }
  };

  const checkRootFlags = () => {
    const ad = isAdShowing(root);
    if (ad !== lastAd) {
      lastAd = ad;
      emit(ad ? 'ad-start' : 'ad-end');
    }
    const hidden = areControlsHidden(root);
    if (hidden !== lastControlsHidden) {
      lastControlsHidden = hidden;
      opts.onChromeChange?.();
    }
    const fs = isPlayerFullscreen(doc, root);
    if (fs !== lastFullscreen) {
      lastFullscreen = fs;
      emit('fullscreen');
    }
  };

  const attachVideo = (next: HTMLVideoElement | null) => {
    videoAbort?.abort();
    videoAbort = null;
    video = next;
    waiting = false;
    lastTickAt = 0;
    if (!next) return;
    const ac = new AbortController();
    videoAbort = ac;
    for (const [type, reason] of Object.entries(MEDIA_EVENTS)) {
      next.addEventListener(
        type,
        () => {
          if (ac.signal.aborted || next !== video) return;
          if (!next.isConnected) {
            // 元素已被移出文档（被替换或播放器重建）：旧元素事件不上报，立即重新扫描。
            scan();
            return;
          }
          if (type === 'waiting') waiting = true;
          if (
            type === 'playing' ||
            type === 'pause' ||
            type === 'seeked' ||
            type === 'emptied' ||
            type === 'ended'
          )
            waiting = false;
          if (reason === null) {
            const t = now();
            if (!next.paused && t - lastTickAt >= tickMs) {
              lastTickAt = t;
              emit('tick', type);
            }
            return;
          }
          if (reason !== 'tick') lastTickAt = now();
          emit(reason, type);
        },
        { signal: ac.signal },
      );
    }
  };

  const attachRoot = (next: HTMLElement | null) => {
    rootObserver?.disconnect();
    rootObserver = null;
    root = next;
    if (next) {
      rootObserver = new MutationObserver(checkRootFlags);
      rootObserver.observe(next, { attributes: true, attributeFilter: ['class'] });
    }
  };

  const scan = () => {
    if (disposed) return;
    let nextRoot: HTMLElement | null;
    try {
      nextRoot = findPlayerRoot(doc, opts.getPageKind());
    } catch {
      nextRoot = null;
    }
    const nextVideo = nextRoot ? findVideo(nextRoot) : null;
    const rootChanged = nextRoot !== root;
    if (rootChanged) attachRoot(nextRoot);
    if (nextVideo !== video) {
      attachVideo(nextVideo);
      emit('video-replaced');
    } else if (rootChanged) {
      emit('video-replaced');
    }
    checkRootFlags();
  };

  const timer = win.setInterval(scan, pollMs);
  const fsAbort = new AbortController();
  doc.addEventListener('fullscreenchange', checkRootFlags, { signal: fsAbort.signal });
  scan();

  return {
    get video() {
      return video;
    },
    get root() {
      return root;
    },
    scan,
    snapshot() {
      if (!video) return null;
      try {
        return readMediaSnapshot(video, root, doc, waiting, now());
      } catch {
        return null;
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      win.clearInterval(timer);
      fsAbort.abort();
      videoAbort?.abort();
      videoAbort = null;
      rootObserver?.disconnect();
      rootObserver = null;
      video = null;
      root = null;
    },
  };
}

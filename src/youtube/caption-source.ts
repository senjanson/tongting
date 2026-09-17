/**
 * 字幕来源适配器（ISOLATED world）：维护当前导航的播放器元数据、被动捕获的 timedtext 正文，
 * 并按需通过桥让播放器加载完整轨道。
 *
 * 身份核对：
 * - 只接受 URL 为同源 /api/timedtext、v= 等于当前导航 videoId、且不是 YouTube 自动翻译（tlang）的正文；
 * - 播放器元数据的 videoId 必须等于当前导航 videoId；
 * - 导航变化时，所有等待中的加载以 navigation-changed 结束，缓存清空，迟到结果被丢弃。
 */
import type { RawCaptionCue } from '../domain/cue';
import type { CaptionTrackInfo } from '../domain/session';
import { primaryLanguageTag } from '../domain/languages';
import { cancelledError } from '../domain/errors';
import { parseCaptionBody, type CaptionFormat, type CaptionParseResult } from '../captions/parse';
import {
  inspectTimedtextUrl,
  toPlayerMetadata,
  type BridgeClient,
  type BridgeCommandResultMsg,
  type BridgeMissingMsg,
  type BridgePlayerResponseMsg,
  type BridgeTimedtextMsg,
  type PlayerMetadata,
} from './bridge-client';
import { trackNameFromVssId } from './bridge/protocol';
import { youtubeError } from './errors';

export interface CaptionNavigation {
  navigationId: number;
  videoId: string | null;
}

export interface LoadedTrack {
  navigationId: number;
  videoId: string;
  track: CaptionTrackInfo;
  format: CaptionFormat;
  cues: RawCaptionCue[];
  complete: boolean;
  rejectedCount: number;
}

export type CaptionsAvailability = 'unknown' | 'available' | 'unavailable';

export interface CaptionSourceDeps {
  bridge: Pick<BridgeClient, 'loadTrack' | 'restoreCaptions' | 'requestPlayerResponse'> &
    Partial<Pick<BridgeClient, 'requestReplay'>>;
  /** 当前是否仍需要保留同听打开的原生字幕（会话活跃）；迟到的「已打开」结果据此立即恢复。 */
  shouldKeepNativeCaptions?(): boolean;
  now?(): number;
  origin: string;
  newId(): string;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  /** 元数据或可用性变化时通知（用于上报 captions/tracks 与 page/video）。 */
  onMetadata?(metadata: PlayerMetadata | null, availability: CaptionsAvailability): void;
  /**
   * 页面自己请求（非同听兜底请求）的正文解析成功后通知，用于识别用户在播放器里切换字幕语言。
   * trackKey 为元数据中对应轨道；元数据未就绪或无对应轨道时为 undefined。
   */
  onPassiveBody?(info: { trackKey: string | undefined; languageCode: string; asr: boolean }): void;
  metadataWaitMs?: number;
  loadTimeoutMs?: number;
  /** 桥报告未捕获到正文后，再等待迟到正文的宽限时间。 */
  noCaptureGraceMs?: number;
}

export interface CaptionSource {
  setNavigation(nav: CaptionNavigation): void;
  handlePlayerResponse(msg: BridgePlayerResponseMsg): void;
  handlePlayerResponseMissing(msg: BridgeMissingMsg): void;
  handleTimedtext(msg: BridgeTimedtextMsg): void;
  handleCommandResult(msg: BridgeCommandResultMsg): void;
  readonly metadata: PlayerMetadata | null;
  readonly availability: CaptionsAvailability;
  selectTrack(req: { trackKey?: string; preferredLanguage?: string }): CaptionTrackInfo | null;
  /** 该轨道的正文是否已在本导航内缓存（不触发播放器请求）。 */
  hasBodyFor(trackKey: string): boolean;
  loadTrack(
    req: { trackKey?: string; preferredLanguage?: string },
    signal?: AbortSignal,
  ): Promise<LoadedTrack>;
  /** 同听是否为了加载轨道打开过原生字幕（需要在会话结束时恢复）。 */
  readonly changedNativeCaptions: boolean;
  restoreNativeCaptions(): void;
  /** 被丢弃的 timedtext 正文数（视频不符、非同源、自动翻译等），不含内容。 */
  readonly droppedBodies: number;
  dispose(): void;
}

type ParsedBody = { ok: true; result: CaptionParseResult } | { ok: false };

const MAX_CACHED_BODIES = 8;

function bodyKey(languageCode: string, asr: boolean, name: string): string {
  return `${languageCode}|${asr ? 'asr' : ''}|${name}`;
}

export { trackNameFromVssId } from './bridge/protocol';

/** 导航提交前后接受相邻导航正文的时间窗口。 */
const ADJACENT_BODY_WINDOW_MS = 5_000;
const MAX_FOREIGN_BODY_CHARS = 8 * 1024 * 1024;

export function selectCaptionTrack(
  tracks: readonly CaptionTrackInfo[],
  req: { trackKey?: string; preferredLanguage?: string },
): CaptionTrackInfo | null {
  if (req.trackKey) return tracks.find((t) => t.trackKey === req.trackKey) ?? null;
  const manual = tracks.filter((t) => t.kind !== 'asr');
  const asr = tracks.filter((t) => t.kind === 'asr');
  const pref =
    req.preferredLanguage && req.preferredLanguage !== 'auto'
      ? req.preferredLanguage.toLowerCase()
      : undefined;
  if (pref) {
    // 人工字幕优先于自动字幕：人工（精确 → 同主语言）→ 自动（精确 → 同主语言）。
    const primary = primaryLanguageTag(pref);
    for (const list of [manual, asr]) {
      const hit =
        list.find((t) => t.languageCode.toLowerCase() === pref) ??
        list.find((t) => primaryLanguageTag(t.languageCode) === primary);
      if (hit) return hit;
    }
  }
  return (
    manual.find((t) => t.isDefault) ?? manual[0] ?? asr.find((t) => t.isDefault) ?? asr[0] ?? null
  );
}

export function createCaptionSource(deps: CaptionSourceDeps): CaptionSource {
  const metadataWaitMs = deps.metadataWaitMs ?? 6_000;
  // 需小于 worker 端 load-track 请求超时（20 秒）：播放器捕获 4s + 兜底请求 + 解析失败后的再次兜底。
  const loadTimeoutMs = deps.loadTimeoutMs ?? 15_000;
  const now = deps.now ?? Date.now;
  const graceMs = deps.noCaptureGraceMs ?? 1_500;

  let nav: CaptionNavigation = { navigationId: 0, videoId: null };
  let navAbort = new AbortController();
  let metadata: PlayerMetadata | null = null;
  let availability: CaptionsAvailability = 'unknown';
  let metadataSignature = '';
  let bodies = new Map<string, ParsedBody>();
  let loaded = new Map<string, LoadedTrack>();
  let inflight = new Map<string, Promise<LoadedTrack>>();
  const changeListeners = new Set<() => void>();
  const commandListeners = new Map<string, (msg: BridgeCommandResultMsg) => void>();
  /** 已发出的桥命令 → videoId；导航后迟到的结果仍用于记录「原生字幕被打开过」。 */
  const issuedCommands = new Map<string, { videoId: string; navigationId: number }>();
  /** 正在等待正文的 body key：只有这些 key 允许被新正文覆盖。 */
  const pendingKeys = new Set<string>();
  /** 等待期间收到无法解析正文的 key。 */
  const failedKeys = new Set<string>();
  /** 与当前导航视频不符、可能属于即将提交的导航的正文（有界）。 */
  let foreignBodies: Array<{ msg: BridgeTimedtextMsg; videoId: string; at: number }> = [];
  let changedCaptionsVideoId: string | null = null;
  let droppedBodies = 0;
  let disposed = false;

  const notifyChange = () => {
    for (const l of [...changeListeners]) l();
  };

  const setMetadata = (m: PlayerMetadata | null, a: CaptionsAvailability) => {
    metadata = m;
    availability = a;
    deps.onMetadata?.(m, a);
    notifyChange();
  };

  /** 等待条件满足；导航变化、外部取消或超时时拒绝。 */
  function waitFor<T>(
    check: () => T | undefined,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    onTimeout: () => Error,
  ): Promise<T> {
    const navSignal = navAbort.signal;
    return new Promise<T>((resolve, reject) => {
      const immediate = check();
      if (immediate !== undefined) return resolve(immediate);
      if (navSignal.aborted) return reject(youtubeError('navigation-changed'));
      if (signal?.aborted) return reject(cancelledError());
      let settled = false;
      const cleanup = () => {
        settled = true;
        changeListeners.delete(onChange);
        deps.clearTimeout(timer);
        navSignal.removeEventListener('abort', onNavAbort);
        signal?.removeEventListener('abort', onAbort);
      };
      const onChange = () => {
        if (settled) return;
        let v: T | undefined;
        try {
          v = check();
        } catch (e) {
          cleanup();
          reject(e);
          return;
        }
        if (v !== undefined) {
          cleanup();
          resolve(v);
        }
      };
      const onNavAbort = () => {
        cleanup();
        reject(youtubeError('navigation-changed'));
      };
      const onAbort = () => {
        cleanup();
        reject(cancelledError());
      };
      const timer = deps.setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(onTimeout());
      }, timeoutMs);
      changeListeners.add(onChange);
      navSignal.addEventListener('abort', onNavAbort, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function doLoad(
    track: CaptionTrackInfo,
    forNav: CaptionNavigation,
    meta: PlayerMetadata,
  ): Promise<LoadedTrack> {
    const bridgeTrack = meta.bridgeTracks.get(track.trackKey);
    if (!bridgeTrack || !forNav.videoId) throw youtubeError('captions-track-not-found');
    const key = bodyKey(
      bridgeTrack.languageCode,
      bridgeTrack.kind === 'asr',
      trackNameFromVssId(bridgeTrack.vssId, bridgeTrack.languageCode),
    );
    const videoId = forNav.videoId;

    if (!bodies.get(key)?.ok) {
      const commandId = deps.newId();
      let failure: Error | undefined;
      let graceTimer: unknown;
      let fetchRetried = false;
      failedKeys.delete(key);
      pendingKeys.add(key);
      const commandIds: string[] = [];
      const sendCommand = (id: string, fetchOnly: boolean) => {
        commandIds.push(id);
        commandListeners.set(id, onResult);
        issuedCommands.set(id, { videoId, navigationId: forNav.navigationId });
        deps.bridge.loadTrack({
          commandId: id,
          videoId,
          languageCode: bridgeTrack.languageCode,
          kind: bridgeTrack.kind,
          ...(bridgeTrack.vssId ? { vssId: bridgeTrack.vssId } : {}),
          ...(fetchOnly ? { fetchOnly: true } : {}),
        });
      };
      while (issuedCommands.size > 32) {
        const first = issuedCommands.keys().next().value;
        if (first === undefined) break;
        issuedCommands.delete(first);
      }
      const onResult = (msg: BridgeCommandResultMsg) => {
        commandListeners.delete(msg.commandId);
        if (msg.ok) return;
        if (msg.code === 'no-capture' || fetchRetried) {
          // 播放器与兜底请求都没拿到正文：留出宽限时间给迟到的捕获。
          graceTimer = deps.setTimeout(() => {
            failure = youtubeError(
              failedKeys.has(key) ? 'captions-parse-failed' : 'captions-load-timeout',
            );
            notifyChange();
          }, graceMs);
          return;
        }
        failure =
          msg.code === 'track-not-found'
            ? youtubeError('captions-track-not-found')
            : msg.code === 'video-mismatch'
              ? youtubeError('navigation-changed')
              : youtubeError('captions-player-unavailable', msg.code);
        notifyChange();
      };
      sendCommand(commandId, false);
      try {
        await waitFor(
          () => {
            if (bodies.get(key)?.ok) return true;
            if (failedKeys.has(key) && !fetchRetried) {
              // 捕获到的正文无法解析（例如非 json3 格式）：再要求桥直接做 fmt=json3 兜底请求。
              fetchRetried = true;
              sendCommand(deps.newId(), true);
            }
            if (failure) throw failure;
            return undefined;
          },
          loadTimeoutMs,
          undefined,
          () =>
            youtubeError(failedKeys.has(key) ? 'captions-parse-failed' : 'captions-load-timeout'),
        );
      } finally {
        for (const id of commandIds) commandListeners.delete(id);
        pendingKeys.delete(key);
        if (graceTimer !== undefined) deps.clearTimeout(graceTimer);
      }
      if (nav.navigationId !== forNav.navigationId) throw youtubeError('navigation-changed');
    }

    const parsed = bodies.get(key);
    if (!parsed?.ok) {
      throw youtubeError(
        failedKeys.has(key) || parsed ? 'captions-parse-failed' : 'captions-load-timeout',
      );
    }
    return {
      navigationId: forNav.navigationId,
      videoId,
      track,
      format: parsed.result.format,
      cues: parsed.result.cues,
      complete: !parsed.result.overflowed && !meta.isLive,
      rejectedCount: parsed.result.rejectedCount,
    };
  }

  const source: CaptionSource = {
    get metadata() {
      return metadata;
    },
    get availability() {
      return availability;
    },
    get changedNativeCaptions() {
      return changedCaptionsVideoId !== null;
    },
    get droppedBodies() {
      return droppedBodies;
    },

    setNavigation(next) {
      if (disposed) return;
      navAbort.abort();
      navAbort = new AbortController();
      nav = { ...next };
      bodies = new Map();
      loaded = new Map();
      inflight = new Map();
      commandListeners.clear();
      pendingKeys.clear();
      failedKeys.clear();
      metadata = null;
      metadataSignature = '';
      availability = 'unknown';
      deps.onMetadata?.(null, 'unknown');
      if (!nav.videoId) return;
      // 导航提交前已到达的本视频正文（窗口内）直接采用；并请求 MAIN 重放其缓存（含 document_start 阶段捕获的正文）。
      const adopt = foreignBodies.filter(
        (f) => f.videoId === nav.videoId && now() - f.at <= ADJACENT_BODY_WINDOW_MS,
      );
      foreignBodies = foreignBodies.filter((f) => f.videoId !== nav.videoId);
      for (const f of adopt) source.handleTimedtext(f.msg);
      deps.bridge.requestReplay?.(nav.videoId);
    },

    handlePlayerResponse(msg) {
      if (disposed || !nav.videoId || msg.videoId !== nav.videoId) return;
      const m = toPlayerMetadata(msg);
      // 桥会在多个时机重复推送同一份数据：内容未变化时不重复通知（避免无意义地唤醒 worker）。
      const signature = JSON.stringify([m.title, m.channel, m.durationMs, m.isLive, m.tracks]);
      if (metadata && signature === metadataSignature) return;
      metadataSignature = signature;
      setMetadata(m, m.tracks.length ? 'available' : 'unavailable');
    },

    handlePlayerResponseMissing(msg) {
      // 仅用于诊断；可用性保持 unknown，由重试或超时决定。
      void msg;
    },

    handleTimedtext(msg) {
      if (disposed) return;
      const info = inspectTimedtextUrl(msg.url, deps.origin);
      if (!info || info.tlang || !info.lang || msg.status < 200 || msg.status >= 300) {
        droppedBodies++;
        return;
      }
      if (!nav.videoId || info.videoId !== nav.videoId) {
        droppedBodies++;
        if (info.videoId) {
          // 可能属于即将提交的导航：短暂保留（最多 2 份、合计 ≤8MB）。
          foreignBodies = foreignBodies.filter((f) => now() - f.at <= ADJACENT_BODY_WINDOW_MS);
          foreignBodies.push({ msg, videoId: info.videoId, at: now() });
          while (
            foreignBodies.length > 2 ||
            foreignBodies.reduce((n, f) => n + f.msg.body.length, 0) > MAX_FOREIGN_BODY_CHARS
          ) {
            foreignBodies.shift();
          }
        }
        return;
      }
      let parsed: ParsedBody;
      try {
        parsed = { ok: true, result: parseCaptionBody(msg.body) };
      } catch {
        parsed = { ok: false };
      }
      const name = info.name ?? '';
      const key = bodyKey(info.lang, info.kind === 'asr', name);
      const existing = bodies.get(key);
      // 已成功解析的正文：不被失败正文覆盖；没有加载在等待时也不被被动正文覆盖（页面脚本可伪造）。
      if (existing?.ok && (!parsed.ok || !pendingKeys.has(key))) {
        droppedBodies++;
        return;
      }
      if (!parsed.ok && pendingKeys.has(key)) failedKeys.add(key);
      bodies.delete(key);
      bodies.set(key, parsed);
      while (bodies.size > MAX_CACHED_BODIES) {
        const first = bodies.keys().next().value;
        if (first === undefined) break;
        bodies.delete(first);
      }
      notifyChange();
      if (parsed.ok && msg.via !== 'bridge-fetch') {
        const asr = info.kind === 'asr';
        let trackKey: string | undefined;
        for (const [k, t] of metadata?.bridgeTracks ?? []) {
          if (
            t.languageCode === info.lang &&
            (t.kind === 'asr') === asr &&
            trackNameFromVssId(t.vssId, t.languageCode) === name
          ) {
            trackKey = k;
            break;
          }
        }
        deps.onPassiveBody?.({ trackKey, languageCode: info.lang, asr });
      }
    },

    handleCommandResult(msg) {
      const issued = issuedCommands.get(msg.commandId);
      if (issued === undefined) return; // 不是本脚本发出的命令
      issuedCommands.delete(msg.commandId);
      if (msg.changedCaptions) {
        changedCaptionsVideoId = issued.videoId;
        // 迟到结果：已导航或会话已不需要原生字幕时立即恢复。
        if (
          issued.navigationId !== nav.navigationId ||
          deps.shouldKeepNativeCaptions?.() === false
        ) {
          source.restoreNativeCaptions();
        }
      }
      commandListeners.get(msg.commandId)?.(msg);
    },

    selectTrack(req) {
      return metadata ? selectCaptionTrack(metadata.tracks, req) : null;
    },

    hasBodyFor(trackKey) {
      const t = metadata?.bridgeTracks.get(trackKey);
      return (
        !!t &&
        bodies.get(
          bodyKey(t.languageCode, t.kind === 'asr', trackNameFromVssId(t.vssId, t.languageCode)),
        )?.ok === true
      );
    },

    async loadTrack(req, signal) {
      if (disposed) throw youtubeError('navigation-changed');
      const forNav = { ...nav };
      if (!forNav.videoId) throw youtubeError('player-unavailable');
      if (!metadata) deps.bridge.requestPlayerResponse(forNav.videoId);
      const meta = await waitFor(
        () => metadata ?? undefined,
        metadataWaitMs,
        signal,
        () => youtubeError('captions-bridge-unavailable'),
      );
      if (nav.navigationId !== forNav.navigationId) throw youtubeError('navigation-changed');
      if (!meta.tracks.length) throw youtubeError('captions-no-tracks');
      const track = selectCaptionTrack(meta.tracks, req);
      if (!track) throw youtubeError('captions-track-not-found');
      const cacheKey = track.trackKey;
      const cached = loaded.get(cacheKey);
      if (cached) return cached;
      let p = inflight.get(cacheKey);
      if (!p) {
        const inflightMap = inflight;
        const loadedMap = loaded;
        p = doLoad(track, forNav, meta).then(
          (r) => {
            if (nav.navigationId === forNav.navigationId) loadedMap.set(cacheKey, r);
            inflightMap.delete(cacheKey);
            return r;
          },
          (e: unknown) => {
            inflightMap.delete(cacheKey);
            throw e;
          },
        );
        inflight.set(cacheKey, p);
      }
      // 共享的加载不因单个请求方取消而中止；请求方只停止等待。
      const shared = p;
      const result = await new Promise<LoadedTrack>((resolve, reject) => {
        if (signal?.aborted) return reject(cancelledError());
        const onAbort = () => reject(cancelledError());
        signal?.addEventListener('abort', onAbort, { once: true });
        shared.then(
          (r) => {
            signal?.removeEventListener('abort', onAbort);
            resolve(r);
          },
          (e: unknown) => {
            signal?.removeEventListener('abort', onAbort);
            reject(e);
          },
        );
      });
      if (nav.navigationId !== forNav.navigationId) throw youtubeError('navigation-changed');
      return result;
    },

    restoreNativeCaptions() {
      if (changedCaptionsVideoId === null) return;
      const videoId = changedCaptionsVideoId;
      changedCaptionsVideoId = null;
      deps.bridge.restoreCaptions({ commandId: deps.newId(), videoId });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      navAbort.abort();
      changeListeners.clear();
      commandListeners.clear();
      bodies = new Map();
      loaded = new Map();
      inflight = new Map();
    },
  };
  return source;
}

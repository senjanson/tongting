/**
 * MAIN world 桥（document_start 注入 www.youtube.com）。
 *
 * 职责（仅在确有必要时读取播放器数据）：
 * 1. 读取 movie_player.getPlayerResponse() / ytInitialPlayerResponse 中的 videoDetails 与 captionTracks；
 * 2. 包装 fetch / XMLHttpRequest，被动观察同源 /api/timedtext 响应正文并转交 ISOLATED 内容脚本；
 * 3. 固定命令 load-track：只接受当前视频、当前播放器响应里已知的轨道；优先让播放器自己切换轨道并发请求
 *    （timedtext 往往需要播放器生成的参数），超时后再以同源 fetch 请求该轨道 baseUrl（fmt=json3）兜底；
 * 4. 固定命令 restore-captions：恢复桥为加载字幕而改变的原生字幕状态。
 *
 * 不注入 Key，不执行远端代码，不提供通用 fetch / 任意 URL / 任意命令代理。
 * 所有包装都不改变页面请求的结果；观察失败静默忽略，不影响 YouTube 自身逻辑。
 */
import { findPlayerRoot } from '../selectors';
import { isValidVideoId, parseYoutubeUrl } from '../video-id';
import {
  BRIDGE_MAX_BODY_CHARS,
  BRIDGE_PLAYER_CAPTURE_WAIT_MS,
  BRIDGE_CACHE_MAX_CHARS,
  BRIDGE_CACHE_MAX_VIDEOS,
  BRIDGE_TAG,
  trackNameFromVssId,
  type BridgePlayerResponse,
  type BridgeTimedtext,
  type BridgeToIsolated,
  type BridgeTrack,
  type DistributiveOmit,
} from './protocol';

interface YtPlayerApi {
  getPlayerResponse?: () => unknown;
  loadModule?: (name: string) => void;
  unloadModule?: (name: string) => void;
  setOption?: (module: string, option: string, value: unknown) => void;
  getOption?: (module: string, option: string) => unknown;
}

interface PrivateTrack extends BridgeTrack {
  baseUrl?: string;
}

interface ExtractedResponse {
  payload: BridgePlayerResponse;
  tracks: PrivateTrack[];
}

type Obj = Record<string, unknown>;

const INSTALL_FLAG = Symbol.for('tongting.youtube-bridge.v1');
const LANGUAGE_CODE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/;
const COMMAND_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown, max: number): string | undefined {
  return typeof v === 'string' ? v.slice(0, max) : undefined;
}

function textOf(v: unknown, max: number): string {
  if (!isObj(v)) return '';
  if (typeof v.simpleText === 'string') return v.simpleText.slice(0, max);
  if (Array.isArray(v.runs)) {
    return v.runs
      .map((r) => (isObj(r) && typeof r.text === 'string' ? r.text : ''))
      .join('')
      .slice(0, max);
  }
  return '';
}

export function extractPlayerResponse(raw: unknown): ExtractedResponse | null {
  if (!isObj(raw)) return null;
  const vd = raw.videoDetails;
  if (!isObj(vd) || typeof vd.videoId !== 'string' || !isValidVideoId(vd.videoId)) return null;
  let lengthSeconds: number | undefined;
  const len = typeof vd.lengthSeconds === 'string' ? Number(vd.lengthSeconds) : vd.lengthSeconds;
  if (typeof len === 'number' && Number.isInteger(len) && len >= 0 && len <= 3_600_000)
    lengthSeconds = len;

  const captions = isObj(raw.captions) ? raw.captions : undefined;
  const renderer =
    captions && isObj(captions.playerCaptionsTracklistRenderer)
      ? captions.playerCaptionsTracklistRenderer
      : undefined;
  const rawTracks =
    renderer && Array.isArray(renderer.captionTracks) ? renderer.captionTracks.slice(0, 100) : [];
  const tracks: PrivateTrack[] = [];
  /** 原始下标 → 过滤后下标。 */
  const indexMap = new Map<number, number>();
  for (const [rawIndex, t] of rawTracks.entries()) {
    // 与 ISOLATED 校验一致：语言码超过 20 字符只跳过该轨道。
    if (
      !isObj(t) ||
      typeof t.languageCode !== 'string' ||
      t.languageCode.length > 20 ||
      !LANGUAGE_CODE_RE.test(t.languageCode)
    )
      continue;
    indexMap.set(rawIndex, tracks.length);
    tracks.push({
      languageCode: t.languageCode,
      kind: typeof t.kind === 'string' && t.kind ? t.kind.slice(0, 20) : null,
      name: textOf(t.name, 200),
      vssId: str(t.vssId, 100) ?? '',
      baseUrl: str(t.baseUrl, 4_000),
    });
  }
  let defaultTrackIndex: number | undefined;
  const audioTracks = renderer && Array.isArray(renderer.audioTracks) ? renderer.audioTracks : [];
  const firstAudio = audioTracks[0];
  if (isObj(firstAudio) && Number.isInteger(firstAudio.defaultCaptionTrackIndex)) {
    // 默认下标指向原始列表；映射到过滤后的列表，被过滤掉或为负数时不设置。
    defaultTrackIndex = indexMap.get(firstAudio.defaultCaptionTrackIndex as number);
  }
  return {
    payload: {
      type: 'player-response',
      videoId: vd.videoId,
      title: str(vd.title, 300),
      author: str(vd.author, 200),
      lengthSeconds,
      isLive: vd.isLive === true,
      tracks: tracks.map(({ languageCode, kind, name, vssId }) => ({
        languageCode,
        kind,
        name,
        vssId,
      })),
      defaultTrackIndex,
    },
    tracks,
  };
}

export function installMainWorldBridge(win: Window & typeof globalThis = window): boolean {
  const flagHost = win as unknown as Record<symbol, unknown>;
  if (flagHost[INSTALL_FLAG]) return false;
  try {
    Object.defineProperty(win, INSTALL_FLAG, {
      value: true,
      configurable: false,
      enumerable: false,
    });
  } catch {
    return false;
  }

  const noop = () => {};
  const origin = () => win.location.origin;

  const post = (msg: DistributiveOmit<BridgeToIsolated, '__tongting' | 'dir'>) => {
    try {
      win.postMessage({ ...msg, __tongting: BRIDGE_TAG, dir: 'to-isolated' }, origin());
    } catch {
      /* 页面卸载中 */
    }
  };

  // -------------------------------------------------------------------------
  // timedtext 被动观察
  // -------------------------------------------------------------------------
  interface CaptureInfo {
    videoId: string | null;
    lang: string | null;
    kind: string | null;
    tlang: string | null;
    name: string | null;
  }
  const captureListeners = new Set<(info: CaptureInfo) => void>();
  let bodyCache: Array<{
    videoId: string;
    lang: string;
    kind: string;
    name: string;
    url: string;
    status: number;
    body: string;
  }> = [];

  const inspect = (raw: string): CaptureInfo | null => {
    try {
      const u = new URL(raw, win.location.href);
      if (u.origin !== origin() || u.pathname !== '/api/timedtext') return null;
      return {
        videoId: u.searchParams.get('v'),
        lang: u.searchParams.get('lang'),
        kind: u.searchParams.get('kind'),
        tlang: u.searchParams.get('tlang'),
        name: u.searchParams.get('name'),
      };
    } catch {
      return null;
    }
  };

  const emitTimedtext = (
    url: string,
    status: number,
    body: string,
    via: BridgeTimedtext['via'],
  ) => {
    if (typeof body !== 'string' || !body || body.length > BRIDGE_MAX_BODY_CHARS) return;
    const info = inspect(url);
    if (!info) return;
    post({ type: 'timedtext', url, status, body, via });
    if (info.videoId && info.lang && !info.tlang) {
      // 缓存最近成功捕获的正文（最多 2 个视频、合计字符数有上限），供内容脚本就绪后重放或再次加载。
      const entry = {
        videoId: info.videoId,
        lang: info.lang,
        kind: info.kind ?? '',
        name: info.name ?? '',
        url,
        status,
        body,
      };
      bodyCache = bodyCache.filter(
        (e) =>
          !(
            e.videoId === entry.videoId &&
            e.lang === entry.lang &&
            e.kind === entry.kind &&
            e.name === entry.name
          ),
      );
      bodyCache.push(entry);
      const videos = [...new Set(bodyCache.map((e) => e.videoId).reverse())].slice(
        0,
        BRIDGE_CACHE_MAX_VIDEOS,
      );
      bodyCache = bodyCache.filter((e) => videos.includes(e.videoId));
      while (bodyCache.reduce((n, e) => n + e.body.length, 0) > BRIDGE_CACHE_MAX_CHARS)
        bodyCache.shift();
    }
    for (const l of captureListeners) {
      try {
        l(info);
      } catch {
        /* ignore */
      }
    }
  };

  const nativeFetch: typeof fetch | undefined =
    typeof win.fetch === 'function' ? win.fetch : undefined;
  if (nativeFetch) {
    const hooked = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
      const promise = Reflect.apply(nativeFetch, win, args) as Promise<Response>;
      try {
        const input = args[0];
        const raw =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : isObj(input) && typeof input.url === 'string'
                ? input.url
                : '';
        if (raw && inspect(raw)) {
          promise.then((res) => {
            if (!res.ok) return;
            res
              .clone()
              .text()
              .then((body) => emitTimedtext(res.url || raw, res.status, body, 'fetch'), noop);
          }, noop);
        }
      } catch {
        /* 观察失败不影响页面请求 */
      }
      return promise;
    };
    try {
      win.fetch = hooked as typeof fetch;
    } catch {
      /* 页面冻结了 fetch */
    }
  }

  const XHR = win.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const urls = new WeakMap<XMLHttpRequest, string>();
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
      try {
        const raw = args[1] instanceof URL ? args[1].href : String(args[1]);
        if (inspect(raw)) urls.set(this, new URL(raw, win.location.href).href);
        else urls.delete(this);
      } catch {
        urls.delete(this);
      }
      return Reflect.apply(origOpen, this, args) as void;
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]) {
      const url = urls.get(this);
      if (url) {
        this.addEventListener(
          'loadend',
          () => {
            try {
              if (this.status < 200 || this.status >= 300) return;
              let body: string | undefined;
              const rt = this.responseType;
              if (rt === '' || rt === 'text') body = this.responseText;
              else if (rt === 'json') body = JSON.stringify(this.response);
              else if (rt === 'arraybuffer' && this.response instanceof ArrayBuffer)
                body = new TextDecoder().decode(this.response);
              if (body) emitTimedtext(this.responseURL || url, this.status, body, 'xhr');
            } catch {
              /* ignore */
            }
          },
          { once: true },
        );
      }
      return Reflect.apply(origSend, this, args) as void;
    } as typeof XHR.prototype.send;
  }

  // -------------------------------------------------------------------------
  // 播放器数据
  // -------------------------------------------------------------------------
  const findPlayerApi = (): YtPlayerApi | null => {
    try {
      const info = parseYoutubeUrl(win.location.href);
      const root = findPlayerRoot(win.document, info.kind) as (HTMLElement & YtPlayerApi) | null;
      return root && typeof root.getPlayerResponse === 'function' ? root : null;
    } catch {
      return null;
    }
  };

  const readResponse = (
    expectedVideoId: string | null,
  ): ExtractedResponse | 'no-player' | 'video-mismatch' | 'no-response' => {
    const api = findPlayerApi();
    let sawResponse = false;
    const candidates: unknown[] = [];
    try {
      if (api?.getPlayerResponse) candidates.push(api.getPlayerResponse());
    } catch {
      /* ignore */
    }
    try {
      candidates.push((win as unknown as Obj).ytInitialPlayerResponse);
    } catch {
      /* ignore */
    }
    for (const c of candidates) {
      const extracted = extractPlayerResponse(c);
      if (!extracted) continue;
      sawResponse = true;
      if (!expectedVideoId || extracted.payload.videoId === expectedVideoId) {
        return extracted;
      }
    }
    if (sawResponse) return 'video-mismatch';
    return api ? 'no-response' : 'no-player';
  };

  const publishResponse = () => {
    const videoId = parseYoutubeUrl(win.location.href).videoId;
    const r = readResponse(videoId);
    if (typeof r === 'string') post({ type: 'player-response-missing', videoId, reason: r });
    else post(r.payload);
  };

  // -------------------------------------------------------------------------
  // 固定命令
  // -------------------------------------------------------------------------
  let captionRestore: { videoId: string; previous: Obj | null } | undefined;

  const result = (
    commandId: string,
    ok: boolean,
    extra: { code?: string; changedCaptions?: boolean; fetched?: boolean } = {},
  ) => post({ type: 'command-result', commandId, ok, ...extra });

  const waitForCapture = (videoId: string, track: PrivateTrack, timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const listener = (info: CaptureInfo) => {
        if (info.videoId !== videoId || info.lang !== track.languageCode || info.tlang) return;
        if ((info.kind === 'asr') !== (track.kind === 'asr')) return;
        if ((info.name ?? '') !== trackNameFromVssId(track.vssId, track.languageCode)) return;
        done(true);
      };
      const timer = win.setTimeout(() => done(false), timeoutMs);
      function done(v: boolean) {
        captureListeners.delete(listener);
        win.clearTimeout(timer);
        resolve(v);
      }
      captureListeners.add(listener);
    });

  const readTrackOption = (api: YtPlayerApi): Obj | null => {
    try {
      const v = api.getOption?.('captions', 'track');
      if (!isObj(v) || typeof v.languageCode !== 'string' || !v.languageCode) return null;
      const copy: Obj = {};
      for (const k of [
        'languageCode',
        'kind',
        'vss_id',
        'vssId',
        'name',
        'id',
        'is_default',
        'translationLanguage',
      ]) {
        if (k in v) copy[k] = v[k];
      }
      return copy;
    } catch {
      return null;
    }
  };

  const trackOptionFor = (api: YtPlayerApi, track: PrivateTrack): unknown => {
    try {
      const list = api.getOption?.('captions', 'tracklist');
      if (Array.isArray(list)) {
        const hit = list.find(
          (e) =>
            isObj(e) &&
            e.languageCode === track.languageCode &&
            (e.kind === 'asr') === (track.kind === 'asr'),
        );
        if (hit) {
          const copy = { ...(hit as Obj) };
          delete copy.translationLanguage;
          return copy;
        }
      }
    } catch {
      /* ignore */
    }
    return track.kind === 'asr'
      ? { languageCode: track.languageCode, kind: 'asr' }
      : { languageCode: track.languageCode };
  };

  const fallbackFetch = async (videoId: string, baseUrl: string): Promise<boolean> => {
    if (!nativeFetch) return false;
    let u: URL;
    try {
      u = new URL(baseUrl, win.location.href);
    } catch {
      return false;
    }
    if (
      u.origin !== origin() ||
      u.pathname !== '/api/timedtext' ||
      u.searchParams.get('v') !== videoId
    )
      return false;
    u.searchParams.set('fmt', 'json3');
    try {
      const res = (await Reflect.apply(nativeFetch, win, [
        u.href,
        { credentials: 'same-origin' },
      ])) as Response;
      if (!res.ok) return false;
      const body = await res.text();
      // 迟到结果：视频已切换则丢弃。
      if (parseYoutubeUrl(win.location.href).videoId !== videoId) return false;
      if (!body || body.length > BRIDGE_MAX_BODY_CHARS) return false;
      emitTimedtext(u.href, res.status, body, 'bridge-fetch');
      return true;
    } catch {
      return false;
    }
  };

  const handleLoadTrack = async (d: Obj) => {
    const commandId = d.commandId as string;
    const videoId = d.videoId as string;
    if (parseYoutubeUrl(win.location.href).videoId !== videoId)
      return result(commandId, false, { code: 'video-mismatch' });
    const resp = readResponse(videoId);
    if (typeof resp === 'string')
      return result(commandId, false, { code: resp === 'no-player' ? 'player-unavailable' : resp });
    const track = resp.tracks.find(
      (t) =>
        t.languageCode === d.languageCode &&
        (t.kind === 'asr') === (d.kind === 'asr') &&
        (!d.vssId || t.vssId === d.vssId),
    );
    if (!track) return result(commandId, false, { code: 'track-not-found' });
    if (d.fetchOnly === true) {
      const fetched = track.baseUrl ? await fallbackFetch(videoId, track.baseUrl) : false;
      return result(commandId, fetched, { code: fetched ? undefined : 'no-capture', fetched });
    }

    // 已缓存该轨道正文：直接重放，不再驱动播放器。
    const trackName = trackNameFromVssId(track.vssId, track.languageCode);
    const cached = bodyCache.find(
      (e) =>
        e.videoId === videoId &&
        e.lang === track.languageCode &&
        (e.kind === 'asr') === (track.kind === 'asr') &&
        e.name === trackName,
    );
    if (cached) {
      post({
        type: 'timedtext',
        url: cached.url,
        status: cached.status,
        body: cached.body,
        via: 'replay',
      });
      return result(commandId, true, { changedCaptions: false });
    }

    const captured = waitForCapture(videoId, track, BRIDGE_PLAYER_CAPTURE_WAIT_MS);
    let changedCaptions = false;
    const api = findPlayerApi();
    if (api?.setOption) {
      try {
        // 只保存首次改动前的用户原始状态，直到 restore 才清除（跨视频不覆盖）。
        const current = readTrackOption(api);
        if (!captionRestore) captionRestore = { videoId, previous: current };
        api.loadModule?.('captions');
        const sameTrack =
          !!current &&
          current.languageCode === track.languageCode &&
          (current.kind === 'asr') === (track.kind === 'asr');
        if (current && (sameTrack || current.translationLanguage)) {
          // 目标轨道已激活（播放器不会重新请求）或开启了自动翻译（tlang）：先关闭再切回原文轨道。
          api.setOption('captions', 'track', {});
        }
        api.setOption('captions', 'track', trackOptionFor(api, track));
        changedCaptions = true;
      } catch {
        /* 播放器 API 不可用，走兜底 */
      }
    }
    let ok = await captured;
    let fetched = false;
    if (!ok && track.baseUrl) {
      fetched = await fallbackFetch(videoId, track.baseUrl);
      ok = fetched;
    }
    return result(commandId, ok, { code: ok ? undefined : 'no-capture', changedCaptions, fetched });
  };

  const handleRestore = (d: Obj) => {
    const commandId = d.commandId as string;
    const videoId = d.videoId as string;
    void videoId;
    const state = captionRestore;
    if (!state) return result(commandId, true, { changedCaptions: false });
    captionRestore = undefined;
    // 即使页面已切到其他视频也恢复：YouTube 会把字幕开关沿用到后续视频，需要还原用户原来的开关状态。
    const api = findPlayerApi();
    try {
      if (state.previous) {
        api?.setOption?.('captions', 'track', state.previous);
      } else {
        api?.setOption?.('captions', 'track', {});
        api?.unloadModule?.('captions');
      }
      return result(commandId, true, { changedCaptions: true });
    } catch {
      return result(commandId, false, { code: 'restore-failed' });
    }
  };

  win.addEventListener('message', (ev: MessageEvent) => {
    if (ev.source !== win) return;
    const d = ev.data;
    if (!isObj(d) || d.__tongting !== BRIDGE_TAG || d.dir !== 'to-main') return;
    try {
      switch (d.type) {
        case 'request-player-response':
          publishResponse();
          break;
        case 'load-track':
          if (
            typeof d.commandId === 'string' &&
            COMMAND_ID_RE.test(d.commandId) &&
            typeof d.videoId === 'string' &&
            isValidVideoId(d.videoId) &&
            typeof d.languageCode === 'string' &&
            LANGUAGE_CODE_RE.test(d.languageCode) &&
            (d.kind === 'asr' || d.kind === 'standard') &&
            (d.vssId === undefined || (typeof d.vssId === 'string' && d.vssId.length <= 100)) &&
            (d.fetchOnly === undefined || typeof d.fetchOnly === 'boolean')
          ) {
            void handleLoadTrack(d).catch(noop);
          }
          break;
        case 'replay-bodies':
          if (typeof d.videoId === 'string' && isValidVideoId(d.videoId)) {
            for (const e of bodyCache) {
              if (e.videoId === d.videoId) {
                post({
                  type: 'timedtext',
                  url: e.url,
                  status: e.status,
                  body: e.body,
                  via: 'replay',
                });
              }
            }
          }
          break;
        case 'restore-captions':
          if (
            typeof d.commandId === 'string' &&
            COMMAND_ID_RE.test(d.commandId) &&
            typeof d.videoId === 'string' &&
            isValidVideoId(d.videoId)
          ) {
            handleRestore(d);
          }
          break;
        default:
          break;
      }
    } catch {
      /* ignore */
    }
  });

  // 导航完成后主动推送一次当前播放器数据（ISOLATED 侧也会主动请求并重试）。
  let pushTimer: number | undefined;
  const schedulePush = () => {
    if (pushTimer !== undefined) win.clearTimeout(pushTimer);
    pushTimer = win.setTimeout(() => {
      pushTimer = undefined;
      try {
        publishResponse();
      } catch {
        /* ignore */
      }
    }, 50);
  };
  win.document.addEventListener('yt-navigate-finish', schedulePush);
  win.document.addEventListener('yt-page-data-updated', schedulePush);

  return true;
}

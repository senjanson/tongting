/**
 * MAIN world 桥 ↔ ISOLATED 内容脚本之间的 window.postMessage 消息形状（仅常量与类型，不含 zod，
 * 以免把校验库打包进页面上下文脚本）。
 *
 * 安全边界：
 * - 页面脚本与桥处于同一 MAIN world，可以伪造任何消息；这里的 tag/dir 只用于过滤无关消息，不是认证。
 * - ISOLATED 侧对所有来自 MAIN world 的数据做 zod 校验（见 bridge-client.ts），并核对视频身份。
 * - 桥只接受固定命令：请求播放器元数据、加载「已知轨道列表中的」字幕轨道、恢复原生字幕状态。
 *   不提供通用 fetch、任意 URL 或任意命令代理。
 */

export const BRIDGE_TAG = 'tongting-bridge-v1';

/** 从 vssId（".en"、"a.en"、".en.sdh"）取轨道名部分，对应 timedtext URL 的 name 参数（待真实页面核对）。 */
export function trackNameFromVssId(vssId: string, languageCode: string): string {
  const m = /^a?\.([^.]+)(?:\.(.+))?$/.exec(vssId);
  return m && m[1] === languageCode ? (m[2] ?? '') : '';
}

/** 对联合类型逐个成员 Omit（内置 Omit 会把联合类型压成公共字段）。 */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** 桥回传的字幕轨道（不含 baseUrl；带签名参数的 URL 只留在 MAIN world 内部使用）。 */
export interface BridgeTrack {
  languageCode: string;
  /** 'asr' 表示自动字幕；null 表示普通字幕；其他值原样传递。 */
  kind: string | null;
  name: string;
  vssId: string;
}

export interface BridgePlayerResponse {
  type: 'player-response';
  videoId: string;
  title?: string;
  author?: string;
  lengthSeconds?: number;
  isLive: boolean;
  tracks: BridgeTrack[];
  defaultTrackIndex?: number;
}

export interface BridgePlayerResponseMissing {
  type: 'player-response-missing';
  videoId: string | null;
  reason: 'no-player' | 'video-mismatch' | 'no-response';
}

export interface BridgeTimedtext {
  type: 'timedtext';
  /** 被观察到的 timedtext 请求 URL（可能含签名参数）；ISOLATED 侧只提取 v/lang/kind/tlang 后立即丢弃。 */
  url: string;
  status: number;
  body: string;
  via: 'fetch' | 'xhr' | 'bridge-fetch' | 'replay';
}

export interface BridgeCommandResult {
  type: 'command-result';
  commandId: string;
  ok: boolean;
  code?: string;
  /** 本次是否由桥切换了播放器字幕轨道（即打开了原生字幕）。 */
  changedCaptions?: boolean;
  /** 是否执行了同源兜底请求。 */
  fetched?: boolean;
}

export type BridgeToIsolated = (
  BridgePlayerResponse | BridgePlayerResponseMissing | BridgeTimedtext | BridgeCommandResult
) & {
  __tongting: typeof BRIDGE_TAG;
  dir: 'to-isolated';
};

export interface BridgeRequestPlayerResponse {
  type: 'request-player-response';
  videoId: string | null;
}

export interface BridgeLoadTrack {
  type: 'load-track';
  commandId: string;
  videoId: string;
  languageCode: string;
  kind: 'asr' | 'standard';
  vssId?: string;
  fetchOnly?: boolean;
}

export interface BridgeReplayBodies {
  type: 'replay-bodies';
  videoId: string;
}

export interface BridgeRestoreCaptions {
  type: 'restore-captions';
  commandId: string;
  videoId: string;
}

export type IsolatedToBridge = (
  BridgeRequestPlayerResponse | BridgeLoadTrack | BridgeRestoreCaptions | BridgeReplayBodies
) & {
  __tongting: typeof BRIDGE_TAG;
  dir: 'to-main';
};

/** 桥在 MAIN world 中对单个 timedtext 正文的上限（字符）。与解析层上限一致。 */
export const BRIDGE_MAX_BODY_CHARS = 8 * 1024 * 1024;
/** MAIN world 缓存最近成功捕获的正文：最多 2 个视频，合计字符数上限。 */
export const BRIDGE_CACHE_MAX_VIDEOS = 2;
export const BRIDGE_CACHE_MAX_CHARS = 8 * 1024 * 1024;
/** 桥在切换播放器轨道后等待播放器自行请求的时间，超时再尝试同源兜底请求。 */
export const BRIDGE_PLAYER_CAPTURE_WAIT_MS = 4_000;

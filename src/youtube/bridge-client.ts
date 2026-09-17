/**
 * ISOLATED world 侧的桥客户端：接收 MAIN world 消息并做严格校验，发送固定命令。
 *
 * MAIN world 数据一律不可信：检查 source/origin/标签只是过滤，真正的约束是 zod 校验（类型、长度、数量）
 * 以及调用方对视频身份的核对。timedtext 的 URL 只在这里解析出 v/lang/kind/tlang，URL 本身不外传、不记录。
 */
import { z } from 'zod';
import type { CaptionTrackInfo } from '../domain/session';
import { MAX_CAPTION_BODY_CHARS } from '../captions/normalize';
import { BRIDGE_TAG, type DistributiveOmit, type IsolatedToBridge } from './bridge/protocol';
import { VIDEO_ID_RE } from './video-id';

const VideoId = z.string().regex(VIDEO_ID_RE);
const LanguageCode = z
  .string()
  .regex(/^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8}){0,3}$/)
  .max(20);

const Envelope = { __tongting: z.literal(BRIDGE_TAG), dir: z.literal('to-isolated') };

const BridgeTrackSchema = z.object({
  languageCode: LanguageCode,
  kind: z.string().max(20).nullable(),
  name: z.string().max(200),
  vssId: z.string().max(100),
});

/** 可选字段非法时只丢弃该字段；单条非法轨道只丢弃该轨道（整体结构仍需合法）。 */
export const BridgePlayerResponseSchema = z.object({
  ...Envelope,
  type: z.literal('player-response'),
  videoId: VideoId,
  title: z.string().max(300).optional().catch(undefined),
  author: z.string().max(200).optional().catch(undefined),
  lengthSeconds: z.number().int().min(0).max(3_600_000).optional().catch(undefined),
  isLive: z.boolean(),
  tracks: z
    .array(z.unknown())
    .max(100)
    .transform((list) =>
      list.flatMap((t) => {
        const r = BridgeTrackSchema.safeParse(t);
        return r.success ? [r.data] : [];
      }),
    ),
  defaultTrackIndex: z.number().int().min(0).max(99).optional().catch(undefined),
});

export const BridgePlayerResponseMissingSchema = z.object({
  ...Envelope,
  type: z.literal('player-response-missing'),
  videoId: VideoId.nullable(),
  reason: z.enum(['no-player', 'video-mismatch', 'no-response']),
});

export const BridgeTimedtextSchema = z.object({
  ...Envelope,
  type: z.literal('timedtext'),
  url: z.string().min(1).max(8_000),
  status: z.number().int().min(100).max(599),
  body: z.string().min(1).max(MAX_CAPTION_BODY_CHARS),
  via: z.enum(['fetch', 'xhr', 'bridge-fetch', 'replay']),
});

export const BridgeCommandResultSchema = z.object({
  ...Envelope,
  type: z.literal('command-result'),
  commandId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  ok: z.boolean(),
  code: z.string().max(40).optional(),
  changedCaptions: z.boolean().optional(),
  fetched: z.boolean().optional(),
});

export type BridgePlayerResponseMsg = z.infer<typeof BridgePlayerResponseSchema>;
export type BridgeTimedtextMsg = z.infer<typeof BridgeTimedtextSchema>;
export type BridgeCommandResultMsg = z.infer<typeof BridgeCommandResultSchema>;
export type BridgeMissingMsg = z.infer<typeof BridgePlayerResponseMissingSchema>;

/** 从 timedtext URL 中提取的非敏感字段。 */
export interface TimedtextRequestInfo {
  videoId: string | null;
  lang: string | null;
  kind: string | null;
  tlang: string | null;
  name: string | null;
}

/** 只接受同源 /api/timedtext；返回值不含 URL 本身。 */
export function inspectTimedtextUrl(
  url: string,
  expectedOrigin: string,
): TimedtextRequestInfo | null {
  let u: URL;
  try {
    u = new URL(url, expectedOrigin);
  } catch {
    return null;
  }
  if (u.origin !== expectedOrigin || u.pathname !== '/api/timedtext') return null;
  const v = u.searchParams.get('v');
  return {
    videoId: v && VIDEO_ID_RE.test(v) ? v : null,
    lang: u.searchParams.get('lang'),
    kind: u.searchParams.get('kind'),
    tlang: u.searchParams.get('tlang'),
    name: u.searchParams.get('name'),
  };
}

export interface PlayerMetadata {
  videoId: string;
  title?: string;
  channel?: string;
  durationMs?: number;
  isLive: boolean;
  tracks: CaptionTrackInfo[];
  /** trackKey → 桥命令所需字段（不含 URL）。 */
  bridgeTracks: Map<string, { languageCode: string; kind: 'asr' | 'standard'; vssId: string }>;
}

const VSS_ID_RE = /^[a-z]?\.[A-Za-z0-9_.-]{1,60}$/;

/** 把桥回传的播放器响应转为 CaptionTrackInfo（trackKey 不含 URL，冲突时加序号）。 */
export function toPlayerMetadata(msg: BridgePlayerResponseMsg): PlayerMetadata {
  const tracks: CaptionTrackInfo[] = [];
  const bridgeTracks: PlayerMetadata['bridgeTracks'] = new Map();
  msg.tracks.forEach((t, i) => {
    const asr = t.kind === 'asr';
    const baseKey = VSS_ID_RE.test(t.vssId) ? t.vssId : `${asr ? 'a' : ''}.${t.languageCode}`;
    let key = baseKey;
    for (let n = 2; bridgeTracks.has(key); n++) key = `${baseKey}#${n}`;
    bridgeTracks.set(key, {
      languageCode: t.languageCode,
      kind: asr ? 'asr' : 'standard',
      vssId: t.vssId,
    });
    const info: CaptionTrackInfo = {
      trackKey: key,
      languageCode: t.languageCode,
      label: t.name || t.languageCode,
      kind: asr ? 'asr' : t.kind === null ? 'manual' : 'unknown',
    };
    if (msg.defaultTrackIndex !== undefined && msg.defaultTrackIndex < msg.tracks.length) {
      info.isDefault = msg.defaultTrackIndex === i;
    }
    tracks.push(info);
  });
  return {
    videoId: msg.videoId,
    title: msg.title,
    channel: msg.author,
    durationMs: msg.lengthSeconds !== undefined ? msg.lengthSeconds * 1000 : undefined,
    isLive: msg.isLive,
    tracks,
    bridgeTracks,
  };
}

export interface BridgeClientHandlers {
  onPlayerResponse(msg: BridgePlayerResponseMsg): void;
  onPlayerResponseMissing?(msg: BridgeMissingMsg): void;
  onTimedtext(msg: BridgeTimedtextMsg): void;
  onCommandResult(msg: BridgeCommandResultMsg): void;
}

export interface BridgeClient {
  requestPlayerResponse(videoId: string | null): void;
  /** 请求 MAIN world 重放其缓存的该视频 timedtext 正文（覆盖内容脚本就绪前捕获的正文）。 */
  requestReplay(videoId: string): void;
  loadTrack(cmd: {
    commandId: string;
    videoId: string;
    languageCode: string;
    kind: 'asr' | 'standard';
    vssId?: string;
    /** 跳过播放器，直接做 fmt=json3 同源兜底请求（捕获到的正文无法解析时）。 */
    fetchOnly?: boolean;
  }): void;
  restoreCaptions(cmd: { commandId: string; videoId: string }): void;
  /** 被丢弃的非法桥消息数（不含内容）。 */
  readonly rejectedCount: number;
  dispose(): void;
}

export function createBridgeClient(win: Window, handlers: BridgeClientHandlers): BridgeClient {
  const ac = new AbortController();
  let rejected = 0;

  win.addEventListener(
    'message',
    (ev: MessageEvent) => {
      if (ev.source !== win || ev.origin !== win.location.origin) return;
      const d: unknown = ev.data;
      if (typeof d !== 'object' || d === null) return;
      const rec = d as Record<string, unknown>;
      if (rec.__tongting !== BRIDGE_TAG || rec.dir !== 'to-isolated') return;
      try {
        switch (rec.type) {
          case 'player-response': {
            const r = BridgePlayerResponseSchema.safeParse(d);
            if (r.success) handlers.onPlayerResponse(r.data);
            else rejected++;
            break;
          }
          case 'player-response-missing': {
            const r = BridgePlayerResponseMissingSchema.safeParse(d);
            if (r.success) handlers.onPlayerResponseMissing?.(r.data);
            else rejected++;
            break;
          }
          case 'timedtext': {
            const r = BridgeTimedtextSchema.safeParse(d);
            if (r.success) handlers.onTimedtext(r.data);
            else rejected++;
            break;
          }
          case 'command-result': {
            const r = BridgeCommandResultSchema.safeParse(d);
            if (r.success) handlers.onCommandResult(r.data);
            else rejected++;
            break;
          }
          default:
            rejected++;
        }
      } catch {
        // 处理器异常不能影响后续消息。
      }
    },
    { signal: ac.signal },
  );

  const post = (msg: DistributiveOmit<IsolatedToBridge, '__tongting' | 'dir'>) => {
    if (ac.signal.aborted) return;
    try {
      win.postMessage({ ...msg, __tongting: BRIDGE_TAG, dir: 'to-main' }, win.location.origin);
    } catch {
      /* 页面卸载中 */
    }
  };

  return {
    get rejectedCount() {
      return rejected;
    },
    requestReplay(videoId) {
      post({ type: 'replay-bodies', videoId });
    },
    requestPlayerResponse(videoId) {
      post({ type: 'request-player-response', videoId });
    },
    loadTrack(cmd) {
      post({ type: 'load-track', ...cmd });
    },
    restoreCaptions(cmd) {
      post({ type: 'restore-captions', ...cmd });
    },
    dispose() {
      ac.abort();
    },
  };
}

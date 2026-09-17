/**
 * 内容脚本（YouTube 页面，ISOLATED world） ↔ service worker 协议。
 *
 * - 通过长连接端口 PORT_CONTENT 传输；发送方身份由 port.sender（tab、documentId、url、frameId）决定，
 *   payload 自报的 tabId 一律不可信，因此消息中不包含 tabId。
 * - 内容脚本只能上报自己页面的播放器/字幕数据，不能请求模型、读取凭证或代理任意网络请求。
 * - 消息中不包含 API Key。
 */
import { z } from 'zod';
import { CaptionSettingsSchema } from '../domain/settings';
import { AppErrorInfoSchema } from '../domain/errors';
import { CueSchema, RawCaptionCueSchema } from '../domain/cue';
import {
  CaptionTrackInfoSchema,
  PlayerStateSchema,
  SessionPhaseSchema,
  SourceModeSchema,
  VideoIdSchema,
} from '../domain/session';

export const CONTENT_PROTOCOL_VERSION = 1;
export const MAX_TRACK_CUES = 20_000;

const RequestId = z.string().min(1).max(64);

// ---------------------------------------------------------------------------
// 内容脚本 → service worker
// ---------------------------------------------------------------------------

export const ContentHelloSchema = z.object({
  type: z.literal('hello'),
  protocolVersion: z.literal(CONTENT_PROTOCOL_VERSION),
  /** 内容脚本实例 ID；页面重载或脚本重新注入后变化。 */
  pageInstanceId: z.string().min(8).max(64),
  url: z.string().max(2_000),
});

export const ContentVideoSchema = z.object({
  type: z.literal('page/video'),
  /** SPA 导航序号，内容脚本内单调递增；同一 videoId 重新进入也会递增。 */
  navigationId: z.number().int().nonnegative(),
  videoId: VideoIdSchema.nullable(),
  title: z.string().max(300).optional(),
  channel: z.string().max(200).optional(),
  durationMs: z.number().nonnegative().optional(),
  isLive: z.boolean(),
  isShorts: z.boolean(),
});

export const ContentPlayerStateSchema = z.object({
  type: z.literal('player/state'),
  navigationId: z.number().int().nonnegative(),
  state: PlayerStateSchema,
  /** 触发原因，便于 worker 识别断点。 */
  reason: z.enum([
    'tick',
    'play',
    'pause',
    'seeking',
    'seeked',
    'ratechange',
    'waiting',
    'playing',
    'ended',
    'ad-start',
    'ad-end',
    'volumechange',
    'video-replaced',
    'fullscreen',
  ]),
});

export const ContentCaptionTracksSchema = z.object({
  type: z.literal('captions/tracks'),
  navigationId: z.number().int().nonnegative(),
  videoId: VideoIdSchema,
  availability: z.enum(['unknown', 'available', 'unavailable']),
  tracks: z.array(CaptionTrackInfoSchema).max(100),
});

export const ContentCaptionTrackDataSchema = z.object({
  type: z.literal('captions/track-data'),
  navigationId: z.number().int().nonnegative(),
  videoId: VideoIdSchema,
  track: CaptionTrackInfoSchema,
  /** 实际拿到的原始格式，仅用于诊断。 */
  format: z.enum(['json3', 'srv3', 'vtt', 'unknown']),
  /** 解析后按 startMs 升序的原始片段。 */
  cues: z.array(RawCaptionCueSchema).max(MAX_TRACK_CUES),
  /** 是否为完整轨道（而非部分窗口）。 */
  complete: z.boolean(),
  /** 解析时被拒绝或截断的片段数（不含原文）。 */
  rejectedCount: z.number().int().nonnegative(),
});

/** 仅能读取当前显示字幕时的增量来源。 */
export const ContentVisibleCaptionSchema = z.object({
  type: z.literal('captions/visible'),
  navigationId: z.number().int().nonnegative(),
  videoId: VideoIdSchema,
  text: z.string().max(2_000),
  mediaTimeMs: z.number().min(0),
  sampledAtEpochMs: z.number(),
});

export const ContentCaptionErrorSchema = z.object({
  type: z.literal('captions/error'),
  navigationId: z.number().int().nonnegative(),
  videoId: VideoIdSchema.nullable(),
  error: AppErrorInfoSchema,
});

export const ContentReplySchema = z.union([
  z.object({
    type: z.literal('reply'),
    requestId: RequestId,
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('reply'),
    requestId: RequestId,
    ok: z.literal(false),
    error: AppErrorInfoSchema,
  }),
]);

export const ContentToBackgroundSchema = z.union([
  ContentHelloSchema,
  ContentVideoSchema,
  ContentPlayerStateSchema,
  ContentCaptionTracksSchema,
  ContentCaptionTrackDataSchema,
  ContentVisibleCaptionSchema,
  ContentCaptionErrorSchema,
  ContentReplySchema,
]);
export type ContentToBackground = z.infer<typeof ContentToBackgroundSchema>;

// ---------------------------------------------------------------------------
// service worker → 内容脚本
// ---------------------------------------------------------------------------

/** 覆盖层显示所需的最少字幕字段。 */
export const DisplayCueSchema = CueSchema.pick({
  id: true,
  revision: true,
  startMs: true,
  endMs: true,
  sourceText: true,
  translatedText: true,
  translationState: true,
  stability: true,
});
export type DisplayCue = z.infer<typeof DisplayCueSchema>;

export const ContentRequestSchema = z.discriminatedUnion('kind', [
  /** 让页面加载完整字幕轨道（可能需要切换播放器字幕轨道以获得有效请求）。 */
  z.object({
    kind: z.literal('captions/load-track'),
    videoId: VideoIdSchema,
    trackKey: z.string().max(200).optional(),
    preferredLanguage: z.string().max(20).optional(),
  }),
  z.object({
    kind: z.literal('captions/observe-visible'),
    videoId: VideoIdSchema,
    enable: z.boolean(),
  }),
  z.object({ kind: z.literal('player/seek'), videoId: VideoIdSchema, timeMs: z.number().min(0) }),
  /**
   * 字幕模式下的原声 ducking：active=true 时按 level 降低 video 音量；
   * 用户在此期间调整音量视为新意图，结束时不得恢复过时快照。
   */
  z.object({
    kind: z.literal('player/duck'),
    videoId: VideoIdSchema,
    active: z.boolean(),
    level: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal('player/query') }),
]);
export type ContentRequest = z.infer<typeof ContentRequestSchema>;

export const BackgroundToContentSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('welcome'),
    protocolVersion: z.literal(CONTENT_PROTOCOL_VERSION),
    workerInstanceId: z.string().max(64),
  }),
  z.object({
    type: z.literal('display/settings'),
    captions: CaptionSettingsSchema,
    targetLanguage: z.string().max(20),
  }),
  z.object({
    type: z.literal('session/state'),
    session: z
      .object({
        sessionId: z.string().max(64),
        epoch: z.number().int().nonnegative(),
        videoId: VideoIdSchema,
        phase: SessionPhaseSchema,
        outputMode: z.enum(['subtitle', 'subtitle-voice']),
        /** 字幕来源；语音识别来源的字幕总是晚于其媒体时间到达，覆盖层据此放宽显示窗口。 */
        sourceMode: SourceModeSchema.optional(),
        /** 覆盖层显示的状态提示，例如「翻译中」「识别服务未配置」。 */
        statusText: z.string().max(120).optional(),
      })
      .nullable(),
  }),
  z.object({
    type: z.literal('session/cues'),
    sessionId: z.string().max(64),
    epoch: z.number().int().nonnegative(),
    cueVersion: z.number().int().nonnegative(),
    /** true 表示替换全部；false 表示按 id 更新。 */
    full: z.boolean(),
    cues: z.array(DisplayCueSchema).max(MAX_TRACK_CUES),
    removedIds: z.array(z.string().max(120)).max(MAX_TRACK_CUES).optional(),
  }),
  z.object({
    type: z.literal('request'),
    requestId: RequestId,
    request: ContentRequestSchema,
    /** 发起请求时 worker 认为的导航序号；与内容脚本当前导航不一致时应回复 stale-video 并不执行。 */
    navigationId: z.number().int().nonnegative().optional(),
  }),
]);
export type BackgroundToContent = z.infer<typeof BackgroundToContentSchema>;

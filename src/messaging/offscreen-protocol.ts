/**
 * Offscreen 文档 ↔ service worker 协议（PORT_OFFSCREEN）。
 *
 * - offscreen 只负责媒体：标签页音频捕获、原声回放增益、PCM 分段与识别请求、云端合成音频播放。
 * - 所有资源都有 owner（sessionId + epoch + tabId）与 leaseId；worker 定期续租，
 *   租约过期或 worker 重启后握手不匹配时，offscreen 必须自行停止捕获与播放。
 * - worker 会把识别/合成所需的凭证随请求下发；offscreen 不持久化、不回传、不记录凭证。
 */
import { z } from 'zod';
import { AppErrorInfoSchema } from '../domain/errors';
import { ResourceStateSchema } from '../domain/session';
import { LocaleSchema } from '../domain/settings';

export const OFFSCREEN_PROTOCOL_VERSION = 1;

const RequestId = z.string().min(1).max(64);
const LeaseId = z.string().min(8).max(64);

export const MediaOwnerSchema = z.object({
  sessionId: z.string().min(8).max(64),
  tabId: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
});
export type MediaOwner = z.infer<typeof MediaOwnerSchema>;

/**
 * 媒体时间锚点：在跨文档 epoch 时钟（Date.now() 基准，见 domain/clock.ts）上的某时刻，
 * 视频媒体时间为 mediaTimeMs，播放速率为 playbackRate。
 * discontinuityId 在暂停、跳转、倍速、广告、换视频时递增，断点前后分开映射。
 */
export const MediaAnchorSchema = z.object({
  epochMs: z.number(),
  mediaTimeMs: z.number().min(0),
  playbackRate: z.number().min(0.0625).max(16),
  paused: z.boolean(),
  seeking: z.boolean(),
  buffering: z.boolean(),
  ad: z.boolean(),
  discontinuityId: z.number().int().nonnegative(),
});
export type MediaAnchor = z.infer<typeof MediaAnchorSchema>;

export const AsrRouteSchema = z.discriminatedUnion('backend', [
  z.object({
    backend: z.literal('local'),
    /** 仅允许 http://127.0.0.1:<port>（本地服务只绑定 IPv4 回环，不接受 localhost）。 */
    baseUrl: z.string().max(200),
    token: z.string().min(1).max(500),
  }),
  z.object({
    backend: z.literal('sub2api'),
    baseUrl: z.string().max(500),
    apiKey: z.string().min(1).max(500),
    model: z.string().min(1).max(200),
  }),
]);
export type AsrRoute = z.infer<typeof AsrRouteSchema>;

export const OffscreenStatusSchema = z.object({
  offscreenInstanceId: z.string().max(64),
  lease: z
    .object({
      leaseId: LeaseId,
      owner: MediaOwnerSchema,
      expiresAtEpochMs: z.number(),
    })
    .nullable(),
  resources: ResourceStateSchema,
  audioContextState: z.enum(['none', 'running', 'suspended', 'closed']),
  ttsPlaying: z.boolean(),
});
export type OffscreenStatus = z.infer<typeof OffscreenStatusSchema>;

export const OffscreenRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('capture/start'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    leaseTtlMs: z.number().int().min(5_000).max(120_000),
    /** chrome.tabCapture.getMediaStreamId 返回值，需立即消费。 */
    streamId: z.string().min(1).max(200),
    asr: AsrRouteSchema,
    /** 识别语言提示；'auto' 表示由识别器检测。 */
    language: z.string().max(20),
    segmentMs: z.number().int().min(2_000).max(15_000),
    originalVolume: z.number().min(0).max(1),
    anchor: MediaAnchorSchema,
  }),
  z.object({ kind: z.literal('capture/stop'), leaseId: LeaseId, reason: z.string().max(80) }),
  /** 跳转、换视频、改语言等：丢弃旧缓冲与在途识别结果，之后结果使用新 epoch。 */
  z.object({
    kind: z.literal('capture/set-epoch'),
    leaseId: LeaseId,
    epoch: z.number().int().nonnegative(),
  }),
  /** 视频自然结束：收尾已缓冲的音频并等待识别排空（有上限），返回 { drained }。 */
  z.object({
    kind: z.literal('capture/drain'),
    leaseId: LeaseId,
    timeoutMs: z.number().int().min(0).max(60_000),
  }),
  /** 暂停翻译但保留原声播放：停止送识别，保留原声路径。 */
  z.object({ kind: z.literal('capture/set-recognition'), leaseId: LeaseId, enabled: z.boolean() }),
  z.object({
    kind: z.literal('audio/original-gain'),
    leaseId: LeaseId,
    /** 最终应用到原声的增益（已包含 ducking 计算）。 */
    gain: z.number().min(0).max(1),
    rampMs: z.number().int().min(0).max(2_000),
  }),
  z.object({ kind: z.literal('timeline/anchor'), leaseId: LeaseId, anchor: MediaAnchorSchema }),
  z.object({
    kind: z.literal('lease/renew'),
    leaseId: LeaseId,
    ttlMs: z.number().int().min(5_000).max(120_000),
  }),
  z.object({ kind: z.literal('status') }),
  /** 云端语音合成：offscreen 请求并播放；worker 负责排队与同步策略。 */
  z.object({
    kind: z.literal('tts/play'),
    utteranceId: z.string().min(1).max(120),
    owner: MediaOwnerSchema,
    baseUrl: z.string().max(500),
    apiKey: z.string().min(1).max(500),
    model: z.string().min(1).max(200),
    voice: z.string().max(100),
    text: z.string().min(1).max(4_000),
    speed: z.number().min(0.25).max(4),
    volume: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal('tts/stop'), utteranceId: z.string().max(120).optional() }),
]);
export type OffscreenRequest = z.infer<typeof OffscreenRequestSchema>;

export const OffscreenEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('capture/started'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    sampleRate: z.number(),
  }),
  z.object({
    kind: z.literal('capture/ended'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    reason: z.enum(['stopped', 'track-ended', 'lease-expired', 'error', 'superseded']),
    error: AppErrorInfoSchema.optional(),
  }),
  z.object({
    kind: z.literal('asr/result'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    segmentId: z.string().max(120),
    /** 映射后的媒体时间。 */
    startMs: z.number().min(0),
    endMs: z.number().min(0),
    endEstimated: z.boolean(),
    text: z.string().max(4_000),
    language: z.string().max(20).optional(),
    final: z.boolean(),
    revision: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('asr/status'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    state: z.enum(['idle', 'loading', 'running', 'backlogged', 'error', 'unavailable']),
    backlogMs: z.number().nonnegative(),
    lastLatencyMs: z.number().nonnegative().optional(),
    /** 处理耗时 / 音频时长；> 1 表示慢于实时。 */
    realtimeFactor: z.number().nonnegative().optional(),
    droppedMs: z.number().nonnegative().optional(),
    /** 识别失败（重试耗尽、格式错误等）而丢弃的音频时长，与积压丢弃 droppedMs 分开。 */
    droppedFailedMs: z.number().nonnegative().optional(),
    /** 有信号但持续判为无语音、未送识别的累计时长（音量过低或被静音的诊断）。 */
    quietInputMs: z.number().nonnegative().optional(),
    /** 该捕获中 readyState 为 live 的音轨数（worker 会话快照据此显示实际占用）。 */
    activeTracks: z.number().int().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('asr/error'),
    leaseId: LeaseId,
    owner: MediaOwnerSchema,
    error: AppErrorInfoSchema,
  }),
  z.object({
    kind: z.literal('tts/event'),
    utteranceId: z.string().max(120),
    event: z.enum(['start', 'end', 'error', 'interrupted']),
    error: AppErrorInfoSchema.optional(),
  }),
  z.object({ kind: z.literal('status'), status: OffscreenStatusSchema }),
]);
export type OffscreenEvent = z.infer<typeof OffscreenEventSchema>;

export const OffscreenToBackgroundSchema = z.union([
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.literal(OFFSCREEN_PROTOCOL_VERSION),
    status: OffscreenStatusSchema,
  }),
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
  z.object({ type: z.literal('event'), event: OffscreenEventSchema }),
]);
export type OffscreenToBackground = z.infer<typeof OffscreenToBackgroundSchema>;

export const BackgroundToOffscreenSchema = z.discriminatedUnion('type', [
  /** locale：offscreen 生成的错误提示使用的界面语言，随握手与每个请求下发，保持与 worker 一致。 */
  z.object({
    type: z.literal('welcome'),
    workerInstanceId: z.string().max(64),
    locale: LocaleSchema.optional(),
  }),
  z.object({
    type: z.literal('request'),
    requestId: RequestId,
    request: OffscreenRequestSchema,
    locale: LocaleSchema.optional(),
  }),
]);
export type BackgroundToOffscreen = z.infer<typeof BackgroundToOffscreenSchema>;

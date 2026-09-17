import { z } from 'zod';
import { AppErrorInfoSchema } from './errors';
import { SubtitleCoverageSchema } from './cue';

export const VideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,20}$/);

export const SessionIdentitySchema = z.object({
  /** 每次新会话生成；同一 videoId 的 A→B→A 也是不同会话。 */
  sessionId: z.string().min(8).max(64),
  tabId: z.number().int().nonnegative(),
  /** 页面加载身份：chrome documentId，不可用时为内容脚本生成的 pageInstanceId。 */
  documentId: z.string().min(1).max(100),
  videoId: VideoIdSchema,
  /** 跳转、改语言、换模型等使旧工作失效时递增。 */
  epoch: z.number().int().nonnegative(),
  configRevision: z.number().int().nonnegative(),
});
export type SessionIdentity = z.infer<typeof SessionIdentitySchema>;

export type JobIdentity = SessionIdentity & { requestId: string; operationId: string };

/** 结果是否仍属于当前会话版本。 */
export function isCurrentIdentity(
  current: Pick<SessionIdentity, 'sessionId' | 'epoch' | 'configRevision'> | undefined,
  candidate: Pick<SessionIdentity, 'sessionId' | 'epoch' | 'configRevision'>,
): boolean {
  return (
    !!current &&
    current.sessionId === candidate.sessionId &&
    current.epoch === candidate.epoch &&
    current.configRevision === candidate.configRevision
  );
}

export const SessionPhaseSchema = z.enum([
  'idle',
  'configuring',
  'starting',
  'running',
  'pausing',
  'paused',
  'stopping',
  'error',
]);
export type SessionPhase = z.infer<typeof SessionPhaseSchema>;

/** 用户最后一次表达的意图，不能被过期请求覆盖。 */
export const DesiredStateSchema = z.enum(['running', 'paused', 'stopped']);
export type DesiredState = z.infer<typeof DesiredStateSchema>;

/** 实际播放器状态，独立于翻译状态。时间为媒体时间。 */
export const PlayerStateSchema = z.object({
  videoId: VideoIdSchema.nullable(),
  title: z.string().max(300).optional(),
  channel: z.string().max(200).optional(),
  /** 上限放宽到 31 天：长时间直播的时间轴可能超过 24 小时（直播本身目前不支持翻译，但状态上报不应被拒）。 */
  currentTimeMs: z
    .number()
    .min(0)
    .max(31 * 24 * 3600 * 1000),
  durationMs: z
    .number()
    .min(0)
    .max(1000 * 3600 * 1000)
    .optional(),
  paused: z.boolean(),
  buffering: z.boolean(),
  seeking: z.boolean(),
  ended: z.boolean(),
  playbackRate: z.number().min(0.0625).max(16),
  /** 当前是否在播放广告。 */
  ad: z.boolean(),
  volume: z.number().min(0).max(1),
  muted: z.boolean(),
  isLive: z.boolean(),
  isShorts: z.boolean(),
  fullscreen: z.boolean(),
  /** 采样时刻：跨文档 epoch 时钟毫秒（Date.now() 基准，见 domain/clock.ts）。 */
  sampledAtEpochMs: z.number(),
});
export type PlayerState = z.infer<typeof PlayerStateSchema>;

export const SourceModeSchema = z.enum(['none', 'full-track', 'incremental-captions', 'asr']);
export type SourceMode = z.infer<typeof SourceModeSchema>;

export const CaptionTrackInfoSchema = z.object({
  /** 适配器内部 key，不含 URL。 */
  trackKey: z.string().max(200),
  languageCode: z.string().max(20),
  label: z.string().max(200),
  kind: z.enum(['manual', 'asr', 'translated', 'unknown']),
  isDefault: z.boolean().optional(),
});
export type CaptionTrackInfo = z.infer<typeof CaptionTrackInfoSchema>;

export const ResourceStateSchema = z.object({
  capture: z.enum(['none', 'requesting', 'active', 'stopping', 'ended', 'error']),
  asr: z.enum(['idle', 'loading', 'running', 'backlogged', 'error', 'unavailable']),
  tts: z.enum(['idle', 'speaking', 'paused', 'error', 'unavailable']),
  activeTracks: z.number().int().nonnegative(),
  pendingRequests: z.number().int().nonnegative(),
  asrBacklogMs: z.number().nonnegative().optional(),
  dubBacklog: z.number().int().nonnegative().optional(),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export const TranslationStatsSchema = z.object({
  total: z.number().int().nonnegative(),
  done: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  /** 限流冷却截止时间（epoch ms）。 */
  rateLimitedUntil: z.number().optional(),
  /** 最近一次实际请求往返延迟（ms），无数据为 undefined。 */
  lastLatencyMs: z.number().nonnegative().optional(),
  model: z.string().max(200).optional(),
  /** 调度器因不可恢复错误（认证、权限、额度、系统性格式失败等）停止发送新请求时的原因。 */
  blockedError: AppErrorInfoSchema.optional(),
  /** 翻译缓存写入失败次数（不影响翻译，但缓存可能未生效）。 */
  cacheWriteFailures: z.number().int().nonnegative().optional(),
});
export type TranslationStats = z.infer<typeof TranslationStatsSchema>;

export const SessionSnapshotSchema = z.object({
  identity: SessionIdentitySchema,
  phase: SessionPhaseSchema,
  desiredState: DesiredStateSchema,
  /** 本会话是否为真实模式（演示模式不经过 service worker）。 */
  outputMode: z.enum(['subtitle', 'subtitle-voice']),
  targetLanguage: z.string(),
  sourceMode: SourceModeSchema,
  sourceTrack: CaptionTrackInfoSchema.optional(),
  detectedSourceLanguage: z.string().max(20).optional(),
  player: PlayerStateSchema.optional(),
  coverage: SubtitleCoverageSchema.optional(),
  translation: TranslationStatsSchema,
  resources: ResourceStateSchema,
  /** 可执行的下一步提示，例如「请配置语音识别服务」。 */
  notice: z
    .object({
      code: z.string().max(80),
      message: z.string().max(300),
      level: z.enum(['info', 'warning', 'error']),
    })
    .optional(),
  error: AppErrorInfoSchema.optional(),
  cueVersion: z.number().int().nonnegative(),
  /**
   * worker 写入 IndexedDB 字幕记录所用的 recordId（收藏按记录保存）。尚未确定字幕来源时缺失。
   * UI 必须使用此值，不得自行拼接。
   */
  recordId: z.string().max(300).optional(),
  /** 全片补译是否开启（仅完整字幕轨道来源可用，用于导出完整译文）。 */
  backfill: z.boolean().optional(),
  startedAt: z.number(),
  updatedAt: z.number(),
});
export type SessionSnapshot = z.infer<typeof SessionSnapshotSchema>;

/** 已登记的 YouTube 页面（有内容脚本连接），可能没有会话。 */
export const PageInfoSchema = z.object({
  tabId: z.number().int().nonnegative(),
  documentId: z.string().max(100),
  url: z.string().max(2_000),
  videoId: VideoIdSchema.nullable(),
  title: z.string().max(300).optional(),
  player: PlayerStateSchema.optional(),
  tracks: z.array(CaptionTrackInfoSchema).max(100),
  captionsAvailability: z.enum(['unknown', 'available', 'unavailable']),
  connectedAt: z.number(),
});
export type PageInfo = z.infer<typeof PageInfoSchema>;

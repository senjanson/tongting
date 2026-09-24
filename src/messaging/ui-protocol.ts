/**
 * 扩展页面（popup / sidepanel / options / workspace） ↔ service worker 协议。
 *
 * - 通过 PORT_UI 长连接；worker 校验 port.sender.url 属于本扩展的受信任页面。
 * - UI 不直接持有翻译客户端或 Key；所有业务状态来自 worker 快照。
 * - 快照只含非敏感设置与凭证「是否已配置 / 掩码」，不含明文 Key。
 * - UI 必须只接受 snapshotVersion 大于当前值的快照；重连后先收到完整快照。
 */
import { z } from 'zod';
import { AppErrorInfoSchema } from '../domain/errors';
import {
  CAPABILITY_MESSAGE_MAX,
  CAPABILITY_REASON_CODE_MAX,
  CapabilityKeySchema,
  CapabilityStatusSchema,
  ProviderCapabilitySchema,
} from '../domain/capability';
import { CueSchema } from '../domain/cue';
import { PageInfoSchema, SessionSnapshotSchema } from '../domain/session';
import { SettingsPatchSchema, SettingsSchema } from '../domain/settings';
import { SearchInputSchema, type SearchRecord } from '../domain/search';

export const UI_PROTOCOL_VERSION = 1;

const RequestId = z.string().min(1).max(64);
const TabId = z.number().int().nonnegative();

export const UiSurfaceSchema = z.enum(['popup', 'sidepanel', 'options', 'workspace']);
export type UiSurface = z.infer<typeof UiSurfaceSchema>;

export const TtsVoiceInfoSchema = z.object({
  voiceName: z.string().max(200),
  lang: z.string().max(40).optional(),
  remote: z.boolean().optional(),
  extensionId: z.string().max(64).optional(),
});
export type TtsVoiceInfo = z.infer<typeof TtsVoiceInfoSchema>;

export const ConnectionCheckItemSchema = z.object({
  key: CapabilityKeySchema,
  status: CapabilityStatusSchema,
  message: z.string().max(CAPABILITY_MESSAGE_MAX),
  latencyMs: z.number().nonnegative().optional(),
  reasonCode: z.string().max(CAPABILITY_REASON_CODE_MAX).optional(),
});
export type ConnectionCheckItem = z.infer<typeof ConnectionCheckItemSchema>;

export const ConnectionReportSchema = z.object({
  checkedAt: z.number(),
  configRevision: z.number().int().nonnegative(),
  /** 检查时的凭证代数；与快照 credential.generation 不同即表示结果已过期。 */
  credentialGeneration: z.number().int().nonnegative(),
  items: z.array(ConnectionCheckItemSchema).max(20),
  detectedProtocol: z.enum(['responses', 'chat']).optional(),
  models: z.array(z.string().max(200)).max(1_000).optional(),
});
export type ConnectionReport = z.infer<typeof ConnectionReportSchema>;

export const UiCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('search/generate'),
    operationId: RequestId,
    query: SearchInputSchema,
  }),
  z.object({ kind: z.literal('search/cancel'), operationId: RequestId }),
  z.object({ kind: z.literal('search/history') }),
  z.object({ kind: z.literal('search/clear-history') }),
  z.object({ kind: z.literal('session/start'), tabId: TabId }),
  /**
   * 以下会话命令可带 sessionId：若与该标签页当前会话不一致，worker 返回 stale-session 错误并附最新快照，
   * 避免针对旧会话（例如导航前）的操作作用到新会话上。
   */
  z.object({
    kind: z.literal('session/pause'),
    tabId: TabId,
    sessionId: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('session/resume'),
    tabId: TabId,
    sessionId: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('session/stop'),
    tabId: TabId,
    sessionId: z.string().max(64).optional(),
  }),
  z.object({
    kind: z.literal('session/retry-failed'),
    tabId: TabId,
    sessionId: z.string().max(64).optional(),
  }),
  /** 全片补译：播放窗口空闲时以并发 1 翻译完整字幕轨道其余部分（会产生额外调用）。 */
  z.object({
    kind: z.literal('session/backfill'),
    tabId: TabId,
    sessionId: z.string().max(64).optional(),
    enabled: z.boolean(),
  }),
  z.object({ kind: z.literal('player/seek'), tabId: TabId, timeMs: z.number().min(0) }),
  z.object({ kind: z.literal('settings/update'), patch: SettingsPatchSchema }),
  z.object({ kind: z.literal('settings/reset') }),
  z.object({
    kind: z.literal('credentials/set'),
    apiKey: z.string().min(1).max(500),
    remember: z.boolean(),
  }),
  z.object({ kind: z.literal('credentials/clear') }),
  /** 本地识别服务配对令牌。 */
  z.object({ kind: z.literal('asr/set-token'), token: z.string().min(1).max(500) }),
  z.object({ kind: z.literal('asr/clear-token') }),
  /** 主机权限由 UI 在用户手势内申请，完成后通知 worker 重新核对。 */
  z.object({ kind: z.literal('permissions/changed') }),
  z.object({
    kind: z.literal('connection/check'),
    scope: z.enum(['text', 'asr', 'tts', 'all']),
    /** 语音识别/合成检查会产生实际调用（可能计费），需要用户显式勾选。 */
    allowBilledAudioProbe: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('models/discover') }),
  z.object({ kind: z.literal('tts/voices') }),
  z.object({
    kind: z.literal('tts/preview'),
    text: z.string().max(200).optional(),
    voiceName: z.string().max(200).optional(),
    rate: z.number().min(0.5).max(2).optional(),
  }),
  z.object({ kind: z.literal('tts/stop-preview') }),
  z.object({ kind: z.literal('cache/clear') }),
]);
export type UiCommand = z.infer<typeof UiCommandSchema>;
export type UiCommandKind = UiCommand['kind'];

export const CredentialStateSchema = z.object({
  configured: z.boolean(),
  /** 凭证代数：每次保存或删除递增（API Key 与本地识别令牌共用），用于判断检查结果是否过期。 */
  generation: z.number().int().nonnegative(),
  storage: z.enum(['none', 'session', 'local']),
  /** 存储副本清理未完成；即使 configured=false 也应保留重试清理入口。 */
  cleanupPending: z.boolean().optional(),
  /** 仅末 4 位，例如「••••abcd」。 */
  masked: z.string().max(20).optional(),
});

export const AppSnapshotSchema = z.object({
  snapshotVersion: z.number().int().nonnegative(),
  workerInstanceId: z.string().max(64),
  settings: SettingsSchema,
  /** 最近一次设置持久化是否成功；失败时 UI 须提示「仅本次生效」。 */
  settingsPersisted: z.boolean(),
  /**
   * 已保存设置无法使用时的状态，UI 须提示当前是默认设置：
   * - recovered：原设置无效（例如来自更新版本或已损坏），已备份并恢复为默认值；成功保存设置后消失。
   * - unreadable：原设置暂时无法读取（或无效且未能备份）；为避免覆盖原设置，修改只在内存中生效，
   *   每次修改前重新读取，读到后在原设置上应用这些修改。
   */
  settingsRecovery: z.enum(['recovered', 'unreadable']).optional(),
  configRevision: z.number().int().nonnegative(),
  credential: CredentialStateSchema,
  asrToken: CredentialStateSchema,
  hostPermission: z.object({ origin: z.string().max(300).optional(), granted: z.boolean() }),
  capabilities: z.partialRecord(CapabilityKeySchema, ProviderCapabilitySchema),
  lastConnectionReport: ConnectionReportSchema.optional(),
  pages: z.array(PageInfoSchema).max(200),
  sessions: z.array(SessionSnapshotSchema).max(50),
  audioOwner: z.object({ tabId: TabId, sessionId: z.string().max(64) }).nullable(),
});
export type AppSnapshot = z.infer<typeof AppSnapshotSchema>;

export const UiToBackgroundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    protocolVersion: z.literal(UI_PROTOCOL_VERSION),
    surface: UiSurfaceSchema,
  }),
  z.object({ type: z.literal('command'), requestId: RequestId, command: UiCommandSchema }),
  /** 订阅某会话的完整字幕与后续增量；sessionId 为 null 表示取消订阅。 */
  z.object({ type: z.literal('cues/subscribe'), sessionId: z.string().max(64).nullable() }),
]);
export type UiToBackground = z.infer<typeof UiToBackgroundSchema>;

export const BackgroundToUiSchema = z.union([
  z.object({ type: z.literal('snapshot'), snapshot: AppSnapshotSchema }),
  z.object({
    type: z.literal('cues'),
    sessionId: z.string().max(64),
    cueVersion: z.number().int().nonnegative(),
    full: z.boolean(),
    cues: z.array(CueSchema).max(20_000),
    removedIds: z.array(z.string().max(120)).max(20_000).optional(),
  }),
  z.object({
    type: z.literal('result'),
    requestId: RequestId,
    ok: z.literal(true),
    data: z.unknown().optional(),
  }),
  z.object({
    type: z.literal('result'),
    requestId: RequestId,
    ok: z.literal(false),
    error: AppErrorInfoSchema,
  }),
]);
export type BackgroundToUi = z.infer<typeof BackgroundToUiSchema>;

/** 各命令成功时的返回数据类型。 */
export interface UiCommandResultMap {
  'search/generate': { record: SearchRecord; persisted: boolean };
  'search/cancel': { cancelled: true };
  'search/history': { records: SearchRecord[] };
  'search/clear-history': { cleared: true };
  'session/start': { accepted: true };
  'session/pause': { accepted: true };
  'session/resume': { accepted: true };
  'session/stop': { accepted: true };
  'session/retry-failed': { retried: number };
  'session/backfill': { enabled: boolean };
  'player/seek': { accepted: true };
  'settings/update': { persisted: boolean };
  'settings/reset': { persisted: boolean };
  'credentials/set': { persisted: boolean; storage: 'session' | 'local' };
  'credentials/clear': { cleared: true };
  'asr/set-token': { persisted: boolean };
  'asr/clear-token': { cleared: true };
  'permissions/changed': { granted: boolean };
  'connection/check': ConnectionReport;
  'models/discover': { models: string[] };
  'tts/voices': { voices: TtsVoiceInfo[] };
  'tts/preview': { started: true };
  'tts/stop-preview': { stopped: true };
  'cache/clear': { cleared: true };
}

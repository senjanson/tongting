import { z } from 'zod';

/** 能力说明与原因码的长度上限（UI 协议中的连接检查项与之一致）。 */
export const CAPABILITY_MESSAGE_MAX = 300;
export const CAPABILITY_REASON_CODE_MAX = 80;

/**
 * 外部能力状态。未经实际调用验证时必须为 unknown，不能因模型名存在而标为 verified。
 */
export const CapabilityStatusSchema = z.enum(['unknown', 'verified', 'unsupported', 'failed']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ProviderCapabilitySchema = z.object({
  status: CapabilityStatusSchema,
  checkedAt: z.string().optional(),
  configRevision: z.number().int().nonnegative(),
  reasonCode: z.string().max(CAPABILITY_REASON_CODE_MAX).optional(),
  /** 面向用户的简短说明。 */
  message: z.string().max(CAPABILITY_MESSAGE_MAX).optional(),
  /** 实测往返耗时（ms）。 */
  latencyMs: z.number().nonnegative().optional(),
});
export type ProviderCapability = z.infer<typeof ProviderCapabilitySchema>;

export const CapabilityKeySchema = z.enum([
  'reachability',
  'auth',
  'modelList',
  'model',
  'translation',
  'streaming',
  'asr',
  'tts',
  'realtimeTranslate',
  'hostPermission',
  'localAsr',
  'systemTts',
]);
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export const CapabilityMatrixSchema = z.partialRecord(
  CapabilityKeySchema,
  ProviderCapabilitySchema,
);
export type CapabilityMatrix = Partial<Record<CapabilityKey, ProviderCapability>>;

export function unknownCapability(configRevision: number): ProviderCapability {
  return { status: 'unknown', configRevision };
}

/**
 * 截断到 schema 的长度上限（zod 的 max 按 UTF-16 长度计），不拆开代理对，超长时以省略号结尾。
 * 服务返回的模型名、设备名或错误文本可能很长；超限的一项会让整份快照校验失败。
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}…`;
}

/** 规范化写入能力矩阵或连接报告的文字与耗时字段：说明截断、原因码截断、非法耗时丢弃。 */
export function clampCapabilityFields<
  T extends { message?: string; reasonCode?: string; latencyMs?: number },
>(value: T): T {
  const out = { ...value };
  if (typeof out.message === 'string')
    Object.assign(out, { message: truncateText(out.message, CAPABILITY_MESSAGE_MAX) });
  if (typeof out.reasonCode === 'string')
    Object.assign(out, { reasonCode: out.reasonCode.slice(0, CAPABILITY_REASON_CODE_MAX) });
  if (out.latencyMs !== undefined && !(Number.isFinite(out.latencyMs) && out.latencyMs >= 0))
    Object.assign(out, { latencyMs: undefined });
  return out;
}

/**
 * 逐项校验能力矩阵（来自 storage.session 或内存）：丢弃未知键与不合法的项，其余保留。
 * 单独一项不合法不能连累其他能力结论，更不能让整份快照回退。
 */
export function parseCapabilityMatrix(value: unknown): {
  matrix: CapabilityMatrix;
  dropped: number;
} {
  const matrix: CapabilityMatrix = {};
  let dropped = 0;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { matrix, dropped };
  for (const [key, entry] of Object.entries(value)) {
    const parsedKey = CapabilityKeySchema.safeParse(key);
    const parsed = ProviderCapabilitySchema.safeParse(entry);
    if (parsedKey.success && parsed.success) matrix[parsedKey.data] = parsed.data;
    else if (entry !== undefined) dropped++;
  }
  return { matrix, dropped };
}

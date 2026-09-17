import { z } from 'zod';

/**
 * 外部能力状态。未经实际调用验证时必须为 unknown，不能因模型名存在而标为 verified。
 */
export const CapabilityStatusSchema = z.enum(['unknown', 'verified', 'unsupported', 'failed']);
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export const ProviderCapabilitySchema = z.object({
  status: CapabilityStatusSchema,
  checkedAt: z.string().optional(),
  configRevision: z.number().int().nonnegative(),
  reasonCode: z.string().max(80).optional(),
  /** 面向用户的简短说明。 */
  message: z.string().max(300).optional(),
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

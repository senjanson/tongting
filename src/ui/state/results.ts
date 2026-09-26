/**
 * UiCommand 结果的运行时校验与超时设置。worker 返回的数据同样视为需要校验的入站消息。
 */
import { z } from 'zod';
import { SEARCH_HISTORY_LIMIT, SearchRecordSchema } from '../../domain/search';
import {
  ConnectionReportSchema,
  TtsVoiceInfoSchema,
  type UiCommandKind,
  type UiCommandResultMap,
} from '../../messaging/ui-protocol';

const accepted = z.object({ accepted: z.literal(true) });
const persisted = z.object({ persisted: z.boolean() });

export const UI_COMMAND_RESULT_SCHEMAS: { [K in UiCommandKind]: z.ZodType<UiCommandResultMap[K]> } =
  {
    'search/generate': z.object({ record: SearchRecordSchema, persisted: z.boolean() }),
    'search/cancel': z.object({ cancelled: z.literal(true) }),
    'search/history': z.object({ records: z.array(SearchRecordSchema).max(SEARCH_HISTORY_LIMIT) }),
    'search/clear-history': z.object({ cleared: z.literal(true) }),
    'session/start': accepted,
    'session/pause': accepted,
    'session/resume': accepted,
    'session/stop': accepted,
    'session/retry-failed': z.object({ retried: z.number().int().nonnegative() }),
    'session/backfill': z.object({ enabled: z.boolean() }),
    'player/seek': accepted,
    'settings/update': persisted,
    'settings/reset': persisted,
    'credentials/set': z.object({ persisted: z.boolean(), storage: z.enum(['session', 'local']) }),
    'credentials/clear': z.object({ cleared: z.literal(true) }),
    'asr/set-token': persisted,
    'asr/clear-token': z.object({ cleared: z.literal(true) }),
    'permissions/changed': z.object({ granted: z.boolean() }),
    'connection/check': ConnectionReportSchema,
    'models/discover': z.object({ models: z.array(z.string().max(200)).max(1_000) }),
    'tts/voices': z.object({ voices: z.array(TtsVoiceInfoSchema).max(1_000) }),
    'tts/preview': z.object({ started: z.literal(true) }),
    'tts/stop-preview': z.object({ stopped: z.literal(true) }),
    'cache/clear': z.object({ cleared: z.literal(true) }),
    'diagnostics/export': z.object({
      text: z.string(),
      entries: z.number().int().nonnegative(),
    }),
    'diagnostics/clear': z.object({ cleared: z.literal(true) }),
  };

/** 默认命令超时（毫秒）。连接检查包含多项真实请求，需要更长时间。 */
export const DEFAULT_COMMAND_TIMEOUT_MS = 15_000;

export const COMMAND_TIMEOUTS_MS: Partial<Record<UiCommandKind, number>> = {
  'search/generate': 130_000,
  'session/start': 30_000,
  'session/stop': 20_000,
  'connection/check': 180_000,
  'models/discover': 45_000,
  'tts/preview': 30_000,
};

export function commandTimeoutMs(kind: UiCommandKind): number {
  return COMMAND_TIMEOUTS_MS[kind] ?? DEFAULT_COMMAND_TIMEOUT_MS;
}

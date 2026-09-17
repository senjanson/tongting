import { z } from 'zod';
import { AppErrorInfoSchema } from './errors';

/** 单条字幕允许的最大字符数；超出部分在解析层截断并计数。 */
export const MAX_CUE_TEXT_LENGTH = 1_000;
/** 允许的最大媒体时间（24 小时），超出视为异常数据。 */
export const MAX_MEDIA_TIME_MS = 24 * 60 * 60 * 1000;

const MediaTimeMs = z.number().int().min(0).max(MAX_MEDIA_TIME_MS);

export const CueSourceSchema = z.enum(['caption-track', 'visible-caption', 'asr']);
export type CueSource = z.infer<typeof CueSourceSchema>;

export const CueStabilitySchema = z.enum(['interim', 'final']);
export type CueStability = z.infer<typeof CueStabilitySchema>;

export const TranslationStateSchema = z.enum(['pending', 'running', 'done', 'failed', 'skipped']);
export type TranslationState = z.infer<typeof TranslationStateSchema>;

/**
 * 页面字幕轨道解析后的原始片段（未合句）。时间为视频媒体时间。
 */
export const RawCaptionCueSchema = z.object({
  startMs: MediaTimeMs,
  endMs: MediaTimeMs,
  text: z.string().max(MAX_CUE_TEXT_LENGTH),
});
export type RawCaptionCue = z.infer<typeof RawCaptionCueSchema>;

/**
 * 字幕单元：翻译、显示、配音、导出的基本单位。可能由多个原始片段合成。
 * `id` 在同一会话（sessionId + 来源版本）内稳定；ASR 临时结果通过 revision 更新。
 */
export const CueSchema = z.object({
  id: z.string().min(1).max(120),
  revision: z.number().int().min(0),
  startMs: MediaTimeMs,
  endMs: MediaTimeMs,
  /** 结束时间是估计值（例如增量字幕或 ASR 尚未确认）。 */
  endEstimated: z.boolean().optional(),
  sourceText: z.string().max(MAX_CUE_TEXT_LENGTH * 4),
  translatedText: z
    .string()
    .max(MAX_CUE_TEXT_LENGTH * 8)
    .optional(),
  /** 实际来源语言（轨道语言或识别语言），未知时为 'und'。 */
  sourceLanguage: z.string().max(20),
  targetLanguage: z.string().max(20),
  source: CueSourceSchema,
  stability: CueStabilitySchema,
  translationState: TranslationStateSchema,
  translationError: AppErrorInfoSchema.optional(),
  /** 产生当前译文时的翻译配置指纹（模型、提示词、风格、术语版本等）。 */
  translationKey: z.string().max(200).optional(),
  /** 合句前原始片段的时间范围，用于追踪映射。 */
  parts: z
    .array(z.object({ startMs: MediaTimeMs, endMs: MediaTimeMs }))
    .max(200)
    .optional(),
});
export type Cue = z.infer<typeof CueSchema>;

export const TimeRangeSchema = z.object({ startMs: MediaTimeMs, endMs: MediaTimeMs });
export type TimeRange = z.infer<typeof TimeRangeSchema>;

export const CoverageGapReasonSchema = z.enum([
  'not-played', // 增量来源尚未播放到
  'asr-backlog',
  'asr-failed',
  'paused-translation',
  'ad',
  'seek-skipped',
  'translation-failed',
  'unknown',
]);

/** 已获得字幕的覆盖范围；导出与工作台据此说明完整性。 */
export const SubtitleCoverageSchema = z.object({
  /** 是否为完整轨道（仅 caption-track 且轨道完整读取时为 true）。 */
  complete: z.boolean(),
  ranges: z.array(TimeRangeSchema).max(10_000),
  gaps: z.array(TimeRangeSchema.extend({ reason: CoverageGapReasonSchema })).max(10_000),
  durationMs: MediaTimeMs.optional(),
});
export type SubtitleCoverage = z.infer<typeof SubtitleCoverageSchema>;

/** 合并时间区间（输入无需有序），返回有序不重叠区间。 */
export function mergeRanges(ranges: readonly TimeRange[], toleranceMs = 0): TimeRange[] {
  const sorted = ranges
    .filter((r) => r.endMs >= r.startMs)
    .map((r) => ({ ...r }))
    .sort((a, b) => a.startMs - b.startMs);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.startMs <= last.endMs + toleranceMs) {
      last.endMs = Math.max(last.endMs, r.endMs);
    } else {
      out.push(r);
    }
  }
  return out;
}

/** 查找覆盖某媒体时间的字幕（cues 需按 startMs 升序）。 */
export function findActiveCue<T extends Pick<Cue, 'startMs' | 'endMs'>>(
  cues: readonly T[],
  timeMs: number,
): T | undefined {
  let lo = 0;
  let hi = cues.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.startMs <= timeMs) {
      candidate = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  for (let i = candidate; i >= 0 && i >= candidate - 3; i--) {
    const c = cues[i]!;
    if (c.startMs <= timeMs && timeMs < c.endMs) return c;
  }
  return undefined;
}

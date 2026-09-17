/**
 * 解析器共用的片段规范化：时间校验、文本清洗/截断、排序、重复合并、重叠裁剪与数量上限。
 *
 * 输出不变量（RawCaptionCue[]）：
 * - 按 startMs 严格升序（相同起点的片段合并为一条）；
 * - 每条 0 <= startMs < endMs <= MAX_MEDIA_TIME_MS，endMs <= 下一条 startMs；
 * - text 非空、已清洗、长度不超过 MAX_CUE_TEXT_LENGTH。
 */
import { MAX_CUE_TEXT_LENGTH, MAX_MEDIA_TIME_MS, type RawCaptionCue } from '../domain/cue';
import { joinCaptionText, normalizeCaptionText, truncateText } from './text';

/** 与 content-protocol 的 MAX_TRACK_CUES 保持一致（有单元测试核对）。 */
export const MAX_PARSED_CUES = 20_000;
/** 允许解析的原始正文上限（字符）。 */
export const MAX_CAPTION_BODY_CHARS = 8 * 1024 * 1024;
/** 缺少时长时的估计时长。 */
export const DEFAULT_CUE_DURATION_MS = 3_000;
/** 单条片段最长显示时长；超出视为异常并截断。 */
export const MAX_SINGLE_CUE_DURATION_MS = 60_000;
/** 原始事件/节点数上限，防止恶意正文耗尽内存。 */
export const MAX_RAW_EVENTS = 200_000;

export type CaptionFormat = 'json3' | 'srv3' | 'vtt';

export interface CaptionParseStats {
  /** 时间非法（负数、NaN、超出 24h）等被拒绝的片段数。 */
  rejected: number;
  /** 文本或时长被截断的片段数。 */
  truncated: number;
  /** 被合并的重复片段数（正常现象，不计入 rejectedCount）。 */
  duplicates: number;
  /** 超出数量上限而被丢弃的片段数。 */
  overflow: number;
}

export interface CaptionParseResult {
  format: CaptionFormat;
  cues: RawCaptionCue[];
  stats: CaptionParseStats;
  /** 协议字段 rejectedCount：拒绝 + 截断 + 超限丢弃。 */
  rejectedCount: number;
  /** 是否因数量上限丢弃了片段（此时轨道不完整）。 */
  overflowed: boolean;
}

export type CaptionParseErrorCode =
  'too-large' | 'invalid-json' | 'invalid-structure' | 'unknown-format';

/** 解析失败。message 不包含字幕原文。 */
export class CaptionParseError extends Error {
  readonly code: CaptionParseErrorCode;
  constructor(code: CaptionParseErrorCode) {
    super(`caption parse failed: ${code}`);
    this.name = 'CaptionParseError';
    this.code = code;
  }
}

/** 解析器产出的候选片段（时间未校验、文本未清洗）。 */
export interface CueCandidate {
  startMs: number;
  /** 缺失时按下一条起点或默认时长估计。 */
  endMs?: number;
  text: string;
}

export function emptyStats(): CaptionParseStats {
  return { rejected: 0, truncated: 0, duplicates: 0, overflow: 0 };
}

function isValidTime(ms: number): boolean {
  return Number.isFinite(ms) && ms >= 0 && ms <= MAX_MEDIA_TIME_MS;
}

export function finalizeCandidates(
  format: CaptionFormat,
  candidates: readonly CueCandidate[],
  stats: CaptionParseStats = emptyStats(),
): CaptionParseResult {
  type Working = { startMs: number; endMs: number | undefined; text: string; order: number };
  const working: Working[] = [];
  let order = 0;
  for (const c of candidates) {
    if (!isValidTime(c.startMs) || c.startMs >= MAX_MEDIA_TIME_MS) {
      stats.rejected++;
      continue;
    }
    const text = normalizeCaptionText(c.text);
    if (!text) continue; // 空白/换行事件是正常结构，不计入拒绝
    const startMs = Math.round(c.startMs);
    // 取整后落在 24 小时边界上时无法再有正时长，视为非法。
    if (startMs >= MAX_MEDIA_TIME_MS) {
      stats.rejected++;
      continue;
    }
    let endMs: number | undefined;
    if (c.endMs !== undefined) {
      if (!Number.isFinite(c.endMs) || c.endMs < 0) {
        stats.rejected++;
        continue;
      }
      endMs = Math.round(c.endMs);
    }
    working.push({ startMs, endMs, text, order: order++ });
  }

  working.sort((a, b) => a.startMs - b.startMs || a.order - b.order);

  // 相同起点合并（例如同时显示的两行/两位说话人）。
  const merged: Working[] = [];
  for (const w of working) {
    const last = merged[merged.length - 1];
    if (last && last.startMs === w.startMs) {
      if (last.text !== w.text) last.text = joinCaptionText(last.text, w.text);
      else stats.duplicates++;
      last.endMs = maxDefined(last.endMs, w.endMs);
      continue;
    }
    merged.push({ ...w });
  }

  const out: RawCaptionCue[] = [];
  for (let i = 0; i < merged.length; i++) {
    const w = merged[i]!;
    const nextStart = merged[i + 1]?.startMs;
    let endMs = w.endMs;
    if (endMs === undefined || endMs <= w.startMs) {
      endMs = w.startMs + DEFAULT_CUE_DURATION_MS;
      if (nextStart !== undefined && nextStart > w.startMs) endMs = Math.min(endMs, nextStart);
    }
    let truncated = false;
    if (endMs - w.startMs > MAX_SINGLE_CUE_DURATION_MS) {
      endMs = w.startMs + MAX_SINGLE_CUE_DURATION_MS;
      truncated = true;
    }
    if (endMs > MAX_MEDIA_TIME_MS) {
      endMs = MAX_MEDIA_TIME_MS;
      truncated = true;
    }
    // 重叠裁剪：结束时间不晚于下一条起点（滚动字幕的上一行在下一行出现时视为结束）。
    if (nextStart !== undefined && endMs > nextStart) endMs = nextStart;
    if (endMs <= w.startMs) {
      stats.rejected++;
      continue;
    }
    const t = truncateText(w.text, MAX_CUE_TEXT_LENGTH);
    if (t.truncated) truncated = true;
    if (truncated) stats.truncated++;

    const prev = out[out.length - 1];
    // 重复段：文本相同且时间相接/重叠，合并为一条。
    if (prev && prev.text === t.text && w.startMs <= prev.endMs + 50) {
      prev.endMs = Math.max(prev.endMs, endMs);
      stats.duplicates++;
      continue;
    }
    out.push({ startMs: w.startMs, endMs, text: t.text });
  }

  let overflowed = false;
  if (out.length > MAX_PARSED_CUES) {
    stats.overflow += out.length - MAX_PARSED_CUES;
    out.length = MAX_PARSED_CUES;
    overflowed = true;
  }

  return {
    format,
    cues: out,
    stats,
    rejectedCount: stats.rejected + stats.truncated + stats.overflow,
    overflowed,
  };
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

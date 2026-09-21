/**
 * 覆盖层字幕选择（纯逻辑）：按媒体时间选中当前字幕；当前字幕尚无译文时，
 * 保留上一条已显示过译文的字幕，直到出现新的已译字幕或超过其结束时间 holdMs。
 * 用于增量字幕：句子通常在显示后才确定并翻译，若不保留，译文往往刚返回就被下一句替换。
 *
 * late 模式（增量字幕与语音识别）：字幕在该句确定、识别并翻译之后才到达，播放位置可能已越过其区间，
 * 甚至越过下一句的开始。因此显示「开始时间不晚于当前时间、结束后未超过 lateHoldMs 的最新已译字幕」，
 * 直到更新的已译字幕到达或超出窗口。
 */
import { findActiveCue } from '../../domain/cue';
import type { DisplayCue } from '../../messaging/content-protocol';

export interface DisplaySelection {
  cue: DisplayCue;
  /** true 表示当前字幕无译文，正在保留上一条已译字幕。 */
  held: boolean;
}

export interface DisplaySelector {
  select(
    cues: readonly DisplayCue[],
    timeMs: number,
    getById: (id: string) => DisplayCue | undefined,
    opts?: { late?: boolean; lateAfterMs?: number },
  ): DisplaySelection | undefined;
  reset(): void;
}

export const DEFAULT_TRANSLATION_HOLD_MS = 3_000;
/** 识别延迟（分段 + 识别 + 翻译）通常为数秒；窗口需覆盖延迟并留出阅读时间。 */
export const DEFAULT_LATE_HOLD_MS = 8_000;
/** late 模式向前查找的最多条数（按开始时间排序，最近的几条足以覆盖窗口）。 */
const LATE_LOOKBACK = 8;

/** 开始时间不晚于 timeMs、且 timeMs 未超过其结束时间 + holdMs 的最新已译字幕。 */
function findLatestTranslated(
  cues: readonly DisplayCue[],
  timeMs: number,
  holdMs: number,
  afterMs = -Infinity,
): DisplayCue | undefined {
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
  for (let i = candidate; i >= 0 && i > candidate - LATE_LOOKBACK; i--) {
    const c = cues[i]!;
    if (c.translatedText?.trim() && c.endMs > afterMs && timeMs <= c.endMs + holdMs) return c;
  }
  return undefined;
}

export function createDisplaySelector(
  holdMs = DEFAULT_TRANSLATION_HOLD_MS,
  lateHoldMs = DEFAULT_LATE_HOLD_MS,
): DisplaySelector {
  let lastId: string | undefined;
  return {
    select(cues, timeMs, getById, opts) {
      const active = findActiveCue(cues, timeMs);
      if (active?.translatedText?.trim()) {
        lastId = active.id;
        return { cue: active, held: false };
      }
      if (opts?.late) {
        const latest = findLatestTranslated(cues, timeMs, lateHoldMs, opts.lateAfterMs);
        if (latest) {
          lastId = latest.id;
          // 当前正在说的句子还没有译文时，标记为保留显示。
          return { cue: latest, held: !!active && active.id !== latest.id };
        }
      }
      if (lastId !== undefined) {
        const last = getById(lastId);
        const valid =
          !!last?.translatedText?.trim() && timeMs >= last.startMs && timeMs <= last.endMs + holdMs;
        if (!valid) {
          lastId = undefined;
        } else if (active && active.startMs >= last!.startMs) {
          return { cue: last!, held: true };
        }
      }
      return active ? { cue: active, held: false } : undefined;
    },
    reset() {
      lastId = undefined;
    },
  };
}

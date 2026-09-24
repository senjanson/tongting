/**
 * 字幕覆盖范围说明（导出与工作台共用），按界面语言生成（默认中文）。
 *
 * 规则：只有来源为完整字幕轨道且 coverage.complete 为 true 时才能称为「完整字幕轨道」；
 * 增量字幕与语音识别得到的内容一律说明为部分字幕，不能标成全视频字幕。
 */
import { mergeRanges, type SubtitleCoverage } from '../domain/cue';
import type { SourceMode } from '../domain/session';
import { translate, type Locale, type MessageKey } from '../i18n';

const GAP_REASON_KEYS: Record<string, MessageKey> = {
  'not-played': 'options.coverage.gap.not-played',
  'asr-backlog': 'options.coverage.gap.asr-backlog',
  'asr-failed': 'options.coverage.gap.asr-failed',
  'paused-translation': 'options.coverage.gap.paused-translation',
  ad: 'options.coverage.gap.ad',
  'seek-skipped': 'options.coverage.gap.seek-skipped',
  'translation-failed': 'options.coverage.gap.translation-failed',
  unknown: 'options.coverage.gap.unknown',
};

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 媒体时间 → `HH:MM:SS`（不含毫秒）。 */
export function formatHms(ms: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(ms) ? ms : 0) / 1000);
  const seconds = Math.floor(total);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 时长 → 「X 分 Y 秒」「X 小时 Y 分」（英文为「X min Y s」「X h Y min」）。 */
export function formatDuration(ms: number, locale: Locale = 'zh-CN'): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return translate(locale, 'options.coverage.duration.seconds', { s: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest
      ? translate(locale, 'options.coverage.duration.minutesSeconds', { m: minutes, s: rest })
      : translate(locale, 'options.coverage.duration.minutes', { m: minutes });
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes
    ? translate(locale, 'options.coverage.duration.hoursMinutes', { h: hours, m: restMinutes })
    : translate(locale, 'options.coverage.duration.hours', { h: hours });
}

export function sourceModeLabel(mode: SourceMode | undefined, locale: Locale = 'zh-CN'): string {
  switch (mode) {
    case 'full-track':
    case 'incremental-captions':
    case 'asr':
    case 'asr-preload':
    case 'none':
      return translate(locale, `options.coverage.mode.${mode}`);
    default:
      return translate(locale, 'options.coverage.mode.unknown');
  }
}

/** 覆盖范围是否可以称为「完整」。增量字幕与语音识别永远不算完整。 */
export function isCompleteCoverage(
  coverage: SubtitleCoverage | undefined,
  sourceMode?: SourceMode,
): boolean {
  if (!coverage?.complete) return false;
  if (
    sourceMode === 'asr' ||
    sourceMode === 'asr-preload' ||
    sourceMode === 'incremental-captions' ||
    sourceMode === 'none'
  )
    return false;
  return true;
}

/**
 * 一句话说明覆盖范围，例如：
 * - 「完整字幕轨道（视频时长 18 分 36 秒）」
 * - 「部分字幕（非全视频，语音识别）：已覆盖 2 段，共 3 分 10 秒 / 视频 18 分 36 秒：00:01:00–00:03:00、00:05:00–00:06:10；缺口 1 段（尚未播放到）」
 */
export function describeCoverage(
  coverage: SubtitleCoverage | undefined,
  sourceMode?: SourceMode,
  locale: Locale = 'zh-CN',
): string {
  const partialMode =
    sourceMode === 'asr' || sourceMode === 'asr-preload' || sourceMode === 'incremental-captions';
  if (!coverage) {
    return partialMode
      ? translate(locale, 'options.coverage.unknownPartial', {
          mode: sourceModeLabel(sourceMode, locale),
        })
      : translate(locale, 'options.coverage.unknown');
  }
  const duration = coverage.durationMs;
  if (isCompleteCoverage(coverage, sourceMode)) {
    return duration
      ? translate(locale, 'options.coverage.completeWithDuration', {
          duration: formatDuration(duration, locale),
        })
      : translate(locale, 'options.coverage.complete');
  }
  const modeNote = partialMode
    ? translate(locale, 'options.coverage.modeNote', { mode: sourceModeLabel(sourceMode, locale) })
    : '';
  const ranges = mergeRanges(coverage.ranges);
  if (ranges.length === 0) {
    return translate(locale, 'options.coverage.partialNone', { modeNote });
  }
  const separator = translate(locale, 'options.coverage.listSeparator');
  const covered = ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  const shown = ranges
    .slice(0, 3)
    .map((r) => `${formatHms(r.startMs)}–${formatHms(r.endMs)}`)
    .join(separator);
  let text = translate(locale, 'options.coverage.partial', {
    modeNote,
    count: ranges.length,
    covered: formatDuration(covered, locale),
  });
  if (duration)
    text += translate(locale, 'options.coverage.partialDuration', {
      duration: formatDuration(duration, locale),
    });
  text += translate(locale, 'options.coverage.ranges', {
    ranges: shown,
    more: ranges.length > 3 ? translate(locale, 'options.coverage.more') : '',
  });
  if (coverage.gaps.length > 0) {
    const reasons = Array.from(
      new Set(
        coverage.gaps.map((g) =>
          translate(locale, GAP_REASON_KEYS[g.reason] ?? 'options.coverage.gap.unknown'),
        ),
      ),
    );
    text += translate(locale, 'options.coverage.gaps', {
      count: coverage.gaps.length,
      reasons: reasons.join(separator),
    });
  }
  return text;
}

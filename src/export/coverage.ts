/**
 * 字幕覆盖范围说明（导出与工作台共用）。
 *
 * 规则：只有来源为完整字幕轨道且 coverage.complete 为 true 时才能称为「完整字幕轨道」；
 * 增量字幕与语音识别得到的内容一律说明为部分字幕，不能标成全视频字幕。
 */
import { mergeRanges, type SubtitleCoverage } from '../domain/cue';
import type { SourceMode } from '../domain/session';

const GAP_REASON_LABELS: Record<string, string> = {
  'not-played': '尚未播放到',
  'asr-backlog': '识别积压',
  'asr-failed': '识别失败',
  'paused-translation': '翻译暂停期间',
  ad: '广告',
  'seek-skipped': '跳转跳过',
  'translation-failed': '翻译失败',
  unknown: '原因未知',
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

/** 时长 → 「X 分 Y 秒」或「X 小时 Y 分」。 */
export function formatDurationZh(ms: number): string {
  const seconds = Math.max(0, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

export function sourceModeLabel(mode: SourceMode | undefined): string {
  switch (mode) {
    case 'full-track':
      return '完整字幕轨道';
    case 'incremental-captions':
      return '增量字幕（仅读取当前显示的字幕）';
    case 'asr':
      return '语音识别';
    case 'none':
      return '暂无字幕来源';
    default:
      return '来源未知';
  }
}

/** 覆盖范围是否可以称为「完整」。增量字幕与语音识别永远不算完整。 */
export function isCompleteCoverage(
  coverage: SubtitleCoverage | undefined,
  sourceMode?: SourceMode,
): boolean {
  if (!coverage?.complete) return false;
  if (sourceMode === 'asr' || sourceMode === 'incremental-captions' || sourceMode === 'none')
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
): string {
  if (!coverage) {
    return sourceMode === 'asr' || sourceMode === 'incremental-captions'
      ? `覆盖范围未知（部分字幕，非全视频，${sourceModeLabel(sourceMode)}）`
      : '覆盖范围未知';
  }
  const duration = coverage.durationMs;
  if (isCompleteCoverage(coverage, sourceMode)) {
    return duration ? `完整字幕轨道（视频时长 ${formatDurationZh(duration)}）` : '完整字幕轨道';
  }
  const modeNote =
    sourceMode === 'asr' || sourceMode === 'incremental-captions'
      ? `，${sourceModeLabel(sourceMode)}`
      : '';
  const ranges = mergeRanges(coverage.ranges);
  if (ranges.length === 0) {
    return `部分字幕（非全视频${modeNote}）：尚未获得任何字幕片段`;
  }
  const covered = ranges.reduce((sum, r) => sum + (r.endMs - r.startMs), 0);
  const shown = ranges
    .slice(0, 3)
    .map((r) => `${formatHms(r.startMs)}–${formatHms(r.endMs)}`)
    .join('、');
  let text = `部分字幕（非全视频${modeNote}）：已覆盖 ${ranges.length} 段，共 ${formatDurationZh(covered)}`;
  if (duration) text += ` / 视频 ${formatDurationZh(duration)}`;
  text += `：${shown}${ranges.length > 3 ? ' 等' : ''}`;
  if (coverage.gaps.length > 0) {
    const reasons = Array.from(
      new Set(coverage.gaps.map((g) => GAP_REASON_LABELS[g.reason] ?? '原因未知')),
    );
    text += `；缺口 ${coverage.gaps.length} 段（${reasons.join('、')}）`;
  }
  return text;
}

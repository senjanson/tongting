/**
 * SRT / VTT / TXT 字幕导出（纯函数）。
 *
 * 规则（EXECUTION_PLAN §4.3、§11 P7、T35）：
 * - 只导出实际获得的内容；默认排除临时（interim）结果，包含时显式标记。
 * - 「仅译文」时未完成翻译的条目排除或以原文标记，并计数；流式部分译文不导出。
 * - SRT 编号连续，时间 HH:MM:SS,mmm；VTT 以 WEBVTT 开头，时间 HH:MM:SS.mmm。
 * - 结束时间必须大于开始时间，否则修正并计数。
 * - 统一使用 \n 换行；去掉会破坏格式的空行与 `-->`；VTT 转义 & < >。
 * - 覆盖范围如实说明，部分字幕不能标成全视频字幕。
 */
import type { Cue, SubtitleCoverage } from '../domain/cue';
import type { SourceMode } from '../domain/session';
import { describeCoverage, formatHms } from './coverage';

export type ExportFormat = 'srt' | 'vtt' | 'txt';
export type ExportContent = 'original' | 'translation' | 'bilingual';
export type ExportScope = 'all' | 'favorites';
/** 未翻译条目的处理：排除，或以原文输出并标记「[未翻译]」。 */
export type UntranslatedPolicy = 'skip' | 'mark';

export interface ExportInput {
  cues: readonly Cue[];
  content: ExportContent;
  scope: ExportScope;
  /** scope 为 favorites 时使用的收藏 cue id。 */
  favoriteCueIds?: Iterable<string>;
  /** 是否包含临时识别结果，默认否。 */
  includeInterim?: boolean;
  /** 默认：仅译文排除，双语标记。仅原文时无效。 */
  untranslated?: UntranslatedPolicy;
  coverage?: SubtitleCoverage;
  sourceMode?: SourceMode;
  title?: string;
  videoId?: string;
  targetLanguage?: string;
  sourceLanguage?: string;
}

export interface ExportResult {
  text: string;
  filename: string;
  includedCount: number;
  /** 因未完成翻译而排除的条数。 */
  skippedUntranslated: number;
  /** 未完成翻译、以原文输出并标记的条数。 */
  markedUntranslated: number;
  /** 被排除的临时识别结果条数。 */
  skippedInterim: number;
  /** 已包含并标记的临时识别结果条数。 */
  markedInterim: number;
  /** 文本为空或时间无效而跳过的条数。 */
  skippedInvalid: number;
  /** 结束时间不大于开始时间而被修正的条数。 */
  fixedTimings: number;
  /** 仅收藏时：收藏中不在当前字幕里的条数（例如来自其他会话或已被修订的字幕）。 */
  missingFavorites: number;
  coverageSummary: string;
}

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
  srt: 'srt',
  vtt: 'vtt',
  txt: 'txt',
};
export const EXPORT_MIME: Record<ExportFormat, string> = {
  srt: 'application/x-subrip',
  vtt: 'text/vtt',
  txt: 'text/plain',
};

export const UNTRANSLATED_MARK = '[未翻译]';
export const INTERIM_MARK = '[临时]';
/** 修正无效结束时间时使用的最短时长。 */
export const FIXED_MIN_DURATION_MS = 1_000;

interface PreparedEntry {
  startMs: number;
  endMs: number;
  /** 已规范化、非空的文本行（未做格式转义）。 */
  lines: string[];
}

interface Prepared {
  entries: PreparedEntry[];
  stats: Omit<ExportResult, 'text' | 'filename' | 'coverageSummary'>;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B\uFEFF]/g;

/**
 * 规范化字幕文本为非空行数组：统一换行、去控制字符、合并空白、替换 `-->`、去掉空行。
 * 空行会在 SRT/VTT 中提前结束一条字幕，因此必须去掉。
 */
export function normalizeCueLines(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/\r\n?|[\u2028\u2029\u0085]/g, '\n')
    .replace(CONTROL_CHARS, '')
    .split('\n')
    .map((line) =>
      line
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/-{2,}>/g, '→'),
    )
    .filter((line) => line.length > 0);
}

function isTranslated(cue: Cue): boolean {
  if (cue.translationState === 'skipped') return true;
  return cue.translationState === 'done' && (cue.translatedText ?? '').trim().length > 0;
}

function translationLines(cue: Cue): string[] {
  if (cue.translationState === 'skipped') {
    // 同语言无需翻译：译文即原文。
    const own = normalizeCueLines(cue.translatedText);
    return own.length ? own : normalizeCueLines(cue.sourceText);
  }
  return normalizeCueLines(cue.translatedText);
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

function compareCues(a: Cue, b: Cue): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function prepare(input: ExportInput): Prepared {
  const favoriteIds = input.scope === 'favorites' ? new Set(input.favoriteCueIds ?? []) : undefined;
  const policy: UntranslatedPolicy =
    input.untranslated ?? (input.content === 'bilingual' ? 'mark' : 'skip');
  const stats: Prepared['stats'] = {
    includedCount: 0,
    skippedUntranslated: 0,
    markedUntranslated: 0,
    skippedInterim: 0,
    markedInterim: 0,
    skippedInvalid: 0,
    fixedTimings: 0,
    missingFavorites: 0,
  };
  const entries: PreparedEntry[] = [];
  const sorted = [...input.cues].sort(compareCues);
  if (favoriteIds) {
    const present = new Set(sorted.map((c) => c.id));
    for (const id of favoriteIds) if (!present.has(id)) stats.missingFavorites++;
  }

  for (const cue of sorted) {
    if (favoriteIds && !favoriteIds.has(cue.id)) continue;
    if (!Number.isFinite(cue.startMs) || !Number.isFinite(cue.endMs) || cue.startMs < 0) {
      stats.skippedInvalid++;
      continue;
    }
    const interim = cue.stability === 'interim';
    if (interim && !input.includeInterim) {
      stats.skippedInterim++;
      continue;
    }

    const original = normalizeCueLines(cue.sourceText);
    let lines: string[];
    let markedUntranslated = false;

    if (input.content === 'original') {
      lines = original;
    } else if (!isTranslated(cue)) {
      if (original.length === 0) {
        // 原文与译文都为空：属于无效条目，而不是「未翻译」。
        stats.skippedInvalid++;
        continue;
      }
      if (policy === 'skip') {
        stats.skippedUntranslated++;
        continue;
      }
      lines = [`${UNTRANSLATED_MARK} ${original[0]}`, ...original.slice(1)];
      markedUntranslated = true;
    } else {
      const translated = translationLines(cue);
      if (input.content === 'translation' || sameLines(translated, original)) {
        lines = translated;
      } else {
        lines = [...translated, ...original];
      }
    }

    if (lines.length === 0) {
      stats.skippedInvalid++;
      continue;
    }
    if (interim) {
      lines = [`${INTERIM_MARK} ${lines[0]}`, ...lines.slice(1)];
      stats.markedInterim++;
    }
    if (markedUntranslated) stats.markedUntranslated++;

    let endMs = cue.endMs;
    if (!(endMs > cue.startMs)) {
      endMs = cue.startMs + FIXED_MIN_DURATION_MS;
      stats.fixedTimings++;
    }
    entries.push({ startMs: Math.round(cue.startMs), endMs: Math.round(endMs), lines });
    stats.includedCount++;
  }
  return { entries, stats };
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** 媒体时间 → `HH:MM:SS<sep>mmm`。 */
export function formatSubtitleTimestamp(ms: number, separator: ',' | '.'): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor(total / 60_000) % 60;
  const s = Math.floor(total / 1_000) % 60;
  const milli = total % 1_000;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(milli, 3)}`;
}

function escapeVtt(line: string): string {
  return line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
  pt: '葡萄牙语',
  und: '语言未知',
};

/** 头部说明中的语言名：未知代码原样显示，但与其他头部字段一样单行化并替换 `-->`。 */
function languageName(code: string | undefined): string {
  if (!code || code === 'auto') return '语言未知';
  return LANGUAGE_NAMES[code] ?? (singleLine(code) || '语言未知');
}

function contentDescription(input: ExportInput): string {
  switch (input.content) {
    case 'original':
      return `仅原文（${languageName(input.sourceLanguage)}）`;
    case 'translation':
      return `仅译文（${languageName(input.targetLanguage)}）`;
    case 'bilingual':
      return `双语：译文（${languageName(input.targetLanguage)}）+ 原文（${languageName(input.sourceLanguage)}）`;
  }
}

/** 覆盖范围 + 本次导出统计，面向用户的一段中文说明。 */
export function buildCoverageSummary(input: ExportInput, stats: Prepared['stats']): string {
  const parts: string[] = [describeCoverage(input.coverage, input.sourceMode)];
  const exportParts: string[] = [`本次导出 ${stats.includedCount} 条`];
  if (input.scope === 'favorites') exportParts.push('仅收藏');
  if (stats.missingFavorites) exportParts.push(`收藏中 ${stats.missingFavorites} 条已不在当前记录`);
  if (stats.skippedUntranslated)
    exportParts.push(`未完成翻译 ${stats.skippedUntranslated} 条已排除`);
  if (stats.markedUntranslated)
    exportParts.push(
      `未完成翻译 ${stats.markedUntranslated} 条以原文输出并标记${UNTRANSLATED_MARK}`,
    );
  if (stats.skippedInterim) exportParts.push(`临时识别结果 ${stats.skippedInterim} 条已排除`);
  if (stats.markedInterim)
    exportParts.push(`包含临时识别结果 ${stats.markedInterim} 条（已标记${INTERIM_MARK}）`);
  if (stats.skippedInvalid) exportParts.push(`空白或时间无效 ${stats.skippedInvalid} 条已跳过`);
  if (stats.fixedTimings) exportParts.push(`修正结束时间 ${stats.fixedTimings} 条`);
  parts.push(exportParts.join('，'));
  return parts.join('。');
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

function truncateCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** 生成安全文件名：`<标题>[.收藏][.双语].<语言>.<扩展名>`。 */
export function buildExportFilename(input: {
  title?: string;
  videoId?: string;
  language?: string;
  format: ExportFormat;
  scope?: ExportScope;
  content?: ExportContent;
}): string {
  let base = (input.title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  base = truncateCodePoints(base, 80)
    .trim()
    .replace(/[.\s]+$/g, '');
  if (!base) {
    const safeId = (input.videoId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
    base = safeId ? `tongting-${safeId}` : 'tongting-subtitles';
  }
  if (WINDOWS_RESERVED.test(base)) base = `_${base}`;
  const language = (input.language ?? '').replace(/[^A-Za-z0-9-]/g, '') || 'und';
  const tags: string[] = [];
  if (input.scope === 'favorites') tags.push('收藏');
  if (input.content === 'bilingual') tags.push('双语');
  return [base, ...tags, language, EXPORT_EXTENSIONS[input.format]].join('.');
}

function filenameLanguage(input: ExportInput): string | undefined {
  return input.content === 'original' ? input.sourceLanguage : input.targetLanguage;
}

function singleLine(text: string | undefined): string {
  return normalizeCueLines(text).join(' ');
}

export function formatSrt(input: ExportInput): ExportResult {
  const { entries, stats } = prepare(input);
  const blocks = entries.map(
    (entry, i) =>
      `${i + 1}\n${formatSubtitleTimestamp(entry.startMs, ',')} --> ${formatSubtitleTimestamp(entry.endMs, ',')}\n${entry.lines.join('\n')}`,
  );
  const text = blocks.length ? `${blocks.join('\n\n')}\n` : '';
  return {
    ...stats,
    text,
    filename: buildExportFilename({ ...input, language: filenameLanguage(input), format: 'srt' }),
    coverageSummary: buildCoverageSummary(input, stats),
  };
}

export function formatVtt(input: ExportInput): ExportResult {
  const { entries, stats } = prepare(input);
  const coverageSummary = buildCoverageSummary(input, stats);
  const noteLines = ['NOTE 同听 Tongting 导出'];
  const title = singleLine(input.title);
  if (title) noteLines.push(`标题：${title}`);
  noteLines.push(`内容：${contentDescription(input)}`);
  // NOTE 内容不能含空行或 `-->`。
  noteLines.push(...normalizeCueLines(`覆盖：${coverageSummary}`));
  const blocks = [
    'WEBVTT',
    noteLines.join('\n'),
    ...entries.map(
      (entry) =>
        `${formatSubtitleTimestamp(entry.startMs, '.')} --> ${formatSubtitleTimestamp(entry.endMs, '.')}\n${entry.lines
          .map(escapeVtt)
          .join('\n')}`,
    ),
  ];
  return {
    ...stats,
    text: `${blocks.join('\n\n')}\n`,
    filename: buildExportFilename({ ...input, language: filenameLanguage(input), format: 'vtt' }),
    coverageSummary,
  };
}

export function formatTxt(input: ExportInput): ExportResult {
  const { entries, stats } = prepare(input);
  const coverageSummary = buildCoverageSummary(input, stats);
  const header = ['同听 Tongting 字幕导出'];
  const title = singleLine(input.title);
  if (title) header.push(`标题：${title}`);
  if (input.videoId) header.push(`视频 ID：${singleLine(input.videoId)}`);
  header.push(`内容：${contentDescription(input)}`);
  header.push(`覆盖：${singleLine(coverageSummary)}`);
  const body = entries.length
    ? entries.map((entry) => `[${formatHms(entry.startMs)}] ${entry.lines.join('\n')}`).join('\n\n')
    : '（没有可导出的字幕）';
  return {
    ...stats,
    text: `${header.join('\n')}\n\n${body}\n`,
    filename: buildExportFilename({ ...input, language: filenameLanguage(input), format: 'txt' }),
    coverageSummary,
  };
}

export function formatExport(format: ExportFormat, input: ExportInput): ExportResult {
  switch (format) {
    case 'srt':
      return formatSrt(input);
    case 'vtt':
      return formatVtt(input);
    case 'txt':
      return formatTxt(input);
  }
}

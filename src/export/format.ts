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
 * - 文件头说明、覆盖统计、文件名标签与正文中的标记（[未翻译]、[临时]）按 locale（界面语言，
 *   默认中文）生成；字幕正文与时间轴不随界面语言变化。
 */
import type { Cue, SubtitleCoverage } from '../domain/cue';
import type { SourceMode } from '../domain/session';
import { translate, type Locale, type MessageKey } from '../i18n';
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
  /** 文件头说明、覆盖统计与文件名标签使用的界面语言，默认中文。 */
  locale?: Locale;
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

const MARKS: Record<Locale, { untranslated: string; interim: string }> = {
  'zh-CN': { untranslated: '[未翻译]', interim: '[临时]' },
  en: { untranslated: '[untranslated]', interim: '[provisional]' },
};
/** 正文标记：未完成翻译以原文输出、临时识别结果。按界面语言，默认中文。 */
export function untranslatedMark(locale: Locale = 'zh-CN'): string {
  return MARKS[locale].untranslated;
}
export function interimMark(locale: Locale = 'zh-CN'): string {
  return MARKS[locale].interim;
}
export const UNTRANSLATED_MARK = untranslatedMark();
export const INTERIM_MARK = interimMark();
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
      lines = [`${untranslatedMark(input.locale)} ${original[0]}`, ...original.slice(1)];
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
      lines = [`${interimMark(input.locale)} ${lines[0]}`, ...lines.slice(1)];
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

const LANGUAGE_NAME_KEYS: Record<string, MessageKey> = {
  'zh-CN': 'options.export.lang.zh-CN',
  'zh-TW': 'options.export.lang.zh-TW',
  zh: 'options.export.lang.zh',
  en: 'options.export.lang.en',
  ja: 'options.export.lang.ja',
  ko: 'options.export.lang.ko',
  es: 'options.export.lang.es',
  fr: 'options.export.lang.fr',
  de: 'options.export.lang.de',
  ru: 'options.export.lang.ru',
  pt: 'options.export.lang.pt',
  und: 'options.export.lang.unknown',
};

/** 头部说明中的语言名：未知代码原样显示，但与其他头部字段一样单行化并替换 `-->`。 */
function languageName(code: string | undefined, locale: Locale): string {
  const unknown = translate(locale, 'options.export.lang.unknown');
  if (!code || code === 'auto') return unknown;
  const key = LANGUAGE_NAME_KEYS[code];
  return key ? translate(locale, key) : singleLine(code) || unknown;
}

function contentDescription(input: ExportInput): string {
  const locale = input.locale ?? 'zh-CN';
  switch (input.content) {
    case 'original':
      return translate(locale, 'options.export.file.contentOriginal', {
        language: languageName(input.sourceLanguage, locale),
      });
    case 'translation':
      return translate(locale, 'options.export.file.contentTranslation', {
        language: languageName(input.targetLanguage, locale),
      });
    case 'bilingual':
      return translate(locale, 'options.export.file.contentBilingual', {
        target: languageName(input.targetLanguage, locale),
        source: languageName(input.sourceLanguage, locale),
      });
  }
}

/** 覆盖范围 + 本次导出统计，面向用户的一段说明（按 input.locale，默认中文）。 */
export function buildCoverageSummary(input: ExportInput, stats: Prepared['stats']): string {
  const locale = input.locale ?? 'zh-CN';
  const t = (key: MessageKey, count?: number) =>
    translate(locale, key, {
      count: count ?? 0,
      mark: key.endsWith('Interim') ? interimMark(locale) : untranslatedMark(locale),
    });
  const parts: string[] = [describeCoverage(input.coverage, input.sourceMode, locale)];
  const exportParts: string[] = [t('options.export.summary.count', stats.includedCount)];
  if (input.scope === 'favorites') exportParts.push(t('options.export.summary.favoritesOnly'));
  if (stats.missingFavorites)
    exportParts.push(t('options.export.summary.missingFavorites', stats.missingFavorites));
  if (stats.skippedUntranslated)
    exportParts.push(t('options.export.summary.skippedUntranslated', stats.skippedUntranslated));
  if (stats.markedUntranslated)
    exportParts.push(t('options.export.summary.markedUntranslated', stats.markedUntranslated));
  if (stats.skippedInterim)
    exportParts.push(t('options.export.summary.skippedInterim', stats.skippedInterim));
  if (stats.markedInterim)
    exportParts.push(t('options.export.summary.markedInterim', stats.markedInterim));
  if (stats.skippedInvalid)
    exportParts.push(t('options.export.summary.skippedInvalid', stats.skippedInvalid));
  if (stats.fixedTimings)
    exportParts.push(t('options.export.summary.fixedTimings', stats.fixedTimings));
  parts.push(exportParts.join(t('options.export.summary.clauseSeparator')));
  return parts.join(t('options.export.summary.sentenceSeparator'));
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
  locale?: Locale;
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
  const locale = input.locale ?? 'zh-CN';
  if (input.scope === 'favorites') tags.push(translate(locale, 'options.export.file.tagFavorites'));
  if (input.content === 'bilingual')
    tags.push(translate(locale, 'options.export.file.tagBilingual'));
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
  const locale = input.locale ?? 'zh-CN';
  const noteLines = [`NOTE ${translate(locale, 'options.export.file.vttNote')}`];
  const title = singleLine(input.title);
  if (title) noteLines.push(translate(locale, 'options.export.file.title', { title }));
  noteLines.push(
    translate(locale, 'options.export.file.content', { content: contentDescription(input) }),
  );
  // NOTE 内容不能含空行或 `-->`。
  noteLines.push(
    ...normalizeCueLines(
      translate(locale, 'options.export.file.coverage', { coverage: coverageSummary }),
    ),
  );
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
  const locale = input.locale ?? 'zh-CN';
  const header = [translate(locale, 'options.export.file.txtHeader')];
  const title = singleLine(input.title);
  if (title) header.push(translate(locale, 'options.export.file.title', { title }));
  if (input.videoId)
    header.push(
      translate(locale, 'options.export.file.videoId', { id: singleLine(input.videoId) }),
    );
  header.push(
    translate(locale, 'options.export.file.content', { content: contentDescription(input) }),
  );
  header.push(
    translate(locale, 'options.export.file.coverage', { coverage: singleLine(coverageSummary) }),
  );
  const body = entries.length
    ? entries.map((entry) => `[${formatHms(entry.startMs)}] ${entry.lines.join('\n')}`).join('\n\n')
    : translate(locale, 'options.export.file.empty');
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

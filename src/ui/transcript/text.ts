/**
 * 字幕文本的显示与复制格式（纯函数）。
 */
import type { Cue } from '../../domain/cue';
import { formatMediaTime } from '../format';

export type CueViewMode = 'translation' | 'original' | 'bilingual';

export function hasFinalTranslation(cue: Cue): boolean {
  if (cue.translationState === 'skipped') return true;
  return cue.translationState === 'done' && !!cue.translatedText?.trim();
}

export function translationOf(cue: Cue): string | undefined {
  if (cue.translationState === 'skipped') return cue.translatedText?.trim() || cue.sourceText;
  return hasFinalTranslation(cue) ? cue.translatedText : undefined;
}

/** 复制用文本：未完成翻译时明确标注，不把原文冒充译文；临时识别结果标记「[临时]」（与导出一致）。 */
export function cueCopyText(cue: Cue, mode: CueViewMode): string {
  const time = `[${formatMediaTime(cue.startMs)}]${cue.stability === 'interim' ? ' [临时]' : ''}`;
  const translated = translationOf(cue);
  switch (mode) {
    case 'original':
      return `${time} ${cue.sourceText}`;
    case 'translation':
      return translated ? `${time} ${translated}` : `${time} [未翻译] ${cue.sourceText}`;
    case 'bilingual':
      if (!translated) return `${time} [未翻译] ${cue.sourceText}`;
      return translated === cue.sourceText
        ? `${time} ${translated}`
        : `${time} ${translated}\n${cue.sourceText}`;
  }
}

export function cuesCopyText(cues: readonly Cue[], mode: CueViewMode): string {
  return cues.map((c) => cueCopyText(c, mode)).join('\n\n');
}

export function matchesQuery(cue: Cue, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    cue.sourceText.toLowerCase().includes(q) || (cue.translatedText ?? '').toLowerCase().includes(q)
  );
}

/** 笔记中的字幕引用。 */
export function cueQuote(cue: Cue): string {
  const translated = translationOf(cue);
  const time = formatMediaTime(cue.startMs);
  if (translated && translated !== cue.sourceText)
    return `> [${time}] ${translated}\n> ${cue.sourceText}`;
  return `> [${time}] ${translated ?? cue.sourceText}`;
}

/**
 * 模型输出解析与校验。
 *
 * 结构性问题（无法解析、缺失 id、同一 id 给出不同译文）意味着整批映射不可信：
 * 此时不接受这批输出中的任何一条，避免把相邻字幕的译文错配到别的 id 上。
 * 条目级问题（空译文、长度异常、明显错误语言）只影响对应 id。
 */
import { primaryLanguageTag } from '../../domain/languages';
import type { TranslationItem } from './types';

export type ParseResult =
  { ok: true; translations: { id: string; text: string }[] } | { ok: false; reason: string };

/** 去掉 Markdown 代码围栏与 JSON 外的多余文本后解析。 */
export function parseTranslationPayload(raw: string): ParseResult {
  let text = raw.trim();
  if (!text) return { ok: false, reason: 'empty-output' };
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = fence[1]!.trim();

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first === -1 || last <= first) return { ok: false, reason: 'invalid-json' };
    try {
      json = JSON.parse(text.slice(first, last + 1));
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }

  let list: unknown;
  if (Array.isArray(json)) {
    list = json;
  } else if (json && typeof json === 'object') {
    list = (json as Record<string, unknown>).translations;
  }
  if (!Array.isArray(list)) return { ok: false, reason: 'missing-translations-array' };

  const translations: { id: string; text: string }[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') return { ok: false, reason: 'invalid-entry' };
    const e = entry as Record<string, unknown>;
    const id =
      typeof e.id === 'string' ? e.id : typeof e.id === 'number' ? String(e.id) : undefined;
    if (id === undefined || typeof e.text !== 'string')
      return { ok: false, reason: 'invalid-entry' };
    translations.push({ id, text: e.text });
  }
  return { ok: true, translations };
}

export type ItemIssue = 'empty' | 'too-long' | 'wrong-language';

export interface ValidationOutcome {
  /** 结构性失败时为原因；此时 accepted 为空。 */
  structuralError?: string;
  accepted: TranslationItem[];
  /** 需要修复的请求条目（结构性失败时为全部）。 */
  rejected: { item: TranslationItem; issue: ItemIssue | 'missing' }[];
  /** 被忽略的非本批 id 数量。 */
  extraIds: number;
}

const CJK_TARGET: Record<string, RegExp> = {
  zh: /[\u3400-\u9fff\uf900-\ufaff]/u,
  ja: /[\u3040-\u30ff\u3400-\u9fff]/u,
  ko: /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u,
};
const CJK_ANY = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uf900-\ufaff]/gu;
const LETTER = /\p{L}/gu;

function countMatches(text: string, re: RegExp): number {
  return text.match(re)?.length ?? 0;
}

/** 像自然句子的原文：至少 3 个全小写拉丁单词（排除只有人名、产品名、缩写的行）。 */
function looksLikeLatinSentence(text: string): boolean {
  const words = text.match(/(?<!\p{L})\p{Ll}{2,}(?!\p{L})/gu) ?? [];
  return words.length >= 3;
}

export function detectItemIssue(
  sourceText: string,
  translated: string,
  targetLanguage: string,
): ItemIssue | undefined {
  const out = translated.trim();
  if (!out) return 'empty';
  const src = sourceText.trim();
  if (out.length > 40 + src.length * 5) return 'too-long';

  const target = primaryLanguageTag(targetLanguage);
  const targetScript = CJK_TARGET[target];
  if (targetScript) {
    // 目标为中/日/韩，但一段自然拉丁语句的译文没有任何目标文字 → 很可能没有翻译。
    if (!targetScript.test(out) && looksLikeLatinSentence(src) && countMatches(src, LETTER) >= 12) {
      return 'wrong-language';
    }
  } else if (target) {
    // 目标为拉丁等语言，但译文仍以 CJK 为主且原文是 CJK。
    const srcCjk = countMatches(src, CJK_ANY);
    const outCjk = countMatches(out, CJK_ANY);
    const outLetters = countMatches(out, LETTER);
    if (srcCjk >= 6 && outLetters > 0 && outCjk / outLetters > 0.5) return 'wrong-language';
  }
  return undefined;
}

/** 按请求条目校验模型输出。 */
export function validateTranslations(
  requested: readonly TranslationItem[],
  output: ParseResult,
  targetLanguage: string,
): ValidationOutcome {
  if (!output.ok) {
    return {
      structuralError: output.reason,
      accepted: [],
      rejected: requested.map((item) => ({ item, issue: 'missing' as const })),
      extraIds: 0,
    };
  }
  const wanted = new Map(requested.map((item) => [item.id, item]));
  const got = new Map<string, string>();
  let extraIds = 0;
  let conflict = false;
  for (const t of output.translations) {
    if (!wanted.has(t.id)) {
      extraIds++;
      continue;
    }
    const prev = got.get(t.id);
    if (prev !== undefined && prev.trim() !== t.text.trim()) conflict = true;
    got.set(t.id, t.text);
  }
  const missing = requested.filter((item) => !got.has(item.id));
  if (conflict || missing.length > 0) {
    return {
      structuralError: conflict ? 'duplicate-id' : 'missing-id',
      accepted: [],
      rejected: requested.map((item) => ({ item, issue: 'missing' as const })),
      extraIds,
    };
  }

  const accepted: TranslationItem[] = [];
  const rejected: ValidationOutcome['rejected'] = [];
  for (const item of requested) {
    const text = got.get(item.id)!;
    const issue = detectItemIssue(item.text, text, targetLanguage);
    if (issue) rejected.push({ item, issue });
    else accepted.push({ id: item.id, text: text.trim() });
  }
  return { accepted, rejected, extraIds };
}

/**
 * 从未完成的流式 JSON 文本中提取已经完整出现的 `{ "id": ..., "text": ... }` 条目，
 * 仅用于可回滚的 partial 显示，不作为最终结果。
 */
export function extractPartialTranslations(
  partialJson: string,
  allowedIds: ReadonlySet<string>,
): TranslationItem[] {
  const out = new Map<string, string>();
  const re = /\{\s*"id"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(partialJson))) {
    try {
      const id = JSON.parse(`"${m[1]!}"`) as string;
      const text = JSON.parse(`"${m[2]!}"`) as string;
      if (allowedIds.has(id) && text.trim()) out.set(id, text.trim());
    } catch {
      // 半截转义，跳过
    }
  }
  return [...out].map(([id, text]) => ({ id, text }));
}

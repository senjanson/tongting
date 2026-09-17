/**
 * 术语表草稿校验（纯函数）。
 */
import type { GlossaryEntry } from '../../domain/settings';

export const MAX_GLOSSARY_ENTRIES = 500;
export const MAX_GLOSSARY_TERM = 100;

export interface GlossaryDraftRow {
  key: number;
  source: string;
  target: string;
}

export type GlossaryValidation =
  | { ok: true; entries: GlossaryEntry[] }
  | { ok: false; errors: Map<number, string>; message: string };

/** 去掉完全空白的行；半填写、超长、重复原文都视为错误。 */
export function validateGlossary(rows: readonly GlossaryDraftRow[]): GlossaryValidation {
  const errors = new Map<number, string>();
  const entries: GlossaryEntry[] = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const source = row.source.trim();
    const target = row.target.trim();
    if (!source && !target) continue;
    if (!source || !target) {
      errors.set(row.key, '原文与译文都需要填写。');
      continue;
    }
    if (source.length > MAX_GLOSSARY_TERM || target.length > MAX_GLOSSARY_TERM) {
      errors.set(row.key, `每项最多 ${MAX_GLOSSARY_TERM} 个字符。`);
      continue;
    }
    const dupKey = source.toLowerCase();
    if (seen.has(dupKey)) {
      errors.set(row.key, '原文与前面的条目重复。');
      continue;
    }
    seen.set(dupKey, row.key);
    entries.push({ source, target });
  }
  if (entries.length > MAX_GLOSSARY_ENTRIES) {
    return { ok: false, errors, message: `术语表最多 ${MAX_GLOSSARY_ENTRIES} 条。` };
  }
  if (errors.size > 0) return { ok: false, errors, message: `有 ${errors.size} 行需要修正。` };
  return { ok: true, entries };
}

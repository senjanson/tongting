/**
 * 按目标语言从「实际可用声音列表」中选择声音。不使用硬编码声音名。
 */
import { findTargetLanguage, primaryLanguageTag } from '../../domain/languages';
import type { TtsVoice } from './types';

export function normalizeLangTag(lang: string | undefined): string {
  return (lang ?? '').replace(/_/g, '-').toLowerCase();
}

/** 目标语言的匹配前缀（优先级从高到低）。 */
export function languagePrefixes(lang: string): string[] {
  const option = findTargetLanguage(lang);
  const list = option ? option.ttsLangPrefixes : [lang, primaryLanguageTag(lang)];
  return Array.from(new Set(list.map(normalizeLangTag).filter(Boolean)));
}

/** 普通话目标不接受粤语声音；返回 -1 表示不匹配，数值越小越优先。 */
export function voiceLanguageRank(voice: TtsVoice, lang: string, allowUnlabeled: boolean): number {
  const voiceLang = normalizeLangTag(voice.lang);
  const prefixes = languagePrefixes(lang);
  if (!voiceLang) return allowUnlabeled ? prefixes.length : -1;
  const target = normalizeLangTag(lang);
  if ((target === 'zh-cn' || target === 'zh-hans') && /^(zh-hk|yue)/.test(voiceLang)) return -1;
  for (let i = 0; i < prefixes.length; i++) {
    const p = prefixes[i]!;
    if (voiceLang === p || voiceLang.startsWith(`${p}-`)) return i;
  }
  return -1;
}

export type VoiceSelection =
  | { ok: true; voice: TtsVoice; usedPreferred: boolean }
  | { ok: false; reason: 'no-voice-for-language' };

export function selectVoice(
  voices: readonly TtsVoice[],
  lang: string,
  preferredName?: string,
  options: { allowUnlabeled?: boolean } = {},
): VoiceSelection {
  const allowUnlabeled = options.allowUnlabeled ?? false;
  if (preferredName) {
    const preferred = voices.find((v) => v.voiceName === preferredName);
    if (preferred && voiceLanguageRank(preferred, lang, allowUnlabeled) >= 0) {
      return { ok: true, voice: preferred, usedPreferred: true };
    }
  }
  let best: TtsVoice | undefined;
  let bestRank = Infinity;
  for (const v of voices) {
    const rank = voiceLanguageRank(v, lang, allowUnlabeled);
    if (rank < 0) continue;
    // 同等优先级时优先本地声音（remote 可能依赖网络）。
    const score = rank * 2 + (v.remote ? 1 : 0);
    if (score < bestRank) {
      bestRank = score;
      best = v;
    }
  }
  return best
    ? { ok: true, voice: best, usedPreferred: false }
    : { ok: false, reason: 'no-voice-for-language' };
}

/**
 * 界面文案格式化工具。所有函数的最后一个参数为界面语言；省略时使用当前页面语言（getLocale）。
 * 中文界面沿用 languages 表中的名称；英文界面使用本文件维护的英文语言名。
 */
import type { CapabilityStatus } from '../domain/capability';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../domain/languages';
import { getLocale, translate, type Locale } from '../i18n';

const EXTRA_LANGUAGE_LABELS: Record<string, string> = {
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  'zh-HK': '繁體中文（香港）',
  'en-US': '英语（美国）',
  'en-GB': '英语（英国）',
};

/** 英文界面的语言名（覆盖目标语言、源语言与常见地区变体）。 */
const ENGLISH_LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese',
  'zh-TW': 'Traditional Chinese',
  'zh-Hans': 'Simplified Chinese',
  'zh-Hant': 'Traditional Chinese',
  'zh-HK': 'Traditional Chinese (Hong Kong)',
  zh: 'Chinese',
  en: 'English',
  'en-US': 'English (US)',
  'en-GB': 'English (UK)',
  ja: 'Japanese',
  ko: 'Korean',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ru: 'Russian',
  uk: 'Ukrainian',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
};

function primaryTag(code: string): string {
  return code.split(/[-_]/)[0]?.toLowerCase() ?? '';
}

/** 表外代码：借助 Intl.DisplayNames 取英文名，失败时返回 undefined。 */
function intlEnglishName(code: string): string | undefined {
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(code);
    return name && name !== code ? name : undefined;
  } catch {
    return undefined;
  }
}

function englishLanguageLabel(code: string): string {
  const known = ENGLISH_LANGUAGE_NAMES[code];
  if (known) return known;
  const primary = ENGLISH_LANGUAGE_NAMES[primaryTag(code)];
  if (primary) return translate('en', 'common.language.withCode', { name: primary, code });
  return intlEnglishName(code) ?? code;
}

/** 语言代码 → 显示名；未知代码原样显示。 */
export function languageLabel(
  code: string | undefined | null,
  locale: Locale = getLocale(),
): string {
  if (!code) return translate(locale, 'common.unknown');
  if (code === 'und') return translate(locale, 'common.language.und');
  if (locale === 'en') return englishLanguageLabel(code);
  const target = TARGET_LANGUAGES.find((l) => l.code === code);
  if (target) return target.label;
  const source = SOURCE_LANGUAGES.find((l) => l.code === code);
  if (source) return source.label;
  if (EXTRA_LANGUAGE_LABELS[code]) return EXTRA_LANGUAGE_LABELS[code];
  const byPrimary = SOURCE_LANGUAGES.find((l) => l.code === primaryTag(code));
  return byPrimary
    ? translate(locale, 'common.language.withCode', { name: byPrimary.label, code })
    : code;
}

/** 源语言显示名：中文界面优先使用中文名称（例如「英语」），目标语言表中的原生名称作为次选。 */
export function sourceLanguageLabel(
  code: string | undefined | null,
  locale: Locale = getLocale(),
): string {
  if (!code) return translate(locale, 'common.unknown');
  if (code === 'auto') return translate(locale, 'common.language.auto');
  if (locale === 'en') return languageLabel(code, locale);
  const source = SOURCE_LANGUAGES.find((l) => l.code === code);
  return source ? source.label : languageLabel(code, locale);
}

/** AI 搜索界面使用的书面语言名（「英文」「日文」），比「英语」更贴近搜索词、释义的语境。 */
const SEARCH_LANGUAGE_NAMES: Record<string, string> = {
  en: '英文',
  ja: '日文',
  ko: '韩文',
  es: '西班牙文',
  fr: '法文',
  de: '德文',
  it: '意大利文',
  pt: '葡萄牙文',
  nl: '荷兰文',
  pl: '波兰文',
  tr: '土耳其文',
  ru: '俄文',
  uk: '乌克兰文',
  ar: '阿拉伯文',
  hi: '印地文',
  th: '泰文',
  vi: '越南文',
  id: '印尼文',
};

/**
 * AI 搜索界面的语言名。简体中文通常直接叫「中文」，只有与繁体中文同时出现时才写「简体中文」；
 * 繁体中文始终写「繁体中文」。other 为同一界面上另一个语言，用于区分简繁。
 */
export function searchLanguageName(
  code: string,
  other?: string,
  locale: Locale = getLocale(),
): string {
  const primary = primaryTag(code);
  if (locale === 'en') {
    if (primary === 'zh') {
      if (code === 'zh-TW') return 'Traditional Chinese';
      return other === 'zh-TW' ? 'Simplified Chinese' : 'Chinese';
    }
    return (
      ENGLISH_LANGUAGE_NAMES[code] ?? ENGLISH_LANGUAGE_NAMES[primary] ?? englishLanguageLabel(code)
    );
  }
  if (primary === 'zh') {
    if (code === 'zh-TW') return '繁体中文';
    return other === 'zh-TW' ? '简体中文' : '中文';
  }
  return (
    SEARCH_LANGUAGE_NAMES[code] ??
    SEARCH_LANGUAGE_NAMES[primary] ??
    sourceLanguageLabel(code, locale)
  );
}

/** 媒体时间 → `m:ss` 或 `h:mm:ss`。 */
export function formatMediaTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 本地时间：中文 `YYYY-MM-DD HH:mm`，英文 `Sep 24, 2026, 14:05`。 */
export function formatDateTime(epochMs: number | undefined, locale: Locale = getLocale()): string {
  if (!epochMs || !Number.isFinite(epochMs)) return translate(locale, 'common.time.unknown');
  const d = new Date(epochMs);
  if (locale === 'en') {
    return new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(d);
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 本地日期：中文 `2026/9/24`，英文 `Sep 24, 2026`。 */
export function formatDate(epochMs: number, locale: Locale = getLocale()): string {
  if (!Number.isFinite(epochMs)) return translate(locale, 'common.time.unknown');
  const d = new Date(epochMs);
  return locale === 'en'
    ? new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric' }).format(
        d,
      )
    : d.toLocaleDateString('zh-CN');
}

export function formatLatency(ms: number | undefined, locale: Locale = getLocale()): string {
  if (ms === undefined || !Number.isFinite(ms)) return translate(locale, 'common.unknown');
  return ms >= 1000
    ? translate(locale, 'common.latency.seconds', { value: (ms / 1000).toFixed(1) })
    : translate(locale, 'common.latency.ms', { value: Math.round(ms) });
}

export function capabilityStatusLabel(
  status: CapabilityStatus | undefined,
  locale: Locale = getLocale(),
): string {
  switch (status) {
    case 'verified':
      return translate(locale, 'common.capability.verified');
    case 'failed':
      return translate(locale, 'common.capability.failed');
    case 'unsupported':
      return translate(locale, 'common.capability.unsupported');
    default:
      return translate(locale, 'common.capability.unchecked');
  }
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

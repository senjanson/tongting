/**
 * 语言表。targetLanguages 只是 UI 可选项，实际可用范围取决于翻译模型、识别与语音合成能力的交集，
 * 由能力矩阵另行标注，不在此处宣称支持。
 */
export interface LanguageOption {
  code: string;
  label: string;
  /** 写入提示词时使用的英文名称，避免模型误解缩写。 */
  promptName: string;
  /** 匹配系统语音时使用的 BCP-47 前缀。 */
  ttsLangPrefixes: string[];
}

export const TARGET_LANGUAGES: readonly LanguageOption[] = [
  {
    code: 'zh-CN',
    label: '简体中文',
    promptName: 'Simplified Chinese',
    ttsLangPrefixes: ['zh-CN', 'cmn-CN', 'zh-Hans', 'zh'],
  },
  {
    code: 'zh-TW',
    label: '繁體中文',
    promptName: 'Traditional Chinese (Taiwan)',
    ttsLangPrefixes: ['zh-TW', 'zh-HK', 'zh-Hant'],
  },
  { code: 'en', label: 'English', promptName: 'English', ttsLangPrefixes: ['en'] },
  { code: 'ja', label: '日本語', promptName: 'Japanese', ttsLangPrefixes: ['ja'] },
  { code: 'ko', label: '한국어', promptName: 'Korean', ttsLangPrefixes: ['ko'] },
  { code: 'es', label: 'Español', promptName: 'Spanish', ttsLangPrefixes: ['es'] },
  { code: 'fr', label: 'Français', promptName: 'French', ttsLangPrefixes: ['fr'] },
  { code: 'de', label: 'Deutsch', promptName: 'German', ttsLangPrefixes: ['de'] },
] as const;

export const SOURCE_LANGUAGES: readonly { code: string; label: string }[] = [
  { code: 'auto', label: '自动识别' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'es', label: '西班牙语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'zh', label: '中文' },
  { code: 'ru', label: '俄语' },
  { code: 'pt', label: '葡萄牙语' },
] as const;

export const DEFAULT_TARGET_LANGUAGE = 'zh-CN';

export function findTargetLanguage(code: string): LanguageOption | undefined {
  return TARGET_LANGUAGES.find((l) => l.code === code);
}

/** 取语言主标签，例如 `en-US` → `en`，`zh-Hans` → `zh`。 */
export function primaryLanguageTag(code: string | undefined): string {
  if (!code) return '';
  return code.toLowerCase().split(/[-_]/)[0] ?? '';
}

/** 源语言与目标语言是否为同一语言（用于跳过同语言翻译）。中文简繁不视为同一语言。 */
export function isSameLanguage(source: string | undefined, target: string): boolean {
  if (!source || source === 'auto') return false;
  const s = source.toLowerCase();
  const t = target.toLowerCase();
  if (s === t) return true;
  if (primaryLanguageTag(s) === 'zh' || primaryLanguageTag(t) === 'zh') {
    // 中文按书写系统判断：简体与繁体之间仍需转换；无法判断书写系统（如单独的 zh）时按不同处理。
    const a = chineseScript(s);
    return !!a && a === chineseScript(t);
  }
  return primaryLanguageTag(s) === primaryLanguageTag(t);
}

function chineseScript(tag: string): 'hans' | 'hant' | undefined {
  const parts = tag.toLowerCase().split(/[-_]/);
  if (parts[0] !== 'zh') return undefined;
  if (parts.includes('hant')) return 'hant';
  if (parts.includes('hans')) return 'hans';
  if (parts.some((p) => p === 'tw' || p === 'hk' || p === 'mo')) return 'hant';
  if (parts.some((p) => p === 'cn' || p === 'sg' || p === 'my')) return 'hans';
  return undefined;
}

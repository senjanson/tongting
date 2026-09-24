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
  { code: 'it', label: 'Italiano', promptName: 'Italian', ttsLangPrefixes: ['it'] },
  {
    code: 'pt',
    label: 'Português',
    promptName: 'Portuguese',
    ttsLangPrefixes: ['pt-BR', 'pt-PT', 'pt'],
  },
  { code: 'nl', label: 'Nederlands', promptName: 'Dutch', ttsLangPrefixes: ['nl'] },
  { code: 'pl', label: 'Polski', promptName: 'Polish', ttsLangPrefixes: ['pl'] },
  { code: 'tr', label: 'Türkçe', promptName: 'Turkish', ttsLangPrefixes: ['tr'] },
  { code: 'ru', label: 'Русский', promptName: 'Russian', ttsLangPrefixes: ['ru'] },
  { code: 'uk', label: 'Українська', promptName: 'Ukrainian', ttsLangPrefixes: ['uk'] },
  { code: 'ar', label: 'العربية', promptName: 'Arabic', ttsLangPrefixes: ['ar'] },
  { code: 'hi', label: 'हिन्दी', promptName: 'Hindi', ttsLangPrefixes: ['hi'] },
  { code: 'th', label: 'ไทย', promptName: 'Thai', ttsLangPrefixes: ['th'] },
  { code: 'vi', label: 'Tiếng Việt', promptName: 'Vietnamese', ttsLangPrefixes: ['vi'] },
  {
    code: 'id',
    label: 'Bahasa Indonesia',
    promptName: 'Indonesian',
    ttsLangPrefixes: ['id', 'in'],
  },
] as const;

/** 源语言选项：label 为中文名，labelEn 为英文界面使用的名称（见 sourceLanguageLabel）。 */
export interface SourceLanguageOption {
  code: string;
  label: string;
  labelEn: string;
}

export const SOURCE_LANGUAGES: readonly SourceLanguageOption[] = [
  { code: 'auto', label: '自动识别', labelEn: 'Auto-detect' },
  { code: 'en', label: '英语', labelEn: 'English' },
  { code: 'ja', label: '日语', labelEn: 'Japanese' },
  { code: 'ko', label: '韩语', labelEn: 'Korean' },
  { code: 'es', label: '西班牙语', labelEn: 'Spanish' },
  { code: 'fr', label: '法语', labelEn: 'French' },
  { code: 'de', label: '德语', labelEn: 'German' },
  { code: 'zh', label: '中文', labelEn: 'Chinese' },
  { code: 'ru', label: '俄语', labelEn: 'Russian' },
  { code: 'pt', label: '葡萄牙语', labelEn: 'Portuguese' },
  { code: 'it', label: '意大利语', labelEn: 'Italian' },
  { code: 'nl', label: '荷兰语', labelEn: 'Dutch' },
  { code: 'pl', label: '波兰语', labelEn: 'Polish' },
  { code: 'tr', label: '土耳其语', labelEn: 'Turkish' },
  { code: 'uk', label: '乌克兰语', labelEn: 'Ukrainian' },
  { code: 'ar', label: '阿拉伯语', labelEn: 'Arabic' },
  { code: 'hi', label: '印地语', labelEn: 'Hindi' },
  { code: 'th', label: '泰语', labelEn: 'Thai' },
  { code: 'vi', label: '越南语', labelEn: 'Vietnamese' },
  { code: 'id', label: '印尼语', labelEn: 'Indonesian' },
] as const;

/** 按界面语言取源语言名称；目标语言表使用各语言的自称，无需按界面语言切换。 */
export function sourceLanguageLabel(option: SourceLanguageOption, locale: 'zh-CN' | 'en'): string {
  return locale === 'en' ? option.labelEn : option.label;
}

export const DEFAULT_TARGET_LANGUAGE = 'zh-CN';

/**
 * 首次安装、设置损坏回退或「恢复默认设置」时按浏览器界面语言挑默认目标语言。
 * 中文界面按简繁保持中文；其余界面优先匹配受支持的同一语言，匹配不到用英文——
 * 看不懂中文的人不应该默认拿到中文字幕。检测不到界面语言时保持内置默认值。
 * 只用于产生初始默认值，绝不覆盖用户已保存的选择。
 */
export function defaultTargetLanguageFor(uiLanguage: string | undefined): string {
  const tag = (uiLanguage ?? '').trim().toLowerCase();
  if (!tag) return DEFAULT_TARGET_LANGUAGE;
  if (primaryLanguageTag(tag) === 'zh')
    return chineseScript(tag) === 'hant' ? 'zh-TW' : DEFAULT_TARGET_LANGUAGE;
  const exact = TARGET_LANGUAGES.find((l) => l.code.toLowerCase() === tag);
  if (exact) return exact.code;
  const primary = primaryLanguageTag(tag);
  const byPrimary = TARGET_LANGUAGES.find(
    (l) => primaryLanguageTag(l.code) === primary && primaryLanguageTag(l.code) !== 'zh',
  );
  return byPrimary?.code ?? 'en';
}

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

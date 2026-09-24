import { z } from 'zod';
import { DEFAULT_TARGET_LANGUAGE, findTargetLanguage } from './languages';
import type { Settings } from './settings';

export const SEARCH_HISTORY_LIMIT = 20;
// A faithful translation of up to 300 input characters may be longer than a search phrase.
export const SEARCH_KEYWORD_MAX_LENGTH = 1200;
/** 搜索词默认使用的语言：YouTube 上英文内容最多。 */
export const DEFAULT_SEARCH_KEYWORD_LANGUAGE = 'en';
/**
 * 旧版本只支持「用中文，搜英文」：没有记录语言的历史记录按此显示。
 */
export const LEGACY_SEARCH_LANGUAGES = { userLanguage: 'zh-CN', keywordLanguage: 'en' } as const;

export const SearchInputSchema = z.string().trim().min(1).max(300);
/**
 * 搜索词与语言无关：单行、非空、无控制字符、有长度上限。
 * 「是否为所选搜索语言」只对新生成的结果检查（见 providers/text/search-keywords），
 * 用户手动编辑与旧历史记录不受影响。此处的规则只能比旧版本更宽松，旧记录才能继续解析。
 */
export const SearchKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(SEARCH_KEYWORD_MAX_LENGTH)
  .refine(
    (value) =>
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      }),
    '请填写单行搜索词',
  );
/** 语言代码格式（BCP-47 形式），只用于记录与设置；不代表模型支持该语言。 */
export const SearchLanguageTagSchema = z
  .string()
  .max(20)
  .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/);
/** 生成请求可选的语言：必须在界面语言表中。 */
export const SearchLanguageSchema = SearchLanguageTagSchema.refine(
  (code) => !!findTargetLanguage(code),
  '不支持的语言',
);
const DisplayText = z.string().trim().min(1);
export const SearchSuggestionSchema = z.object({
  label: DisplayText.max(40),
  keyword: SearchKeywordSchema,
  annotation: DisplayText.max(160),
});
export const SearchSuggestionsSchema = z
  .array(SearchSuggestionSchema)
  .length(3)
  .refine(
    (items) =>
      new Set(items.map((item) => item.keyword.toLowerCase().replace(/\s+/g, ' '))).size === 3,
    '搜索词不能重复',
  );
export type SearchSuggestion = z.infer<typeof SearchSuggestionSchema>;
export const SearchRecordSchema = z.object({
  id: z.string().min(1).max(64),
  query: SearchInputSchema,
  items: SearchSuggestionsSchema,
  model: z.string().min(1).max(200),
  createdAt: z.number().nonnegative(),
  /** 输入、标签与释义的语言；旧记录没有此字段。 */
  userLanguage: SearchLanguageTagSchema.optional(),
  /** 搜索词的语言；旧记录没有此字段。 */
  keywordLanguage: SearchLanguageTagSchema.optional(),
});
export type SearchRecord = z.infer<typeof SearchRecordSchema>;

export interface SearchLanguages {
  userLanguage: string;
  keywordLanguage: string;
}

/**
 * 搜索页实际使用的语言。「我的语言」未单独选择时跟随翻译目标语言（它本身按浏览器界面语言确定）；
 * 设置里出现语言表之外的代码（例如手工导入的旧配置）时回退到默认值，不把未知代码发给模型。
 */
export function resolveSearchLanguages(settings: Pick<Settings, 'targetLanguage' | 'search'>) {
  const pick = (code: string | undefined) => (code && findTargetLanguage(code) ? code : undefined);
  return {
    userLanguage:
      pick(settings.search.userLanguage) ??
      pick(settings.targetLanguage) ??
      DEFAULT_TARGET_LANGUAGE,
    keywordLanguage: pick(settings.search.keywordLanguage) ?? DEFAULT_SEARCH_KEYWORD_LANGUAGE,
  } satisfies SearchLanguages;
}

/** 记录生成时使用的语言；旧记录按当时唯一支持的「中文 → 英文」显示。 */
export function searchRecordLanguages(record: SearchRecord): SearchLanguages {
  return {
    userLanguage: record.userLanguage ?? LEGACY_SEARCH_LANGUAGES.userLanguage,
    keywordLanguage: record.keywordLanguage ?? LEGACY_SEARCH_LANGUAGES.keywordLanguage,
  };
}

/** Search words are data, never URLs or executable markup. */
export function youtubeSearchUrl(keyword: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(SearchKeywordSchema.parse(keyword))}`;
}

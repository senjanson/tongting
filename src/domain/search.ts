import { z } from 'zod';

export const SEARCH_HISTORY_LIMIT = 20;
// A faithful translation of up to 300 Chinese characters may be longer than a search phrase.
export const SEARCH_KEYWORD_MAX_LENGTH = 1200;
export const SearchInputSchema = z.string().trim().min(1).max(300);
export const SearchKeywordSchema = z
  .string()
  .trim()
  .min(1)
  .max(SEARCH_KEYWORD_MAX_LENGTH)
  .regex(/[a-z]/i, '请填写英文搜索词')
  .refine(
    (value) =>
      !/\p{Script=Han}/u.test(value) &&
      [...value].every((character) => {
        const code = character.codePointAt(0)!;
        return code >= 32 && code !== 127;
      }),
    '请填写单行英文搜索词',
  );
const ChineseText = z
  .string()
  .trim()
  .min(1)
  .regex(/\p{Script=Han}/u);
export const SearchSuggestionSchema = z.object({
  label: ChineseText.max(20),
  keyword: SearchKeywordSchema,
  annotation: ChineseText.max(160),
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
});
export type SearchRecord = z.infer<typeof SearchRecordSchema>;

/** Search words are data, never URLs or executable markup. */
export function youtubeSearchUrl(keyword: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(SearchKeywordSchema.parse(keyword))}`;
}

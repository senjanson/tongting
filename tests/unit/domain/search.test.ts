import { describe, expect, it } from 'vitest';
import {
  SearchKeywordSchema,
  SearchRecordSchema,
  resolveSearchLanguages,
  searchRecordLanguages,
  youtubeSearchUrl,
} from '@src/domain/search';
import {
  SettingsPatchSchema,
  SettingsSchema,
  applySettingsPatch,
  defaultSettings,
  initialSettings,
  translationFingerprint,
} from '@src/domain/settings';
import { buildSettingsExport } from '@src/ui/options/export-settings';
import { searchRecord } from '../../fixtures/search';

describe('language-agnostic search keywords', () => {
  it.each([
    'YouTube AI editing tutorial',
    'AI 剪辑教程',
    'AI 動画編集 入門',
    '요리 기초',
    'монтаж видео',
    'ตัดต่อวิดีโอ',
    'تعديل الفيديو',
  ])('accepts a single-line keyword in any script: %s', (keyword) => {
    expect(SearchKeywordSchema.parse(keyword)).toBe(keyword);
    expect(youtubeSearchUrl(keyword)).toBe(
      `https://www.youtube.com/results?search_query=${encodeURIComponent(keyword)}`,
    );
  });

  it.each([
    '',
    '   ',
    'line one\nline two',
    'tab\there',
    'bell\u0007',
    'del\u007f',
    'x'.repeat(1201),
  ])('rejects empty, multi-line, control-character or oversized keywords', (keyword) => {
    expect(SearchKeywordSchema.safeParse(keyword).success).toBe(false);
    expect(() => youtubeSearchUrl(keyword)).toThrow();
  });

  it('encodes URL-like keywords as search data', () => {
    expect(youtubeSearchUrl('https://evil.test/?a=1&b=<script>')).toBe(
      'https://www.youtube.com/results?search_query=https%3A%2F%2Fevil.test%2F%3Fa%3D1%26b%3D%3Cscript%3E',
    );
  });

  it('keeps legacy records valid and shows them as Chinese → English', () => {
    const legacy = SearchRecordSchema.parse(searchRecord);
    expect(legacy).not.toHaveProperty('userLanguage');
    expect(searchRecordLanguages(legacy)).toEqual({ userLanguage: 'zh-CN', keywordLanguage: 'en' });
    const labelled = SearchRecordSchema.parse({
      ...searchRecord,
      userLanguage: 'fr',
      keywordLanguage: 'de',
      items: searchRecord.items.map((item, i) => ({
        ...item,
        label: `Traduction directe de la requête ${i}`,
        annotation: 'Explication en français',
      })),
    });
    expect(searchRecordLanguages(labelled)).toEqual({ userLanguage: 'fr', keywordLanguage: 'de' });
    expect(
      SearchRecordSchema.safeParse({ ...searchRecord, keywordLanguage: 'en; drop' }).success,
    ).toBe(false);
    expect(
      SearchRecordSchema.safeParse({
        ...searchRecord,
        items: searchRecord.items.map((item) => ({ ...item, label: 'x'.repeat(41) })),
      }).success,
    ).toBe(false);
  });
});

describe('search language settings', () => {
  it('defaults: my language follows the target language, search language is English', () => {
    const settings = initialSettings('ja-JP');
    expect(settings.search).toEqual({ keywordLanguage: 'en' });
    expect(resolveSearchLanguages(settings)).toEqual({ userLanguage: 'ja', keywordLanguage: 'en' });
    expect(resolveSearchLanguages(initialSettings('fi-FI'))).toEqual({
      userLanguage: 'en',
      keywordLanguage: 'en',
    });
    const retargeted = applySettingsPatch(settings, { targetLanguage: 'ko' });
    expect(resolveSearchLanguages(retargeted).userLanguage).toBe('ko');
  });

  it('parses stored settings without the search field and without migration', () => {
    const { search: _search, ...legacy } = defaultSettings('zh-TW');
    const parsed = SettingsSchema.parse(legacy);
    expect(parsed.search).toEqual({ keywordLanguage: 'en' });
    expect(resolveSearchLanguages(parsed)).toEqual({
      userLanguage: 'zh-TW',
      keywordLanguage: 'en',
    });
  });

  it('merges nested search patches without resetting the other field or unrelated settings', () => {
    const base = applySettingsPatch(defaultSettings(), { provider: { model: 'custom-model' } });
    const patch = SettingsPatchSchema.parse({ search: { userLanguage: 'fr' } });
    expect(patch).toEqual({ search: { userLanguage: 'fr' } });
    const a = applySettingsPatch(base, patch);
    expect(a.search).toEqual({ userLanguage: 'fr', keywordLanguage: 'en' });
    expect(a.provider.model).toBe('custom-model');
    const b = applySettingsPatch(a, { search: { keywordLanguage: 'es' } });
    expect(b.search).toEqual({ userLanguage: 'fr', keywordLanguage: 'es' });
    expect(
      resolveSearchLanguages(applySettingsPatch(b, { targetLanguage: 'de' })).userLanguage,
    ).toBe('fr');
    expect(SettingsPatchSchema.safeParse({ search: { keywordLanguage: 'en"; x' } }).success).toBe(
      false,
    );
  });

  it('falls back to defaults for codes outside the language table', () => {
    const settings = SettingsSchema.parse({
      ...defaultSettings(),
      search: { userLanguage: 'xx', keywordLanguage: 'yy' },
    });
    expect(resolveSearchLanguages(settings)).toEqual({
      userLanguage: 'zh-CN',
      keywordLanguage: 'en',
    });
  });

  it('does not affect the translation fingerprint and is included in exported settings', () => {
    const base = defaultSettings();
    const changed = applySettingsPatch(base, {
      search: { userLanguage: 'en', keywordLanguage: 'ja' },
    });
    expect(translationFingerprint(changed)).toBe(translationFingerprint(base));
    expect(buildSettingsExport(changed).settings.search).toEqual({
      userLanguage: 'en',
      keywordLanguage: 'ja',
    });
  });
});

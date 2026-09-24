import { describe, expect, it } from 'vitest';
import { background } from '@src/i18n/areas/background';
import { common } from '@src/i18n/areas/common';
import { options } from '@src/i18n/areas/options';
import { sidepanel } from '@src/i18n/areas/sidepanel';
import { CATALOGS, resolveLocale, translate, type MessageKey } from '@src/i18n';

describe('resolveLocale', () => {
  it('中文浏览器（含繁体）显示中文，其他语言一律英文', () => {
    for (const ui of ['zh', 'zh-CN', 'zh-TW', 'zh-HK', 'ZH_cn'])
      expect(resolveLocale('auto', ui)).toBe('zh-CN');
    for (const ui of ['en-US', 'ja', 'fr-FR', 'ar', '', undefined])
      expect(resolveLocale('auto', ui)).toBe('en');
  });

  it('手动选择优先于浏览器语言', () => {
    expect(resolveLocale('en', 'zh-CN')).toBe('en');
    expect(resolveLocale('zh-CN', 'en-US')).toBe('zh-CN');
    expect(resolveLocale(undefined, 'zh-CN')).toBe('zh-CN');
  });
});

describe('message catalogs', () => {
  it.each([
    ['common', common],
    ['sidepanel', sidepanel],
    ['options', options],
    ['background', background],
  ] as const)('%s: 中英文案键一致且非空', (area, catalog) => {
    const zh = Object.keys(catalog['zh-CN']).sort();
    expect(Object.keys(catalog.en).sort()).toEqual(zh);
    for (const key of zh) {
      expect(key.startsWith(`${area}.`)).toBe(true);
      expect((catalog['zh-CN'] as Record<string, string>)[key]!.trim()).not.toBe('');
      expect((catalog.en as Record<string, string>)[key]!.trim()).not.toBe('');
    }
  });

  it('各区域键不重复', () => {
    const total = [common, sidepanel, options, background].reduce(
      (n, c) => n + Object.keys(c['zh-CN']).length,
      0,
    );
    expect(Object.keys(CATALOGS['zh-CN'])).toHaveLength(total);
  });

  it('两种语言的占位符一致', () => {
    const holes = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(CATALOGS['zh-CN']))
      expect(holes(CATALOGS.en[key]!), key).toEqual(holes(CATALOGS['zh-CN'][key]!));
  });

  it('插值与缺失参数', () => {
    const key = 'common.localePreference.en' as MessageKey;
    expect(translate('en', key)).toBe('English');
    expect(translate('zh-CN', 'common.localePreference.auto')).toBe('跟随浏览器');
  });
});

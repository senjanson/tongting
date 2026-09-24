/**
 * 界面语言：只有简体中文与英文两套文案。中文浏览器（含繁体界面）显示中文，其余一律英文。
 * 用户可在设置中手动指定（uiLocale），默认跟随浏览器界面语言。
 */
export type Locale = 'zh-CN' | 'en';
export type LocalePreference = 'auto' | Locale;

export const LOCALE_PREFERENCES: readonly LocalePreference[] = ['auto', 'zh-CN', 'en'];

export function resolveLocale(
  preference: LocalePreference | undefined,
  uiLanguage: string | undefined,
): Locale {
  if (preference === 'zh-CN' || preference === 'en') return preference;
  const primary = (uiLanguage ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'zh' ? 'zh-CN' : 'en';
}

/**
 * React 绑定：页面在根组件用 I18nProvider 提供语言，组件用 useT() 取文案。
 * 语言来自快照中的设置（settings.uiLocale）与浏览器界面语言；快照到达前按浏览器界面语言显示。
 */
import { createContext, useCallback, useContext, type ReactNode } from 'react';
import { browser } from 'wxt/browser';
import {
  resolveLocale,
  translate,
  type Locale,
  type LocalePreference,
  type MessageKey,
  type MessageParams,
} from './index';

const LocaleContext = createContext<Locale>('zh-CN');

export function browserUiLanguage(): string | undefined {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return typeof navigator !== 'undefined' ? navigator.language : undefined;
  }
}

export function I18nProvider({
  preference,
  locale,
  children,
}: {
  preference?: LocalePreference;
  /** 直接指定（测试、演示）；优先于 preference。 */
  locale?: Locale;
  children: ReactNode;
}) {
  const value = locale ?? resolveLocale(preference, browserUiLanguage());
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function useT(): Translate {
  const locale = useLocale();
  return useCallback((key, params) => translate(locale, key, params), [locale]);
}

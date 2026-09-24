/**
 * 文案查找与插值。界面与 service worker 共用：
 * - 页面通过 react.tsx 的 I18nProvider / useT 取得当前语言；
 * - worker 与其他非 React 代码在确定语言后调用 setLocale，随后 t() 使用该语言生成消息。
 * 占位符写作 `{name}`，缺失参数原样保留，便于发现漏传。
 */
import { background } from './areas/background';
import { common } from './areas/common';
import { options } from './areas/options';
import { sidepanel } from './areas/sidepanel';
import type { Locale } from './locale';

export * from './locale';

const AREAS = [common, sidepanel, options, background] as const;

type Catalog = (typeof common)['zh-CN'] &
  (typeof sidepanel)['zh-CN'] &
  (typeof options)['zh-CN'] &
  (typeof background)['zh-CN'];
export type MessageKey = keyof Catalog;
export type MessageParams = Record<string, string | number>;

export const CATALOGS: Record<Locale, Record<string, string>> = {
  'zh-CN': Object.assign({}, ...AREAS.map((area) => area['zh-CN'])),
  en: Object.assign({}, ...AREAS.map((area) => area.en)),
};

export function translate(locale: Locale, key: MessageKey, params?: MessageParams): string {
  const template = CATALOGS[locale][key] ?? CATALOGS['zh-CN'][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

let current: Locale = 'zh-CN';

/** 非 React 代码（worker、内容脚本）使用的当前语言。 */
export function setLocale(locale: Locale): void {
  current = locale;
}

export function getLocale(): Locale {
  return current;
}

export function t(key: MessageKey, params?: MessageParams): string {
  return translate(current, key, params);
}

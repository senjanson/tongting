/**
 * 页面根部的界面语言：按快照中的 settings.uiLocale 与浏览器界面语言确定，快照到达前按浏览器界面语言显示。
 * 同时同步到 i18n 的当前语言（setLocale），使非 React 代码（客户端错误、地址校验等）生成的文案与界面一致。
 * 同时更新 <html lang>，便于读屏与按语言调整的样式。必须放在 UiClientProvider 内部。
 * 外观主题同样在这里跟随快照中的 settings.uiTheme（快照到达前保持页面启动时的本机记录）。
 */
import { useEffect, type ReactNode } from 'react';
import { resolveLocale, setLocale, type Locale } from '../../i18n';
import { browserUiLanguage, I18nProvider } from '../../i18n/react';
import { useClientState } from '../state/hooks';
import { applyUiTheme } from '../theme/themes';

export function useSnapshotLocale(): Locale {
  const { snapshot } = useClientState();
  return resolveLocale(snapshot?.settings.uiLocale, browserUiLanguage());
}

export function SnapshotI18nProvider({
  locale,
  children,
}: {
  /** 直接指定（测试）；优先于快照设置。 */
  locale?: Locale;
  children: ReactNode;
}) {
  const fromSnapshot = useSnapshotLocale();
  const theme = useClientState().snapshot?.settings.uiTheme;
  useEffect(() => {
    if (theme) applyUiTheme(theme);
  }, [theme]);
  const resolved = locale ?? fromSnapshot;
  // 渲染期间同步（幂等）：同一次渲染中非组件代码生成的文案即可使用新语言。
  setLocale(resolved);
  useEffect(() => {
    document.documentElement.lang = resolved;
  }, [resolved]);
  return <I18nProvider locale={resolved}>{children}</I18nProvider>;
}

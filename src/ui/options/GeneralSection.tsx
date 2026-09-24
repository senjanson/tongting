/**
 * 常规设置：界面语言（跟随浏览器 / 中文 / English）与外观主题。
 *
 * 界面语言切换后立即以新语言显示（乐观切换），同时发送 settings/update；未被 worker 接受时恢复原显示，
 * 被接受却没有出现在快照中时（例如旧版 worker），稍后也恢复为快照中的真实值。
 * 外观主题由 ThemePicker 发送 settings/update，页面外观随快照中的 settings.uiTheme 切换（见 LocaleRoot）。
 */
import { LOCALE_PREFERENCES, type LocalePreference } from '../../i18n';
import { useT } from '../../i18n/react';
import { Hint, SelectField } from '../components/controls';
import { useSettingsUpdater } from '../shared/hooks';
import { ThemePicker } from '../shared/ThemePicker';
import type { UiThemePreference } from '../theme/themes';
import { Section } from './common';
import styles from './options.module.css';

export function GeneralSection({
  uiLocale,
  uiTheme,
  onPreviewLocale,
}: {
  uiLocale: LocalePreference;
  uiTheme: UiThemePreference;
  onPreviewLocale(value: LocalePreference | null, settled?: LocalePreference): void;
}) {
  const t = useT();
  const update = useSettingsUpdater();
  const change = async (value: LocalePreference) => {
    if (value === uiLocale) return;
    onPreviewLocale(value);
    if (!(await update({ uiLocale: value }))) onPreviewLocale(null);
    else onPreviewLocale(null, value);
  };
  return (
    <Section
      id="general"
      title={t('options.section.general')}
      description={t('options.general.description')}
    >
      <SelectField<LocalePreference>
        label={t('options.general.uiLocale')}
        value={uiLocale}
        onChange={(value) => void change(value)}
        options={LOCALE_PREFERENCES.map((value) => ({
          value,
          label: t(`common.localePreference.${value}`),
        }))}
        hint={t('options.general.uiLocaleHint')}
      />
      <div className={styles.themeBlock}>
        <ThemePicker value={uiTheme} titleAs="h3" className={styles.themePicker} />
        <Hint>{t('options.general.themeHint')}</Hint>
      </div>
    </Section>
  );
}

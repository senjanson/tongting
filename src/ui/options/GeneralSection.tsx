/**
 * 常规设置：界面语言（跟随浏览器 / 中文 / English）。
 *
 * 切换后立即以新语言显示（乐观切换），同时发送 settings/update；未被 worker 接受时恢复原显示，
 * 被接受却没有出现在快照中时（例如旧版 worker），稍后也恢复为快照中的真实值。
 */
import { LOCALE_PREFERENCES, type LocalePreference } from '../../i18n';
import { useT } from '../../i18n/react';
import { SelectField } from '../components/controls';
import { useSettingsUpdater } from '../shared/hooks';
import { Section } from './common';

export function GeneralSection({
  uiLocale,
  onPreviewLocale,
}: {
  uiLocale: LocalePreference;
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
    </Section>
  );
}

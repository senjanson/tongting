/**
 * 外观主题选择：跟随系统 + 四种主题的色块按钮。选择后立即写入设置；
 * 页面外观随快照中的 settings.uiTheme 切换（见 LocaleRoot），这里只负责发出更新。
 */
import { useT } from '../../i18n/react';
import { cx } from '../components/cx';
import { useSettingsUpdater } from './hooks';
import {
  THEME_LABELS,
  THEME_SWATCHES,
  UI_THEME_PREFERENCES,
  type UiTheme,
  type UiThemePreference,
} from '../theme/themes';
import styles from './theme-picker.module.css';

function Swatch({ theme }: { theme: UiTheme }) {
  const s = THEME_SWATCHES[theme];
  return (
    <span className={styles.swatchFace} style={{ background: s.bg }}>
      <span className={styles.bar} style={{ background: s.accent }} />
      <span className={styles.barShort} style={{ background: s.fg }} />
    </span>
  );
}

export function ThemePicker({
  value,
  className,
  titleAs: Title = 'h3',
}: {
  value: UiThemePreference;
  className?: string;
  /** 标题层级随所在页面的结构调整。 */
  titleAs?: 'h2' | 'h3';
}) {
  const t = useT();
  const update = useSettingsUpdater();
  const current = THEME_LABELS[value];
  return (
    <section className={cx(styles.picker, className)}>
      <div className={styles.head}>
        <Title className={styles.title}>{t('common.theme.label')}</Title>
        <span className={styles.current}>
          {t(current.name)} · {t(current.mood)}
        </span>
      </div>
      <div role="group" aria-label={t('common.theme.groupAria')} className={styles.grid}>
        {UI_THEME_PREFERENCES.map((pref) => {
          const name = t(THEME_LABELS[pref].name);
          const on = pref === value;
          return (
            <button
              key={pref}
              type="button"
              className={cx(styles.option, on && styles.selected)}
              aria-pressed={on}
              aria-label={t('common.theme.optionAria', { name })}
              title={t(THEME_LABELS[pref].mood)}
              onClick={() => {
                if (!on) void update({ uiTheme: pref });
              }}
            >
              <span className={styles.ring} aria-hidden="true">
                {pref === 'auto' ? (
                  <span className={styles.split}>
                    <Swatch theme="paper" />
                    <Swatch theme="ink" />
                  </span>
                ) : (
                  <Swatch theme={pref} />
                )}
              </span>
              <span className={styles.name} aria-hidden="true">
                {name}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

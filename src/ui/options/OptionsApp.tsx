/**
 * 设置页（在新标签页中打开）。
 *
 * 界面语言取自快照中的 settings.uiLocale（快照到达前按浏览器界面语言显示）。
 * 在本页切换界面语言时先乐观切换显示，快照中的设置随后到达即以快照为准；保存失败则恢复。
 */
import { useCallback, useEffect, useState } from 'react';
import { resolveLocale, type LocalePreference, type MessageKey } from '../../i18n';
import { browserUiLanguage, useLocale, useT } from '../../i18n/react';
import { Spinner } from '../components/controls';
import { Brand, Callout, EmptyState, ReconnectBanner } from '../components/layout';
import { ToastProvider } from '../components/toast';
import { UiClientProvider, useBackground, useClientState } from '../state/hooks';
import { ConnectionSection } from './ConnectionSection';
import { DataSection, DemoSection, ShortcutsSection } from './DataSection';
import { GeneralSection } from './GeneralSection';
import { GlossarySection } from './GlossarySection';
import styles from './options.module.css';
import { ProcessingSection } from './ProcessingSection';
import { SnapshotI18nProvider } from '../shared/LocaleRoot';

const NAV: ReadonlyArray<{ id: string; label: MessageKey }> = [
  { id: 'general', label: 'options.section.general' },
  { id: 'connection', label: 'options.section.connection' },
  { id: 'processing', label: 'options.section.processing' },
  { id: 'glossary', label: 'options.section.glossary' },
  { id: 'data', label: 'options.section.data' },
  { id: 'shortcuts', label: 'options.section.shortcuts' },
  { id: 'demo', label: 'options.section.demo' },
];

export function OptionsApp() {
  const { client } = useBackground('options');
  return (
    <UiClientProvider client={client}>
      <LocalizedOptions />
    </UiClientProvider>
  );
}

/**
 * 乐观切换的界面语言：记录切换时快照中的值，快照中的值变化后即失效。
 * worker 接受了命令却没有在快照中采用（例如尚未重新加载的旧版 worker 丢弃了未知字段）时，
 * 不能一直显示预览：命令成功后一段时间内快照仍未变化，就恢复为快照中的真实值。
 */
interface PendingLocale {
  value: LocalePreference;
  saved: LocalePreference | undefined;
}
const PREVIEW_SETTLE_MS = 2_000;

function LocalizedOptions() {
  const { snapshot } = useClientState();
  const saved = snapshot?.settings.uiLocale;
  const [pending, setPending] = useState<PendingLocale | null>(null);
  const preference = pending && pending.saved === saved ? pending.value : saved;
  const previewLocale = useCallback(
    (value: LocalePreference | null, settled?: LocalePreference) => {
      if (value !== null) {
        setPending({ value, saved });
        return;
      }
      if (settled === undefined) {
        setPending(null);
        return;
      }
      // 只结束同一次切换的预览；期间用户又切换了别的值则保留新的预览。
      setTimeout(
        () => setPending((current) => (current?.value === settled ? null : current)),
        PREVIEW_SETTLE_MS,
      );
    },
    [saved],
  );
  return (
    <SnapshotI18nProvider locale={resolveLocale(preference, browserUiLanguage())}>
      <ToastProvider>
        <OptionsView uiLocale={preference ?? 'auto'} onPreviewLocale={previewLocale} />
      </ToastProvider>
    </SnapshotI18nProvider>
  );
}

function OptionsView({
  uiLocale,
  onPreviewLocale,
}: {
  uiLocale: LocalePreference;
  onPreviewLocale(value: LocalePreference | null, settled?: LocalePreference): void;
}) {
  const { connection, snapshot } = useClientState();
  const t = useT();
  const locale = useLocale();
  const documentTitle = t('options.page.documentTitle');
  useEffect(() => {
    document.title = documentTitle;
    document.documentElement.lang = locale;
  }, [documentTitle, locale]);
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Brand />
          <h1>{t('options.page.title')}</h1>
        </div>
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      {!snapshot ? (
        <EmptyState icon={<Spinner />} title={t('options.page.connecting')}>
          {t('options.page.connectingHint')}
        </EmptyState>
      ) : (
        <div className={styles.layout}>
          <nav className={styles.nav} aria-label={t('options.page.navLabel')}>
            {NAV.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {t(item.label)}
              </a>
            ))}
          </nav>
          <main className={styles.main}>
            {snapshot.settingsRecovery === 'recovered' && (
              <Callout tone="warning" title={t('options.page.recoveredTitle')}>
                {t('options.page.recoveredBody')}
              </Callout>
            )}
            {snapshot.settingsRecovery === 'unreadable' ? (
              <Callout tone="warning" title={t('options.page.unreadableTitle')}>
                {t('options.page.unreadableBody')}
              </Callout>
            ) : (
              !snapshot.settingsPersisted && (
                <Callout tone="warning" title={t('options.page.notPersistedTitle')}>
                  {t('options.page.notPersistedBody')}
                </Callout>
              )
            )}
            <GeneralSection uiLocale={uiLocale} onPreviewLocale={onPreviewLocale} />
            <ConnectionSection snapshot={snapshot} />
            <ProcessingSection snapshot={snapshot} />
            <GlossarySection glossary={snapshot.settings.glossary} />
            <DataSection snapshot={snapshot} />
            <ShortcutsSection />
            <DemoSection />
          </main>
        </div>
      )}
    </div>
  );
}

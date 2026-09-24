/**
 * 工具栏弹窗：当前视频、目标语言、开始/暂停翻译、真实连接状态、打开侧栏与工作台。
 * 关闭弹窗不会停止翻译（会话由 worker 管理）。界面语言按快照中的 settings.uiLocale 决定。
 */
import { Languages, PanelRightOpen, PanelsTopLeft, Pause, Play, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { browser } from 'wxt/browser';
import { TARGET_LANGUAGES } from '../../domain/languages';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, SelectField } from '../components/controls';
import { cx } from '../components/cx';
import { Brand, Card, List, ListRow, ReconnectBanner, StatusPill } from '../components/layout';
import { ToastProvider, useToast } from '../components/toast';
import { capabilityStatusLabel, formatDateTime, formatMediaTime, languageLabel } from '../format';
import { SnapshotI18nProvider } from '../shared/LocaleRoot';
import { useCommandRunner, usePlayerClock, useSettingsUpdater } from '../shared/hooks';
import { openOptionsPage, openWorkspace, reloadTab } from '../shared/navigation';
import { useActiveTab } from '../state/active-tab';
import {
  derivePrimaryAction,
  deriveServiceConfig,
  deriveStatus,
  deriveTabContext,
  findPageByTab,
  playerStatusLabel,
  type NextStepAction,
  type ServiceConfigState,
} from '../state/derive';
import { usePageWake } from '../state/page-wake';
import { SessionProblemCallout } from '../shared/SessionProblemCallout';
import { UiClientProvider, useBackground, useClientState } from '../state/hooks';
import styles from './popup.module.css';

export function PopupApp() {
  const { client } = useBackground('popup');
  return (
    <UiClientProvider client={client}>
      <SnapshotI18nProvider>
        <ToastProvider>
          <PopupView />
        </ToastProvider>
      </SnapshotI18nProvider>
    </UiClientProvider>
  );
}

function PopupView() {
  const { connection, snapshot } = useClientState();
  const activeTab = useActiveTab();
  const notify = useToast();
  const update = useSettingsUpdater();
  const { run, isBusy } = useCommandRunner();
  const locale = useLocale();
  const t = useT();
  const activeTabId = activeTab.tab?.tabId;
  const hasPage = activeTabId !== undefined && !!findPageByTab(snapshot, activeTabId);
  const waking = usePageWake(activeTabId, hasPage, connection === 'connected' && !!snapshot);
  const tabContext = useMemo(
    () => deriveTabContext(snapshot, activeTab.tab, activeTab.loading, waking),
    [snapshot, activeTab.tab, activeTab.loading, waking],
  );
  const config = useMemo(() => deriveServiceConfig(snapshot, locale), [snapshot, locale]);
  const status = deriveStatus({ connection, snapshot, tabContext, config, locale });
  const video = tabContext.kind === 'video' ? tabContext : undefined;
  const action = derivePrimaryAction(video?.session, config, connection, locale);
  const targetOptions = useMemo(
    () => TARGET_LANGUAGES.map((l) => ({ value: l.code, label: languageLabel(l.code, locale) })),
    [locale],
  );
  const time = usePlayerClock(video?.page.player);

  const openSidePanel = () => {
    const tab = activeTab.tab;
    if (!tab) {
      notify(t('sidepanel.popup.noTab'), 'danger');
      return;
    }
    let opening: Promise<void>;
    try {
      // 必须在点击处理中同步调用，保留用户手势。
      opening = browser.sidePanel.open({ tabId: tab.tabId });
    } catch {
      notify(t('sidepanel.popup.sidePanelUnsupported'), 'danger');
      return;
    }
    opening.then(
      () => window.close(),
      () => notify(t('sidepanel.popup.sidePanelFailed'), 'danger'),
    );
  };

  const onPrimary = () => {
    if (!video) return;
    const tabId = video.page.tabId;
    const sessionId = video.session?.identity.sessionId;
    if (action.kind === 'start')
      void run(
        { kind: 'session/start', tabId },
        { key: 'primary', errorPrefix: t('sidepanel.translate.startFailed') },
      );
    if (action.kind === 'pause')
      void run(
        { kind: 'session/pause', tabId, sessionId },
        { key: 'primary', errorPrefix: t('sidepanel.translate.pauseFailed') },
      );
    if (action.kind === 'resume')
      void run(
        { kind: 'session/resume', tabId, sessionId },
        { key: 'primary', errorPrefix: t('sidepanel.translate.resumeFailed') },
      );
  };

  const onNextStep = (next: NextStepAction) => {
    if (!video) return;
    if (next === 'open-settings')
      openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'));
    if (next === 'reload-tab') {
      reloadTab(video.page.tabId).catch(() => notify(t('common.reloadTabFailed'), 'danger'));
    }
    if (next === 'retry') {
      void run(
        { kind: 'session/start', tabId: video.page.tabId },
        { key: 'primary', errorPrefix: t('sidepanel.translate.retryFailed') },
      );
    }
  };

  return (
    <div className={styles.app} lang={locale}>
      <header className={styles.header}>
        <Brand />
        <StatusPill label={status.label} tone={status.tone} />
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      <div className={styles.body}>
        <section
          className={cx(styles.card, styles.videoCard)}
          aria-label={t('sidepanel.popup.currentTab')}
        >
          <span className={styles.eyebrow}>
            <span className={cx(styles.dot, video && styles.dotOn)} aria-hidden="true" />
            {t('sidepanel.popup.currentTab')}
          </span>
          {video ? (
            <>
              <span className={styles.videoTitle}>
                {video.page.title || video.page.player?.title || t('sidepanel.video.noTitle')}
              </span>
              <span className={styles.videoMeta}>
                {playerStatusLabel(video.page.player, locale)}
                {video.page.player ? ` · ${formatMediaTime(time)}` : ''}
              </span>
            </>
          ) : (
            <span className={styles.videoMeta}>
              {tabContext.kind === 'loading'
                ? t('sidepanel.popup.reading')
                : tabContext.kind === 'waking'
                  ? t('sidepanel.noVideo.waking')
                  : tabContext.kind === 'youtube-no-video'
                    ? t('sidepanel.popup.ytNoVideo')
                    : !snapshot
                      ? t('sidepanel.popup.waitingService')
                      : t('sidepanel.popup.notYt')}
            </span>
          )}
        </section>

        {snapshot && (
          <div className={cx(styles.card, styles.languageRow)}>
            <SelectField
              inline
              label={
                <span className={styles.languageLabel}>
                  <Languages size={16} aria-hidden="true" />
                  {t('sidepanel.language.target')}
                </span>
              }
              value={snapshot.settings.targetLanguage}
              options={targetOptions}
              disabled={connection !== 'connected'}
              onChange={(targetLanguage) => void update({ targetLanguage })}
            />
          </div>
        )}

        {video && (
          <>
            <Button
              variant="primary"
              block
              className={styles.cta}
              icon={
                action.kind === 'pause' ? (
                  <Pause size={16} aria-hidden="true" />
                ) : (
                  <Play size={16} aria-hidden="true" />
                )
              }
              busy={isBusy('primary') || action.kind === 'busy'}
              disabled={!!action.disabledReason}
              onClick={onPrimary}
            >
              {action.label}
            </Button>
            {action.disabledReason && action.kind !== 'busy' && (
              <Hint>{action.disabledReason}</Hint>
            )}
            <SessionProblemCallout session={video.session} onNextStep={onNextStep} compact />
          </>
        )}

        {snapshot && <ConnectionSummary snapshot={snapshot} config={config} />}

        <Card flush>
          <List className={styles.links}>
            <ListRow
              icon={<PanelRightOpen size={16} aria-hidden="true" />}
              label={t('sidepanel.popup.openSidePanel')}
              onClick={openSidePanel}
            />
            <ListRow
              icon={<PanelsTopLeft size={16} aria-hidden="true" />}
              label={t('sidepanel.popup.workspace')}
              onClick={() =>
                openWorkspace(video?.page.videoId ?? undefined).catch(() =>
                  notify(t('common.openWorkspaceFailed'), 'danger'),
                )
              }
            />
            <ListRow
              icon={<Settings size={16} aria-hidden="true" />}
              label={t('common.settings')}
              onClick={() =>
                openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'))
              }
            />
          </List>
        </Card>
      </div>
    </div>
  );
}

function ConnectionSummary({
  snapshot,
  config,
}: {
  snapshot: AppSnapshot;
  config: ServiceConfigState;
}) {
  const locale = useLocale();
  const t = useT();
  const cap = snapshot.capabilities.translation;
  let text: string;
  if (!config.ready) text = config.message;
  else if (cap?.status === 'verified') {
    text = cap.checkedAt
      ? t('sidepanel.popup.verifiedAt', {
          time: formatDateTime(Date.parse(cap.checkedAt), locale),
        })
      : t('sidepanel.popup.verified');
  } else if (cap?.status === 'failed' || cap?.status === 'unsupported') {
    const label = capabilityStatusLabel(cap.status, locale);
    text = cap.message
      ? t('common.errorWithDetail', { prefix: label, detail: cap.message })
      : label;
  } else {
    text = t('sidepanel.popup.notChecked');
  }
  const tone = !config.ready
    ? 'warning'
    : cap?.status === 'verified'
      ? 'ok'
      : cap?.status === 'failed' || cap?.status === 'unsupported'
        ? 'danger'
        : 'idle';
  return (
    <div className={cx(styles.card, styles.service)} role="status" data-tone={tone}>
      <span className={styles.serviceDot} aria-hidden="true" />
      <span className={styles.serviceText}>
        <strong>
          {t('sidepanel.popup.serviceTitle', {
            status: config.ready
              ? capabilityStatusLabel(cap?.status, locale)
              : t('sidepanel.popup.notConfigured'),
          })}
        </strong>
        <span>{text}</span>
      </span>
    </div>
  );
}

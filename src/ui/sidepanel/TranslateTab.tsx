/**
 * 侧栏「翻译」标签：当前字幕与真实进度、语言、输出方式、可展开的设置列表、外观主题，
 * 底部固定主按钮（开始 / 暂停 / 继续翻译）与「停止并释放音频」。
 *
 * 「暂停视频」由 YouTube 播放器负责（这里只显示状态）；「暂停翻译」「停止并释放音频」是两个独立命令。
 */
import { ChevronRight, Pause, Play, RefreshCw, Settings, Square } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { SessionSnapshot } from '../../domain/session';
import { describeCoverage } from '../../export';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, Spinner } from '../components/controls';
import { cx } from '../components/cx';
import { Callout, Group, Stat, StatGrid } from '../components/layout';
import { useToast } from '../components/toast';
import { formatLatency } from '../format';
import { useCommandRunner, useVoiceList } from '../shared/hooks';
import { openOptionsPage, reloadTab } from '../shared/navigation';
import { SessionProblemCallout } from '../shared/SessionProblemCallout';
import { hasActiveDubbing } from '../shared/SystemVoicePicker';
import { ThemePicker } from '../shared/ThemePicker';
import type { ConnectionStatus } from '../state/client';
import {
  canRetryFailed,
  canStop,
  derivePrimaryAction,
  deriveVoiceAvailability,
  findPageByTab,
  noticeHasSettingsAction,
  type NextStepAction,
  sessionPhaseStatus,
  sourceModeShortLabel,
  type ServiceConfigState,
} from '../state/derive';
import { useUiClient } from '../state/hooks';
import { NowCard } from './NowCard';
import { LanguageCard, OutputMode, SettingsList } from './TranslateSettings';
import styles from './translate.module.css';

export interface TranslateTabProps {
  snapshot: AppSnapshot;
  connection: ConnectionStatus;
  tabId: number;
  session: SessionSnapshot | undefined;
  config: ServiceConfigState;
  videoDetails?: ReactNode;
}

export function TranslateTab({
  snapshot,
  connection,
  tabId,
  session,
  config,
  videoDetails,
}: TranslateTabProps) {
  const client = useUiClient();
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();
  const locale = useLocale();
  const t = useT();
  const hintId = useId();
  const { settings } = snapshot;
  const action = derivePrimaryAction(session, config, connection, locale);
  const disabledCommands = connection !== 'connected';
  const sessionId = session?.identity.sessionId;
  const voiceEnabled = settings.outputMode === 'subtitle-voice';
  const voices = useVoiceList(
    voiceEnabled && settings.tts.backend === 'system',
    settings.tts.backend,
  );
  const availability = deriveVoiceAvailability(snapshot, voices.state, locale);
  const page = findPageByTab(snapshot, tabId);

  const onPrimary = () => {
    switch (action.kind) {
      case 'start':
        void run(
          { kind: 'session/start', tabId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.startFailed') },
        );
        break;
      case 'pause':
        void run(
          { kind: 'session/pause', tabId, sessionId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.pauseFailed') },
        );
        break;
      case 'resume':
        void run(
          { kind: 'session/resume', tabId, sessionId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.resumeFailed') },
        );
        break;
      case 'busy':
        break;
    }
  };

  // 不因上一次停止仍在途而忽略点击：期间用户可能已经重新开始，最后一次停止意图必须送达（worker 侧幂等）。
  const onStop = () =>
    void run(
      { kind: 'session/stop', tabId, sessionId },
      { errorPrefix: t('sidepanel.translate.stopFailed') },
    );

  const onNextStep = (nextAction: NextStepAction) => {
    switch (nextAction) {
      case 'open-settings':
        openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'));
        break;
      case 'reload-tab':
        if (client.mode === 'demo') return;
        reloadTab(tabId).catch(() => notify(t('common.reloadTabFailed'), 'danger'));
        break;
      case 'retry':
        void run(
          { kind: 'session/start', tabId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.retryFailed') },
        );
        break;
      case 'none':
        break;
    }
  };

  const primaryBusy = isBusy('primary') || action.kind === 'busy';
  const primaryHint = action.disabledReason && action.kind !== 'busy' ? action.disabledReason : '';
  const stopBusy = isBusy('session/stop') || session?.phase === 'stopping';
  const stopLabel = t('sidepanel.translate.stopRelease');
  const otherOwner =
    snapshot.audioOwner && snapshot.audioOwner.tabId !== tabId ? snapshot.audioOwner : null;

  return (
    <div className={styles.tab}>
      <div className={styles.body}>
        {!config.ready && (
          <Callout
            tone="warning"
            title={t('sidepanel.translate.notConfigured')}
            actions={
              <Button
                size="sm"
                icon={<Settings size={14} aria-hidden="true" />}
                onClick={() => void openOptionsPage()}
              >
                {t('common.openSettings')}
              </Button>
            }
          >
            {config.message}
          </Callout>
        )}
        {!snapshot.settingsPersisted && (
          <Callout tone="warning" title={t('sidepanel.translate.notPersistedTitle')}>
            {t('sidepanel.translate.notPersistedBody')}
          </Callout>
        )}
        <SessionProblemCallout session={session} onNextStep={onNextStep} />
        {session?.notice && (
          <Callout
            tone={
              session.notice.level === 'error'
                ? 'danger'
                : session.notice.level === 'warning'
                  ? 'warning'
                  : 'info'
            }
            live
            actions={
              noticeHasSettingsAction(session.notice.code) ? (
                <Button size="sm" onClick={() => void openOptionsPage()}>
                  {t('common.openSettings')}
                </Button>
              ) : undefined
            }
          >
            {session.notice.message}
          </Callout>
        )}
        {otherOwner && <Callout tone="info">{t('sidepanel.translate.otherOwner')}</Callout>}

        <NowCard session={session} page={page} captionOffsetMs={settings.captions.offsetMs} />
        <LanguageCard settings={settings} session={session} />
        <OutputMode settings={settings} availability={availability} />
        <SettingsList
          settings={settings}
          session={session}
          availability={availability}
          reloadVoices={voices.reload}
          dubbingActive={hasActiveDubbing(snapshot)}
        />
        <div className={cx(styles.card, styles.themeCard)}>
          <ThemePicker value={settings.uiTheme} />
        </div>

        {(session || videoDetails) && (
          <details className={cx(styles.card, styles.details)}>
            <summary className={styles.detailsSummary}>
              {t('sidepanel.translate.details')}
              <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
            </summary>
            <div className={styles.detailsBody}>
              {videoDetails && <div className={styles.videoSlot}>{videoDetails}</div>}
              {session && <SessionStatus session={session} />}
              {session && canRetryFailed(session) && (
                <Button
                  icon={<RefreshCw size={14} aria-hidden="true" />}
                  busy={isBusy('session/retry-failed')}
                  disabled={disabledCommands}
                  onClick={async () => {
                    const result = await run(
                      { kind: 'session/retry-failed', tabId, sessionId },
                      { errorPrefix: t('sidepanel.translate.retryFailed') },
                    );
                    if (result)
                      notify(
                        t('sidepanel.translate.retried', { count: result.retried }),
                        'success',
                      );
                  }}
                >
                  {t('sidepanel.translate.retryCount', { count: session.translation.failed })}
                </Button>
              )}
              {session?.phase === 'stopping' && (
                <Hint>{t('sidepanel.translate.stoppingHint')}</Hint>
              )}
            </div>
          </details>
        )}
      </div>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.cta}
              aria-busy={primaryBusy || undefined}
              aria-describedby={primaryHint ? hintId : undefined}
              disabled={!!action.disabledReason}
              onClick={onPrimary}
            >
              {primaryBusy ? (
                <Spinner />
              ) : action.kind === 'pause' ? (
                <Pause size={16} aria-hidden="true" />
              ) : (
                <Play size={16} aria-hidden="true" />
              )}
              <span>{action.label}</span>
            </button>
            <button
              type="button"
              className={styles.stop}
              aria-label={stopLabel}
              title={stopLabel}
              aria-busy={stopBusy || undefined}
              disabled={!canStop(session) || disabledCommands}
              onClick={onStop}
            >
              {stopBusy ? <Spinner /> : <Square size={16} aria-hidden="true" />}
            </button>
          </div>
          {primaryHint && <Hint id={hintId}>{primaryHint}</Hint>}
          {session?.resources.capture === 'active' && (
            <p className={styles.captureStatus} role="status">
              {t('sidepanel.translate.capturing')}
            </p>
          )}
        </div>
      </footer>
    </div>
  );
}

function SessionStatus({ session }: { session: SessionSnapshot }) {
  const locale = useLocale();
  const t = useT();
  const phase = sessionPhaseStatus(session, locale);
  const stats = session.translation;
  const unknown = t('common.unknown');
  const progress = stats.total > 0 ? `${stats.done} / ${stats.total}` : unknown;
  const resources: string[] = [];
  if (session.resources.capture === 'active') resources.push(t('sidepanel.translate.capturing'));
  if (session.resources.capture === 'requesting')
    resources.push(t('sidepanel.res.requestingCapture'));
  if (session.resources.asr === 'backlogged') {
    resources.push(
      session.resources.asrBacklogMs !== undefined
        ? t('sidepanel.res.asrBacklog', {
            seconds: Math.round(session.resources.asrBacklogMs / 1000),
          })
        : t('sidepanel.res.asrBacklogged'),
    );
  }
  if (session.resources.asr === 'loading') resources.push(t('sidepanel.res.asrLoading'));
  if (session.resources.tts === 'speaking') resources.push(t('sidepanel.res.speaking'));
  if (session.resources.dubBacklog)
    resources.push(t('sidepanel.res.dubBacklog', { count: session.resources.dubBacklog }));
  // 以快照更新时间判断，避免渲染中读取当前时间。
  if (stats.rateLimitedUntil && stats.rateLimitedUntil > session.updatedAt)
    resources.push(t('sidepanel.res.rateLimited'));
  if (stats.cacheWriteFailures)
    resources.push(t('sidepanel.res.cacheWriteFailures', { count: stats.cacheWriteFailures }));

  return (
    <Group title={t('sidepanel.status.title')}>
      <StatGrid>
        <Stat
          label={t('sidepanel.status.state')}
          value={phase?.label ?? t('sidepanel.status.notStarted')}
        />
        <Stat
          label={t('sidepanel.status.source')}
          value={sourceModeShortLabel(session.sourceMode, locale)}
        />
        <Stat label={t('sidepanel.status.translated')} value={progress} />
        <Stat
          label={t('sidepanel.status.failed')}
          value={stats.total > 0 ? String(stats.failed) : unknown}
        />
        <Stat
          label={t('sidepanel.status.latency')}
          value={formatLatency(stats.lastLatencyMs, locale)}
        />
        <Stat label={t('sidepanel.status.model')} value={stats.model ?? unknown} />
      </StatGrid>
      <Hint>
        {t('sidepanel.status.coverage', {
          detail: describeCoverage(session.coverage, session.sourceMode, locale),
        })}
      </Hint>
      {resources.length > 0 && <Hint>{resources.join(' · ')}</Hint>}
    </Group>
  );
}

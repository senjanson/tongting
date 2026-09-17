/**
 * 工具栏弹窗：当前视频、目标语言、开始/暂停翻译、真实连接状态、打开侧栏与工作台。
 * 关闭弹窗不会停止翻译（会话由 worker 管理）。
 */
import { PanelRightOpen, PanelsTopLeft, Pause, Play, Settings } from 'lucide-react';
import { useMemo } from 'react';
import { browser } from 'wxt/browser';
import { TARGET_LANGUAGES } from '../../domain/languages';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, SelectField } from '../components/controls';
import { Brand, ReconnectBanner, StatusPill } from '../components/layout';
import { ToastProvider, useToast } from '../components/toast';
import { capabilityStatusLabel, formatDateTime, formatMediaTime } from '../format';
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
    <ToastProvider>
      <UiClientProvider client={client}>
        <PopupView />
      </UiClientProvider>
    </ToastProvider>
  );
}

function PopupView() {
  const { connection, snapshot } = useClientState();
  const activeTab = useActiveTab();
  const notify = useToast();
  const update = useSettingsUpdater();
  const { run, isBusy } = useCommandRunner();
  const activeTabId = activeTab.tab?.tabId;
  const hasPage = activeTabId !== undefined && !!findPageByTab(snapshot, activeTabId);
  const waking = usePageWake(activeTabId, hasPage, connection === 'connected' && !!snapshot);
  const tabContext = useMemo(
    () => deriveTabContext(snapshot, activeTab.tab, activeTab.loading, waking),
    [snapshot, activeTab.tab, activeTab.loading, waking],
  );
  const config = useMemo(() => deriveServiceConfig(snapshot), [snapshot]);
  const status = deriveStatus({ connection, snapshot, tabContext, config });
  const video = tabContext.kind === 'video' ? tabContext : undefined;
  const action = derivePrimaryAction(video?.session, config, connection);
  const time = usePlayerClock(video?.page.player);

  const openSidePanel = () => {
    const tab = activeTab.tab;
    if (!tab) {
      notify('无法确定当前标签页。', 'danger');
      return;
    }
    let opening: Promise<void>;
    try {
      // 必须在点击处理中同步调用，保留用户手势。
      opening = browser.sidePanel.open({ tabId: tab.tabId });
    } catch {
      notify('当前浏览器无法从弹窗打开侧栏，请点击浏览器侧边栏按钮后选择「同听」。', 'danger');
      return;
    }
    opening.then(
      () => window.close(),
      () => notify('打开侧栏失败，请点击浏览器侧边栏按钮后选择「同听」。', 'danger'),
    );
  };

  const onPrimary = () => {
    if (!video) return;
    const tabId = video.page.tabId;
    const sessionId = video.session?.identity.sessionId;
    if (action.kind === 'start')
      void run({ kind: 'session/start', tabId }, { key: 'primary', errorPrefix: '无法开始翻译' });
    if (action.kind === 'pause')
      void run(
        { kind: 'session/pause', tabId, sessionId },
        { key: 'primary', errorPrefix: '无法暂停翻译' },
      );
    if (action.kind === 'resume')
      void run(
        { kind: 'session/resume', tabId, sessionId },
        { key: 'primary', errorPrefix: '无法继续翻译' },
      );
  };

  const onNextStep = (next: NextStepAction) => {
    if (!video) return;
    if (next === 'open-settings')
      openOptionsPage().catch(() => notify('无法打开设置页。', 'danger'));
    if (next === 'reload-tab') {
      reloadTab(video.page.tabId).catch(() => notify('无法刷新标签页，请手动刷新。', 'danger'));
    }
    if (next === 'retry') {
      void run(
        { kind: 'session/start', tabId: video.page.tabId },
        { key: 'primary', errorPrefix: '重试失败' },
      );
    }
  };

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <Brand />
        <StatusPill label={status.label} tone={status.tone} />
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      <div className={styles.body}>
        <section className={styles.videoCard} aria-label="当前标签页">
          <span className={styles.videoLabel}>当前标签页</span>
          {video ? (
            <>
              <span className={styles.videoTitle}>
                {video.page.title || video.page.player?.title || '（未获取到视频标题）'}
              </span>
              <span className={styles.videoMeta}>
                {playerStatusLabel(video.page.player)}
                {video.page.player ? ` · ${formatMediaTime(time)}` : ''}
              </span>
            </>
          ) : (
            <span className={styles.videoMeta}>
              {tabContext.kind === 'loading'
                ? '正在读取…'
                : tabContext.kind === 'waking'
                  ? '正在连接页面…'
                  : tabContext.kind === 'youtube-no-video'
                    ? '这个 YouTube 页面没有正在播放的视频。'
                    : !snapshot
                      ? '等待后台服务…'
                      : '不是 YouTube 视频页。打开视频后可开始翻译；刚打开的页面可能需要刷新。'}
            </span>
          )}
        </section>

        {snapshot && (
          <SelectField
            label="翻译为"
            value={snapshot.settings.targetLanguage}
            options={TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
            disabled={connection !== 'connected'}
            onChange={(targetLanguage) => void update({ targetLanguage })}
          />
        )}

        {video && (
          <>
            <Button
              variant="primary"
              block
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

        <Button
          block
          icon={<PanelRightOpen size={15} aria-hidden="true" />}
          onClick={openSidePanel}
        >
          打开侧栏
        </Button>
        <div className={styles.links}>
          <Button
            icon={<PanelsTopLeft size={15} aria-hidden="true" />}
            onClick={() =>
              openWorkspace(video?.page.videoId ?? undefined).catch(() =>
                notify('无法打开字幕工作台。', 'danger'),
              )
            }
          >
            字幕工作台
          </Button>
          <Button
            icon={<Settings size={15} aria-hidden="true" />}
            onClick={() => openOptionsPage().catch(() => notify('无法打开设置页。', 'danger'))}
          >
            设置
          </Button>
        </div>
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
  const cap = snapshot.capabilities.translation;
  let text: string;
  if (!config.ready) text = config.message;
  else if (cap?.status === 'verified') {
    text = `最近一次检查实际翻译成功${cap.checkedAt ? `（${formatDateTime(Date.parse(cap.checkedAt))}）` : ''}`;
  } else if (cap?.status === 'failed' || cap?.status === 'unsupported') {
    text = `${capabilityStatusLabel(cap.status)}${cap.message ? `：${cap.message}` : ''}`;
  } else {
    text = '尚未检查连接。可在设置页点击「检查连接」验证。';
  }
  return (
    <div className={styles.connection} role="status">
      <strong>翻译服务：{config.ready ? capabilityStatusLabel(cap?.status) : '未配置'}</strong>
      <span>{text}</span>
    </div>
  );
}

/**
 * A 轻巧侧栏。真实模式通过 worker 快照工作；演示模式只从明确入口开启，并持续显示演示标识。
 * 界面语言按快照中的 settings.uiLocale 决定（演示模式同样适用），快照到达前按浏览器界面语言显示。
 */
import {
  AudioLines,
  Clock,
  Gauge,
  MonitorPlay,
  Search,
  SlidersHorizontal,
  Text,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { PageInfo } from '../../domain/session';
import { resolveLocale } from '../../i18n';
import { browserUiLanguage, useLocale, useT } from '../../i18n/react';
import { Button, Spinner } from '../components/controls';
import { EmptyState, ReconnectBanner, StatusPill, TabPanel, Tabs } from '../components/layout';
import { ToastProvider, useToast } from '../components/toast';
import { createDemoRepos, DemoClient } from '../demo/demo-client';
import { DEMO_TAB_ID } from '../demo/demo-data';
import { formatMediaTime } from '../format';
import { usePlayerClock } from '../shared/hooks';
import { SnapshotI18nProvider } from '../shared/LocaleRoot';
import { reloadTab } from '../shared/navigation';
import { useActiveTab, type ActiveTabState } from '../state/active-tab';
import {
  deriveServiceConfig,
  deriveStatus,
  deriveTabContext,
  findPageByTab,
  playerStatusLabel,
  type ActiveTabInfo,
} from '../state/derive';
import type { UiClient } from '../state/client';
import { usePageWake } from '../state/page-wake';
import { UiClientProvider, useBackground, useClientState } from '../state/hooks';
import { indexedDbRepos, ReposProvider, type UiRepos } from '../state/repos';
import { SettingsTab } from './SettingsTab';
import styles from './sidepanel.module.css';
import { TranscriptTab } from './TranscriptTab';
import { TranslateTab } from './TranslateTab';
import { SearchTab } from './SearchTab';

type PanelTab = 'translate' | 'transcript' | 'search' | 'settings';

function initialDemoFlag(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('demo') === '1';
  } catch {
    return false;
  }
}

export function SidePanelApp() {
  const { client: realClient } = useBackground('sidepanel');
  const activeTab = useActiveTab();
  const [demo, setDemo] = useState(initialDemoFlag);

  return demo ? (
    <DemoRoot realClient={realClient} onExit={() => setDemo(false)} />
  ) : (
    <UiClientProvider client={realClient}>
      <ReposProvider repos={indexedDbRepos}>
        <SnapshotI18nProvider>
          <ToastProvider>
            <PanelView activeTab={activeTab} onEnterDemo={() => setDemo(true)} />
          </ToastProvider>
        </SnapshotI18nProvider>
      </ReposProvider>
    </UiClientProvider>
  );
}

function DemoRoot({ realClient, onExit }: { realClient: UiClient; onExit(): void }) {
  const [client] = useState(() => new DemoClient(resolveLocale(undefined, browserUiLanguage())));
  const [repos] = useState<UiRepos>(() => createDemoRepos());
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  // 演示不向 worker 发命令，但界面语言应与用户保存的设置一致：只读取真实快照中的 uiLocale。
  useEffect(() => {
    const adopt = () => client.adoptUiLocale(realClient.getState().snapshot?.settings.uiLocale);
    adopt();
    return realClient.subscribe(adopt);
  }, [client, realClient]);
  return (
    <UiClientProvider client={client}>
      <ReposProvider repos={repos}>
        <SnapshotI18nProvider>
          <ToastProvider>
            <DemoPanel onExit={onExit} />
          </ToastProvider>
        </SnapshotI18nProvider>
      </ReposProvider>
    </UiClientProvider>
  );
}

function DemoPanel({ onExit }: { onExit(): void }) {
  const t = useT();
  const activeTab = useMemo<ActiveTabState>(
    () => ({
      loading: false,
      tab: {
        tabId: DEMO_TAB_ID,
        windowId: -1,
        title: t('sidepanel.demo.tabTitle'),
      } satisfies ActiveTabInfo,
    }),
    [t],
  );
  return <PanelView activeTab={activeTab} onExitDemo={onExit} />;
}

export function PanelView({
  activeTab,
  onEnterDemo,
  onExitDemo,
}: {
  activeTab: ActiveTabState;
  onEnterDemo?: () => void;
  onExitDemo?: () => void;
}) {
  const { connection, snapshot } = useClientState();
  const locale = useLocale();
  const t = useT();
  const [tab, setTab] = useState<PanelTab>('translate');
  useEffect(() => {
    document.title = t('common.brand.name');
  }, [t]);
  const [searchDraft, setSearchDraft] = useState('');
  const demo = !!onExitDemo;
  const activeTabId = activeTab.tab?.tabId;
  const hasPage = activeTabId !== undefined && !!findPageByTab(snapshot, activeTabId);
  // 快照中没有当前标签页时唤醒其内容脚本，短时间内显示「正在连接页面…」。
  const waking = usePageWake(
    activeTabId,
    hasPage,
    !demo && connection === 'connected' && !!snapshot,
  );
  const tabContext = useMemo(
    () => deriveTabContext(snapshot, activeTab.tab, activeTab.loading, waking),
    [snapshot, activeTab.tab, activeTab.loading, waking],
  );
  const config = useMemo(() => deriveServiceConfig(snapshot, locale), [snapshot, locale]);
  const status = deriveStatus({ connection, snapshot, tabContext, config, locale });

  return (
    <div className={styles.app} lang={locale} aria-label={t('common.brand.name')}>
      <header className={styles.header}>
        <h1 className={styles.panelTitle}>
          {tab === 'search' ? t('sidepanel.title.search') : t('sidepanel.title.translate')}
        </h1>
        <div className={styles.headerRight}>
          {demo ? (
            <StatusPill label={t('sidepanel.pill.demo')} tone="accent" />
          ) : (
            <StatusPill
              label={
                tab === 'search' && config.ready && connection === 'connected'
                  ? t('sidepanel.pill.searchReady')
                  : status.label
              }
              tone={
                tab === 'search' && config.ready && connection === 'connected'
                  ? 'neutral'
                  : status.tone
              }
            />
          )}
        </div>
      </header>
      {!demo && connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}

      {!snapshot ? (
        <div className={styles.surface}>
          <EmptyState icon={<Spinner />} title={t('common.reconnect.connecting')}>
            {t('sidepanel.connecting.body')}
          </EmptyState>
        </div>
      ) : (
        <>
          <Tabs<PanelTab>
            idPrefix="panel"
            label={t('sidepanel.tabs.label')}
            value={tab}
            onChange={setTab}
            items={[
              {
                id: 'translate',
                label: t('sidepanel.tabs.translate'),
                icon: <AudioLines size={15} aria-hidden="true" />,
              },
              {
                id: 'transcript',
                label: t('sidepanel.tabs.transcript'),
                icon: <Text size={15} aria-hidden="true" />,
              },
              {
                id: 'search',
                label: t('sidepanel.tabs.search'),
                icon: <Search size={15} aria-hidden="true" />,
              },
              {
                id: 'settings',
                label: t('sidepanel.tabs.settings'),
                icon: <SlidersHorizontal size={15} aria-hidden="true" />,
              },
            ]}
          />
          <div className={styles.surface}>
            <TabPanel
              idPrefix="panel"
              id="translate"
              active={tab === 'translate'}
              className={styles.scroll}
            >
              {tabContext.kind === 'video' ? (
                <TranslateTab
                  snapshot={snapshot}
                  connection={connection}
                  tabId={tabContext.page.tabId}
                  session={tabContext.session}
                  config={config}
                  videoDetails={<VideoCard page={tabContext.page} demo={demo} />}
                />
              ) : (
                <NoVideoState
                  kind={tabContext.kind}
                  maybeYoutube={tabContext.kind === 'not-youtube' && tabContext.maybeYoutube}
                  tabId={activeTab.tab?.tabId}
                  configMessage={config.ready ? undefined : config.message}
                  onOpenSettings={() => setTab('settings')}
                />
              )}
            </TabPanel>
            <TabPanel
              idPrefix="panel"
              id="transcript"
              active={tab === 'transcript'}
              className={tabContext.kind === 'video' ? styles.surface : styles.scroll}
            >
              {tabContext.kind === 'video' ? (
                <TranscriptTab
                  page={tabContext.page}
                  session={tabContext.session}
                  targetLanguage={snapshot.settings.targetLanguage}
                  captionOffsetMs={snapshot.settings.captions.offsetMs}
                />
              ) : (
                <NoVideoState
                  kind={tabContext.kind}
                  maybeYoutube={tabContext.kind === 'not-youtube' && tabContext.maybeYoutube}
                  tabId={activeTab.tab?.tabId}
                />
              )}
            </TabPanel>
            <TabPanel
              idPrefix="panel"
              id="search"
              active={tab === 'search'}
              className={styles.scroll}
            >
              <SearchTab
                query={searchDraft}
                onQueryChange={setSearchDraft}
                onOpenSettings={() => setTab('settings')}
              />
            </TabPanel>
            <TabPanel
              idPrefix="panel"
              id="settings"
              active={tab === 'settings'}
              className={styles.scroll}
            >
              <SettingsTab
                snapshot={snapshot}
                config={config}
                onEnterDemo={onEnterDemo}
                onExitDemo={onExitDemo}
              />
            </TabPanel>
          </div>
        </>
      )}
      {demo && (
        <div className={styles.demoFooter} role="note">
          <span>{t('common.demo.label')}</span>
          <button type="button" onClick={onExitDemo} aria-label={t('common.demo.exit')}>
            {t('sidepanel.demo.exitShort')}
          </button>
        </div>
      )}
    </div>
  );
}

function VideoCard({ page, demo }: { page: PageInfo; demo: boolean }) {
  const player = page.player;
  const time = usePlayerClock(player);
  const locale = useLocale();
  const t = useT();
  const title = page.title || player?.title || t('sidepanel.video.noTitle');
  const paused = !!player && (player.paused || player.ended);
  return (
    <section className={styles.video} aria-label={t('sidepanel.video.aria')}>
      <div className={styles.videoTitle} title={title}>
        {title}
      </div>
      <div className={styles.videoMeta}>
        {player?.channel && <span>{player.channel}</span>}
        <span className={paused ? styles.playerPaused : undefined}>
          <MonitorPlay size={13} aria-hidden="true" />
          {playerStatusLabel(player, locale)}
        </span>
        {player && (
          <span>
            <Clock size={13} aria-hidden="true" />
            {formatMediaTime(time)} /{' '}
            {player.isLive ? t('sidepanel.video.live') : formatMediaTime(player.durationMs)}
          </span>
        )}
        {player && (
          <span title={t('sidepanel.video.rate')}>
            <Gauge size={13} aria-hidden="true" />
            {player.playbackRate}×
          </span>
        )}
        {demo && <span>{t('sidepanel.video.sample')}</span>}
      </div>
    </section>
  );
}

function NoVideoState({
  kind,
  maybeYoutube,
  tabId,
  configMessage,
  onOpenSettings,
}: {
  kind: 'loading' | 'waking' | 'no-tab' | 'not-youtube' | 'youtube-no-video';
  maybeYoutube: boolean;
  tabId?: number;
  configMessage?: string;
  onOpenSettings?: () => void;
}) {
  const notify = useToast();
  const t = useT();
  if (kind === 'loading') {
    return <EmptyState icon={<Spinner />} title={t('sidepanel.noVideo.loadingTab')} />;
  }
  if (kind === 'waking') {
    return <EmptyState icon={<Spinner />} title={t('sidepanel.noVideo.waking')} />;
  }
  const reload =
    maybeYoutube && tabId !== undefined ? (
      <Button
        size="sm"
        onClick={() => reloadTab(tabId).catch(() => notify(t('common.reloadTabFailed'), 'danger'))}
      >
        {t('sidepanel.noVideo.reload')}
      </Button>
    ) : undefined;
  return (
    <div>
      {kind === 'youtube-no-video' ? (
        <EmptyState
          icon={<MonitorPlay size={20} aria-hidden="true" />}
          title={t('sidepanel.noVideo.ytTitle')}
        >
          {t('sidepanel.noVideo.ytBody')}
        </EmptyState>
      ) : (
        <EmptyState
          icon={<MonitorPlay size={20} aria-hidden="true" />}
          title={t('sidepanel.noVideo.notYtTitle')}
          actions={reload}
        >
          {t('sidepanel.noVideo.notYtBody')}
        </EmptyState>
      )}
      {configMessage && (
        <div style={{ padding: '0 12px 12px' }}>
          <EmptyState
            title={t('sidepanel.noVideo.configTitle')}
            actions={
              onOpenSettings ? (
                <Button size="sm" onClick={onOpenSettings}>
                  {t('sidepanel.noVideo.viewSettings')}
                </Button>
              ) : undefined
            }
          >
            {configMessage}
          </EmptyState>
        </div>
      )}
    </div>
  );
}

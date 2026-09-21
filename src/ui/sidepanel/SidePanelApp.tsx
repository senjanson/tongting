/**
 * A 轻巧侧栏。真实模式通过 worker 快照工作；演示模式只从明确入口开启，并持续显示演示标识。
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
import { Button, Spinner } from '../components/controls';
import { EmptyState, ReconnectBanner, StatusPill, TabPanel, Tabs } from '../components/layout';
import { ToastProvider, useToast } from '../components/toast';
import { createDemoRepos, DemoClient } from '../demo/demo-client';
import { DEMO_TAB_ID } from '../demo/demo-data';
import { formatMediaTime } from '../format';
import { usePlayerClock } from '../shared/hooks';
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

  return (
    <ToastProvider>
      {demo ? (
        <DemoRoot onExit={() => setDemo(false)} />
      ) : (
        <UiClientProvider client={realClient}>
          <ReposProvider repos={indexedDbRepos}>
            <PanelView activeTab={activeTab} onEnterDemo={() => setDemo(true)} />
          </ReposProvider>
        </UiClientProvider>
      )}
    </ToastProvider>
  );
}

const DEMO_ACTIVE_TAB: ActiveTabState = {
  loading: false,
  tab: { tabId: DEMO_TAB_ID, windowId: -1, title: '演示' } satisfies ActiveTabInfo,
};

function DemoRoot({ onExit }: { onExit(): void }) {
  const [client] = useState(() => new DemoClient());
  const [repos] = useState<UiRepos>(() => createDemoRepos());
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  return (
    <UiClientProvider client={client}>
      <ReposProvider repos={repos}>
        <PanelView activeTab={DEMO_ACTIVE_TAB} onExitDemo={onExit} />
      </ReposProvider>
    </UiClientProvider>
  );
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
  const [tab, setTab] = useState<PanelTab>('translate');
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
  const config = useMemo(() => deriveServiceConfig(snapshot), [snapshot]);
  const status = deriveStatus({ connection, snapshot, tabContext, config });

  return (
    <div className={styles.app} aria-label="同听">
      <header className={styles.header}>
        <h1 className={styles.panelTitle}>{tab === 'search' ? '同听 · AI 搜索' : '实时翻译'}</h1>
        <div className={styles.headerRight}>
          {demo ? (
            <StatusPill label="演示中" tone="accent" />
          ) : (
            <StatusPill
              label={
                tab === 'search' && config.ready && connection === 'connected'
                  ? '可搜索'
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
          <EmptyState icon={<Spinner />} title="正在连接后台服务…">
            如果长时间停留在这里，请在 chrome://extensions 中重新加载同听。
          </EmptyState>
        </div>
      ) : (
        <>
          <Tabs<PanelTab>
            idPrefix="panel"
            label="同听功能"
            value={tab}
            onChange={setTab}
            items={[
              { id: 'translate', label: '翻译', icon: <AudioLines size={15} aria-hidden="true" /> },
              { id: 'transcript', label: '字幕', icon: <Text size={15} aria-hidden="true" /> },
              { id: 'search', label: '搜索', icon: <Search size={15} aria-hidden="true" /> },
              {
                id: 'settings',
                label: '设置',
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
          <span>演示模式 · 示例数据，不连接视频与服务</span>
          <button type="button" onClick={onExitDemo} aria-label="退出演示">
            退出
          </button>
        </div>
      )}
    </div>
  );
}

function VideoCard({ page, demo }: { page: PageInfo; demo: boolean }) {
  const player = page.player;
  const time = usePlayerClock(player);
  const title = page.title || player?.title || '（未获取到视频标题）';
  const paused = !!player && (player.paused || player.ended);
  return (
    <section className={styles.video} aria-label="当前视频">
      <div className={styles.videoTitle} title={title}>
        {title}
      </div>
      <div className={styles.videoMeta}>
        {player?.channel && <span>{player.channel}</span>}
        <span className={paused ? styles.playerPaused : undefined}>
          <MonitorPlay size={13} aria-hidden="true" />
          {playerStatusLabel(player)}
        </span>
        {player && (
          <span>
            <Clock size={13} aria-hidden="true" />
            {formatMediaTime(time)} / {player.isLive ? '直播' : formatMediaTime(player.durationMs)}
          </span>
        )}
        {player && (
          <span title="播放速度">
            <Gauge size={13} aria-hidden="true" />
            {player.playbackRate}×
          </span>
        )}
        {demo && <span>示例视频</span>}
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
  if (kind === 'loading') {
    return <EmptyState icon={<Spinner />} title="正在读取当前标签页…" />;
  }
  if (kind === 'waking') {
    return <EmptyState icon={<Spinner />} title="正在连接页面…" />;
  }
  const reload =
    maybeYoutube && tabId !== undefined ? (
      <Button
        size="sm"
        onClick={() =>
          reloadTab(tabId).catch(() => notify('无法刷新标签页，请手动刷新。', 'danger'))
        }
      >
        刷新该页面
      </Button>
    ) : undefined;
  return (
    <div>
      {kind === 'youtube-no-video' ? (
        <EmptyState
          icon={<MonitorPlay size={20} aria-hidden="true" />}
          title="这个 YouTube 页面没有正在播放的视频"
        >
          打开一个视频页面后，这里会显示翻译控制。
        </EmptyState>
      ) : (
        <EmptyState
          icon={<MonitorPlay size={20} aria-hidden="true" />}
          title="当前标签不是 YouTube 视频页"
          actions={reload}
        >
          在 www.youtube.com 打开视频后即可开始翻译。如果当前就是刚打开或刚安装扩展前打开的 YouTube
          页面，请刷新该页面。
        </EmptyState>
      )}
      {configMessage && (
        <div style={{ padding: '0 12px 12px' }}>
          <EmptyState
            title="尚未配置翻译服务"
            actions={
              onOpenSettings ? (
                <Button size="sm" onClick={onOpenSettings}>
                  查看设置
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

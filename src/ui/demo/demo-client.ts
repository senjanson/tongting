/**
 * 演示模式客户端：实现与真实客户端相同的接口，但全部在页面内存中完成。
 * 不连接 service worker、不发送 UiCommand、不访问网络。
 * 示例标签按界面语言生成；在演示中切换界面语言时同步更新。
 * 界面语言与外观主题可采用用户真实设置中的值（只读取，见 adoptUiPreferences）。
 */
import { AppError } from '../../domain/errors';
import { t, type Locale, type LocalePreference } from '../../i18n';
import type { SearchRecord } from '../../domain/search';
import { demoSearchSuggestions } from './search-data';
import {
  applySettingsPatch,
  defaultSettings,
  type Settings,
  type UiThemePreference,
} from '../../domain/settings';
import type { UiCommand } from '../../messaging/ui-protocol';
import type { FavoriteRecord } from '../../storage/db';
import { favoriteKey, type FavoriteInput } from '../../storage/favorites';
import type { ClientState, ResultOf, UiClient } from '../state/client';
import { IDLE_CUES_STATE, type CuesState } from '../state/cues';
import type { UiRepos } from '../state/repos';
import {
  DEMO_DURATION_MS,
  DEMO_SESSION_ID,
  demoCues,
  demoPage,
  demoPlayer,
  demoSession,
  demoSnapshot,
  demoVoices,
} from './demo-data';

function demoUnavailable(): AppError {
  return new AppError({
    code: 'demo-unavailable',
    category: 'unsupported',
    retryable: false,
    message: t('sidepanel.demo.unavailable'),
  });
}

export class DemoClient implements UiClient {
  private searchRecords: SearchRecord[] = [];
  readonly mode = 'demo' as const;
  private version = 1;
  private state: ClientState;
  private cuesState: CuesState = IDLE_CUES_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly cuesListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cueRefs = new Map<string, number>();

  private locale: Locale;
  /** 最近一次采用的真实设置值：只有真实值变化时才覆盖演示中的切换。 */
  private readonly adopted: { uiLocale?: LocalePreference; uiTheme?: UiThemePreference } = {};

  /**
   * browserLocale：界面语言设为「跟随浏览器」时使用的语言。
   * initial.uiTheme：演示开始时的外观主题（真实快照尚未到达时沿用页面当前主题）。
   */
  constructor(
    private readonly browserLocale: Locale = 'zh-CN',
    initial: { uiTheme?: UiThemePreference | undefined } = {},
  ) {
    this.locale = browserLocale;
    const snapshot = demoSnapshot(this.version, this.locale);
    this.state = {
      connection: 'connected',
      snapshot: initial.uiTheme
        ? { ...snapshot, settings: { ...snapshot.settings, uiTheme: initial.uiTheme } }
        : snapshot,
      reconnectAttempts: 0,
    };
  }

  /** 设置中的界面语言变化后，重新生成示例标题、频道、轨道与模型名称。 */
  private relocalize(preference: string | undefined): void {
    const next: Locale =
      preference === 'zh-CN' || preference === 'en' ? preference : this.browserLocale;
    if (next === this.locale) return;
    this.locale = next;
    const snapshot = this.state.snapshot!;
    const current = snapshot.pages[0]?.player;
    const player = demoPlayer(current?.currentTimeMs ?? 0, current?.paused ?? false, next);
    const session = snapshot.sessions[0];
    const fresh = demoSession(player, demoCues(), next);
    this.update({
      pages: [
        { ...demoPage(player, next), connectedAt: snapshot.pages[0]?.connectedAt ?? Date.now() },
      ],
      sessions: session
        ? [
            {
              ...session,
              player,
              sourceTrack: fresh.sourceTrack,
              translation: { ...session.translation, model: fresh.translation.model },
            },
          ]
        : [],
    });
  }

  /**
   * 采用用户在真实设置中保存的界面语言与外观主题（只读取，不写回、不访问服务）。
   * 演示期间在演示设置里的切换只作用于演示本身；只有真实设置的值发生变化时才以它为准——
   * 真实快照的其他更新（例如播放进度）不会把演示中的选择改回去。
   */
  adoptUiPreferences(real: Partial<Pick<Settings, 'uiLocale' | 'uiTheme'>> | undefined): void {
    if (!real) return;
    const settings = this.state.snapshot!.settings;
    const patch: Partial<Pick<Settings, 'uiLocale' | 'uiTheme'>> = {};
    if (real.uiLocale && real.uiLocale !== this.adopted.uiLocale) {
      this.adopted.uiLocale = real.uiLocale;
      if (real.uiLocale !== settings.uiLocale) patch.uiLocale = real.uiLocale;
    }
    if (real.uiTheme && real.uiTheme !== this.adopted.uiTheme) {
      this.adopted.uiTheme = real.uiTheme;
      if (real.uiTheme !== settings.uiTheme) patch.uiTheme = real.uiTheme;
    }
    if (!patch.uiLocale && !patch.uiTheme) return;
    this.update({ settings: { ...settings, ...patch } });
    if (patch.uiLocale) this.relocalize(patch.uiLocale);
  }

  /** 模拟播放进度，便于展示字幕高亮。 */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getState = (): ClientState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getCuesState = (): CuesState => this.cuesState;

  subscribeCues = (listener: () => void): (() => void) => {
    this.cuesListeners.add(listener);
    return () => this.cuesListeners.delete(listener);
  };

  acquireCues(sessionId: string): () => void {
    this.cueRefs.set(sessionId, (this.cueRefs.get(sessionId) ?? 0) + 1);
    if (sessionId === DEMO_SESSION_ID && this.cuesState.sessionId !== sessionId) {
      this.setCues({ sessionId, status: 'ready', cueVersion: 1, cues: demoCues() });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (this.cueRefs.get(sessionId) ?? 1) - 1;
      if (count <= 0) this.cueRefs.delete(sessionId);
      else this.cueRefs.set(sessionId, count);
    };
  }

  sendCommand<C extends UiCommand>(command: C): Promise<ResultOf<C>> {
    try {
      return Promise.resolve(this.handle(command) as ResultOf<C>);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private handle(command: UiCommand): unknown {
    const snapshot = this.state.snapshot!;
    const session = snapshot.sessions[0];
    switch (command.kind) {
      case 'search/generate': {
        const record: SearchRecord = {
          id: `demo-search-${Date.now()}`,
          query: command.query,
          items: demoSearchSuggestions.map((item) => ({ ...item })),
          model: 'gpt-5.6-luna',
          createdAt: Date.now(),
          // 演示数据固定为中文输入、英文搜索词；按数据实际语言标注，不随所选语言假装生成。
          userLanguage: 'zh-CN',
          keywordLanguage: 'en',
        };
        this.searchRecords = [
          record,
          ...this.searchRecords.filter((item) => item.query !== record.query),
        ].slice(0, 20);
        return { record, persisted: true };
      }
      case 'search/history':
        return { records: this.searchRecords };
      case 'search/cancel':
        return { cancelled: true };
      case 'search/clear-history':
        this.searchRecords = [];
        return { cleared: true };
      case 'session/start':
      case 'session/resume':
        if (session)
          this.update({
            sessions: [
              { ...session, phase: 'running', desiredState: 'running', updatedAt: Date.now() },
            ],
          });
        return { accepted: true };
      case 'session/pause':
        if (session)
          this.update({
            sessions: [
              { ...session, phase: 'paused', desiredState: 'paused', updatedAt: Date.now() },
            ],
          });
        return { accepted: true };
      case 'session/stop':
        if (session)
          this.update({
            sessions: [
              { ...session, phase: 'idle', desiredState: 'stopped', updatedAt: Date.now() },
            ],
          });
        return { accepted: true };
      case 'session/retry-failed':
        return { retried: 0 };
      case 'player/seek':
        this.setPlayerTime(Math.min(command.timeMs, DEMO_DURATION_MS));
        return { accepted: true };
      case 'settings/update': {
        const settings = applySettingsPatch(snapshot.settings, command.patch);
        this.update({ settings });
        this.relocalize(settings.uiLocale);
        return { persisted: true };
      }
      case 'settings/reset': {
        const settings = defaultSettings();
        this.update({ settings });
        this.relocalize(settings.uiLocale);
        return { persisted: true };
      }
      case 'tts/voices':
        return { voices: demoVoices(this.locale) };
      case 'tts/preview':
        return { started: true };
      case 'tts/stop-preview':
        return { stopped: true };
      default:
        throw demoUnavailable();
    }
  }

  private tick(): void {
    const player = this.state.snapshot?.pages[0]?.player;
    if (!player || player.paused) return;
    const next = player.currentTimeMs + 1_000;
    this.setPlayerTime(next >= 64_000 ? 0 : next);
  }

  private setPlayerTime(timeMs: number): void {
    const snapshot = this.state.snapshot!;
    const player = demoPlayer(timeMs, false, this.locale);
    const session = snapshot.sessions[0];
    this.update({
      pages: [
        {
          ...demoPage(player, this.locale),
          connectedAt: snapshot.pages[0]?.connectedAt ?? Date.now(),
        },
      ],
      sessions: session ? [{ ...session, player }] : [],
    });
  }

  private update(patch: Partial<NonNullable<ClientState['snapshot']>>): void {
    const snapshot = this.state.snapshot!;
    this.version += 1;
    this.state = {
      ...this.state,
      snapshot: { ...snapshot, ...patch, snapshotVersion: this.version },
    };
    for (const listener of [...this.listeners]) listener();
  }

  private setCues(next: CuesState): void {
    this.cuesState = next;
    for (const listener of [...this.cuesListeners]) listener();
  }
}

/** 演示模式的内存仓库：收藏只保存在当前页面，不写入 IndexedDB。 */
export function createDemoRepos(): UiRepos {
  const favorites = new Map<string, FavoriteRecord>();
  return {
    favorites: {
      async listByRecord(recordId) {
        return [...favorites.values()]
          .filter((f) => f.recordId === recordId)
          .sort((a, b) => a.startMs - b.startMs);
      },
      async set(input: FavoriteInput, favorited: boolean) {
        const id = favoriteKey(input.recordId, input.cueId);
        if (!favorited) favorites.delete(id);
        else if (!favorites.has(id)) {
          favorites.set(id, { ...input, schemaVersion: 1, favoriteId: id, createdAt: Date.now() });
        }
        return favorited;
      },
    },
    transcripts: {
      async listByVideo() {
        return [];
      },
    },
  };
}

/**
 * 演示模式客户端：实现与真实客户端相同的接口，但全部在页面内存中完成。
 * 不连接 service worker、不发送 UiCommand、不访问网络。
 */
import { AppError } from '../../domain/errors';
import { applySettingsPatch, defaultSettings } from '../../domain/settings';
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
  demoSnapshot,
  demoVoices,
} from './demo-data';

function demoUnavailable(): AppError {
  return new AppError({
    code: 'demo-unavailable',
    category: 'unsupported',
    retryable: false,
    message: '演示模式下不可用。退出演示后可在真实设置中操作。',
  });
}

export class DemoClient implements UiClient {
  readonly mode = 'demo' as const;
  private version = 1;
  private state: ClientState;
  private cuesState: CuesState = IDLE_CUES_STATE;
  private readonly listeners = new Set<() => void>();
  private readonly cuesListeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly cueRefs = new Map<string, number>();

  constructor() {
    this.state = {
      connection: 'connected',
      snapshot: demoSnapshot(this.version),
      reconnectAttempts: 0,
    };
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
      case 'settings/update':
        this.update({ settings: applySettingsPatch(snapshot.settings, command.patch) });
        return { persisted: true };
      case 'settings/reset':
        this.update({ settings: defaultSettings() });
        return { persisted: true };
      case 'tts/voices':
        return { voices: demoVoices() };
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
    const player = demoPlayer(timeMs);
    const session = snapshot.sessions[0];
    this.update({
      pages: [{ ...demoPage(player), connectedAt: snapshot.pages[0]?.connectedAt ?? Date.now() }],
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

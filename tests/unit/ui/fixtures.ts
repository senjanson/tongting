/**
 * UI 单测夹具：构造合法快照、会话、页面与字幕。
 */
import type { Cue } from '@src/domain/cue';
import type { PageInfo, PlayerState, SessionSnapshot } from '@src/domain/session';
import { applySettingsPatch, defaultSettings, type SettingsPatch } from '@src/domain/settings';
import { AppSnapshotSchema, type AppSnapshot } from '@src/messaging/ui-protocol';

export const VIDEO_ID = 'abcdefghijk';
export const TAB_ID = 42;

export function makeCue(id: string, startMs: number, overrides: Partial<Cue> = {}): Cue {
  return {
    id,
    revision: 0,
    startMs,
    endMs: startMs + 2_000,
    sourceText: `source ${id}`,
    translatedText: `译文 ${id}`,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track',
    stability: 'final',
    translationState: 'done',
    ...overrides,
  };
}

export function makePlayer(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    videoId: VIDEO_ID,
    title: '真实视频标题',
    currentTimeMs: 5_000,
    durationMs: 600_000,
    paused: false,
    buffering: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    ad: false,
    volume: 1,
    muted: false,
    isLive: false,
    isShorts: false,
    fullscreen: false,
    sampledAtEpochMs: 1_000_000,
    ...overrides,
  };
}

export function makePage(overrides: Partial<PageInfo> = {}): PageInfo {
  return {
    tabId: TAB_ID,
    documentId: 'doc-1',
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
    videoId: VIDEO_ID,
    title: '真实视频标题',
    player: makePlayer(),
    tracks: [],
    captionsAvailability: 'available',
    connectedAt: 1,
    ...overrides,
  };
}

export function makeSession(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    identity: {
      sessionId: 'session-00000001',
      tabId: TAB_ID,
      documentId: 'doc-1',
      videoId: VIDEO_ID,
      epoch: 0,
      configRevision: 1,
    },
    phase: 'running',
    desiredState: 'running',
    outputMode: 'subtitle',
    targetLanguage: 'zh-CN',
    sourceMode: 'full-track',
    sourceTrack: { trackKey: 'en.manual', languageCode: 'en', label: 'English', kind: 'manual' },
    translation: { total: 10, done: 4, pending: 6, running: 0, failed: 0 },
    resources: { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 },
    cueVersion: 1,
    recordId: `${VIDEO_ID}|zh-CN|en.manual`,
    startedAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<AppSnapshot> = {},
  settingsPatch: SettingsPatch = { provider: { baseUrl: 'https://api.example.com/v1' } },
): AppSnapshot {
  const snapshot: AppSnapshot = {
    snapshotVersion: 1,
    workerInstanceId: 'worker-a',
    settings: applySettingsPatch(defaultSettings(), settingsPatch),
    settingsPersisted: true,
    configRevision: 1,
    credential: { configured: true, generation: 1, storage: 'session', masked: '••••abcd' },
    asrToken: { configured: false, generation: 1, storage: 'none' },
    hostPermission: { origin: 'https://api.example.com', granted: true },
    capabilities: {},
    pages: [],
    sessions: [],
    audioOwner: null,
    ...overrides,
  };
  // 夹具必须符合协议 schema，避免测试与真实消息脱节。
  return AppSnapshotSchema.parse(snapshot);
}

/**
 * 演示模式数据。仅在用户明确开启演示模式时使用，界面持续显示演示标识。
 * 这里的视频、字幕、模型与声音全部是示例，不代表任何真实服务能力。
 * 标题、频道、模型与声音名称随界面语言显示；示例字幕固定为英文原文 → 简体中文译文。
 */
import type { Cue } from '../../domain/cue';
import { defaultSettings, applySettingsPatch } from '../../domain/settings';
import type { PageInfo, PlayerState, SessionSnapshot } from '../../domain/session';
import { translate, type Locale } from '../../i18n';
import type { AppSnapshot, TtsVoiceInfo } from '../../messaging/ui-protocol';

export const DEMO_TAB_ID = 0;
export const DEMO_VIDEO_ID = 'DEMO0000001';
export const DEMO_SESSION_ID = 'demo-session-0001';
/** 中文界面的示例视频标题。 */
export const DEMO_TITLE = translate('zh-CN', 'sidepanel.demo.videoTitle');
export const DEMO_DURATION_MS = 96_000;

const LINES: Array<[number, number, string, string | undefined]> = [
  [
    2_000,
    8_000,
    'We often look at things without really seeing them.',
    '我们常常看着眼前的事物，却没有真正看见。',
  ],
  [8_500, 15_000, 'Attention is something we can practice.', '专注观察是一项可以练习的能力。'],
  [15_500, 23_000, 'Real learning begins with staying curious.', '真正的学习，始于保持好奇。'],
  [23_500, 30_000, 'You do not need to have all the answers.', '你不需要掌握所有答案。'],
  [
    30_500,
    38_000,
    'Sometimes a better question is enough.',
    '有时候，提出一个更好的问题就足够了。',
  ],
  [
    38_500,
    46_000,
    'Try slowing down and noticing one small detail.',
    '试着慢下来，留意一个微小的细节。',
  ],
  [
    46_500,
    54_000,
    'Familiar places can reveal new possibilities.',
    '熟悉的地方，也能让你看见新的可能。',
  ],
  [54_500, 62_000, 'That is where a different way of thinking begins.', undefined],
];

export function demoCues(): Cue[] {
  return LINES.map(([startMs, endMs, sourceText, translatedText], i) => ({
    id: `demo-${i + 1}`,
    revision: 0,
    startMs,
    endMs,
    sourceText,
    ...(translatedText ? { translatedText } : {}),
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track' as const,
    stability: 'final' as const,
    translationState: translatedText ? ('done' as const) : ('pending' as const),
  }));
}

export function demoVoices(locale: Locale = 'zh-CN'): TtsVoiceInfo[] {
  return [
    { voiceName: translate(locale, 'sidepanel.demo.voiceZhA'), lang: 'zh-CN' },
    { voiceName: translate(locale, 'sidepanel.demo.voiceZhB'), lang: 'zh-CN' },
    { voiceName: translate(locale, 'sidepanel.demo.voiceEn'), lang: 'en-US' },
  ];
}

export function demoPlayer(
  currentTimeMs: number,
  paused = false,
  locale: Locale = 'zh-CN',
): PlayerState {
  return {
    videoId: DEMO_VIDEO_ID,
    title: translate(locale, 'sidepanel.demo.videoTitle'),
    channel: translate(locale, 'sidepanel.demo.channel'),
    currentTimeMs,
    durationMs: DEMO_DURATION_MS,
    paused,
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
    sampledAtEpochMs: Date.now(),
  };
}

export function demoPage(player: PlayerState, locale: Locale = 'zh-CN'): PageInfo {
  return {
    tabId: DEMO_TAB_ID,
    documentId: 'demo-document',
    url: `https://www.youtube.com/watch?v=${DEMO_VIDEO_ID}`,
    videoId: DEMO_VIDEO_ID,
    title: translate(locale, 'sidepanel.demo.videoTitle'),
    player,
    tracks: [
      {
        trackKey: 'demo.en',
        languageCode: 'en',
        label: translate(locale, 'sidepanel.demo.track'),
        kind: 'manual',
      },
    ],
    captionsAvailability: 'available',
    connectedAt: Date.now(),
  };
}

export function demoSession(
  player: PlayerState,
  cues: readonly Cue[],
  locale: Locale = 'zh-CN',
): SessionSnapshot {
  const done = cues.filter((c) => c.translationState === 'done').length;
  return {
    identity: {
      sessionId: DEMO_SESSION_ID,
      tabId: DEMO_TAB_ID,
      documentId: 'demo-document',
      videoId: DEMO_VIDEO_ID,
      epoch: 0,
      configRevision: 0,
    },
    phase: 'running',
    desiredState: 'running',
    outputMode: 'subtitle',
    targetLanguage: 'zh-CN',
    sourceMode: 'full-track',
    sourceTrack: {
      trackKey: 'demo.en',
      languageCode: 'en',
      label: translate(locale, 'sidepanel.demo.track'),
      kind: 'manual',
    },
    detectedSourceLanguage: 'en',
    player,
    coverage: {
      complete: true,
      ranges: [{ startMs: 0, endMs: DEMO_DURATION_MS }],
      gaps: [],
      durationMs: DEMO_DURATION_MS,
    },
    translation: {
      total: cues.length,
      done,
      pending: cues.length - done,
      running: 0,
      failed: 0,
      model: translate(locale, 'sidepanel.demo.model'),
    },
    resources: { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 },
    cueVersion: 1,
    recordId: `${DEMO_VIDEO_ID}|zh-CN|demo.en`,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function demoSnapshot(version: number, locale: Locale = 'zh-CN'): AppSnapshot {
  const player = demoPlayer(16_000, false, locale);
  const cues = demoCues();
  const settings = applySettingsPatch(defaultSettings(), {
    provider: { baseUrl: 'https://sub2api.example.invalid' },
    captions: { fontSizePx: 21 },
    audio: { originalVolume: 0.7 },
  });
  return {
    snapshotVersion: version,
    workerInstanceId: 'demo',
    settings,
    settingsPersisted: true,
    configRevision: 0,
    credential: { configured: true, generation: 0, storage: 'session', masked: '••••demo' },
    asrToken: { configured: false, generation: 0, storage: 'none' },
    hostPermission: { origin: 'https://sub2api.example.invalid', granted: true },
    capabilities: {},
    pages: [demoPage(player, locale)],
    sessions: [demoSession(player, cues, locale)],
    audioOwner: null,
  };
}

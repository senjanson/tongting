/**
 * 导出诊断日志：环境与当前状态摘要 + 按时间排列的日志记录，纯文本。
 * 设置只导出非敏感字段：服务地址只保留 origin，术语表只给条数，不含 Key 或识别令牌。
 */
import type { PageInfo, SessionSnapshot } from '../domain/session';
import type { Settings } from '../domain/settings';
import { formatDiagEntry, formatLocalTime, type DiagEntry } from './log';
import { redact } from './redact';

export interface DiagnosticsExportInput {
  version: string;
  userAgent: string;
  uiLanguage: string;
  generatedAt: number;
  settings: Settings;
  credentialConfigured: boolean;
  asrTokenConfigured: boolean;
  hostPermission: { origin?: string; granted: boolean };
  sessions: readonly SessionSnapshot[];
  pages: readonly PageInfo[];
  entries: readonly DiagEntry[];
}

function origin(url: string): string {
  if (!url) return '';
  try {
    return new URL(url).origin;
  } catch {
    return '[url]';
  }
}

export function settingsSummary(s: Settings): Record<string, unknown> {
  return {
    sourceLanguage: s.sourceLanguage,
    targetLanguage: s.targetLanguage,
    outputMode: s.outputMode,
    playbackMode: s.playbackMode,
    bufferSeconds: s.bufferSeconds,
    sourceStrategy: s.sourceStrategy,
    style: s.style,
    prefetch: s.prefetch,
    cacheTranslations: s.cacheTranslations,
    glossaryEntries: s.glossary.length,
    provider: {
      baseUrl: origin(s.provider.baseUrl),
      protocol: s.provider.protocol,
      detectedProtocol: s.provider.detectedProtocol,
      model: s.provider.model,
      streaming: s.provider.streaming,
      reasoningEffort: s.provider.reasoningEffort,
      timeoutMs: s.provider.timeoutMs,
    },
    asr: {
      backend: s.asr.backend,
      localUrl: origin(s.asr.localUrl),
      sub2apiModel: s.asr.sub2apiModel,
      segmentMs: s.asr.segmentMs,
    },
    tts: s.tts,
    audio: s.audio,
    captions: s.captions,
    pauseDubWithVideo: s.pauseDubWithVideo,
    uiLocale: s.uiLocale,
    uiTheme: s.uiTheme,
  };
}

function sessionLine(s: SessionSnapshot): Record<string, unknown> {
  return {
    session: s.identity.sessionId,
    tab: s.identity.tabId,
    video: s.identity.videoId,
    phase: s.phase,
    desired: s.desiredState,
    source: s.sourceMode,
    track: s.sourceTrack && `${s.sourceTrack.languageCode}:${s.sourceTrack.kind}`,
    output: s.outputMode,
    notice: s.notice && `${s.notice.code}: ${s.notice.message}`,
    error: s.error && `${s.error.code}: ${s.error.message}`,
    buffer: s.playbackBuffer,
    translation: {
      total: s.translation.total,
      done: s.translation.done,
      pending: s.translation.pending,
      failed: s.translation.failed,
      blocked: s.translation.blockedError?.code,
      latencyMs: s.translation.lastLatencyMs,
    },
    resources: s.resources,
    player: s.player && {
      timeMs: Math.round(s.player.currentTimeMs),
      paused: s.player.paused,
      muted: s.player.muted,
      volume: s.player.volume,
      ad: s.player.ad,
    },
  };
}

function pageLine(p: PageInfo): Record<string, unknown> {
  return {
    tab: p.tabId,
    video: p.videoId,
    captions: p.captionsAvailability,
    tracks: p.tracks.map((t) => `${t.languageCode}:${t.kind}`),
    player: p.player && {
      timeMs: Math.round(p.player.currentTimeMs),
      paused: p.player.paused,
      muted: p.player.muted,
      volume: p.player.volume,
      ad: p.player.ad,
    },
  };
}

export function buildDiagnosticsText(input: DiagnosticsExportInput): string {
  const json = (v: unknown) => JSON.stringify(redact(v));
  const lines = [
    `Vocasub diagnostics ${input.version}`,
    `generated: ${formatLocalTime(input.generatedAt)}`,
    `browser: ${input.userAgent}`,
    `uiLanguage: ${input.uiLanguage}`,
    `credential: ${input.credentialConfigured ? 'configured' : 'missing'}; asrToken: ${input.asrTokenConfigured ? 'configured' : 'missing'}`,
    `hostPermission: ${input.hostPermission.granted ? 'granted' : 'not granted'} ${origin(input.hostPermission.origin ?? '')}`,
    `settings: ${json(settingsSummary(input.settings))}`,
    '',
    `pages (${input.pages.length}):`,
    ...input.pages.map((p) => `  ${json(pageLine(p))}`),
    `sessions (${input.sessions.length}):`,
    ...input.sessions.map((s) => `  ${json(sessionLine(s))}`),
    '',
    `log (${input.entries.length} entries, oldest first):`,
    // 页面记录按批次到达，与 worker 记录交错：按记录时间排序（相同时间保持到达顺序）。
    ...[...input.entries].sort((a, b) => a.t - b.t).map(formatDiagEntry),
    '',
  ];
  return lines.join('\n');
}

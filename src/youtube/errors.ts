/**
 * 内容脚本侧可展示错误。message 面向用户，不含字幕原文、URL 或堆栈。
 */
import { AppError, type AppErrorInfo, type ErrorCategory } from '../domain/errors';
import { t, type MessageKey } from '../i18n';

export type YoutubeErrorCode =
  | 'stale-video'
  | 'navigation-changed'
  | 'player-unavailable'
  | 'ad-playing'
  | 'captions-no-tracks'
  | 'captions-track-not-found'
  | 'captions-load-timeout'
  | 'captions-parse-failed'
  | 'captions-player-unavailable'
  | 'captions-bridge-unavailable'
  | 'duck-failed'
  | 'internal';

/** 文案在创建错误时按内容脚本当前语言生成（语言由 worker 下发，见 controller）。 */
const DEFS: Record<
  YoutubeErrorCode,
  { category: ErrorCategory; retryable: boolean; messageKey: MessageKey }
> = {
  'stale-video': {
    category: 'youtube',
    retryable: false,
    messageKey: 'background.youtube.staleVideo',
  },
  'navigation-changed': {
    category: 'cancelled',
    retryable: false,
    messageKey: 'background.youtube.navigationChanged',
  },
  'player-unavailable': {
    category: 'youtube',
    retryable: true,
    messageKey: 'background.youtube.playerUnavailable',
  },
  'ad-playing': {
    category: 'youtube',
    retryable: true,
    messageKey: 'background.youtube.adPlaying',
  },
  'captions-no-tracks': {
    category: 'captions',
    retryable: false,
    messageKey: 'background.youtube.noTracks',
  },
  'captions-track-not-found': {
    category: 'captions',
    retryable: false,
    messageKey: 'background.youtube.trackNotFound',
  },
  'captions-load-timeout': {
    category: 'captions',
    retryable: true,
    messageKey: 'background.youtube.loadTimeout',
  },
  'captions-parse-failed': {
    category: 'captions',
    retryable: false,
    messageKey: 'background.youtube.parseFailed',
  },
  'captions-player-unavailable': {
    category: 'captions',
    retryable: true,
    messageKey: 'background.youtube.captionsPlayerUnavailable',
  },
  'captions-bridge-unavailable': {
    category: 'captions',
    retryable: true,
    messageKey: 'background.youtube.bridgeUnavailable',
  },
  'duck-failed': {
    category: 'youtube',
    retryable: false,
    messageKey: 'background.youtube.duckFailed',
  },
  internal: {
    category: 'internal',
    retryable: false,
    messageKey: 'background.youtube.internal',
  },
};

export function youtubeError(code: YoutubeErrorCode, detail?: string): AppError {
  const def = DEFS[code];
  return new AppError({
    code,
    category: def.category,
    retryable: def.retryable,
    message: t(def.messageKey),
    detail,
  });
}

export function youtubeErrorInfo(code: YoutubeErrorCode, detail?: string): AppErrorInfo {
  return youtubeError(code, detail).info;
}

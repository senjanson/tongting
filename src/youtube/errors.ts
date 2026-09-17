/**
 * 内容脚本侧可展示错误。message 面向用户，不含字幕原文、URL 或堆栈。
 */
import { AppError, type AppErrorInfo, type ErrorCategory } from '../domain/errors';

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

const DEFS: Record<
  YoutubeErrorCode,
  { category: ErrorCategory; retryable: boolean; message: string }
> = {
  'stale-video': {
    category: 'youtube',
    retryable: false,
    message: '页面上的视频已经变化，旧请求已忽略。',
  },
  'navigation-changed': {
    category: 'cancelled',
    retryable: false,
    message: '页面已切换到其他视频，操作已取消。',
  },
  'player-unavailable': {
    category: 'youtube',
    retryable: true,
    message: '未找到页面中的视频播放器，请等待视频加载后重试。',
  },
  'ad-playing': {
    category: 'youtube',
    retryable: true,
    message: '广告播放中，请在正片开始后重试。',
  },
  'captions-no-tracks': {
    category: 'captions',
    retryable: false,
    message: '当前视频没有可读取的字幕轨道。',
  },
  'captions-track-not-found': {
    category: 'captions',
    retryable: false,
    message: '找不到指定的字幕轨道，可能已随视频切换失效。',
  },
  'captions-load-timeout': {
    category: 'captions',
    retryable: true,
    message: '字幕轨道加载超时：播放器没有返回可读取的字幕内容。可改用当前显示字幕或语音识别。',
  },
  'captions-parse-failed': {
    category: 'captions',
    retryable: false,
    message: '字幕内容格式无法识别，无法读取完整轨道。',
  },
  'captions-player-unavailable': {
    category: 'captions',
    retryable: true,
    message: '暂时无法读取播放器字幕信息，请稍后重试。',
  },
  'captions-bridge-unavailable': {
    category: 'captions',
    retryable: true,
    message: '页面字幕接入未就绪，请刷新 YouTube 页面后重试。',
  },
  'duck-failed': { category: 'youtube', retryable: false, message: '无法调整原声音量。' },
  internal: {
    category: 'internal',
    retryable: false,
    message: '页面接入发生内部错误，请刷新页面后重试。',
  },
};

export function youtubeError(code: YoutubeErrorCode, detail?: string): AppError {
  const def = DEFS[code];
  return new AppError({
    code,
    category: def.category,
    retryable: def.retryable,
    message: def.message,
    detail,
  });
}

export function youtubeErrorInfo(code: YoutubeErrorCode, detail?: string): AppErrorInfo {
  return youtubeError(code, detail).info;
}

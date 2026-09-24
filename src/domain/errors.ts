import { z } from 'zod';
import { t } from '../i18n';

export const ErrorCategorySchema = z.enum([
  'config', // 未配置或配置无效
  'auth', // 401 / Key 无效
  'permission', // 403 / 模型无权限 / 未授予 host 权限
  'quota', // 余额不足
  'rate-limit', // 429
  'network', // 断网、DNS、CORS、重定向被拒
  'timeout',
  'server', // 5xx
  'format', // 响应格式或内容校验失败
  'unsupported', // 服务/设备/视频不支持
  'captions', // 字幕不可读
  'capture', // 标签页音频捕获
  'audio', // AudioContext / 播放
  'tts',
  'asr',
  'youtube', // 播放器接入
  'storage',
  'cancelled',
  'internal',
]);
export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

/**
 * 可跨进程传递、可展示给用户的错误。禁止放入 Key、请求头、带签名 URL 或原始堆栈。
 */
export const AppErrorInfoSchema = z.object({
  code: z.string().max(80),
  category: ErrorCategorySchema,
  retryable: z.boolean(),
  /** 面向用户的中文说明，包含下一步操作。 */
  message: z.string().max(500),
  httpStatus: z.number().int().optional(),
  retryAfterMs: z.number().nonnegative().optional(),
  /** 已脱敏的补充信息，例如脱敏后的 origin 或服务返回的错误类型。 */
  detail: z.string().max(500).optional(),
  at: z.number().optional(),
});
export type AppErrorInfo = z.infer<typeof AppErrorInfoSchema>;

export class AppError extends Error {
  readonly info: AppErrorInfo;
  constructor(info: Omit<AppErrorInfo, 'at'> & { at?: number }, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = 'AppError';
    this.info = { ...info, at: info.at ?? Date.now() };
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof AppError && error.info.category === 'cancelled')
  );
}

export function cancelledError(detail?: string): AppError {
  return new AppError({
    code: 'cancelled',
    category: 'cancelled',
    retryable: false,
    message: t('background.errors.cancelled'),
    detail,
  });
}

/** 将未知异常转为可展示错误，避免把堆栈或敏感字段带出。 */
export function toAppErrorInfo(error: unknown, fallback?: Partial<AppErrorInfo>): AppErrorInfo {
  if (error instanceof AppError) return error.info;
  if (isAbortError(error)) return cancelledError().info;
  return {
    code: fallback?.code ?? 'internal',
    category: fallback?.category ?? 'internal',
    retryable: fallback?.retryable ?? false,
    message: fallback?.message ?? t('background.errors.internal'),
    detail:
      fallback?.detail ??
      (error instanceof Error ? redactSecrets(error.message).slice(0, 200) : undefined),
    at: Date.now(),
  };
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{8,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /([?&](?:key|api_key|apikey|token|access_token|signature|sig|pot|auth)=)[^&\s#]+/gi,
  /("?(?:authorization|api[_-]?key|x-api-key|token)"?\s*[:=]\s*"?)[^",\s}]+/gi,
];

/** 日志与错误文本脱敏。只做防御性处理，不能代替「不记录敏感字段」。 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(SECRET_PATTERNS[0]!, '[REDACTED_KEY]');
  out = out.replace(SECRET_PATTERNS[1]!, 'Bearer [REDACTED]');
  out = out.replace(SECRET_PATTERNS[2]!, '$1[REDACTED]');
  out = out.replace(SECRET_PATTERNS[3]!, '$1[REDACTED]');
  return out;
}

/** 返回脱敏后的 origin，例如 `https://api.example.com`；无效时返回 `[invalid-url]`。 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '[invalid-url]';
  }
}

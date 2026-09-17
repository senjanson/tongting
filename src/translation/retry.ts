/**
 * 重试与退避策略（纯函数，时间与随机数由调用方注入）。
 */
import type { AppErrorInfo } from '../domain/errors';

export interface BackoffPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
}

/** 可自动重试的故障类别：网络、超时、5xx、限流。认证/权限/余额/配置/格式错误不自动重试。 */
export function isAutoRetryable(error: AppErrorInfo): boolean {
  return (
    error.retryable &&
    (error.category === 'network' ||
      error.category === 'timeout' ||
      error.category === 'server' ||
      error.category === 'rate-limit')
  );
}

/** 同一服务的所有后续请求都会同样失败的错误：暂停发送，等待用户动作（改配置 / 重试 / 继续）。 */
export function isBlockingError(error: AppErrorInfo): boolean {
  if (error.retryable) return false;
  return (
    error.category === 'auth' ||
    error.category === 'permission' ||
    error.category === 'quota' ||
    error.category === 'config' ||
    error.category === 'unsupported' ||
    error.category === 'network'
  );
}

/**
 * 指数退避 + 等量抖动：delay ∈ [d/2, d]，d = min(max, base · 2^(attempt-1))。
 * attempt 从 1 开始。
 */
export function backoffDelay(attempt: number, policy: BackoffPolicy, random: () => number): number {
  const exp = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + clamp01(random()) * (exp / 2));
}

/** 优先遵守 Retry-After，并加少量抖动避免多个任务在同一时刻重试。 */
export function retryDelay(
  error: AppErrorInfo,
  attempt: number,
  policy: BackoffPolicy,
  random: () => number,
): number {
  if (error.retryAfterMs !== undefined) {
    return Math.round(
      error.retryAfterMs + clamp01(random()) * Math.min(1_000, policy.baseDelayMs / 2),
    );
  }
  return backoffDelay(attempt, policy, random);
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5;
}

/** 同步的短指纹（FNV-1a 双 32 位），用于 translationKey 标识，不用于安全用途。 */
export function shortFingerprint(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193 + 0x1000);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

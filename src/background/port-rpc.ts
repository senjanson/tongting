/**
 * 端口请求/响应的通用部分：requestId 对应、超时、断开时拒绝全部在途请求。
 */
import { AppError } from '../domain/errors';
import type { AppErrorInfo } from '../domain/errors';
import { t } from '../i18n';

interface Pending {
  resolve(data: unknown): void;
  reject(error: AppError): void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingRequests {
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(private readonly randomId: (prefix?: string) => string) {}

  create(timeoutMs: number, send: (requestId: string) => void): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(disconnectedError());
    }
    const requestId = this.randomId('r');
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(
          new AppError({
            code: 'request-timeout',
            category: 'timeout',
            retryable: true,
            message: t('background.rpc.timeout'),
          }),
        );
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        send(requestId);
      } catch {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(disconnectedError());
      }
    });
  }

  settle(
    requestId: string,
    result: { ok: true; data?: unknown } | { ok: false; error: AppErrorInfo },
  ): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    if (result.ok) p.resolve(result.data);
    else p.reject(new AppError(result.error));
  }

  closeAll(): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(disconnectedError());
      this.pending.delete(id);
    }
  }

  get size(): number {
    return this.pending.size;
  }
}

function disconnectedError(): AppError {
  return new AppError({
    code: 'port-disconnected',
    category: 'internal',
    retryable: true,
    message: t('background.rpc.disconnected'),
  });
}

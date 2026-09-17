/**
 * sub2api HTTP 层：真实 fetch 传输、超时与取消组合、错误映射、受限读取。
 *
 * 安全约束：
 * - `redirect: 'manual'`：不跟随任何重定向（包括同站），检测到 3xx / opaqueredirect 即失败，
 *   Authorization 不会被发往其他地址。选择 manual 而不是 error，是为了在浏览器中也能给出
 *   「服务返回了重定向」的明确提示（error 模式在 Chrome 中只表现为无法区分的 TypeError）。
 * - `credentials: 'omit'`：不携带 Cookie。
 * - 请求只发往调用方给出的、已规范化的 origin；发送前再次核对。
 */
import { AppError, cancelledError, isAbortError } from '../../domain/errors';
import type { HttpTransport } from './types';
import { errorFromHttpStatus, networkError, timeoutError } from './http-errors';

/** 响应体读取上限，防止异常服务把超大内容塞进扩展内存。 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** 真实 fetch 传输。真实模式只能使用它，不会自动回落到 mock。 */
export function createFetchTransport(
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): HttpTransport {
  return {
    kind: 'fetch',
    fetch(url, init) {
      return fetchImpl(url, {
        ...init,
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    },
  };
}

export interface ApiRequest {
  transport: HttpTransport;
  url: string;
  /** 规范化后的 origin；请求 URL 必须属于它。 */
  expectedOrigin: string;
  method: 'GET' | 'POST';
  apiKey?: string;
  body?: unknown;
  accept: 'json' | 'sse';
  signal: AbortSignal;
}

/**
 * 在「用户取消 + 超时」组合信号下执行一个完整操作（包括读取响应体/流）。
 * 取消 → cancelled；超时 → timeout；其他 TypeError → network。
 * 即使传输层忽略 signal，也会在取消/超时时立即返回（race），不让调用方无限等待。
 */
export async function withRequestSignal<T>(
  userSignal: AbortSignal,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (userSignal.aborted) throw cancelledError();
  const controller = new AbortController();
  let reason: 'cancelled' | 'timeout' | undefined;
  let rejectAbort: ((error: AppError) => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  // 避免未等待的 rejection 警告
  abortPromise.catch(() => undefined);

  const onUserAbort = () => {
    if (reason) return;
    reason = 'cancelled';
    controller.abort();
    rejectAbort?.(cancelledError());
  };
  userSignal.addEventListener('abort', onUserAbort, { once: true });
  const timer = setTimeout(
    () => {
      if (reason) return;
      reason = 'timeout';
      controller.abort();
      rejectAbort?.(timeoutError(timeoutMs));
    },
    Math.max(1, timeoutMs),
  );

  try {
    return await Promise.race([run(controller.signal), abortPromise]);
  } catch (error) {
    // run 以任何错误结束时都中止底层请求，确保连接关闭、服务端不再继续生成。
    if (!controller.signal.aborted) controller.abort();
    if (reason === 'cancelled') throw cancelledError();
    if (reason === 'timeout') throw timeoutError(timeoutMs);
    if (error instanceof AppError) throw error;
    if (isAbortError(error)) throw cancelledError();
    if (error instanceof TypeError) throw networkError(error);
    throw new AppError(
      {
        code: 'request-failed',
        category: 'internal',
        retryable: false,
        message: '请求处理失败，请重试。',
      },
      { cause: error },
    );
  } finally {
    clearTimeout(timer);
    userSignal.removeEventListener('abort', onUserAbort);
  }
}

function assertOrigin(url: string, expectedOrigin: string): void {
  let origin: string;
  try {
    origin = new URL(url).origin.toLowerCase();
  } catch {
    origin = '';
  }
  if (!origin || origin !== expectedOrigin.toLowerCase()) {
    throw new AppError({
      code: 'origin-mismatch',
      category: 'config',
      retryable: false,
      message: '请求地址与已配置的服务地址不一致，已拒绝发送。',
    });
  }
}

/**
 * 发送请求并在非 2xx 时抛出映射后的 AppError。返回的 Response 状态一定是 2xx。
 * 必须在 withRequestSignal 内调用，signal 为组合后的信号。
 */
export async function sendApiRequest(req: ApiRequest): Promise<Response> {
  assertOrigin(req.url, req.expectedOrigin);
  const headers: Record<string, string> = {
    Accept: req.accept === 'sse' ? 'text/event-stream' : 'application/json',
  };
  if (req.apiKey) headers.Authorization = `Bearer ${req.apiKey}`;
  if (req.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await req.transport.fetch(req.url, {
    method: req.method,
    headers,
    body: req.body === undefined ? undefined : JSON.stringify(req.body),
    signal: req.signal,
    redirect: 'manual',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  });

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    void response.body?.cancel().catch(() => undefined);
    throw new AppError(errorFromHttpStatus(response.status || 302, response.headers, ''));
  }
  if (!response.ok) {
    const text = await readTextLimited(response, 64 * 1024).catch(() => '');
    throw new AppError(errorFromHttpStatus(response.status, response.headers, text));
  }
  return response;
}

/** 读取响应文本，超过上限即中止读取并报错。 */
export async function readTextLimited(
  response: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let total = 0;
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new AppError({
          code: 'response-too-large',
          category: 'format',
          retryable: false,
          message: '服务返回的内容过大，已停止读取。',
        });
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    reader.releaseLock();
  }
}

/** 读取并解析 JSON 响应；非 JSON 时给出 Base URL 相关提示。 */
export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await readTextLimited(response);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError({
      code: 'invalid-json-response',
      category: 'format',
      retryable: true,
      message: '服务返回的不是有效 JSON：请确认 Base URL 指向 API 根地址而不是网页。',
    });
  }
}

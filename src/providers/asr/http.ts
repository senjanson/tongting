/**
 * 语音类 HTTP 客户端共用工具：地址校验、超时/取消（覆盖到响应体读取完毕）、有上限的流式读取、错误映射。
 *
 * 安全约束：
 * - 不跟随重定向（redirect: 'error'），避免认证头被带到其他站点（T30）。
 * - 不携带 Cookie（credentials: 'omit'）。
 * - 错误信息只包含脱敏后的 origin 和服务返回的错误码，不含 Key、请求头与完整 URL。
 */
import { AppError, redactSecrets, redactUrl, type AppErrorInfo } from '../../domain/errors';

export type AudioServiceKind = 'local-asr' | 'sub2api-asr' | 'sub2api-tts';

const SERVICE_LABEL: Record<AudioServiceKind, string> = {
  'local-asr': '本地识别服务',
  'sub2api-asr': 'sub2api 语音识别',
  'sub2api-tts': 'sub2api 语音合成',
};

/** 错误响应体最多读取的字节数（超出部分截断丢弃）。 */
export const ERROR_BODY_MAX_BYTES = 16_000;

function configError(code: string, message: string): AppError {
  return new AppError({ code, category: 'config', retryable: false, message });
}

/**
 * 本地识别服务地址：只允许 http://127.0.0.1:<port>。
 * 服务只绑定 IPv4 回环且校验 Host 头；localhost 可能解析到被其他进程占用的 ::1，因此拒绝。
 */
export function normalizeLoopbackBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw configError('asr-local-url-invalid', '本地识别服务地址无效，应为 http://127.0.0.1:端口');
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port) {
    throw configError(
      'asr-local-url-not-loopback',
      '本地识别服务地址只允许 http://127.0.0.1:端口（不支持 localhost）',
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configError('asr-local-url-invalid', '本地识别服务地址不能包含账号、查询参数或锚点');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** sub2api 地址：生产只允许 HTTPS；loopback HTTP 仅用于本机开发。 */
export function normalizeServiceBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw configError('base-url-invalid', 'sub2api 地址无效');
  }
  // 与 worker 端 base-url 规则一致：http 只允许 127.0.0.1（manifest 不再申请 localhost 主机权限）。
  const loopback = url.protocol === 'http:' && url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !loopback) {
    throw configError('base-url-insecure', 'sub2api 地址必须使用 HTTPS（本机开发地址除外）');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw configError('base-url-invalid', 'sub2api 地址不能包含账号、查询参数或锚点');
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`;
}

/** 拼接 API 路径，避免 Base URL 已带 /v1 时重复。path 以 /v1/ 开头。 */
export function joinApiPath(normalizedBase: string, path: string): string {
  const base = normalizedBase.replace(/\/+$/, '');
  if (path.startsWith('/v1/') && /\/v1$/.test(base)) return base + path.slice(3);
  return base + path;
}

export function parseRetryAfterMs(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.min(600_000, Math.round(Number(trimmed) * 1000));
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) return Math.min(600_000, Math.max(0, date - nowMs));
  return undefined;
}

export interface FetchGuardOptions {
  signal: AbortSignal;
  timeoutMs: number;
  service: AudioServiceKind;
  origin: string;
}

/** 在 guardedRequest 的超时/取消保护下读取响应体。 */
export interface GuardedBody {
  /** 流式读取，超过 maxBytes 立即取消读取并抛 response-too-large。 */
  bytes(maxBytes: number): Promise<Uint8Array>;
  /** 读取 JSON（超限同上；解析失败抛出原始 SyntaxError，由调用方映射）。 */
  json(maxBytes: number): Promise<unknown>;
  /** 读取文本并在 maxBytes 处截断（用于错误体）。 */
  truncatedText(maxBytes: number): Promise<string>;
}

function tooLarge(): AppError {
  return new AppError({
    code: 'response-too-large',
    category: 'format',
    retryable: false,
    message: '服务返回的数据过大',
  });
}

async function readStream(
  response: Response,
  maxBytes: number,
  truncate: boolean,
): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      if (truncate) return buf.slice(0, maxBytes);
      throw tooLarge();
    }
    return buf;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (total + value.byteLength > maxBytes) {
      if (truncate) chunks.push(value.slice(0, maxBytes - total));
      total = maxBytes;
      await reader.cancel().catch(() => undefined);
      if (!truncate) throw tooLarge();
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * 带超时与取消的请求：超时与调用方取消覆盖整个过程（请求、响应头、响应体读取与 consume 回调）。
 * 调用方取消 → cancelled；超时 → timeout；网络失败 → network；仍为重定向响应 → redirect-blocked。
 * consume 中卡住（例如服务端迟迟不发 body）时，abort 会让等待立即失败，并取消响应体。
 */
export async function guardedRequest<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: FetchGuardOptions,
  consume: (response: Response, body: GuardedBody) => Promise<T>,
): Promise<T> {
  if (options.signal.aborted) throw cancelled();
  const controller = new AbortController();
  let timedOut = false;
  let rejectAbort!: (e: unknown) => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  aborted.catch(() => undefined);
  const onAbort = () => {
    controller.abort();
    rejectAbort(cancelled());
  };
  options.signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectAbort(timeoutError(options));
  }, options.timeoutMs);
  let response: Response | undefined;
  const mapError = (error: unknown): unknown => {
    if (timedOut) return timeoutError(options);
    if (options.signal.aborted) return cancelled();
    return error;
  };
  try {
    try {
      response = await Promise.race([
        fetchImpl(url, {
          ...init,
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
        }),
        aborted,
      ]);
    } catch (error) {
      const mapped = mapError(error);
      if (mapped instanceof AppError) throw mapped;
      throw networkError(options, error);
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new AppError({
        code: 'redirect-blocked',
        category: 'network',
        retryable: false,
        message: `${SERVICE_LABEL[options.service]}返回了重定向，已拒绝跟随以保护凭证；请检查服务地址。`,
        httpStatus: response.status || undefined,
        detail: options.origin,
      });
    }
    const res = response;
    const body: GuardedBody = {
      bytes: (max) => readStream(res, max, false),
      json: async (max) => JSON.parse(new TextDecoder().decode(await readStream(res, max, false))),
      truncatedText: async (max) => new TextDecoder().decode(await readStream(res, max, true)),
    };
    try {
      return await Promise.race([consume(res, body), aborted]);
    } catch (error) {
      throw mapError(error);
    }
  } catch (error) {
    // 未读完的响应体一并取消，释放连接。
    response?.body?.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener('abort', onAbort);
  }
}

function cancelled(): AppError {
  return new AppError({
    code: 'cancelled',
    category: 'cancelled',
    retryable: false,
    message: '操作已取消',
  });
}

function timeoutError(o: FetchGuardOptions): AppError {
  return new AppError({
    code: `${o.service}-timeout`,
    category: 'timeout',
    retryable: true,
    message: `${SERVICE_LABEL[o.service]}响应超时`,
    detail: o.origin,
  });
}

function networkError(o: FetchGuardOptions, error: unknown): AppError {
  const local = o.service === 'local-asr';
  return new AppError(
    {
      code: local ? 'asr-local-unreachable' : 'network',
      category: 'network',
      retryable: true,
      message: local
        ? '无法连接本地识别服务：请确认服务已启动、地址为 http://127.0.0.1:端口，并已授予扩展访问 http://127.0.0.1 的权限。'
        : `无法连接${SERVICE_LABEL[o.service]}：可能是网络中断、跨域被拒绝或服务尝试重定向（已禁止跟随）。`,
      detail: `${o.origin}${error instanceof Error ? ` ${redactSecrets(error.name)}` : ''}`,
    },
    { cause: error },
  );
}

/** 解析常见错误体：{ error: { code, message, type } } 或 { error: string }。只取短的错误码/类型。 */
export function extractErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const err = (body as Record<string, unknown>).error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const code =
      typeof e.code === 'string' ? e.code : typeof e.type === 'string' ? e.type : undefined;
    return code ? redactSecrets(code).slice(0, 80) : undefined;
  }
  if (typeof err === 'string') return redactSecrets(err).slice(0, 80);
  return undefined;
}

/** 在 consume 回调内调用：读取截断的错误体并映射。 */
export async function httpError(
  response: Response,
  body: GuardedBody,
  service: AudioServiceKind,
  origin: string,
  nowMs: number,
): Promise<AppError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await body.truncatedText(ERROR_BODY_MAX_BYTES));
  } catch (error) {
    if (error instanceof AppError) throw error;
    parsed = undefined;
  }
  return mapHttpStatus(
    response.status,
    extractErrorCode(parsed),
    parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
    service,
    origin,
  );
}

export function mapHttpStatus(
  status: number,
  serviceCode: string | undefined,
  retryAfterMs: number | undefined,
  service: AudioServiceKind,
  origin: string,
): AppError {
  const label = SERVICE_LABEL[service];
  const local = service === 'local-asr';
  const detail = [origin, serviceCode].filter(Boolean).join(' ');
  const info = (i: Omit<AppErrorInfo, 'httpStatus' | 'detail'>): AppError =>
    new AppError({
      ...i,
      httpStatus: status,
      detail: detail || undefined,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  const code = serviceCode?.toLowerCase() ?? '';
  switch (true) {
    case status === 400 && local && /language/.test(code):
      return info({
        code: 'asr-local-language-unsupported',
        category: 'config',
        retryable: false,
        message: '本地识别服务不支持当前识别语言，请改为「自动识别」或其他语言。',
      });
    case status === 400:
      return info({
        code: `${service}-bad-request`,
        category: 'format',
        retryable: false,
        message: `${label}拒绝了请求参数（400）`,
      });
    case status === 401:
      return info({
        code: local ? 'asr-local-token-invalid' : 'auth-invalid',
        category: 'auth',
        retryable: false,
        message: local
          ? '本地识别服务配对令牌无效，请在设置中重新配对。'
          : 'API Key 无效或已失效，请在设置中检查。',
      });
    case status === 402:
      return info({
        code: 'quota-exceeded',
        category: 'quota',
        retryable: false,
        message: `${label}余额或额度不足。`,
      });
    case status === 403:
      return info({
        code: local
          ? /host/.test(code)
            ? 'asr-local-host-not-allowed'
            : 'asr-local-forbidden'
          : 'permission-denied',
        category: 'permission',
        retryable: false,
        message: local
          ? '本地识别服务拒绝了请求（403）：请使用 http://127.0.0.1:端口 地址，并确认请求来自扩展。'
          : `当前 Key 无权使用${label}或所选模型（403）。`,
      });
    case status === 404:
      return info({
        code: `${service}-not-found`,
        category: 'unsupported',
        retryable: false,
        message: `${label}接口不存在（404）：服务可能不支持该能力或地址有误。`,
      });
    case status === 408:
      return info({
        code: `${service}-timeout`,
        category: 'timeout',
        retryable: true,
        message: `${label}处理超时（408）`,
      });
    case status === 413:
      return info({
        code: 'audio-too-large',
        category: 'format',
        retryable: false,
        message: `${label}拒绝了过长的音频（413）`,
      });
    case status === 415:
      return info({
        code: 'audio-format-unsupported',
        category: 'format',
        retryable: false,
        message: `${label}不接受该音频格式（415）`,
      });
    case status === 429 && /quota|insufficient|billing/.test(code):
      return info({
        code: 'quota-exceeded',
        category: 'quota',
        retryable: false,
        message: `${label}额度不足（429）。`,
      });
    case status === 429:
      return info({
        code: `${service}-rate-limited`,
        category: 'rate-limit',
        retryable: true,
        message: `${label}繁忙或限流（429），稍后重试。`,
      });
    case status === 503 && local && /load/.test(code):
      return info({
        code: 'asr-local-model-loading',
        category: 'server',
        retryable: true,
        message: '本地识别模型正在加载，请稍候。',
      });
    case status === 503 && local && /unavailable/.test(code):
      return info({
        code: 'asr-local-model-unavailable',
        category: 'server',
        retryable: true,
        message: '本地识别服务的模型不可用，请检查服务日志或重新启动服务。',
      });
    case status === 503 && local:
      return info({
        code: 'asr-local-unavailable',
        category: 'server',
        retryable: true,
        message: '本地识别服务暂不可用（503）。',
      });
    case status >= 500:
      return info({
        code: `${service}-server-error`,
        category: 'server',
        retryable: true,
        message: `${label}服务端错误（${status}）`,
      });
    default:
      return info({
        code: `${service}-http-${status}`,
        category: 'server',
        retryable: false,
        message: `${label}返回异常状态（${status}）`,
      });
  }
}

export { redactUrl };

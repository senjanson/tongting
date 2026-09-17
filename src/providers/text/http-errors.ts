/**
 * HTTP 状态码 / 网络异常 → AppErrorInfo 映射。
 *
 * - 解析 OpenAI 风格错误体（`{ error: { message, type, code, param } }`），只保留脱敏后的简短说明。
 * - 不把请求头、Key、完整 URL 或原始堆栈带进错误。
 */
import { AppError, redactSecrets, redactUrl, type AppErrorInfo } from '../../domain/errors';

export interface ParsedServiceError {
  message?: string;
  type?: string;
  code?: string;
  param?: string;
}

/** 从错误响应体中提取服务返回的错误字段（不做任何信任假设）。 */
export function parseServiceErrorBody(bodyText: string): ParsedServiceError {
  const text = bodyText.trim();
  if (!text) return {};
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === 'object') {
      const obj = json as Record<string, unknown>;
      const err = obj.error;
      if (typeof err === 'string') return { message: err };
      if (err && typeof err === 'object') {
        const e = err as Record<string, unknown>;
        return {
          message: asShortString(e.message),
          type: asShortString(e.type),
          code: asShortString(e.code),
          param: asShortString(e.param),
        };
      }
      return {
        message: asShortString(obj.message) ?? asShortString(obj.detail),
        code: asShortString(obj.code),
      };
    }
  } catch {
    // 非 JSON：可能是反向代理的 HTML 错误页，仅取前一小段纯文本。
  }
  const plain = text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain ? { message: plain.slice(0, 160) } : {};
}

function asShortString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number') return String(value);
  return undefined;
}

/** 脱敏：去掉 Key、Bearer、签名参数，并把任何 URL 缩减为 origin。 */
export function sanitizeDetail(text: string | undefined, max = 200): string | undefined {
  if (!text) return undefined;
  const noUrls = text.replace(/https?:\/\/[^\s"'<>]+/gi, (m) => redactUrl(m));
  const out = redactSecrets(noUrls).replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, max) : undefined;
}

/**
 * 解析 Retry-After（秒数或 HTTP 日期）以及 OpenAI 风格的 `retry-after-ms`。
 * 返回毫秒；无法解析时为 undefined。
 */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const ms = headers.get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms.trim())) {
    return Math.max(0, Math.round(Number(ms.trim())));
  }
  const value = headers.get('retry-after');
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** 只凭错误体中的 code / type 判断额度不足（消息正文里的 billing / credit 字样不足为凭）。 */
const QUOTA_CODES = new Set([
  'insufficient_quota',
  'billing_hard_limit_reached',
  'insufficient_balance',
  'insufficient_funds',
  'insufficient_user_quota',
]);
/** 403 / 流内错误的中文余额提示（sub2api 可能直接返回中文消息）。 */
const QUOTA_MESSAGE_PATTERN =
  /insufficient[_\s-]?(quota|balance|funds)|余额不足|欠费|额度不足|额度已用完/i;
const MODEL_NOT_FOUND_PATTERN =
  /model[^.]{0,80}?(does not exist|not[_\s-]?found|not exist)|模型[^。]{0,40}?(不存在|未找到)/i;
const MODEL_PERMISSION_PATTERN = /model|模型|group|分组|channel|渠道/i;
/** 本适配器可能发送、且服务可能不支持的可选参数。 */
const OPTIONAL_PARAM_NAMES = new Set([
  'reasoning',
  'reasoning.effort',
  'reasoning_effort',
  'text',
  'text.format',
  'response_format',
  'stream_options',
  'stream_options.include_usage',
]);
const OPTIONAL_PARAM_MENTION =
  /(^|[^a-z0-9_.])(reasoning(?:[._]effort)?|text\.format|response_format|json_schema|json_object|stream_options|include_usage)(?![a-z0-9_])/i;
const REJECTION_WORDS =
  /unsupported|not supported|does not support|unknown|unrecognized|invalid|not allowed|not permitted|extra (inputs|fields)|不支持/i;
const CONTENT_POLICY_PATTERN =
  /invalid_prompt|content[_\s-]?(policy|filter|management)|flagged|safety|moderation|usage polic|违规|敏感/i;
const CONTEXT_LENGTH_PATTERN =
  /context_length_exceeded|maximum context length|too many tokens|上下文.*(过长|超出)/i;

export function isQuotaCode(code: string | undefined, type: string | undefined): boolean {
  return QUOTA_CODES.has((code ?? '').toLowerCase()) || QUOTA_CODES.has((type ?? '').toLowerCase());
}

/** 400 是否明确指向本请求发送的可选参数（param 字段优先，其次是去掉 URL 后的消息正文）。 */
function rejectsOptionalParameter(parsed: ParsedServiceError): boolean {
  const param = (parsed.param ?? '').toLowerCase();
  if (param && OPTIONAL_PARAM_NAMES.has(param)) return true;
  if (param) return false;
  const code = (parsed.code ?? '').toLowerCase();
  const message = (parsed.message ?? '').replace(/https?:\/\/\S+/gi, ' ');
  if (!OPTIONAL_PARAM_MENTION.test(message)) return false;
  return (
    code === 'unsupported_parameter' ||
    code === 'unsupported_value' ||
    REJECTION_WORDS.test(message)
  );
}

function info(partial: Omit<AppErrorInfo, 'at'>): AppErrorInfo {
  return { ...partial, at: Date.now() };
}

/**
 * 把非 2xx 响应映射为 AppErrorInfo。
 * @param bodyText 错误响应体（调用方负责限制读取大小）。
 */
export function errorFromHttpStatus(
  status: number,
  headers: Headers,
  bodyText: string,
  now: number = Date.now(),
): AppErrorInfo {
  const parsed = parseServiceErrorBody(bodyText);
  const combined = [parsed.type, parsed.code, parsed.param, parsed.message]
    .filter(Boolean)
    .join(' ');
  const detail = sanitizeDetail(combined);
  const base = { httpStatus: status, detail };

  if (status >= 300 && status < 400) {
    return info({
      ...base,
      code: 'redirect-blocked',
      category: 'network',
      retryable: false,
      message:
        '服务返回了重定向，为避免把 API Key 发往其他地址已停止请求；请把 Base URL 改为最终的 API 地址。',
    });
  }
  if (status === 401) {
    return info({
      ...base,
      code: 'auth-invalid',
      category: 'auth',
      retryable: false,
      message: 'API Key 无效或已失效（401）：请在设置中重新填写 Key 后再试。',
    });
  }
  const quotaByCode = isQuotaCode(parsed.code, parsed.type);
  if (
    status === 402 ||
    (status === 429 && quotaByCode) ||
    (status === 403 && (quotaByCode || QUOTA_MESSAGE_PATTERN.test(parsed.message ?? '')))
  ) {
    return info({
      ...base,
      code: 'quota-exhausted',
      category: 'quota',
      retryable: false,
      message: '服务提示余额或额度不足：请到 sub2api 后台确认余额与分组额度后再试。',
    });
  }
  if (status === 403) {
    return info({
      ...base,
      code: MODEL_PERMISSION_PATTERN.test(combined) ? 'model-forbidden' : 'forbidden',
      category: 'permission',
      retryable: false,
      message: '没有使用该模型或接口的权限（403）：请检查 Key 所属分组的模型权限，或更换模型。',
    });
  }
  const modelNotFound =
    (parsed.code ?? '').toLowerCase() === 'model_not_found' ||
    MODEL_NOT_FOUND_PATTERN.test(parsed.message ?? '');
  if (status === 404) {
    if (modelNotFound) {
      return info({
        ...base,
        code: 'model-not-found',
        category: 'config',
        retryable: false,
        message: '服务找不到该模型（404）：请确认模型 ID 拼写，或从模型列表中重新选择。',
      });
    }
    return info({
      ...base,
      code: 'endpoint-not-found',
      category: 'unsupported',
      retryable: false,
      message: '服务不支持该接口（404）：请确认 Base URL 是否正确，或在设置中切换协议。',
    });
  }
  if (status === 405 || status === 501) {
    return info({
      ...base,
      code: 'endpoint-unsupported',
      category: 'unsupported',
      retryable: false,
      message: `服务不支持该接口（${status}）：请在设置中切换协议（Responses / Chat Completions）。`,
    });
  }
  if (status === 408) {
    return info({
      ...base,
      code: 'timeout',
      category: 'timeout',
      retryable: true,
      message: '服务处理超时（408），稍后会自动重试。',
    });
  }
  if (status === 413) {
    return info({
      ...base,
      code: 'payload-too-large',
      category: 'format',
      retryable: false,
      message: '请求内容过大（413），请减少单批字幕数量。',
    });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers, now);
    return info({
      ...base,
      code: 'rate-limited',
      category: 'rate-limit',
      retryable: true,
      retryAfterMs,
      message:
        retryAfterMs !== undefined
          ? `请求过于频繁（429），约 ${Math.ceil(retryAfterMs / 1000)} 秒后再试。`
          : '请求过于频繁（429），已暂停预取并稍后重试。',
    });
  }
  if (status === 400 || status === 422) {
    if (modelNotFound) {
      return info({
        ...base,
        code: 'model-not-found',
        category: 'config',
        retryable: false,
        message: '服务不接受该模型 ID：请确认模型名称，或从模型列表中重新选择。',
      });
    }
    if (rejectsOptionalParameter(parsed)) {
      return info({
        ...base,
        code: 'unsupported-parameter',
        category: 'unsupported',
        retryable: false,
        message:
          '服务不接受本次请求中的可选参数（推理参数或结构化输出）：如设置了推理参数，请改为「不发送」后重试。',
      });
    }
    // 以下都只影响这一批/这一条字幕，不代表整个服务不可用。
    const text = [parsed.code, parsed.type, parsed.message].filter(Boolean).join(' ');
    if (CONTENT_POLICY_PATTERN.test(text)) {
      return info({
        ...base,
        code: 'content-rejected',
        category: 'format',
        retryable: false,
        message: '服务的内容审核拒绝了这段字幕，已跳过；其余字幕会继续翻译。',
      });
    }
    if (CONTEXT_LENGTH_PATTERN.test(text)) {
      return info({
        ...base,
        code: 'context-too-long',
        category: 'format',
        retryable: false,
        message: '这批字幕超出模型的上下文长度，将改为逐条翻译。',
      });
    }
    return info({
      ...base,
      code: 'bad-request',
      category: 'format',
      retryable: false,
      message: `服务拒绝了这次翻译请求（${status}），其余字幕会继续翻译；持续出现请检查模型与协议设置。`,
    });
  }
  if (status >= 500) {
    const retryAfterMs = parseRetryAfter(headers, now);
    return info({
      ...base,
      code: 'server-error',
      category: 'server',
      retryable: true,
      retryAfterMs,
      message: `服务暂时异常（${status}），稍后会自动重试；持续失败请检查 sub2api 上游状态。`,
    });
  }
  return info({
    ...base,
    code: `http-${status}`,
    category: 'unsupported',
    retryable: false,
    message: `服务返回了无法处理的状态（${status}）。`,
  });
}

export function networkError(error?: unknown): AppError {
  const cause =
    error instanceof Error
      ? error.cause instanceof Error
        ? error.cause.message
        : error.message
      : '';
  const redirect = /redirect/i.test(cause);
  return new AppError(
    redirect
      ? {
          code: 'redirect-blocked',
          category: 'network',
          retryable: false,
          message:
            '服务返回了重定向，为避免把 API Key 发往其他地址已停止请求；请把 Base URL 改为最终的 API 地址。',
        }
      : {
          code: 'network-error',
          category: 'network',
          retryable: true,
          message: '无法连接到服务：请检查网络、Base URL 与证书，并确认已授予该地址的访问权限。',
          detail: sanitizeDetail(cause, 120),
        },
    { cause: error },
  );
}

export function timeoutError(timeoutMs: number): AppError {
  return new AppError({
    code: 'timeout',
    category: 'timeout',
    retryable: true,
    message: `服务在 ${Math.round(timeoutMs / 1000)} 秒内没有完成响应，稍后会自动重试；持续超时可在设置中调大超时时间。`,
  });
}

export function formatError(
  code: string,
  message: string,
  detail?: string,
  retryable = true,
): AppError {
  return new AppError({
    code,
    category: 'format',
    retryable,
    message,
    detail: sanitizeDetail(detail),
  });
}

export function streamInterruptedError(detail?: string): AppError {
  return new AppError({
    code: 'stream-interrupted',
    category: 'network',
    retryable: true,
    message: '流式响应在结束前中断，本次结果已丢弃，稍后会自动重试。',
    detail: sanitizeDetail(detail),
  });
}

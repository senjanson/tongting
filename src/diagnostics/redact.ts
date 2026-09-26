/**
 * 诊断日志脱敏。日志里不能出现 Key、令牌、带授权参数的 URL、字幕原文或音频。
 *
 * 调用方只应传入状态、计数、长度、错误码等；这里再兜底一层：
 * - 敏感字段名（key / token / authorization / cookie / secret / password / signature / pot …）的字符串值替换为 [redacted]；
 * - 字符串里的 URL 只保留 origin + pathname 与参数名，不保留任何参数值；
 * - 形如 sk-xxx 的密钥、Bearer 令牌、40 位以上的连续令牌字符替换为 [redacted]；
 * - 字符串截断，数组、对象与嵌套深度限长。
 */

const SENSITIVE_KEY =
  /(api[-_]?key|apikey|token|secret|passw(or)?d|authorization|cookie|credential|bearer|signature|^sig$|^pot$|^potc$)/i;
const URL_RE = /\bhttps?:\/\/[^\s"'<>`]+/gi;
const KEY_RE = /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{6,}/g;
const BEARER_RE = /\bBearer\s+[^\s,;"']+/gi;
const LONG_TOKEN_RE = /[A-Za-z0-9_\-+/=]{40,}/g;

export const REDACTED = '[redacted]';
const MAX_STRING = 300;
const MAX_ARRAY = 20;
const MAX_KEYS = 30;
const MAX_DEPTH = 4;

/** URL 只保留 origin + pathname 与去重后的参数名。 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const names = [...new Set(u.searchParams.keys())];
    const path = u.pathname === '/' ? '' : u.pathname;
    return `${u.origin}${path}${names.length ? `?{${names.join(',')}}` : ''}`;
  } catch {
    return '[url]';
  }
}

export function redactString(value: string): string {
  const cleaned = value
    .replace(URL_RE, (m) => redactUrl(m))
    .replace(BEARER_RE, `Bearer ${REDACTED}`)
    .replace(KEY_RE, REDACTED)
    .replace(LONG_TOKEN_RE, REDACTED);
  return cleaned.length > MAX_STRING ? `${cleaned.slice(0, MAX_STRING)}…` : cleaned;
}

/** 把任意值变成可安全写入日志的 JSON 值。 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return `[${typeof value}]`;
  }
  if (value instanceof Error) {
    return { name: redactString(value.name), message: redactString(value.message) };
  }
  if (depth >= MAX_DEPTH) return '[…]';
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redact(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY})`);
    return out;
  }
  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_KEYS)) {
    out[k] = SENSITIVE_KEY.test(k) && typeof v === 'string' ? REDACTED : redact(v, depth + 1);
  }
  if (entries.length > MAX_KEYS) out['…'] = `+${entries.length - MAX_KEYS}`;
  return out;
}

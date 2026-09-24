/**
 * sub2api Base URL 规范化（设置页 UI 与 service worker 共用）。
 *
 * 规则：
 * - 统一处理 `https://x.com`、`https://x.com/`、`https://x.com/v1`、`https://x.com/v1/` 以及带子路径的反向代理，
 *   返回不含 `/v1` 与末尾斜杠的根地址（适配器再拼接 `/v1/...`），避免出现 `/v1/v1`。
 * - 误粘贴完整端点（`/v1/responses`、`/v1/chat/completions`、`/v1/models`）时也回退到根地址。
 * - 生产只允许 https；http 仅允许 127.0.0.1（不接受 localhost：它可能解析到 ::1 上的其他进程）。
 * - 主机名必须是单一、具体的主机（DNS 名称、IPv4 或 [IPv6]）；拒绝 `*` 等通配字符，
 *   保证 originPattern 只对应一个 origin，不会因此申请到通配主机权限。
 * - 拒绝带用户名密码、query、fragment 的地址，避免凭证或签名参数混入配置。
 */
import type { AppErrorInfo } from '../../domain/errors';
import { t } from '../../i18n';

export type NormalizeBaseUrlResult =
  | { ok: true; baseUrl: string; origin: string; originPattern: string }
  | { ok: false; error: AppErrorInfo };

const LOOPBACK_HTTP_HOST = '127.0.0.1';

/** URL 解析后（已小写、已转 punycode）的具体主机名：DNS 标签序列、IPv4，或方括号 IPv6。 */
const CONCRETE_HOST =
  /^(?:\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/;

/** 用户误粘贴的完整端点后缀（大小写不敏感）。 */
const ENDPOINT_SUFFIXES = [
  /\/v1\/chat\/completions$/i,
  /\/v1\/responses$/i,
  /\/v1\/models$/i,
  /\/v1$/i,
];

function configError(code: string, message: string): { ok: false; error: AppErrorInfo } {
  return { ok: false, error: { code, category: 'config', retryable: false, message } };
}

export function normalizeBaseUrl(input: string): NormalizeBaseUrlResult {
  const raw = (input ?? '').trim();
  if (!raw) {
    return configError('base-url-empty', t('background.baseUrl.empty'));
  }
  if (raw.length > 500) {
    return configError('base-url-too-long', t('background.baseUrl.tooLong'));
  }
  if (/\s/.test(raw)) {
    return configError('base-url-invalid', t('background.baseUrl.whitespace'));
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return configError('base-url-no-scheme', t('background.baseUrl.noScheme'));
  }
  // 原始输入中的 authority 部分（scheme:// 之后、第一个 / ? # 之前）。
  const rawAuthority = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configError('base-url-invalid', t('background.baseUrl.invalid'));
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return configError('base-url-scheme', t('background.baseUrl.scheme'));
  }
  if (!url.hostname) {
    return configError('base-url-invalid', t('background.baseUrl.noHost'));
  }
  if (url.username || url.password || rawAuthority.includes('@')) {
    return configError('base-url-credentials', t('background.baseUrl.credentials'));
  }
  // URL 解析会丢弃空的 `?` / `#`，因此同时检查原始字符串。
  if (url.search || raw.includes('?')) {
    return configError('base-url-query', t('background.baseUrl.query'));
  }
  if (url.hash || raw.includes('#')) {
    return configError('base-url-fragment', t('background.baseUrl.fragment'));
  }
  if (
    rawAuthority.includes('*') ||
    rawAuthority.includes('%') ||
    !CONCRETE_HOST.test(url.hostname)
  ) {
    return configError('base-url-host-invalid', t('background.baseUrl.hostInvalid'));
  }
  if (url.protocol === 'http:' && url.hostname !== LOOPBACK_HTTP_HOST) {
    return configError('base-url-insecure', t('background.baseUrl.insecure'));
  }

  let path = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '');
  for (const suffix of ENDPOINT_SUFFIXES) {
    if (suffix.test(path)) {
      path = path.replace(suffix, '');
      break;
    }
  }
  path = path.replace(/\/+$/, '');

  const origin = `${url.protocol}//${url.host}`.toLowerCase();
  return {
    ok: true,
    baseUrl: `${origin}${path}`,
    origin,
    originPattern: `${origin}/*`,
  };
}

/** 由根地址拼接 API 端点，例如 `apiEndpoint(root, '/v1/responses')`。 */
export function apiEndpoint(baseUrl: string, path: `/v1/${string}`): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

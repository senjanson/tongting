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
    return configError(
      'base-url-empty',
      '请填写 sub2api 服务地址（Base URL），例如 https://api.example.com。',
    );
  }
  if (raw.length > 500) {
    return configError('base-url-too-long', '服务地址过长，请只填写 API 根地址。');
  }
  if (/\s/.test(raw)) {
    return configError('base-url-invalid', '服务地址中包含空白字符，请检查后重新填写。');
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    return configError(
      'base-url-no-scheme',
      '服务地址需要以 https:// 开头，例如 https://api.example.com。',
    );
  }
  // 原始输入中的 authority 部分（scheme:// 之后、第一个 / ? # 之前）。
  const rawAuthority = raw.slice(raw.indexOf('//') + 2).split(/[/?#]/)[0] ?? '';

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return configError(
      'base-url-invalid',
      '服务地址格式无效，请填写类似 https://api.example.com 的地址。',
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return configError(
      'base-url-scheme',
      '服务地址只支持 https://（本机调试可使用 http://127.0.0.1）。',
    );
  }
  if (!url.hostname) {
    return configError('base-url-invalid', '服务地址缺少主机名，请检查后重新填写。');
  }
  if (url.username || url.password || rawAuthority.includes('@')) {
    return configError(
      'base-url-credentials',
      '服务地址不能包含用户名或密码，API Key 请在「API Key」输入框填写。',
    );
  }
  // URL 解析会丢弃空的 `?` / `#`，因此同时检查原始字符串。
  if (url.search || raw.includes('?')) {
    return configError(
      'base-url-query',
      '服务地址不能包含查询参数（? 之后的内容），请只填写 API 根地址。',
    );
  }
  if (url.hash || raw.includes('#')) {
    return configError('base-url-fragment', '服务地址不能包含 # 片段，请只填写 API 根地址。');
  }
  if (
    rawAuthority.includes('*') ||
    rawAuthority.includes('%') ||
    !CONCRETE_HOST.test(url.hostname)
  ) {
    return configError(
      'base-url-host-invalid',
      '服务地址的主机名无效：请填写具体的域名或 IP，不能包含 * 等通配符或编码字符。',
    );
  }
  if (url.protocol === 'http:' && url.hostname !== LOOPBACK_HTTP_HOST) {
    return configError(
      'base-url-insecure',
      '为保护 API Key，服务地址必须使用 https://；http 仅允许本机调试地址 127.0.0.1。',
    );
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

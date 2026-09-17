/**
 * 服务地址 → 主机权限匹配模式。
 *
 * - sub2api 地址直接复用 worker 使用的 normalizeBaseUrl，保证 UI 申请的权限与 worker 核对的一致。
 * - 本地识别服务只允许 http://127.0.0.1:<端口>：服务只监听 IPv4，localhost 可能解析到 ::1 上的其他进程。
 */
import { normalizeBaseUrl } from '../../providers/text/base-url';

export type OriginCheck =
  { ok: true; origin: string; pattern: string; baseUrl: string } | { ok: false; reason: string };

/** sub2api 服务地址校验（与 worker 规则一致）。 */
export function checkServiceUrl(input: string): OriginCheck {
  const result = normalizeBaseUrl(input);
  if (!result.ok) return { ok: false, reason: result.error.message };
  // 通配主机名会申请过宽的权限，一律拒绝（与 worker 规则保持一致的防御）。
  if (result.origin.includes('*')) return { ok: false, reason: '服务地址的主机名不能包含 *。' };
  return {
    ok: true,
    origin: result.origin,
    pattern: result.originPattern,
    baseUrl: result.baseUrl,
  };
}

/** 本地识别服务地址校验：只允许 http://127.0.0.1:<端口>，不带路径、查询或凭证。 */
export function checkLocalAsrUrl(input: string): OriginCheck {
  const value = input.trim();
  const match = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/?$/.exec(value);
  const port = match ? Number(match[1]) : NaN;
  if (!match || !Number.isInteger(port) || port < 1 || port > 65_535) {
    return {
      ok: false,
      reason: '本地识别服务地址只允许 http://127.0.0.1:<端口>，例如 http://127.0.0.1:8765。',
    };
  }
  const origin = `http://127.0.0.1:${port}`;
  return { ok: true, origin, pattern: `${origin}/*`, baseUrl: origin };
}

/** 比较两个 origin 或匹配模式是否指向同一 origin（协议 + 主机 + 端口）。 */
export function sameOrigin(a: string | undefined, b: string | undefined): boolean {
  const norm = (v: string | undefined) => {
    if (!v) return '';
    const m = /^(https?):\/\/([^/]+)/i.exec(v.trim());
    if (!m) return '';
    const protocol = m[1]!.toLowerCase();
    let host = m[2]!.toLowerCase();
    if (
      (protocol === 'https' && host.endsWith(':443')) ||
      (protocol === 'http' && host.endsWith(':80'))
    ) {
      host = host.replace(/:\d+$/, '');
    }
    return `${protocol}://${host}`;
  };
  const na = norm(a);
  return na !== '' && na === norm(b);
}

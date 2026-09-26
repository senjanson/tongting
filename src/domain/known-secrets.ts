/**
 * 已知凭证（API Key、识别令牌）的内存登记，脱敏时按原文替换。
 *
 * 通用规则认不出任意格式的 Key（例如不带 sk- 前缀的 32 位 Key）；服务在错误正文里回显 Key 时，
 * 只有按原文替换才可靠。只保存在当前上下文（worker 或 offscreen）的内存中，不持久化、不回传。
 * 换 Key 后仍保留旧值，避免旧 Key 的在途请求迟到报错时泄漏。
 */

const MIN_LENGTH = 8;
const MAX_ENTRIES = 8;
const known: string[] = [];

export function rememberSecret(value: string | undefined): void {
  const secret = value?.trim();
  if (!secret || secret.length < MIN_LENGTH || known.includes(secret)) return;
  known.push(secret);
  if (known.length > MAX_ENTRIES) known.shift();
}

export function scrubKnownSecrets(text: string, replacement: string): string {
  let out = text;
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join(replacement);
  }
  return out;
}

/** 仅供测试。 */
export function forgetKnownSecrets(): void {
  known.length = 0;
}

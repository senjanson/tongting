/**
 * 界面文案格式化工具。
 */
import type { CapabilityStatus } from '../domain/capability';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../domain/languages';

const EXTRA_LANGUAGE_LABELS: Record<string, string> = {
  und: '未知语言',
  'zh-Hans': '简体中文',
  'zh-Hant': '繁體中文',
  'zh-HK': '繁體中文（香港）',
  'en-US': '英语（美国）',
  'en-GB': '英语（英国）',
};

/** 语言代码 → 显示名；未知代码原样显示。 */
export function languageLabel(code: string | undefined | null): string {
  if (!code) return '未知';
  const target = TARGET_LANGUAGES.find((l) => l.code === code);
  if (target) return target.label;
  const source = SOURCE_LANGUAGES.find((l) => l.code === code);
  if (source) return source.label;
  if (EXTRA_LANGUAGE_LABELS[code]) return EXTRA_LANGUAGE_LABELS[code];
  const primary = code.split(/[-_]/)[0]?.toLowerCase();
  const byPrimary = SOURCE_LANGUAGES.find((l) => l.code === primary);
  return byPrimary ? `${byPrimary.label}（${code}）` : code;
}

/** 源语言显示名：优先使用中文名称（例如「英语」），目标语言表中的原生名称作为次选。 */
export function sourceLanguageLabel(code: string | undefined | null): string {
  if (!code) return '未知';
  if (code === 'auto') return '自动识别';
  const source = SOURCE_LANGUAGES.find((l) => l.code === code);
  return source ? source.label : languageLabel(code);
}

/** 媒体时间 → `m:ss` 或 `h:mm:ss`。 */
export function formatMediaTime(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '--:--';
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** 本地时间 `YYYY-MM-DD HH:mm`。 */
export function formatDateTime(epochMs: number | undefined): string {
  if (!epochMs || !Number.isFinite(epochMs)) return '未知时间';
  const d = new Date(epochMs);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return '未知';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.round(ms)} 毫秒`;
}

export function capabilityStatusLabel(status: CapabilityStatus | undefined): string {
  switch (status) {
    case 'verified':
      return '已验证';
    case 'failed':
      return '失败';
    case 'unsupported':
      return '不支持';
    default:
      return '未检测';
  }
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

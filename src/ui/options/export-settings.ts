/**
 * 导出非敏感设置：不含 API Key 与配对令牌（它们本就不在 Settings 中），
 * 并去掉地址里可能夹带的用户名、密码、查询参数与片段。
 */
import type { Settings } from '../../domain/settings';
import { translate, type Locale } from '../../i18n';

export function sanitizeUrlForExport(value: string): string {
  if (!value) return value;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, value.endsWith('/') ? '/' : '');
  } catch {
    return '';
  }
}

export interface ExportedSettingsFile {
  app: '译听 Vocasub';
  kind: 'settings';
  exportedAt: string;
  note: string;
  settings: Settings;
}

export function buildSettingsExport(
  settings: Settings,
  now = new Date(),
  locale: Locale = 'zh-CN',
): ExportedSettingsFile {
  const copy: Settings = JSON.parse(JSON.stringify(settings)) as Settings;
  copy.provider.baseUrl = sanitizeUrlForExport(copy.provider.baseUrl);
  copy.asr.localUrl = sanitizeUrlForExport(copy.asr.localUrl);
  return {
    app: '译听 Vocasub',
    kind: 'settings',
    exportedAt: now.toISOString(),
    note: translate(locale, 'options.data.exportNote'),
    settings: copy,
  };
}

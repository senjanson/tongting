/**
 * 外观主题：纸墨（浅）、夜墨（深）、影院（深，字幕优先）、声波（浅，明快）；auto 跟随系统明暗。
 *
 * 主题通过 <html data-tt-theme> 切换 tokens.css 中的变量。快照到达前先用本机上次使用的主题，
 * 避免打开页面时闪一下默认主题；本机记录只是显示便利，真正的设置以快照中的 settings.uiTheme 为准。
 */
import type { UiThemePreference } from '../../domain/settings';
import type { MessageKey } from '../../i18n';

export type { UiThemePreference };
export type UiTheme = Exclude<UiThemePreference, 'auto'>;

export const UI_THEME_PREFERENCES: readonly UiThemePreference[] = [
  'auto',
  'paper',
  'ink',
  'cinema',
  'wave',
];

/** 主题选择器里的色块：底色、强调色、次要文字色（与 tokens.css 保持一致）。 */
export const THEME_SWATCHES: Record<UiTheme, { bg: string; accent: string; fg: string }> = {
  paper: { bg: '#f4f1ea', accent: '#1f6b52', fg: '#5b6058' },
  ink: { bg: '#111412', accent: '#6fc39e', fg: '#98a098' },
  cinema: { bg: '#0f1011', accent: '#f2c14e', fg: '#a0a5ab' },
  wave: { bg: '#eef0f7', accent: '#3140e0', fg: '#50567a' },
};

export const THEME_LABELS: Record<UiThemePreference, { name: MessageKey; mood: MessageKey }> = {
  auto: { name: 'common.theme.auto', mood: 'common.theme.autoMood' },
  paper: { name: 'common.theme.paper', mood: 'common.theme.paperMood' },
  ink: { name: 'common.theme.ink', mood: 'common.theme.inkMood' },
  cinema: { name: 'common.theme.cinema', mood: 'common.theme.cinemaMood' },
  wave: { name: 'common.theme.wave', mood: 'common.theme.waveMood' },
};

const STORAGE_KEY = 'tt-ui-theme';

export function isUiThemePreference(value: unknown): value is UiThemePreference {
  return typeof value === 'string' && (UI_THEME_PREFERENCES as readonly string[]).includes(value);
}

/** 把主题写到 <html data-tt-theme>，并记在本机供下次打开页面时先行使用。 */
export function applyUiTheme(preference: UiThemePreference, doc: Document = document): void {
  if (doc.documentElement.dataset.ttTheme !== preference) {
    doc.documentElement.dataset.ttTheme = preference;
  }
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // 隐私模式或存储被禁用时只影响首帧，忽略。
  }
}

/** 页面启动时（快照到达前）使用本机上次的主题；没有记录时跟随系统。 */
export function applyStoredUiTheme(doc: Document = document): void {
  let stored: unknown;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  doc.documentElement.dataset.ttTheme = isUiThemePreference(stored) ? stored : 'auto';
}

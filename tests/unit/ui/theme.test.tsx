// @vitest-environment happy-dom
/**
 * 外观主题：设置字段、<html data-tt-theme> 的写入、页面启动时使用本机记录、随快照切换。
 */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applySettingsPatch,
  defaultSettings,
  SettingsPatchSchema,
  SettingsSchema,
  translationFingerprint,
} from '@src/domain/settings';
import type { AppSnapshot } from '@src/messaging/ui-protocol';
import { SnapshotI18nProvider } from '@src/ui/shared/LocaleRoot';
import { UiClientProvider } from '@src/ui/state/hooks';
import {
  applyStoredUiTheme,
  applyUiTheme,
  isUiThemePreference,
  THEME_LABELS,
  THEME_SWATCHES,
  UI_THEME_PREFERENCES,
} from '@src/ui/theme/themes';
import { makeSnapshot } from './fixtures';
import { StaticClient } from './static-client';

const root = () => document.documentElement;

beforeEach(() => {
  delete root().dataset.ttTheme;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  delete root().dataset.ttTheme;
  localStorage.clear();
});

describe('uiTheme setting', () => {
  it('defaults to following the system and accepts the four themes', () => {
    expect(defaultSettings().uiTheme).toBe('auto');
    for (const theme of ['paper', 'ink', 'cinema', 'wave'] as const) {
      expect(applySettingsPatch(defaultSettings(), { uiTheme: theme }).uiTheme).toBe(theme);
    }
  });

  it('rejects unknown themes and keeps other settings on a theme-only patch', () => {
    expect(SettingsPatchSchema.safeParse({ uiTheme: 'neon' }).success).toBe(false);
    const base = applySettingsPatch(defaultSettings(), {
      targetLanguage: 'ja',
      captions: { fontSizePx: 30 },
    });
    const next = applySettingsPatch(base, { uiTheme: 'cinema' });
    expect(next.targetLanguage).toBe('ja');
    expect(next.captions.fontSizePx).toBe(30);
  });

  it('old saved settings without the field read as auto', () => {
    const { uiTheme: _omit, ...legacy } = defaultSettings();
    expect(SettingsSchema.parse(legacy).uiTheme).toBe('auto');
  });

  it('does not change the translation fingerprint', () => {
    const base = defaultSettings();
    expect(translationFingerprint(applySettingsPatch(base, { uiTheme: 'wave' }))).toBe(
      translationFingerprint(base),
    );
  });
});

describe('theme helpers', () => {
  it('lists every preference with labels, and a swatch for every concrete theme', () => {
    expect(UI_THEME_PREFERENCES).toEqual(['auto', 'paper', 'ink', 'cinema', 'wave']);
    for (const pref of UI_THEME_PREFERENCES) expect(THEME_LABELS[pref]).toBeTruthy();
    expect(Object.keys(THEME_SWATCHES).sort()).toEqual(['cinema', 'ink', 'paper', 'wave']);
    expect(isUiThemePreference('ink')).toBe(true);
    expect(isUiThemePreference('neon')).toBe(false);
    expect(isUiThemePreference(null)).toBe(false);
  });

  it('applyUiTheme writes the attribute and remembers it for the next page load', () => {
    applyUiTheme('cinema');
    expect(root().dataset.ttTheme).toBe('cinema');
    delete root().dataset.ttTheme;
    applyStoredUiTheme();
    expect(root().dataset.ttTheme).toBe('cinema');
  });

  it('startup without a record, or with a damaged one, follows the system', () => {
    applyStoredUiTheme();
    expect(root().dataset.ttTheme).toBe('auto');
    localStorage.setItem('tt-ui-theme', 'neon');
    applyStoredUiTheme();
    expect(root().dataset.ttTheme).toBe('auto');
  });
});

describe('page root follows the snapshot theme', () => {
  function withTheme(uiTheme: AppSnapshot['settings']['uiTheme']): AppSnapshot {
    const base = makeSnapshot();
    return { ...base, settings: { ...base.settings, uiTheme } };
  }

  it('keeps the startup theme until a snapshot arrives, then switches with it', () => {
    applyUiTheme('wave');
    const client = new StaticClient({
      connection: 'connecting',
      snapshot: null,
      reconnectAttempts: 0,
    });
    render(
      <UiClientProvider client={client}>
        <SnapshotI18nProvider locale="en">
          <span>page</span>
        </SnapshotI18nProvider>
      </UiClientProvider>,
    );
    expect(root().dataset.ttTheme).toBe('wave');

    act(() =>
      client.setState({
        connection: 'connected',
        snapshot: withTheme('ink'),
        reconnectAttempts: 0,
      }),
    );
    expect(root().dataset.ttTheme).toBe('ink');
    expect(localStorage.getItem('tt-ui-theme')).toBe('ink');
  });
});

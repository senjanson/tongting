import { describe, expect, it } from 'vitest';
import { findActiveCue, mergeRanges } from '@src/domain/cue';
import { redactSecrets, redactUrl, toAppErrorInfo } from '@src/domain/errors';
import { isSameLanguage } from '@src/domain/languages';
import { isCurrentIdentity } from '@src/domain/session';
import {
  applySettingsPatch,
  defaultSettings,
  SettingsPatchSchema,
  translationFingerprint,
  type SettingsPatch,
} from '@src/domain/settings';
import { UiCommandSchema } from '@src/messaging/ui-protocol';

describe('cue helpers', () => {
  it('merges overlapping and touching ranges', () => {
    expect(
      mergeRanges(
        [
          { startMs: 5000, endMs: 6000 },
          { startMs: 0, endMs: 1000 },
          { startMs: 900, endMs: 2000 },
          { startMs: 2100, endMs: 3000 },
        ],
        100,
      ),
    ).toEqual([
      { startMs: 0, endMs: 3000 },
      { startMs: 5000, endMs: 6000 },
    ]);
  });

  it('finds the active cue with binary search and returns undefined in gaps', () => {
    const cues = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1000, endMs: 2500 },
      { startMs: 4000, endMs: 5000 },
    ];
    expect(findActiveCue(cues, 1000)).toBe(cues[1]);
    expect(findActiveCue(cues, 3000)).toBeUndefined();
    expect(findActiveCue(cues, 4999)).toBe(cues[2]);
    expect(findActiveCue([], 10)).toBeUndefined();
  });
});

describe('errors', () => {
  it('redacts keys, bearer tokens and signed query params', () => {
    const text =
      'Authorization: Bearer sk-abcdefghijklmnop url=https://x.com/a?key=SECRET123&pot=zzz';
    const out = redactSecrets(text);
    expect(out).not.toContain('sk-abcdefghijklmnop');
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('zzz');
  });

  it('redactUrl keeps only origin', () => {
    expect(redactUrl('https://api.example.com/v1/responses?key=abc')).toBe(
      'https://api.example.com',
    );
    expect(redactUrl('not a url')).toBe('[invalid-url]');
  });

  it('toAppErrorInfo does not leak raw error text with secrets', () => {
    const info = toAppErrorInfo(new Error('failed with sk-1234567890abcdef'));
    expect(info.detail).not.toContain('sk-1234567890abcdef');
    expect(info.category).toBe('internal');
  });
});

describe('settings', () => {
  it('applies nested patches and validates', () => {
    const base = defaultSettings();
    const next = applySettingsPatch(base, { captions: { fontSizePx: 30 }, targetLanguage: 'ja' });
    expect(next.captions.fontSizePx).toBe(30);
    expect(next.captions.bilingual).toBe(base.captions.bilingual);
    expect(next.targetLanguage).toBe('ja');
  });

  it('patch schema does not inject defaults for missing keys (partial update must not reset other settings)', () => {
    expect(SettingsPatchSchema.parse({ targetLanguage: 'ja' })).toEqual({ targetLanguage: 'ja' });
    expect(SettingsPatchSchema.parse({ captions: { fontSizePx: 30 } })).toEqual({
      captions: { fontSizePx: 30 },
    });
    expect(SettingsPatchSchema.safeParse({ captions: { fontSizePx: 500 } }).success).toBe(false);
    expect(SettingsPatchSchema.safeParse({ provider: { protocol: 'soap' } }).success).toBe(false);
    const cmd = UiCommandSchema.parse({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 30 } },
    });
    const base = applySettingsPatch(defaultSettings(), { targetLanguage: 'ko', style: 'concise' });
    const next = applySettingsPatch(base, (cmd as { patch: SettingsPatch }).patch);
    expect(next.targetLanguage).toBe('ko');
    expect(next.style).toBe('concise');
    expect(next.captions.fontSizePx).toBe(30);
  });

  it('rejects invalid values', () => {
    expect(() =>
      applySettingsPatch(defaultSettings(), { captions: { fontSizePx: 500 } }),
    ).toThrow();
  });

  it('clears detected protocol when base URL changes', () => {
    const base = applySettingsPatch(defaultSettings(), {
      provider: { baseUrl: 'https://a.example.com', detectedProtocol: 'responses' },
    });
    expect(base.provider.detectedProtocol).toBe('responses');
    const next = applySettingsPatch(base, { provider: { baseUrl: 'https://b.example.com' } });
    expect(next.provider.detectedProtocol).toBeUndefined();
    // 提交未变化的地址（不带协议字段）不应清除检测结果。
    const same = applySettingsPatch(base, {
      provider: { baseUrl: 'https://a.example.com', model: 'x' },
    });
    expect(same.provider.detectedProtocol).toBe('responses');
  });

  it('translation fingerprint ignores caption appearance but tracks model and language', () => {
    const base = defaultSettings();
    const fp = translationFingerprint(base);
    expect(translationFingerprint(applySettingsPatch(base, { captions: { fontSizePx: 40 } }))).toBe(
      fp,
    );
    expect(translationFingerprint(applySettingsPatch(base, { provider: { model: 'x' } }))).not.toBe(
      fp,
    );
    expect(translationFingerprint(applySettingsPatch(base, { targetLanguage: 'ja' }))).not.toBe(fp);
  });
});

describe('languages & identity', () => {
  it('treats zh variants as different and en-US/en as same', () => {
    expect(isSameLanguage('en-US', 'en')).toBe(true);
    expect(isSameLanguage('zh-Hans', 'zh-TW')).toBe(false);
    expect(isSameLanguage('zh-Hans', 'zh-CN')).toBe(true);
    expect(isSameLanguage('zh-HK', 'zh-Hant')).toBe(true);
    expect(isSameLanguage('zh-Hant-HK', 'zh-TW')).toBe(true);
    expect(isSameLanguage('zh', 'zh-CN')).toBe(false);
    expect(isSameLanguage('zh-TW', 'zh-CN')).toBe(false);
    expect(isSameLanguage('auto', 'zh-CN')).toBe(false);
  });

  it('isCurrentIdentity requires session, epoch and config revision to match', () => {
    const cur = { sessionId: 's1', epoch: 2, configRevision: 3 };
    expect(isCurrentIdentity(cur, { ...cur })).toBe(true);
    expect(isCurrentIdentity(cur, { ...cur, epoch: 1 })).toBe(false);
    expect(isCurrentIdentity(cur, { ...cur, sessionId: 's0' })).toBe(false);
    expect(isCurrentIdentity(undefined, cur)).toBe(false);
  });
});

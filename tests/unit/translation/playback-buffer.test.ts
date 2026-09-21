import { describe, expect, it } from 'vitest';
import { translatedUntil } from '@src/translation/playback-buffer';
import { makeCue } from './fakes';

describe('contiguous translated playback range', () => {
  it('never treats unknown future audio as silence', () => {
    expect(translatedUntil(0, [], [])).toBe(0);
    expect(translatedUntil(1000, [{ startMs: 2000, endMs: 20000 }], [])).toBe(1000);
  });
  it('counts known silence but stops at the first missing translation', () => {
    const pending = { ...makeCue('a', 3000, 5000, 'Hello'), translationState: 'pending' as const };
    expect(translatedUntil(0, [{ startMs: 0, endMs: 20000 }], [pending])).toBe(3000);
    expect(translatedUntil(4000, [{ startMs: 0, endMs: 20000 }], [pending])).toBe(4000);
    expect(translatedUntil(6000, [{ startMs: 0, endMs: 20000 }], [pending])).toBe(20000);
  });
  it('requires final nonempty translations; same-language skipped cues are ready', () => {
    const cue = {
      ...makeCue('a', 0, 5000, 'Hello'),
      translationState: 'done' as const,
      translatedText: '你好',
    };
    const ranges = [{ startMs: 0, endMs: 20000 }];
    expect(translatedUntil(0, ranges, [cue])).toBe(20000);
    expect(translatedUntil(0, ranges, [{ ...cue, translatedText: '' }])).toBe(0);
    expect(translatedUntil(0, ranges, [{ ...cue, stability: 'interim' }])).toBe(0);
    expect(
      translatedUntil(0, ranges, [
        { ...cue, translationState: 'skipped', translatedText: undefined },
      ]),
    ).toBe(20000);
  });
});

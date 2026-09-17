import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_CUE_TEXT_LENGTH,
  MAX_MEDIA_TIME_MS,
  RawCaptionCueSchema,
  type RawCaptionCue,
} from '@src/domain/cue';
import { MAX_TRACK_CUES } from '@src/messaging/content-protocol';
import {
  CaptionParseError,
  MAX_PARSED_CUES,
  detectCaptionFormat,
  parseCaptionBody,
  parseJson3,
  parseSrv3,
  parseVtt,
} from '@src/captions/parse';
import { decodeEntities, joinCaptionText, normalizeCaptionText } from '@src/captions/text';
import { finalizeCandidates } from '@src/captions/normalize';

const fixture = (name: string) =>
  readFileSync(resolve(import.meta.dirname, '../../fixtures/youtube', name), 'utf8');

function expectWellFormed(cues: RawCaptionCue[]) {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!;
    expect(RawCaptionCueSchema.safeParse(c).success).toBe(true);
    expect(c.endMs).toBeGreaterThan(c.startMs);
    expect(c.text.trim()).toBe(c.text);
    expect(c.text.length).toBeGreaterThan(0);
    const next = cues[i + 1];
    if (next) {
      expect(next.startMs).toBeGreaterThan(c.startMs);
      expect(c.endMs).toBeLessThanOrEqual(next.startMs);
    }
  }
}

describe('text helpers', () => {
  it('decodes entities exactly once and keeps markup as literal text', () => {
    expect(decodeEntities('&lt;b&gt;x&lt;/b&gt; &amp;lt; &#39;q&#x27; &nbsp;|&bogus;')).toBe(
      "<b>x</b> &lt; 'q' \u00a0|&bogus;",
    );
    expect(decodeEntities('&#0; &#x110000; &#xD800;')).toBe('\ufffd \ufffd \ufffd');
  });

  it('normalizes whitespace, control and zero-width characters, joining CJK lines without spaces', () => {
    expect(normalizeCaptionText('  hello\u0000\u200b \t world \r\n second\u00a0line ')).toBe(
      'hello world second line',
    );
    expect(normalizeCaptionText('日本語の\n字幕です')).toBe('日本語の字幕です');
    expect(joinCaptionText('abc', 'def')).toBe('abc def');
    expect(joinCaptionText('你好', 'world')).toBe('你好world');
  });

  it('keeps parser cue cap in sync with the content protocol', () => {
    expect(MAX_PARSED_CUES).toBe(MAX_TRACK_CUES);
  });
});

describe('format detection', () => {
  it('detects json3, srv3 and vtt and rejects unknown bodies', () => {
    expect(detectCaptionFormat(fixture('manual.json3'))).toBe('json3');
    expect(detectCaptionFormat(fixture('manual.srv3.xml'))).toBe('srv3');
    expect(detectCaptionFormat('\ufeffWEBVTT\n\n')).toBe('vtt');
    expect(() => parseCaptionBody('<html><body>nope</body></html>')).toThrow(CaptionParseError);
    try {
      parseCaptionBody('garbage');
    } catch (e) {
      expect((e as CaptionParseError).code).toBe('unknown-format');
      expect((e as Error).message).not.toContain('garbage');
    }
  });
});

describe('json3', () => {
  it('parses manual captions: entities stay literal, duplicates merge, invalid times rejected, overlaps clipped', () => {
    const r = parseJson3(fixture('manual.json3'));
    expect(r.format).toBe('json3');
    expectWellFormed(r.cues);
    const texts = r.cues.map((c) => c.text);
    expect(texts).toContain('Today we test <b>tags</b> & <img src=x onerror=alert(1)>');
    expect(texts).toContain("It costs $5.99. That's not cheap.");
    expect(texts.filter((t) => t === "Mr. Smith didn't agree.")).toHaveLength(1);
    expect(texts).not.toContain('negative start');
    expect(texts).not.toContain('far future');
    expect(r.stats.rejected).toBe(2);
    expect(r.stats.duplicates).toBeGreaterThanOrEqual(1);
    expect(r.rejectedCount).toBe(r.stats.rejected + r.stats.truncated + r.stats.overflow);
    const overlap = r.cues.find((c) => c.text === 'Overlapping line one')!;
    expect(overlap.endMs).toBe(18_000);
    const noDuration = r.cues.find((c) => c.text === 'No duration given.')!;
    expect(noDuration.endMs).toBe(25_000);
    expect(texts).toContain('日本語の字幕です。');
  });

  it('parses auto captions with word segments and newline append events', () => {
    const r = parseJson3(fixture('auto.json3'));
    expectWellFormed(r.cues);
    expect(r.cues).toEqual([
      { startMs: 400, endMs: 2450, text: 'so today we are going' },
      { startMs: 2450, endMs: 5200, text: 'to talk about captions' },
      { startMs: 5200, endMs: 8200, text: 'and how they work' },
      { startMs: 10200, endMs: 13400, text: "first let's look at the player" },
    ]);
    expect(r.rejectedCount).toBe(0);
  });

  it('appends non-empty aAppend text to the previous cue of the same window', () => {
    const r = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1000, wWinId: 1, segs: [{ utf8: 'hello' }] },
        { tStartMs: 500, dDurationMs: 1500, wWinId: 1, aAppend: 1, segs: [{ utf8: ' world' }] },
      ],
    });
    expect(r.cues).toEqual([{ startMs: 0, endMs: 2000, text: 'hello world' }]);
  });

  it('rejects malformed json and structures, and handles empty tracks', () => {
    expect(() => parseJson3('{not json')).toThrow(CaptionParseError);
    expect(() => parseJson3('[1,2]')).toThrow(CaptionParseError);
    expect(() => parseJson3('{"events": 5}')).toThrow(CaptionParseError);
    expect(parseJson3('{"wireMagic":"pb3"}').cues).toEqual([]);
    const r = parseJson3({
      events: [null, 5, { tStartMs: 'x', segs: [] }, { tStartMs: 1, segs: 'bad' }],
    });
    expect(r.cues).toEqual([]);
    expect(r.stats.rejected).toBe(4);
  });

  it('truncates oversize text, clamps abnormal durations and counts them without keeping text in errors', () => {
    const long = 'a'.repeat(MAX_CUE_TEXT_LENGTH + 50);
    const r = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: long }] },
        { tStartMs: 5000, dDurationMs: 10 * 3600 * 1000, segs: [{ utf8: 'very long display' }] },
        { tStartMs: MAX_MEDIA_TIME_MS - 10, dDurationMs: 1000, segs: [{ utf8: 'edge' }] },
      ],
    });
    expect(r.cues[0]!.text).toHaveLength(MAX_CUE_TEXT_LENGTH);
    expect(r.cues[1]!.endMs).toBe(65_000);
    expect(r.cues[2]!.endMs).toBe(MAX_MEDIA_TIME_MS);
    expect(r.stats.truncated).toBe(3);
    expectWellFormed(r.cues);
  });

  it('caps the number of cues and reports overflow', () => {
    const events = Array.from({ length: MAX_PARSED_CUES + 5 }, (_, i) => ({
      tStartMs: i * 10,
      dDurationMs: 10,
      segs: [{ utf8: `c${i}` }],
    }));
    const r = parseJson3({ events });
    expect(r.cues).toHaveLength(MAX_PARSED_CUES);
    expect(r.overflowed).toBe(true);
    expect(r.stats.overflow).toBe(5);
  });

  it('rejects oversize bodies before parsing', () => {
    expect(() => parseCaptionBody(`{"events":[]}${' '.repeat(8 * 1024 * 1024)}`)).toThrow(
      /too-large/,
    );
  });
});

describe('srv3', () => {
  it('parses manual srv3 with <br>, <s> and entities decoded once as plain text', () => {
    const r = parseSrv3(fixture('manual.srv3.xml'));
    expect(r.format).toBe('srv3');
    expectWellFormed(r.cues);
    const texts = r.cues.map((c) => c.text);
    expect(texts).toEqual([
      'Welcome to the',
      'channel, everyone.',
      'Today we test <img src=x onerror=alert(1)> &amp; &lt;b&gt;',
      "It costs $5.99. That's not cheap.",
      "Mr. Smith didn't agree.",
      '日本語の字幕です。',
    ]);
    expect(r.stats.rejected).toBe(2);
  });

  it('parses auto srv3 identically to the equivalent json3', () => {
    expect(parseSrv3(fixture('auto.srv3.xml')).cues).toEqual(
      parseJson3(fixture('auto.json3')).cues,
    );
  });

  it('rejects non-srv3 xml', () => {
    expect(() => parseSrv3('<timedtext format="1"><text start="0">x</text></timedtext>')).toThrow(
      CaptionParseError,
    );
    expect(() => parseSrv3('<xml/>')).toThrow(CaptionParseError);
  });
});

describe('vtt', () => {
  it('parses manual vtt with identifiers, voice tags, styles, entities and invalid timings', () => {
    const r = parseVtt(fixture('manual.vtt'));
    expect(r.format).toBe('vtt');
    expectWellFormed(r.cues);
    expect(r.cues.map((c) => c.text)).toEqual([
      'Welcome to the',
      'channel, everyone.',
      'Today we test <script>alert(1)</script> & bold',
      "It costs $5.99. That's not cheap.",
      '日本語の字幕です。',
    ]);
    expect(r.cues[0]).toMatchObject({ startMs: 1000, endMs: 3500 });
    expect(r.stats.rejected).toBe(2);
  });

  it('removes rolling duplicate lines and transition cues from YouTube auto vtt', () => {
    const r = parseVtt(fixture('auto.vtt'));
    expectWellFormed(r.cues);
    expect(r.cues).toEqual([
      { startMs: 400, endMs: 2440, text: 'so today we are going' },
      { startMs: 2450, endMs: 5190, text: 'to talk about captions' },
      { startMs: 5200, endMs: 8200, text: 'and how they work' },
      { startMs: 10200, endMs: 13400, text: "first let's look at the player" },
    ]);
  });

  it('requires the WEBVTT header', () => {
    expect(() => parseVtt('00:00.000 --> 00:01.000\nhi')).toThrow(CaptionParseError);
  });
});

describe('review 16a/16f', () => {
  it('rejects a start that rounds onto the 24h boundary instead of emitting startMs === endMs', () => {
    const r = finalizeCandidates('json3', [{ startMs: 86_399_999.6, text: 'edge' }]);
    expect(r.cues).toEqual([]);
    expect(r.stats.rejected).toBe(1);
  });

  it('strips bidi embedding/override/isolate characters', () => {
    const rlo = String.fromCharCode(0x202e);
    const lri = String.fromCharCode(0x2066);
    const pdi = String.fromCharCode(0x2069);
    expect(normalizeCaptionText(`abc${rlo}gpj.exe ${lri}x${pdi}`)).toBe('abcgpj.exe x');
  });
});

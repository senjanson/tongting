import { describe, expect, it } from 'vitest';
import SrtParser from 'srt-parser-2';
import { WebVTTParser } from 'webvtt-parser';
import type { Cue, SubtitleCoverage } from '@src/domain/cue';
import {
  buildExportFilename,
  describeCoverage,
  formatExport,
  formatSrt,
  formatSubtitleTimestamp,
  formatTxt,
  formatVtt,
  normalizeCueLines,
  type ExportInput,
} from '@src/export';

function cue(partial: Partial<Cue> & Pick<Cue, 'id' | 'startMs' | 'endMs' | 'sourceText'>): Cue {
  return {
    revision: 0,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track',
    stability: 'final',
    translationState: 'done',
    ...partial,
  };
}

const fullCoverage: SubtitleCoverage = {
  complete: true,
  ranges: [{ startMs: 0, endMs: 600_000 }],
  gaps: [],
  durationMs: 600_000,
};

const partialCoverage: SubtitleCoverage = {
  complete: false,
  ranges: [
    { startMs: 60_000, endMs: 120_000 },
    { startMs: 300_000, endMs: 330_000 },
  ],
  gaps: [{ startMs: 120_000, endMs: 300_000, reason: 'not-played' }],
  durationMs: 600_000,
};

/** 故意乱序、含特殊字符、未翻译、临时、无效结束时间的样本。 */
function sampleCues(): Cue[] {
  return [
    cue({
      id: 'c3',
      startMs: 7_000,
      endMs: 9_500,
      sourceText: 'Third line',
      translatedText: '第三句',
    }),
    cue({
      id: 'c1',
      startMs: 1_000,
      endMs: 3_000,
      sourceText: 'Hello --> world',
      translatedText: '你好 --> 世界',
    }),
    cue({
      id: 'c2',
      startMs: 3_500,
      endMs: 3_500, // 结束时间等于开始时间，必须修正
      sourceText: 'Line A\r\n\r\nLine B',
      translatedText: 'A 行\n\n\nB 行 <b>&</b>',
    }),
    cue({
      id: 'c4',
      startMs: 10_000,
      endMs: 12_000,
      sourceText: 'Not yet',
      translationState: 'pending',
    }),
    cue({
      id: 'c5',
      startMs: 12_500,
      endMs: 14_000,
      sourceText: 'Streaming partial',
      translatedText: '流式部分结果',
      translationState: 'running',
    }),
    cue({
      id: 'c6',
      startMs: 15_000,
      endMs: 16_000,
      sourceText: 'interim words',
      translatedText: '临时词',
      stability: 'interim',
      source: 'asr',
    }),
    cue({ id: 'c7', startMs: 17_000, endMs: 18_000, sourceText: '   ', translatedText: '   ' }),
  ];
}

function baseInput(overrides: Partial<ExportInput> = {}): ExportInput {
  return {
    cues: sampleCues(),
    content: 'translation',
    scope: 'all',
    coverage: fullCoverage,
    sourceMode: 'full-track',
    title: 'My: "Video" / Test?',
    videoId: 'abcdefghijk',
    targetLanguage: 'zh-CN',
    sourceLanguage: 'en',
    ...overrides,
  };
}

describe('formatSubtitleTimestamp', () => {
  it('formats hours, minutes, seconds and milliseconds with the right separator', () => {
    expect(formatSubtitleTimestamp(0, ',')).toBe('00:00:00,000');
    expect(formatSubtitleTimestamp(3_723_004, ',')).toBe('01:02:03,004');
    expect(formatSubtitleTimestamp(59_999.6, '.')).toBe('00:01:00.000');
  });
});

describe('normalizeCueLines', () => {
  it('unifies line endings, removes blank lines, control characters and arrow separators', () => {
    expect(normalizeCueLines('a\r\n\r\n b \u0007\rc --> d ---> e')).toEqual([
      'a',
      'b',
      'c → d → e',
    ]);
    expect(normalizeCueLines(undefined)).toEqual([]);
  });
});

describe('formatSrt', () => {
  it('produces contiguous numbering, valid timings and translation-only text parseable by srt-parser-2', () => {
    const result = formatSrt(baseInput());
    const parsed = new SrtParser().fromSrt(result.text);

    // c1、c2、c3 已翻译；c4 pending、c5 running（流式部分）未完成；c6 临时；c7 空白。
    expect(result.includedCount).toBe(3);
    expect(result.skippedUntranslated).toBe(2);
    expect(result.skippedInterim).toBe(1);
    expect(result.skippedInvalid).toBe(1);
    expect(result.fixedTimings).toBe(1);
    expect(parsed).toHaveLength(3);
    expect(parsed.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(parsed.map((p) => p.startSeconds)).toEqual([1, 3.5, 7]);
    for (const p of parsed) expect(p.endSeconds).toBeGreaterThan(p.startSeconds);
    expect(parsed[0]!.text).toBe('你好 → 世界');
    expect(parsed[1]!.text).toBe('A 行\nB 行 <b>&</b>');
    expect(result.text).not.toContain('流式部分结果');
    expect(result.text).not.toContain('\r');
    expect(result.text.match(/-->/g)).toHaveLength(3);
    expect(result.filename).toBe('My Video Test.zh-CN.srt');
  });

  it('marks untranslated cues when requested and counts them', () => {
    const result = formatSrt(baseInput({ untranslated: 'mark' }));
    const parsed = new SrtParser().fromSrt(result.text);
    expect(result.markedUntranslated).toBe(2);
    expect(result.skippedUntranslated).toBe(0);
    expect(parsed).toHaveLength(5);
    expect(parsed[3]!.text).toBe('[未翻译] Not yet');
    expect(parsed[4]!.text).toBe('[未翻译] Streaming partial');
    expect(result.coverageSummary).toContain('未完成翻译 2 条以原文输出并标记');
  });

  it('exports bilingual favorites only, in time order', () => {
    const result = formatSrt(
      baseInput({ content: 'bilingual', scope: 'favorites', favoriteCueIds: ['c3', 'c1', 'c4'] }),
    );
    const parsed = new SrtParser().fromSrt(result.text);
    expect(parsed.map((p) => p.text)).toEqual([
      '你好 → 世界\nHello → world',
      '第三句\nThird line',
      '[未翻译] Not yet',
    ]);
    expect(parsed.map((p) => p.id)).toEqual(['1', '2', '3']);
    expect(result.markedUntranslated).toBe(1);
    expect(result.filename).toBe('My Video Test.收藏.双语.zh-CN.srt');
    expect(result.coverageSummary).toContain('仅收藏');
  });

  it('includes interim results only when asked and marks them', () => {
    const result = formatSrt(baseInput({ content: 'original', includeInterim: true }));
    const parsed = new SrtParser().fromSrt(result.text);
    expect(result.skippedInterim).toBe(0);
    expect(result.markedInterim).toBe(1);
    expect(parsed.find((p) => p.text.includes('interim words'))?.text).toBe('[临时] interim words');
    // 原文模式不受翻译状态影响
    expect(result.skippedUntranslated).toBe(0);
    expect(result.filename).toBe('My Video Test.en.srt');
  });

  it('returns empty text with zero included cues', () => {
    const result = formatSrt(baseInput({ scope: 'favorites', favoriteCueIds: [] }));
    expect(result.text).toBe('');
    expect(result.includedCount).toBe(0);
  });

  it('treats same-language skipped cues as translated without duplicating lines', () => {
    const result = formatSrt(
      baseInput({
        content: 'bilingual',
        cues: [
          cue({
            id: 's',
            startMs: 0,
            endMs: 1000,
            sourceText: '中文原文',
            translationState: 'skipped',
          }),
        ],
      }),
    );
    expect(new SrtParser().fromSrt(result.text)[0]!.text).toBe('中文原文');
    expect(result.markedUntranslated).toBe(0);
  });
});

describe('formatVtt', () => {
  it('produces a WEBVTT file with a coverage NOTE that webvtt-parser accepts without errors', () => {
    const result = formatVtt(
      baseInput({ content: 'bilingual', coverage: partialCoverage, sourceMode: 'asr' }),
    );
    expect(result.text.startsWith('WEBVTT\n\nNOTE 同听 Tongting 导出\n')).toBe(true);
    const tree = new WebVTTParser().parse(result.text, 'metadata');
    expect(tree.errors).toEqual([]);
    // c1,c2,c3 双语 + c4/c5 未翻译标记；c6 临时排除；c7 空白跳过
    expect(tree.cues).toHaveLength(5);
    expect(tree.cues.map((c) => c.startTime)).toEqual([1, 3.5, 7, 10, 12.5]);
    for (const c of tree.cues) expect(c.endTime).toBeGreaterThan(c.startTime);
    expect(tree.cues[1]!.text).toBe('A 行\nB 行 &lt;b&gt;&amp;&lt;/b&gt;\nLine A\nLine B');
    expect(result.text).toMatch(/00:00:01\.000 --> 00:00:03\.000/);
    // 部分字幕必须说明非全视频
    expect(result.coverageSummary).toContain('部分字幕（非全视频');
    expect(result.coverageSummary).not.toContain('完整字幕轨道');
    const note = result.text.split('\n\n')[1]!;
    expect(note).toContain('部分字幕');
    expect(note).not.toContain('-->');
    expect(result.filename).toBe('My Video Test.双语.zh-CN.vtt');
  });

  it('keeps an empty but valid file when nothing is exported', () => {
    const result = formatVtt(baseInput({ scope: 'favorites', favoriteCueIds: [] }));
    const tree = new WebVTTParser().parse(result.text, 'metadata');
    expect(tree.errors).toEqual([]);
    expect(tree.cues).toHaveLength(0);
  });
});

describe('formatTxt', () => {
  it('writes timestamps, header and coverage', () => {
    const result = formatTxt(baseInput({ content: 'bilingual' }));
    expect(result.text).toContain('标题：My: "Video" / Test?');
    expect(result.text).toContain('覆盖：完整字幕轨道');
    expect(result.text).toContain('[00:00:01] 你好 → 世界\nHello → world');
    expect(result.text).toContain('[00:00:07] 第三句\nThird line');
    expect(result.filename.endsWith('.txt')).toBe(true);
  });

  it('dispatches by format', () => {
    expect(formatExport('txt', baseInput()).filename).toMatch(/\.txt$/);
    expect(formatExport('vtt', baseInput()).text.startsWith('WEBVTT')).toBe(true);
  });
});

describe('describeCoverage', () => {
  it('never calls ASR or incremental captions a full-video track', () => {
    expect(describeCoverage(fullCoverage, 'full-track')).toBe('完整字幕轨道（视频时长 10 分）');
    expect(describeCoverage(fullCoverage, 'asr')).toContain('部分字幕（非全视频，语音识别）');
    expect(describeCoverage(partialCoverage, 'incremental-captions')).toContain(
      '已覆盖 2 段，共 1 分 30 秒 / 视频 10 分',
    );
    expect(describeCoverage(partialCoverage)).toContain('缺口 1 段（尚未播放到）');
    expect(describeCoverage(undefined)).toBe('覆盖范围未知');
    expect(describeCoverage(undefined, 'asr')).toContain('非全视频');
  });
});

describe('buildExportFilename', () => {
  it('removes illegal characters and falls back to the video id', () => {
    expect(
      buildExportFilename({
        title: '  ..<>:"/\\|?*  ',
        videoId: 'abc_DEF-123',
        format: 'vtt',
        language: 'zh-CN',
      }),
    ).toBe('tongting-abc_DEF-123.zh-CN.vtt');
    expect(buildExportFilename({ title: 'CON', format: 'srt', language: 'en' })).toBe(
      '_CON.en.srt',
    );
    expect(buildExportFilename({ format: 'txt' })).toBe('tongting-subtitles.und.txt');
    const long = buildExportFilename({ title: '长'.repeat(200), format: 'srt', language: 'zh-CN' });
    expect(Array.from(long.split('.')[0]!)).toHaveLength(80);
  });
});

describe('favorites missing from the record', () => {
  it('counts favorites that are not in the current cues', () => {
    const result = formatSrt(
      baseInput({
        content: 'bilingual',
        scope: 'favorites',
        favoriteCueIds: ['c1', 'old-session-cue'],
      }),
    );
    expect(result.includedCount).toBe(1);
    expect(result.missingFavorites).toBe(1);
    expect(result.coverageSummary).toContain('收藏中 1 条已不在当前记录');
  });
});

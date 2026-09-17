import { describe, expect, it } from 'vitest';
import { CueSchema, type Cue } from '@src/domain/cue';
import { createIncrementalCaptionAssembler } from '@src/captions/incremental';
import type { IncrementalCaptionAssembler } from '@src/captions/types';

/** 模拟 worker 侧按 id 维护的字幕表。 */
function createStore() {
  const cues = new Map<string, Cue>();
  return {
    cues,
    apply(r: { upserts: Cue[]; removedIds: string[] }) {
      for (const c of r.upserts) {
        expect(CueSchema.safeParse(c).success).toBe(true);
        const prev = cues.get(c.id);
        // revision 只随文本变化递增。
        if (prev && prev.sourceText !== c.sourceText)
          expect(c.revision).toBeGreaterThan(prev.revision);
        if (prev && prev.sourceText === c.sourceText) expect(c.revision).toBe(prev.revision);
        cues.set(c.id, c);
      }
      for (const id of r.removedIds) cues.delete(id);
      return r;
    },
    finals() {
      return [...cues.values()]
        .filter((c) => c.stability === 'final')
        .sort((a, b) => a.startMs - b.startMs);
    },
    interims() {
      return [...cues.values()].filter((c) => c.stability === 'interim');
    },
  };
}

function make(): IncrementalCaptionAssembler {
  return createIncrementalCaptionAssembler({
    idPrefix: 'vid:visible',
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
  });
}

describe('incremental caption assembler', () => {
  it('assembles rolling auto captions word by word without duplicates', () => {
    const a = make();
    const store = createStore();
    const samples: Array<[string, number]> = [
      ['so', 400],
      ['so today', 700],
      ['so today we are', 1300],
      ['so today we are going', 1500],
      ['so today we are going\nto', 2450],
      ['so today we are going\nto talk about', 3050],
      ['so today we are going\nto talk about captions', 3450],
      ['to talk about captions\nand', 5200],
      ['to talk about captions\nand how they work', 5800],
      ['to talk about captions\nand how they work', 6000],
      ['', 8200],
    ];
    for (const [text, t] of samples) store.apply(a.push({ text, mediaTimeMs: t }));
    const finals = store.finals();
    const all = finals.map((c) => c.sourceText).join(' ');
    expect(all).toBe('so today we are going to talk about captions and how they work');
    expect(store.interims()).toHaveLength(0);
    for (const c of finals) expect(c.source).toBe('visible-caption');
  });

  it('emits interim first, then final with the same id and a higher revision', () => {
    const a = make();
    const first = a.push({ text: 'hello', mediaTimeMs: 1000 });
    expect(first.upserts).toHaveLength(1);
    expect(first.upserts[0]).toMatchObject({
      stability: 'interim',
      revision: 0,
      endEstimated: true,
      sourceText: 'hello',
    });
    const second = a.push({ text: 'hello world', mediaTimeMs: 1400 });
    expect(second.upserts[0]).toMatchObject({
      id: first.upserts[0]!.id,
      stability: 'interim',
      revision: 1,
      sourceText: 'hello world',
    });
    const done = a.push({ text: '', mediaTimeMs: 3000 });
    expect(done.upserts[0]).toMatchObject({
      id: first.upserts[0]!.id,
      stability: 'final',
      revision: 1, // 文本未变：只确定结束时间，revision 不变
      startMs: 1000,
      endMs: 3000,
      endEstimated: false,
    });
  });

  it('handles last-word revisions and punctuation added later', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'we can wor', mediaTimeMs: 0 }));
    store.apply(a.push({ text: 'we can work', mediaTimeMs: 300 }));
    store.apply(a.push({ text: 'we can work together', mediaTimeMs: 600 }));
    store.apply(a.push({ text: 'we can work together.', mediaTimeMs: 900 }));
    store.apply(a.push({ text: 'we can work together. Next one', mediaTimeMs: 1500 }));
    const finals = store.finals();
    expect(finals.map((c) => c.sourceText)).toEqual(['we can work together.']);
    expect(finals[0]!.endMs).toBe(1500);
    expect(store.interims().map((c) => c.sourceText)).toEqual(['Next one']);
    expect(store.interims()[0]!.startMs).toBe(1500);
  });

  it('treats unrelated manual captions as replacements and does not drop repeated words', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'I said no.', mediaTimeMs: 0 }));
    store.apply(a.push({ text: 'No. Absolutely not.', mediaTimeMs: 2000 }));
    store.apply(a.push({ text: '', mediaTimeMs: 4000 }));
    expect(store.finals().map((c) => [c.sourceText, c.startMs, c.endMs])).toEqual([
      ['I said no.', 0, 2000],
      ['No. Absolutely not.', 2000, 4000],
    ]);
  });

  it('ignores re-renders of already seen text and repeated identical samples', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'one two three four', mediaTimeMs: 0 }));
    store.apply(a.push({ text: 'one two three four five six', mediaTimeMs: 500 }));
    expect(a.push({ text: 'one two three four five six', mediaTimeMs: 600 }).upserts).toHaveLength(
      0,
    );
    expect(a.push({ text: 'two three four', mediaTimeMs: 700 }).upserts).toHaveLength(0);
    store.apply(a.push({ text: '', mediaTimeMs: 1000 }));
    expect(store.finals().map((c) => c.sourceText)).toEqual(['one two three four five six']);
  });

  it('finalizes on seek discontinuity and on flush, restarting fresh afterwards', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'before seeking', mediaTimeMs: 60_000 }));
    // 回退到 10s：上一句在最后观察时间结束。
    store.apply(a.push({ text: 'before seeking', mediaTimeMs: 10_000 }));
    const finals = store.finals();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ sourceText: 'before seeking', startMs: 60_000 });
    // 同样的文本在新位置重新出现，是一个新的临时句（时间不同）。
    expect(store.interims().map((c) => c.startMs)).toEqual([10_000]);
    const flushed = store.apply(a.flush(10_500));
    expect(flushed.upserts[0]).toMatchObject({
      stability: 'final',
      startMs: 10_000,
      endMs: 10_500,
    });
    expect(store.interims()).toHaveLength(0);
  });

  it('splits long unpunctuated rolling text by length at arrival boundaries', () => {
    const a = createIncrementalCaptionAssembler({
      idPrefix: 'v',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      maxChars: 30,
    });
    const store = createStore();
    const words = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu'.split(' ');
    let text = '';
    words.forEach((w, i) => {
      text = text ? `${text} ${w}` : w;
      store.apply(a.push({ text, mediaTimeMs: i * 300 }));
    });
    store.apply(a.flush(words.length * 300));
    const finals = store.finals();
    expect(finals.length).toBeGreaterThan(1);
    expect(finals.map((c) => c.sourceText).join(' ')).toBe(words.join(' '));
    for (let i = 1; i < finals.length; i++)
      expect(finals[i]!.startMs).toBeGreaterThanOrEqual(finals[i - 1]!.endMs);
  });

  it('handles CJK rolling captions', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: '今日は', mediaTimeMs: 0 }));
    store.apply(a.push({ text: '今日は字幕の', mediaTimeMs: 400 }));
    store.apply(a.push({ text: '今日は字幕の話です。次', mediaTimeMs: 800 }));
    store.apply(a.flush(1500));
    expect(store.finals().map((c) => c.sourceText)).toEqual(['今日は字幕の話です。', '次']);
  });

  it('rejects invalid times and text safely; keeps HTML-like text literal', () => {
    const a = make();
    expect(a.push({ text: 'x', mediaTimeMs: -1 }).upserts).toHaveLength(0);
    expect(a.push({ text: 'x', mediaTimeMs: Number.NaN }).upserts).toHaveLength(0);
    const r = a.push({ text: '<img src=x onerror=alert(1)>', mediaTimeMs: 5 });
    expect(r.upserts[0]!.sourceText).toBe('<img src=x onerror=alert(1)>');
    a.reset();
    expect(a.flush(10).upserts).toHaveLength(0);
  });

  it('does not duplicate a final sentence when the same caption is re-rendered after clearing', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'Same line here.', mediaTimeMs: 1000 }));
    store.apply(a.push({ text: '', mediaTimeMs: 1500 }));
    const r = store.apply(a.push({ text: 'Same line here.', mediaTimeMs: 1600 }));
    store.apply(a.push({ text: '', mediaTimeMs: 2500 }));
    expect(r.upserts[0]!.stability).toBe('interim');
    expect(store.finals().map((c) => c.sourceText)).toEqual(['Same line here.']);
    expect(store.interims()).toHaveLength(0);
  });
});

describe('incremental early final and heartbeat', () => {
  it('finalizes a stable pop-on line early (endEstimated) and later only updates endMs without a new revision', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'Hello there.', mediaTimeMs: 1000 }));
    store.apply(a.push({ text: 'Hello there.', mediaTimeMs: 1300 }));
    const early = store.apply(a.push({ text: 'Hello there.', mediaTimeMs: 1600 }));
    expect(early.upserts[0]).toMatchObject({ stability: 'final', endEstimated: true, revision: 0 });
    const id = early.upserts[0]!.id;
    for (let t = 1900; t <= 3700; t += 300)
      store.apply(a.push({ text: 'Hello there.', mediaTimeMs: t }));
    expect(store.cues.get(id)!.endMs).toBeGreaterThan(4000); // 心跳延长了估计结束时间
    const done = store.apply(a.push({ text: 'Next line.', mediaTimeMs: 4000 }));
    expect(done.upserts.find((c) => c.id === id)).toMatchObject({
      revision: 0,
      endMs: 4000,
      endEstimated: false,
      stability: 'final',
    });
  });

  it('uses a longer stability window for word-by-word rolling text and starts a new cue after a frozen one', () => {
    const a = make();
    const store = createStore();
    store.apply(a.push({ text: 'so today', mediaTimeMs: 0 }));
    store.apply(a.push({ text: 'so today we', mediaTimeMs: 300 }));
    store.apply(a.push({ text: 'so today we', mediaTimeMs: 1000 }));
    expect(store.finals()).toHaveLength(0);
    store.apply(a.push({ text: 'so today we', mediaTimeMs: 1900 }));
    expect(store.finals().map((c) => c.sourceText)).toEqual(['so today we']);
    store.apply(a.push({ text: 'so today we talk', mediaTimeMs: 2100 }));
    store.apply(a.push({ text: '', mediaTimeMs: 3000 }));
    expect(store.finals().map((c) => [c.sourceText, c.startMs, c.endMs])).toEqual([
      ['so today we', 0, 2100],
      ['talk', 2100, 3000],
    ]);
  });
});

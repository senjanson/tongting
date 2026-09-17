import { describe, expect, it } from 'vitest';
import type { Cue } from '@src/domain/cue';
import { createIncrementalCaptionAssembler } from '@src/captions/incremental';
import { createDisplaySelector } from '@src/youtube/overlay/display-select';

describe('incremental captions: translated text stays visible long enough', () => {
  it('each 3s caption with 1s translation latency shows its translation for at least 1.5s', () => {
    const a = createIncrementalCaptionAssembler({
      idPrefix: 'v',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
    });
    const cues = new Map<string, Cue>();
    const pending: Array<{ id: string; at: number; revision: number }> = [];
    const selector = createDisplaySelector();
    const shownMs = new Map<string, number>();
    const captions = Array.from({ length: 6 }, (_, i) => `Caption number ${i} is shown.`);
    const apply = (r: { upserts: Cue[]; removedIds: string[] }, now: number) => {
      for (const c of r.upserts) {
        const prev = cues.get(c.id);
        // worker 语义：revision 与原文不变时保留译文；首次 final 时发起翻译（延迟 1s）。
        const keep = prev && prev.revision === c.revision && prev.sourceText === c.sourceText;
        cues.set(c.id, keep ? { ...c, translatedText: prev.translatedText } : c);
        if (c.stability === 'final' && !keep && !pending.some((p) => p.id === c.id)) {
          pending.push({ id: c.id, at: now + 1000, revision: c.revision });
        }
        if (
          c.stability === 'final' &&
          keep &&
          !prev.translatedText &&
          !pending.some((p) => p.id === c.id)
        ) {
          pending.push({ id: c.id, at: now + 1000, revision: c.revision });
        }
      }
      for (const id of r.removedIds) cues.delete(id);
    };
    for (let t = 0; t < captions.length * 3000; t += 50) {
      if (t % 300 === 0 || t % 3000 === 0) {
        apply(a.push({ text: captions[Math.floor(t / 3000)]!, mediaTimeMs: t }), t);
      }
      for (const p of pending.filter((x) => x.at <= t)) {
        const c = cues.get(p.id);
        if (c && c.revision === p.revision)
          cues.set(p.id, { ...c, translatedText: `译文 ${c.sourceText}` });
        pending.splice(pending.indexOf(p), 1);
      }
      const sorted = [...cues.values()].sort((x, y) => x.startMs - y.startMs);
      const sel = selector.select(sorted, t, (id) => cues.get(id));
      if (sel?.cue.translatedText) shownMs.set(sel.cue.id, (shownMs.get(sel.cue.id) ?? 0) + 50);
    }
    const finals = [...cues.values()].filter((c) => c.stability === 'final');
    expect(finals.length).toBeGreaterThanOrEqual(captions.length - 1);
    for (const c of finals.slice(0, -1))
      expect(shownMs.get(c.id) ?? 0).toBeGreaterThanOrEqual(1500);
  });

  it('does not hold across a seek backwards or beyond the hold window', () => {
    const s = createDisplaySelector(3000);
    const done = {
      id: 'a',
      revision: 0,
      startMs: 0,
      endMs: 1000,
      sourceText: 'a',
      translatedText: '甲',
      translationState: 'done' as const,
      stability: 'final' as const,
    };
    const next = {
      ...done,
      id: 'b',
      startMs: 1000,
      endMs: 9000,
      sourceText: 'b',
      translatedText: undefined,
      translationState: 'pending' as const,
    };
    const all = [done, next];
    const get = (id: string) => all.find((c) => c.id === id);
    expect(s.select(all, 500, get)).toMatchObject({ cue: { id: 'a' }, held: false });
    expect(s.select(all, 2000, get)).toMatchObject({ cue: { id: 'a' }, held: true });
    expect(s.select(all, 4500, get)).toMatchObject({ cue: { id: 'b' }, held: false });
    expect(s.select(all, 500, get)?.held).toBe(false);
    expect(s.select([next], 1500, (id) => (id === 'b' ? next : undefined))).toMatchObject({
      cue: { id: 'b' },
      held: false,
    });
  });
});

describe('speech-recognition cues arrive after their media time (late mode)', () => {
  // 8 句，每句 3 s，句间静音 1.2 s；译文在句末 + 2.65 s 才到达（E2E 实测 p50）。
  const SENTENCES = 8;
  const SPAN_MS = 3_000;
  const GAP_MS = 1_200;
  const LATENCY_MS = 2_650;
  const sentence = (i: number) => {
    const startMs = i * (SPAN_MS + GAP_MS);
    return {
      id: `asr-${i}`,
      revision: 0,
      startMs,
      endMs: startMs + SPAN_MS,
      sourceText: `Sentence ${i}.`,
      translatedText: `第 ${i} 句。`,
      translationState: 'done' as const,
      stability: 'final' as const,
    };
  };
  const all = Array.from({ length: SENTENCES }, (_, i) => sentence(i));

  function simulate(late: boolean) {
    const selector = createDisplaySelector();
    const shownMs = new Map<string, number>();
    let emptyAfterFirst = 0;
    let samples = 0;
    const endMs = all.at(-1)!.endMs + LATENCY_MS + 2_000;
    for (let t = 0; t <= endMs; t += 250) {
      const arrived = all.filter((c) => c.endMs + LATENCY_MS <= t);
      const get = (id: string) => arrived.find((c) => c.id === id);
      const sel = selector.select(arrived, t, get, { late });
      if (sel?.cue.translatedText) {
        shownMs.set(sel.cue.id, (shownMs.get(sel.cue.id) ?? 0) + 250);
      }
      if (t >= all[0]!.endMs + LATENCY_MS && t <= all.at(-1)!.endMs + LATENCY_MS) {
        samples += 1;
        if (!sel) emptyAfterFirst += 1;
      }
    }
    return { shownMs, emptyAfterFirst, samples };
  }

  it('without late mode nothing is shown while playing (the reported defect)', () => {
    const r = simulate(false);
    expect(r.shownMs.size).toBe(0);
  });

  it('late mode shows every translation for at least 2 s and keeps the overlay mostly filled', () => {
    const r = simulate(true);
    for (const c of all) expect(r.shownMs.get(c.id) ?? 0).toBeGreaterThanOrEqual(2_000);
    expect(r.emptyAfterFirst).toBe(0);
  });

  it('late mode hides a translation once it is older than the window, and prefers the newest', () => {
    const s = createDisplaySelector(3_000, 8_000);
    const [a, b] = [all[0]!, all[1]!];
    const get = (id: string) => [a, b].find((c) => c.id === id);
    expect(s.select([a], a.endMs + 7_000, get, { late: true })).toMatchObject({
      cue: { id: a.id },
    });
    expect(s.select([a], a.endMs + 9_000, get, { late: true })).toBeUndefined();
    expect(s.select([a, b], b.endMs + 1_000, get, { late: true })).toMatchObject({
      cue: { id: b.id },
    });
    // 当前句还没有译文：保留最近的已译句并标记 held。
    const pending = {
      ...sentence(2),
      translatedText: undefined,
      translationState: 'pending' as const,
    };
    const get2 = (id: string) => [a, b, pending].find((c) => c.id === id);
    expect(s.select([a, b, pending], pending.startMs + 500, get2, { late: true })).toMatchObject({
      cue: { id: b.id },
      held: true,
    });
  });
});

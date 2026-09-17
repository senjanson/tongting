import { describe, expect, it } from 'vitest';
import { CueSchema, type Cue } from '@src/domain/cue';
import { createAsrCueAssembler } from '@src/captions/asr-assembler';

type Push = Parameters<ReturnType<typeof createAsrCueAssembler>['push']>[0];

function seg(p: Partial<Push> & Pick<Push, 'segmentId' | 'startMs' | 'endMs' | 'text'>): Push {
  return { endEstimated: false, final: true, revision: 0, language: 'en', ...p };
}

function createStore() {
  const cues = new Map<string, Cue>();
  return {
    cues,
    apply(r: { upserts: Cue[]; removedIds: string[] }) {
      for (const c of r.upserts) {
        expect(CueSchema.safeParse(c).success).toBe(true);
        const prev = cues.get(c.id);
        // revision 只随文本变化递增；仅时间/stability 变化时保持不变。
        if (prev && prev.sourceText !== c.sourceText)
          expect(c.revision).toBeGreaterThan(prev.revision);
        if (prev && prev.sourceText === c.sourceText) expect(c.revision).toBe(prev.revision);
        cues.set(c.id, c);
      }
      for (const id of r.removedIds) cues.delete(id);
      return r;
    },
    sorted() {
      return [...cues.values()].sort((a, b) => a.startMs - b.startMs);
    },
  };
}

describe('ASR cue assembler', () => {
  it('removes duplicated words in overlapping segments and keeps timing monotonic', () => {
    const a = createAsrCueAssembler({ idPrefix: 'vid:asr', targetLanguage: 'zh-CN' });
    const store = createStore();
    store.apply(
      a.push(seg({ segmentId: 's1', startMs: 0, endMs: 5000, text: 'hello world this is a' })),
    );
    store.apply(
      a.push(seg({ segmentId: 's2', startMs: 4500, endMs: 9500, text: 'is a test of the system' })),
    );
    store.apply(
      a.push(seg({ segmentId: 's3', startMs: 9000, endMs: 14000, text: 'the system works well' })),
    );
    const cues = store.sorted();
    expect(cues.map((c) => c.sourceText)).toEqual([
      'hello world this is a',
      'test of the system',
      'works well',
    ]);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i]!.startMs).toBeGreaterThanOrEqual(cues[i - 1]!.endMs);
    expect(cues[0]).toMatchObject({
      id: 'vid:asr:s1',
      source: 'asr',
      stability: 'final',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      translationState: 'pending',
    });
  });

  it('does not treat a short common word as overlap', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const store = createStore();
    store.apply(a.push(seg({ segmentId: '1', startMs: 0, endMs: 3000, text: 'give it to a' })));
    store.apply(a.push(seg({ segmentId: '2', startMs: 3000, endMs: 6000, text: 'a friend' })));
    expect(store.sorted().map((c) => c.sourceText)).toEqual(['give it to a', 'a friend']);
  });

  it('updates the same cue on newer revisions, ignores stale revisions and final→interim regressions', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const store = createStore();
    const r0 = store.apply(
      a.push(
        seg({
          segmentId: 'x',
          startMs: 0,
          endMs: 4000,
          text: 'hel',
          final: false,
          endEstimated: true,
        }),
      ),
    );
    expect(r0.upserts[0]).toMatchObject({ stability: 'interim', revision: 0, endEstimated: true });
    const r1 = store.apply(
      a.push(
        seg({
          segmentId: 'x',
          startMs: 0,
          endMs: 4000,
          text: 'hello there',
          final: false,
          revision: 1,
          endEstimated: true,
        }),
      ),
    );
    expect(r1.upserts[0]).toMatchObject({
      id: r0.upserts[0]!.id,
      revision: 1,
      sourceText: 'hello there',
    });
    expect(
      a.push(
        seg({ segmentId: 'x', startMs: 0, endMs: 4000, text: 'stale', final: false, revision: 0 }),
      ).upserts,
    ).toHaveLength(0);
    const r2 = store.apply(
      a.push(
        seg({
          segmentId: 'x',
          startMs: 0,
          endMs: 3800,
          text: 'hello there',
          final: true,
          revision: 2,
        }),
      ),
    );
    // 文本未变：只更新 stability/结束时间，revision 保持 1（worker 保留已有译文）。
    expect(r2.upserts[0]).toMatchObject({
      stability: 'final',
      revision: 1,
      endMs: 3800,
      endEstimated: false,
    });
    expect(
      a.push(
        seg({
          segmentId: 'x',
          startMs: 0,
          endMs: 3800,
          text: 'regress',
          final: false,
          revision: 3,
        }),
      ).upserts,
    ).toHaveLength(0);
    // final 之后的结果（即使 revision 更高、文本不同）一律忽略。
    expect(
      a.push(
        seg({ segmentId: 'x', startMs: 0, endMs: 3800, text: 'changed', final: true, revision: 9 }),
      ).upserts,
    ).toHaveLength(0);
    expect(
      a.push(
        seg({
          segmentId: 'x',
          startMs: 0,
          endMs: 3800,
          text: 'hello there',
          final: true,
          revision: 3,
        }),
      ).upserts,
    ).toHaveLength(0);
  });

  it('drops a cut-off last word from an interim previous segment but not from a final one', () => {
    const interim = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const s1 = createStore();
    s1.apply(
      interim.push(
        seg({ segmentId: '1', startMs: 0, endMs: 5000, text: 'this is a te', final: false }),
      ),
    );
    s1.apply(
      interim.push(
        seg({ segmentId: '2', startMs: 4600, endMs: 9000, text: 'a test of it', final: false }),
      ),
    );
    expect(s1.sorted().map((c) => c.sourceText)).toEqual(['this is a', 'test of it']);

    const finalPrev = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const s2 = createStore();
    s2.apply(
      finalPrev.push(
        seg({ segmentId: '1', startMs: 0, endMs: 5000, text: 'this is a te', final: true }),
      ),
    );
    s2.apply(
      finalPrev.push(
        seg({ segmentId: '2', startMs: 4600, endMs: 9000, text: 'a test of it', final: true }),
      ),
    );
    expect(s2.sorted().map((c) => c.sourceText)).toEqual(['this is a te', 'test of it']);
  });

  it('keeps an already emitted final segment frozen when an earlier segment arrives late', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const store = createStore();
    const first = store.apply(
      a.push(seg({ segmentId: 'b', startMs: 4500, endMs: 9500, text: 'is a test of the system' })),
    );
    const late = store.apply(
      a.push(seg({ segmentId: 'a', startMs: 0, endMs: 5000, text: 'hello world this is a' })),
    );
    // 已确认的 b 不被修订；迟到的 a 让出重叠部分，且结束时间不晚于 b 的起点。
    expect(late.upserts.map((c) => c.id)).toEqual(['v:a']);
    expect(store.sorted().map((c) => c.sourceText)).toEqual([
      'hello world this',
      'is a test of the system',
    ]);
    expect(store.cues.get('v:b')).toEqual(first.upserts[0]);
    expect(store.cues.get('v:a')!.endMs).toBeLessThanOrEqual(4500);
  });

  it('removes a cue whose text becomes fully duplicated or empty', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const store = createStore();
    store.apply(
      a.push(
        seg({ segmentId: '1', startMs: 0, endMs: 5000, text: 'one two three four', final: false }),
      ),
    );
    store.apply(
      a.push(
        seg({ segmentId: '2', startMs: 4000, endMs: 5500, text: 'something new', final: false }),
      ),
    );
    const r = store.apply(
      a.push(
        seg({
          segmentId: '2',
          startMs: 4000,
          endMs: 5500,
          text: 'three four',
          final: true,
          revision: 1,
        }),
      ),
    );
    expect(r.removedIds).toEqual(['v:2']);
    expect(store.sorted().map((c) => c.sourceText)).toEqual(['one two three four']);
    const empty = store.apply(
      a.push(seg({ segmentId: '3', startMs: 6000, endMs: 8000, text: '   ' })),
    );
    expect(empty.upserts).toHaveLength(0);
  });

  it('deduplicates a re-recognized segment covering the same time range', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    const store = createStore();
    store.apply(
      a.push(seg({ segmentId: 'first', startMs: 10_000, endMs: 15_000, text: 'same audio again' })),
    );
    const dup = a.push(
      seg({ segmentId: 'again', startMs: 10_100, endMs: 15_050, text: 'same audio again' }),
    );
    expect(dup.upserts).toHaveLength(0);
    const differentFinalKept = a.push(
      seg({ segmentId: 'again2', startMs: 10_000, endMs: 15_000, text: 'different words' }),
    );
    expect(differentFinalKept.upserts).toHaveLength(0);
    // 后续同 id 的修订作用在原 cue 上（已为 final，不再回退/改写）。
    expect(
      a.push(
        seg({
          segmentId: 'again',
          startMs: 10_100,
          endMs: 15_050,
          text: 'x',
          revision: 5,
          final: false,
        }),
      ).upserts,
    ).toHaveLength(0);
  });

  it('validates input and keeps HTML-like text literal', () => {
    const a = createAsrCueAssembler({ idPrefix: 'v', targetLanguage: 'zh-CN' });
    expect(a.push(seg({ segmentId: '', startMs: 0, endMs: 1, text: 'x' })).upserts).toHaveLength(0);
    expect(a.push(seg({ segmentId: 'n', startMs: -5, endMs: 1, text: 'x' })).upserts).toHaveLength(
      0,
    );
    expect(
      a.push(seg({ segmentId: 'n', startMs: Number.POSITIVE_INFINITY, endMs: 1, text: 'x' }))
        .upserts,
    ).toHaveLength(0);
    const r = a.push(
      seg({
        segmentId: 'h',
        startMs: 0,
        endMs: 1000,
        text: '<script>alert(1)</script>',
        language: undefined,
      }),
    );
    expect(r.upserts[0]).toMatchObject({
      sourceText: '<script>alert(1)</script>',
      sourceLanguage: 'und',
    });
    a.reset();
    const again = a.push(seg({ segmentId: 'h', startMs: 0, endMs: 1000, text: 'fresh' }));
    expect(again.upserts[0]).toMatchObject({ revision: 0, sourceText: 'fresh' });
  });
});

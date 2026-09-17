import { describe, expect, it } from 'vitest';
import type { MediaAnchor } from '@src/messaging/offscreen-protocol';
import { mediaTimeAt, MediaTimeline } from '@src/audio/timeline';

function anchor(
  p: Partial<MediaAnchor> & Pick<MediaAnchor, 'epochMs' | 'mediaTimeMs' | 'discontinuityId'>,
): MediaAnchor {
  return { playbackRate: 1, paused: false, seeking: false, buffering: false, ad: false, ...p };
}

const T0 = 1_700_000_000_000;

describe('MediaTimeline mapping', () => {
  it.each([0.75, 1, 1.5, 2])('maps capture epoch time to media time at %sx', (rate) => {
    const tl = new MediaTimeline();
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 10_000, discontinuityId: 1, playbackRate: rate }));
    tl.add(
      anchor({
        epochMs: T0 + 20_000,
        mediaTimeMs: 10_000 + 20_000 * rate,
        discontinuityId: 1,
        playbackRate: rate,
      }),
    );
    const [piece] = tl.plan({ startEpochMs: T0 + 4_000, endEpochMs: T0 + 8_000 });
    expect(piece).toMatchObject({ disposition: 'send', discontinuityId: 1, playbackRate: rate });
    const m = tl.map({ startEpochMs: T0 + 4_000, endEpochMs: T0 + 8_000 }, 1);
    expect(m).toEqual({
      ok: true,
      startMs: 10_000 + 4_000 * rate,
      endMs: 10_000 + 8_000 * rate,
      endEstimated: false,
      clipped: false,
    });
  });

  it('splits a range at a seek boundary and maps each side with its own anchor', () => {
    const tl = new MediaTimeline({ minPieceMs: 800 });
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    // 在 T0+3000 跳转到 120 s
    tl.add(anchor({ epochMs: T0 + 3_000, mediaTimeMs: 120_000, discontinuityId: 2 }));
    const pieces = tl.plan({ startEpochMs: T0 + 1_000, endEpochMs: T0 + 6_000 });
    expect(pieces).toEqual([
      {
        startEpochMs: T0 + 1_000,
        endEpochMs: T0 + 3_000,
        disposition: 'send',
        discontinuityId: 1,
        playbackRate: 1,
      },
      {
        startEpochMs: T0 + 3_000,
        endEpochMs: T0 + 6_000,
        disposition: 'send',
        discontinuityId: 2,
        playbackRate: 1,
      },
    ]);
    const before = tl.map({ startEpochMs: T0 + 1_000, endEpochMs: T0 + 2_500 }, 1);
    expect(before).toMatchObject({ ok: true, startMs: 1_000, endMs: 2_500 });
    const after = tl.map({ startEpochMs: T0 + 3_500, endEpochMs: T0 + 5_000 }, 2);
    expect(after).toMatchObject({ ok: true, startMs: 120_500, endMs: 122_000 });
  });

  it('handles rate change as a boundary (1x → 2x)', () => {
    const tl = new MediaTimeline();
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    tl.add(
      anchor({ epochMs: T0 + 5_000, mediaTimeMs: 5_000, discontinuityId: 2, playbackRate: 2 }),
    );
    const pieces = tl.plan({ startEpochMs: T0 + 3_000, endEpochMs: T0 + 8_000 });
    expect(pieces.map((p) => p.disposition)).toEqual(['send', 'send']);
    expect(tl.map({ startEpochMs: T0 + 6_000, endEpochMs: T0 + 7_000 }, 2)).toMatchObject({
      startMs: 7_000,
      endMs: 9_000,
    });
  });

  it('drops paused, buffering, seeking and ad ranges', () => {
    const tl = new MediaTimeline();
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    tl.add(anchor({ epochMs: T0 + 2_000, mediaTimeMs: 2_000, discontinuityId: 2, paused: true }));
    tl.add(anchor({ epochMs: T0 + 4_000, mediaTimeMs: 2_000, discontinuityId: 3 }));
    tl.add(anchor({ epochMs: T0 + 6_000, mediaTimeMs: 0, discontinuityId: 4, ad: true }));
    tl.add(anchor({ epochMs: T0 + 9_000, mediaTimeMs: 4_000, discontinuityId: 5 }));
    const pieces = tl.plan({ startEpochMs: T0, endEpochMs: T0 + 11_000 });
    expect(pieces.map((p) => (p.disposition === 'send' ? 'send' : p.reason))).toEqual([
      'send',
      'not-playing',
      'send',
      'ad',
      'send',
    ]);
    // 恢复后映射正确（T18）：广告结束 2 s 后为 6 s
    expect(tl.map({ startEpochMs: T0 + 9_000, endEpochMs: T0 + 11_000 }, 5)).toMatchObject({
      ok: true,
      startMs: 4_000,
      endMs: 6_000,
    });
    expect(tl.map({ startEpochMs: T0 + 6_500, endEpochMs: T0 + 7_000 }, 4)).toEqual({
      ok: false,
      reason: 'ad',
    });
  });

  it('drops pieces shorter than minPieceMs and ranges before any anchor', () => {
    const tl = new MediaTimeline({ minPieceMs: 800 });
    tl.add(anchor({ epochMs: T0 + 1_000, mediaTimeMs: 0, discontinuityId: 1 }));
    tl.add(anchor({ epochMs: T0 + 1_500, mediaTimeMs: 50_000, discontinuityId: 2 }));
    const pieces = tl.plan({ startEpochMs: T0, endEpochMs: T0 + 3_000 });
    expect(pieces.map((p) => (p.disposition === 'send' ? 'send' : p.reason))).toEqual([
      'no-anchor',
      'too-short',
      'send',
    ]);
  });

  it('rejects results whose discontinuity changed after sending and clips at late boundaries', () => {
    const tl = new MediaTimeline();
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    // 分段在 T0+1000..T0+5000 送出时区间 1 未见断点；随后迟到的暂停锚点出现在 T0+3000
    tl.add(anchor({ epochMs: T0 + 3_000, mediaTimeMs: 3_000, discontinuityId: 2, paused: true }));
    const clipped = tl.map({ startEpochMs: T0 + 2_000, endEpochMs: T0 + 4_500 }, 1);
    expect(clipped).toEqual({
      ok: true,
      startMs: 2_000,
      endMs: 3_000,
      endEstimated: false,
      clipped: true,
    });
    expect(tl.map({ startEpochMs: T0 + 3_200, endEpochMs: T0 + 4_000 }, 1)).toEqual({
      ok: false,
      reason: 'discontinuity-changed',
    });
  });

  it('marks end as estimated when no anchor confirms playback up to the end', () => {
    const tl = new MediaTimeline({ staleAnchorMs: 3_000 });
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    expect(tl.map({ startEpochMs: T0 + 1_000, endEpochMs: T0 + 2_000 }, 1)).toMatchObject({
      endEstimated: false,
    });
    expect(tl.map({ startEpochMs: T0 + 1_000, endEpochMs: T0 + 5_000 }, 1)).toMatchObject({
      endEstimated: true,
    });
    expect(
      tl.map({ startEpochMs: T0 + 1_000, endEpochMs: T0 + 2_000 }, 1, { timingEstimated: true }),
    ).toMatchObject({ endEstimated: true });
  });

  it('keeps anchors ordered, bounded and prunable', () => {
    const tl = new MediaTimeline({ maxAnchors: 5 });
    for (let i = 9; i >= 0; i--)
      tl.add(anchor({ epochMs: T0 + i * 1000, mediaTimeMs: i * 1000, discontinuityId: 1 }));
    expect(tl.size).toBe(5);
    tl.prune(T0 + 100_000);
    expect(tl.size).toBe(1);
    expect(tl.anchorAt(T0 + 200_000)).toBeDefined();
    expect(
      mediaTimeAt(
        anchor({ epochMs: T0, mediaTimeMs: 5_000, discontinuityId: 1, paused: true }),
        T0 + 9_000,
      ),
    ).toBe(5_000);
  });

  it('thins high-frequency calibration anchors so old boundaries survive (coordinator sends one per player update)', () => {
    const tl = new MediaTimeline({ maxAnchors: 50, minSpacingMs: 1_000 });
    tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 1 }));
    tl.add(anchor({ epochMs: T0 + 5_000, mediaTimeMs: 90_000, discontinuityId: 2 }));
    // 60 秒内每 50 ms 一个校准锚点（1200 个）
    for (let t = 5_050; t <= 65_000; t += 50)
      tl.add(anchor({ epochMs: T0 + t, mediaTimeMs: 90_000 + (t - 5_000), discontinuityId: 2 }));
    expect(tl.size).toBeLessThanOrEqual(50);
    // 积压 30 秒前的分段仍可映射到正确区间
    expect(tl.map({ startEpochMs: T0 + 36_000, endEpochMs: T0 + 37_000 }, 2)).toMatchObject({
      ok: true,
      startMs: 121_000,
      endMs: 122_000,
    });
    expect(tl.anchorAt(T0 + 64_990)?.discontinuityId).toBe(2);
    expect(tl.latest()?.epochMs).toBe(T0 + 65_000);
  });

  it('periodic anchors within the same discontinuity are not boundaries', () => {
    const tl = new MediaTimeline();
    expect(tl.add(anchor({ epochMs: T0, mediaTimeMs: 0, discontinuityId: 3 })).boundary).toBe(true);
    expect(
      tl.add(anchor({ epochMs: T0 + 1_000, mediaTimeMs: 1_010, discontinuityId: 3 })).boundary,
    ).toBe(false);
    expect(tl.plan({ startEpochMs: T0 + 100, endEpochMs: T0 + 4_000 })).toHaveLength(1);
  });
});

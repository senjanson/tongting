import { describe, expect, it } from 'vitest';
import { createContextClock } from '@src/audio/context-clock';

/** 可控的时钟：wall = Date.now 基准，perf = 本文档 performance.now（可与 wall 相差任意偏移）。 */
function fakeClocks(perfLagMs = 0) {
  const t = { perf: 5_000, wall: 1_800_000_000_000 };
  return {
    t,
    clock: { dateNow: () => t.wall, performance: { now: () => t.perf } },
    advance(ms: number) {
      t.perf += ms;
      t.wall += ms;
    },
    perfLagMs,
  };
}

describe('ContextClock (epoch = Date.now 基准)', () => {
  it('converts output timestamps via perfToEpochMs and subtracts latency; no timeOrigin involved', () => {
    const c = fakeClocks();
    // performance 时钟比 Date.now 基准落后 2 小时（系统睡眠期间停走）
    c.t.wall += 2 * 3600_000;
    const ctxTime = { current: 2.02 };
    const clock = createContextClock({
      getOutputTimestamp: () => ({ contextTime: 2, performanceTime: 4_990 }),
      currentTime: () => ctxTime.current,
      baseLatency: () => 0.01,
      outputLatency: () => 0.03,
      clock: c.clock,
    });
    clock.sample();
    expect(clock.source).toBe('output-timestamp');
    // epoch(p) = wall - perf + p
    const expected = c.t.wall - c.t.perf + 4_990 + 1_000 - 40;
    expect(clock.contextTimeToEpochMs(3)).toBeCloseTo(expected, 6);
    expect(clock.epochMsToContextTime(expected)).toBeCloseTo(3, 9);
  });

  it('smooths small jitter across multiple samples', () => {
    const c = fakeClocks();
    let jitter = 0;
    const clock = createContextClock(
      {
        getOutputTimestamp: () => ({
          contextTime: (c.t.perf - 5_000) / 1000 + 1,
          performanceTime: c.t.perf + jitter,
        }),
        currentTime: () => 0,
        clock: c.clock,
      },
      { smoothing: 0.5, resetThresholdMs: 40 },
    );
    clock.sample();
    const base = clock.offsetMs!;
    jitter = 8;
    c.advance(100);
    clock.sample();
    expect(clock.offsetMs! - base).toBeCloseTo(4, 6);
    c.advance(100);
    clock.sample();
    expect(clock.offsetMs! - base).toBeCloseTo(6, 6);
    jitter = 0;
    c.advance(100);
    clock.sample();
    expect(clock.offsetMs! - base).toBeCloseTo(3, 6);
    expect(clock.resets).toBe(0);
  });

  it('resets immediately (no smoothing) when the offset jumps beyond the threshold', () => {
    const c = fakeClocks();
    let audioTime = 1;
    const clock = createContextClock(
      {
        getOutputTimestamp: () => ({ contextTime: audioTime, performanceTime: c.t.perf }),
        currentTime: () => audioTime,
        clock: c.clock,
      },
      { smoothing: 0.1, resetThresholdMs: 40 },
    );
    clock.sample();
    const before = clock.offsetMs!;
    // 系统睡眠 10 分钟：墙钟与 performance 前进，音频时钟停走
    c.advance(600_000);
    clock.sample();
    expect(clock.resets).toBe(1);
    expect(clock.offsetMs! - before).toBeCloseTo(600_000, 6);
    audioTime += 0.1;
    c.advance(100);
    clock.sample();
    expect(clock.offsetMs! - before).toBeCloseTo(600_000, 6);
  });

  it('falls back to currentTime pairing and prefers output timestamps once acquired; reset() re-anchors', () => {
    const c = fakeClocks();
    let valid = false;
    const clock = createContextClock({
      getOutputTimestamp: () =>
        valid
          ? { contextTime: 2, performanceTime: c.t.perf }
          : { contextTime: 0, performanceTime: 0 },
      currentTime: () => 1.5,
      clock: c.clock,
    });
    clock.sample();
    expect(clock.source).toBe('current-time');
    expect(clock.contextTimeToEpochMs(1.5)).toBeCloseTo(c.t.wall, 6);
    valid = true;
    clock.sample();
    expect(clock.source).toBe('output-timestamp');
    valid = false;
    clock.sample();
    expect(clock.source).toBe('output-timestamp');
    clock.reset();
    expect(clock.source).toBe('none');
    expect(clock.offsetMs).toBeUndefined();
    clock.sample();
    expect(clock.source).toBe('current-time');
  });

  it('ignores stale output timestamps', () => {
    const c = fakeClocks();
    const clock = createContextClock({
      getOutputTimestamp: () => ({ contextTime: 1, performanceTime: c.t.perf - 4_000 }),
      currentTime: () => 3,
      clock: c.clock,
    });
    clock.sample();
    expect(clock.source).toBe('current-time');
  });
});

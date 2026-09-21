import { describe, expect, it, vi } from 'vitest';
import { createAudioPreloader } from '@src/translation/audio-preloader';
import type { YoutubePreloadResult } from '@src/providers/asr/youtube-preload';

function setup() {
  const requests: {
    start: number;
    duration: number;
    signal: AbortSignal;
    resolve(value: YoutubePreloadResult): void;
    reject(error: Error): void;
  }[] = [];
  const onResult = vi.fn();
  const onChange = vi.fn();
  const preloader = createAudioPreloader({
    load: (start, duration, signal) =>
      new Promise((resolve, reject) => requests.push({ start, duration, signal, resolve, reject })),
    onResult,
    onChange,
  });
  const answer = (index: number, duration = requests[index]!.duration) => {
    const req = requests[index]!;
    req.resolve({ startMs: req.start, durationMs: duration, text: '', segments: [] });
  };
  return { preloader, requests, onResult, onChange, answer };
}
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('ahead-of-playhead audio recognition', () => {
  it('prepares bounded chunks even while the source video stays paused', async () => {
    const h = setup();
    h.preloader.update(0, 120000);
    expect(h.requests).toHaveLength(1);
    h.answer(0);
    await settle();
    expect(h.preloader.ranges()).toEqual([{ startMs: 0, endMs: 20000 }]);
    h.answer(1);
    await settle();
    h.answer(2);
    await settle();
    expect(h.requests.map((r) => r.start)).toEqual([0, 20000, 40000]);
    expect(h.preloader.ranges()).toEqual([{ startMs: 0, endMs: 60000 }]);
    h.preloader.dispose();
  });
  it('ignores a late response after seeking and reads the new position', async () => {
    const h = setup();
    h.preloader.update(0, 120000);
    h.preloader.update(90000, 120000, true);
    expect(h.requests[0]!.signal.aborted).toBe(true);
    h.answer(0);
    await settle();
    expect(h.onResult).not.toHaveBeenCalled();
    expect(h.preloader.ranges()).toEqual([]);
    h.answer(1);
    await settle();
    expect(h.preloader.ranges()[0]!.startMs).toBe(90000);
    h.preloader.dispose();
  });
  it('does not allow stale ABA results, pause, or disposal to publish', async () => {
    const h = setup();
    h.preloader.update(0, 120000);
    h.preloader.update(60000, 120000, true);
    h.preloader.update(0, 120000, true);
    h.answer(0);
    h.answer(1);
    await settle();
    expect(h.onResult).not.toHaveBeenCalled();
    h.preloader.pause();
    h.answer(2);
    await settle();
    expect(h.onResult).not.toHaveBeenCalled();
    h.preloader.resume();
    expect(h.requests).toHaveLength(4);
    h.preloader.dispose();
    h.answer(3);
    await settle();
    expect(h.onResult).not.toHaveBeenCalled();
  });
  it('stops on failure, exposes it, and retries only on explicit retry', async () => {
    const h = setup();
    h.preloader.update(0, 120000);
    h.requests[0]!.reject(new Error('unavailable'));
    await settle();
    expect(h.preloader.error()).toBeDefined();
    h.preloader.update(1000, 120000);
    expect(h.requests).toHaveLength(1);
    h.preloader.retry();
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.start).toBe(1000);
    h.preloader.dispose();
  });
  it('requests the short last fraction rather than buffering forever at EOF', async () => {
    const h = setup();
    h.preloader.update(20000, 20500);
    expect(h.requests[0]!.duration).toBe(500);
    h.answer(0, 500);
    await settle();
    expect(h.preloader.ranges()).toEqual([{ startMs: 20000, endMs: 20500 }]);
    expect(h.requests).toHaveLength(1);
    h.preloader.dispose();
  });
  it('fills disjoint gaps without requesting audio from the next known range again', async () => {
    const h = setup();
    h.preloader.update(0, 120000);
    h.answer(0);
    await settle();
    h.answer(1);
    await settle();
    h.answer(2);
    await settle();
    h.preloader.update(90000, 120000, true);
    h.answer(3);
    await settle();
    h.preloader.update(50000, 120000, true);
    expect(h.requests[4]!.signal.aborted).toBe(true);
    expect(h.requests[5]).toMatchObject({ start: 60000, duration: 20000 });
    h.answer(5);
    await settle();
    expect(h.requests[6]).toMatchObject({ start: 80000, duration: 10000 });
    h.answer(6);
    await settle();
    expect(h.preloader.ranges()).toEqual([{ startMs: 0, endMs: 110000 }]);
    expect(h.requests).toHaveLength(7);
    h.preloader.dispose();
  });
  it('reads a sub-second unknown gap instead of crossing a known cue boundary or inventing silence', async () => {
    const h = setup();
    h.preloader.update(20500, 60000);
    h.answer(0);
    await settle();
    h.preloader.update(0, 60000, true);
    h.answer(2);
    await settle();
    expect(h.requests[3]).toMatchObject({ start: 20000, duration: 500 });
    expect(h.preloader.ranges()).toEqual([
      { startMs: 0, endMs: 20000 },
      { startMs: 20500, endMs: 40500 },
    ]);
    h.answer(3);
    await settle();
    expect(h.preloader.ranges()).toEqual([{ startMs: 0, endMs: 40500 }]);
    expect(h.requests[4]).toMatchObject({ start: 40500, duration: 19500 });
    h.preloader.dispose();
  });
});

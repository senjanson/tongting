import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAudioPreloader } from '@src/translation/audio-preloader';
import { mapHttpStatus } from '@src/providers/asr/http';
import { PreloadRangeError, type YoutubePreloadResult } from '@src/providers/asr/youtube-preload';

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

const ORIGIN = 'http://127.0.0.1:8765';
const serviceError = (status: number, code: string, retryAfterMs?: number) =>
  mapHttpStatus(status, code, retryAfterMs, 'local-asr', ORIGIN);
const outOfRange = (mediaEndMs?: number) =>
  new PreloadRangeError(serviceError(416, 'youtube_range_unavailable').info, mediaEndMs);

/** Answers immediately, like a local service reading a media file that ends at mediaEndMs. */
function autoSetup(respond: (start: number, duration: number) => YoutubePreloadResult | Error): {
  preloader: ReturnType<typeof createAudioPreloader>;
  calls: [number, number][];
} {
  const calls: [number, number][] = [];
  const preloader = createAudioPreloader({
    load: async (start, duration) => {
      calls.push([start, duration]);
      const answer = respond(start, duration);
      if (answer instanceof Error) throw answer;
      return answer;
    },
    onResult: () => {},
    onChange: () => {},
  });
  return { preloader, calls };
}
const audio = (start: number, durationMs: number): YoutubePreloadResult => ({
  startMs: start,
  durationMs,
  text: '',
  segments: [],
});
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

describe('end of media', () => {
  it('finishes at the player duration when an old service only knows whole seconds', async () => {
    // yt-dlp reports lengthSeconds (213) for a 213.461 s video; the old service answers 416 past it.
    const h = autoSetup((start, duration) =>
      start >= 213_000
        ? serviceError(416, 'youtube_range_unavailable')
        : audio(start, Math.min(duration, 213_000 - start)),
    );
    h.preloader.update(168_500, 213_461);
    await flush();
    expect(h.calls.at(-1)).toEqual([213_000, 461]);
    expect(h.preloader.error()).toBeUndefined();
    expect(h.preloader.ranges()).toEqual([{ startMs: 168_500, endMs: 213_461 }]);
    h.preloader.dispose();
  });

  it('trusts the end of media reported by the service, even before the player duration', async () => {
    for (const mediaEndMs of [213_300, 180_000]) {
      const h = autoSetup((start, duration) =>
        start >= mediaEndMs
          ? outOfRange(mediaEndMs)
          : audio(start, Math.min(duration, mediaEndMs - start)),
      );
      h.preloader.update(170_000, 213_461);
      await flush();
      expect(h.calls.at(-1)![0]).toBe(mediaEndMs);
      expect(h.preloader.error()).toBeUndefined();
      expect(h.preloader.ranges()).toEqual([{ startMs: 170_000, endMs: 213_461 }]);
      h.preloader.dispose();
    }
  });

  it('treats an old service failing to decode the last fraction as the end', async () => {
    // The audio track ends 161 ms before video.duration; the old service answers 502 (empty PCM).
    const h = autoSetup((start, duration) =>
      start >= 213_300
        ? serviceError(502, 'youtube_audio_failed')
        : audio(start, Math.min(duration, 213_300 - start)),
    );
    h.preloader.update(200_000, 213_461);
    await flush();
    expect(h.calls.at(-1)).toEqual([213_300, 161]);
    expect(h.preloader.error()).toBeUndefined();
    expect(h.preloader.ranges()).toEqual([{ startMs: 200_000, endMs: 213_461 }]);
    h.preloader.dispose();
  });

  it('accepts an empty result only at the very end', async () => {
    const tail = autoSetup((start) => audio(start, 0));
    tail.preloader.update(213_000, 213_461);
    await flush();
    expect(tail.preloader.error()).toBeUndefined();
    expect(tail.preloader.ranges()).toEqual([{ startMs: 213_000, endMs: 213_461 }]);
    const middle = autoSetup((start) => audio(start, 0));
    middle.preloader.update(60_000, 213_461);
    await flush();
    expect(middle.preloader.error()).toBeDefined();
    expect(middle.preloader.ranges()).toEqual([]);
  });

  it('still fails on 416 away from the end of media', async () => {
    for (const error of [serviceError(416, 'youtube_range_unavailable'), outOfRange(213_461)]) {
      const h = autoSetup(() => error);
      h.preloader.update(60_000, 213_461);
      await flush();
      expect(h.preloader.error()).toMatchObject({ code: 'preload-range-unavailable' });
      expect(h.preloader.ranges()).toEqual([]);
      expect(h.calls).toHaveLength(1);
    }
  });
});

describe('retryable preload failures', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const loading = () => serviceError(503, 'model_loading', 5_000);

  it('waits out Retry-After while the model loads, then reads from the latest position', async () => {
    const h = setup();
    h.preloader.update(0, 600_000);
    h.requests[0]!.reject(loading());
    await settle();
    expect(h.preloader.error()).toBeUndefined();
    expect(h.onChange).not.toHaveBeenCalled();
    h.preloader.update(3_000, 600_000); // Playback heartbeats do not bypass the wait.
    vi.advanceTimersByTime(4_999);
    expect(h.requests).toHaveLength(1);
    vi.advanceTimersByTime(501);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.start).toBe(3_000);
    h.answer(1);
    await settle();
    expect(h.preloader.ranges()).toEqual([{ startMs: 3_000, endMs: 23_000 }]);
    h.preloader.dispose();
  });

  it('backs off without Retry-After and fails only after repeated consecutive failures', async () => {
    const h = setup();
    const busy = () => serviceError(502, 'youtube_audio_failed');
    h.preloader.update(0, 600_000);
    // A success in between resets the consecutive count.
    h.requests[0]!.reject(busy());
    await settle();
    vi.advanceTimersByTime(10_000);
    h.answer(1);
    await settle();
    for (let i = 2; i <= 7; i++) {
      h.requests[i]!.reject(busy());
      await settle();
      if (i < 7) {
        expect(h.preloader.error()).toBeUndefined();
        vi.advanceTimersByTime(10_000);
      }
    }
    expect(h.requests).toHaveLength(8);
    expect(h.preloader.error()).toMatchObject({ code: 'preload-audio-failed', retryable: true });
    vi.advanceTimersByTime(600_000);
    expect(h.requests).toHaveLength(8);
    h.preloader.retry();
    expect(h.requests).toHaveLength(9);
    expect(h.requests[8]!.start).toBe(20_000);
    h.preloader.dispose();
  });

  it('fails at once for non-retryable errors or an unreasonably long Retry-After', async () => {
    for (const error of [
      serviceError(503, 'youtube_preload_unavailable'),
      serviceError(429, 'busy', 120_000),
    ]) {
      const h = setup();
      h.preloader.update(0, 600_000);
      h.requests[0]!.reject(error);
      await settle();
      expect(h.preloader.error()).toMatchObject({ code: error.info.code });
      vi.advanceTimersByTime(600_000);
      expect(h.requests).toHaveLength(1);
      h.preloader.dispose();
    }
  });

  it('drops a pending retry on seek and never replays it at the old position', async () => {
    const h = setup();
    h.preloader.update(0, 600_000);
    h.requests[0]!.reject(loading());
    await settle();
    h.preloader.update(300_000, 600_000, true);
    expect(h.requests).toHaveLength(2);
    expect(h.requests[1]!.start).toBe(300_000);
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(2);
    // A late failure of the request that was pending before the seek schedules nothing.
    h.preloader.update(0, 600_000, true);
    h.requests[1]!.reject(loading());
    await settle();
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(3);
    expect(h.preloader.error()).toBeUndefined();
    h.preloader.dispose();
  });

  it('drops the wait on pause, keeps counting failures, and clears timers on dispose', async () => {
    const h = setup();
    h.preloader.update(0, 600_000);
    for (let i = 0; i < 5; i++) {
      h.requests[i]!.reject(loading());
      await settle();
      // Pausing (user pause, ad, seeking) cancels the pending retry; resuming is a fresh attempt.
      h.preloader.pause();
      expect(vi.getTimerCount()).toBe(0);
      vi.advanceTimersByTime(60_000);
      expect(h.requests).toHaveLength(i + 1);
      h.preloader.update(1_000, 600_000);
      h.preloader.resume();
      expect(h.requests).toHaveLength(i + 2);
    }
    // Pausing does not reset the consecutive failure count.
    h.requests[5]!.reject(loading());
    await settle();
    expect(h.preloader.error()).toMatchObject({ code: 'asr-local-model-loading' });
    h.preloader.retry();
    h.requests[6]!.reject(loading());
    await settle();
    expect(h.preloader.error()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);
    h.preloader.dispose();
    vi.advanceTimersByTime(60_000);
    expect(h.requests).toHaveLength(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});

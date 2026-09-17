import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import type { AsrTranscription } from '@src/providers/asr/types';
import {
  RecognitionQueue,
  type AsrQueueStatus,
  type RecognitionResult,
  type RecognitionSegment,
} from '@src/audio/recognition-queue';

function seg(id: string, ms: number, start = 0): RecognitionSegment {
  return {
    id,
    samples: new Float32Array(Math.round((ms / 1000) * 16000)),
    sampleRate: 16000,
    startEpochMs: start,
    endEpochMs: start + ms,
    discontinuityId: 1,
  };
}

interface Deferred {
  resolve(t: AsrTranscription): void;
  reject(e: unknown): void;
  signal: AbortSignal;
}

function setup(options: Partial<ConstructorParameters<typeof RecognitionQueue>[0]> = {}) {
  const calls: Deferred[] = [];
  const results: RecognitionResult[] = [];
  const statuses: AsrQueueStatus[] = [];
  const errors: string[] = [];
  const queue = new RecognitionQueue({
    transcribe: (_wav, opts) =>
      new Promise<AsrTranscription>((resolve, reject) => {
        calls.push({ resolve, reject, signal: opts.signal });
      }),
    language: 'en',
    onResult: (r) => results.push(r),
    onStatus: (s) => statuses.push(s),
    onError: (e) => errors.push(e.code),
    now: () => Date.now(),
    ...options,
  });
  return { queue, calls, results, statuses, errors };
}

const ok = (text: string): AsrTranscription => ({ text, durationMs: 1000, segments: [] });

describe('RecognitionQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends serially and reports measured latency and realtime factor', async () => {
    const { queue, calls, results } = setup();
    queue.enqueue(seg('a', 4000));
    queue.enqueue(seg('b', 4000));
    expect(calls).toHaveLength(1);
    expect(queue.pendingRequests).toBe(1);
    vi.advanceTimersByTime(2000);
    calls[0]!.resolve(ok('hello'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => r.segment.id)).toEqual(['a']);
    expect(results[0]!.latencyMs).toBe(2000);
    expect(queue.status().lastLatencyMs).toBe(2000);
    expect(queue.status().realtimeFactor).toBeCloseTo(0.5, 5);
    expect(calls).toHaveLength(2);
  });

  it('bounds backlog by dropping the oldest queued segments (T32)', () => {
    const { queue, calls } = setup({ maxBacklogMs: 30_000, backlogWarnMs: 12_000 });
    for (let i = 0; i < 12; i++) queue.enqueue(seg(`s${i}`, 5000));
    const st = queue.status();
    expect(calls).toHaveLength(1); // 只有一个在途
    expect(st.backlogMs).toBeLessThanOrEqual(30_000);
    expect(st.droppedSegments).toBe(12 - 6);
    expect(st.droppedMs).toBe(6 * 5000);
    expect(st.state).toBe('backlogged');
  });

  it('reset aborts in-flight work and drops late results from the old generation', async () => {
    const { queue, calls, results } = setup();
    queue.enqueue(seg('old', 3000));
    queue.enqueue(seg('old2', 3000));
    const first = calls[0]!;
    queue.reset();
    expect(first.signal.aborted).toBe(true);
    expect(queue.status().queued).toBe(0);
    first.resolve(ok('stale'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(0);
    queue.enqueue(seg('new', 3000));
    calls[1]!.resolve(ok('fresh'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => r.segment.id)).toEqual(['new']);
  });

  it('retries retryable errors with bounded backoff and Retry-After', async () => {
    const { queue, calls, errors, results } = setup({ maxAttempts: 2 });
    queue.enqueue(seg('a', 3000));
    calls[0]!.reject(
      new AppError({
        code: 'local-asr-server-error',
        category: 'server',
        retryable: true,
        message: '5xx',
        retryAfterMs: 1500,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual(['local-asr-server-error']);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    // 第二次仍失败 → 丢弃该段（最多 2 次）
    calls[1]!.reject(
      new AppError({
        code: 'asr-local-unreachable',
        category: 'network',
        retryable: true,
        message: 'down',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status().state).toBe('unavailable');
    // 失败丢弃与积压丢弃分开计数
    expect(queue.status()).toMatchObject({
      failedSegments: 1,
      droppedFailedMs: 3000,
      droppedSegments: 0,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(2);
    queue.enqueue(seg('b', 3000));
    expect(calls).toHaveLength(3);
    calls[2]!.resolve(ok('back'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(1);
    expect(queue.status().lastError).toBeUndefined();
  });

  it('429 busy responses do not consume retry attempts; segments wait in order under the backlog bound', async () => {
    const { queue, calls, results } = setup({ maxAttempts: 2 });
    queue.enqueue(seg('a', 5000));
    queue.enqueue(seg('b', 5000));
    const busy = () =>
      new AppError({
        code: 'local-asr-rate-limited',
        category: 'rate-limit',
        retryable: true,
        message: 'busy',
        retryAfterMs: 1000,
      });
    for (let i = 0; i < 4; i++) {
      calls[i]!.reject(busy());
      await vi.advanceTimersByTimeAsync(1000);
    }
    // 4 次 429 后仍在重试同一段（串行，不并发）
    expect(calls).toHaveLength(5);
    expect(queue.status().droppedSegments).toBe(0);
    expect(queue.status().backlogMs).toBe(10_000);
    calls[4]!.resolve(ok('a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(results.map((r) => r.segment.id)).toEqual(['a']);
    expect(calls).toHaveLength(6);
  });

  it('reports loading state while the local model loads', async () => {
    const { queue, calls } = setup();
    queue.enqueue(seg('a', 3000));
    calls[0]!.reject(
      new AppError({
        code: 'asr-local-model-loading',
        category: 'server',
        retryable: true,
        message: 'loading',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status().state).toBe('loading');
  });

  it('blocks on auth/permission errors until reset', async () => {
    const { queue, calls, errors } = setup();
    queue.enqueue(seg('a', 3000));
    queue.enqueue(seg('b', 3000));
    calls[0]!.reject(
      new AppError({
        code: 'asr-local-token-invalid',
        category: 'auth',
        retryable: false,
        message: 'bad token',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status().state).toBe('error');
    expect(queue.enqueue(seg('c', 3000))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(errors).toEqual(['asr-local-token-invalid']);
    queue.reset();
    expect(queue.enqueue(seg('d', 3000))).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('drops a single non-retryable format failure and continues', async () => {
    const { queue, calls } = setup();
    queue.enqueue(seg('a', 3000));
    queue.enqueue(seg('b', 3000));
    calls[0]!.reject(
      new AppError({
        code: 'audio-too-large',
        category: 'format',
        retryable: false,
        message: '413',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(queue.status()).toMatchObject({ failedSegments: 1, droppedSegments: 0, state: 'error' });
  });

  it('setEnabled(false) stops processing and ignores new segments; dispose is final', async () => {
    const { queue, calls } = setup();
    queue.enqueue(seg('a', 3000));
    queue.setEnabled(false);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(queue.enqueue(seg('b', 3000))).toBe(false);
    queue.setEnabled(true);
    expect(queue.enqueue(seg('c', 3000))).toBe(true);
    queue.dispose();
    expect(calls[1]!.signal.aborted).toBe(true);
    expect(queue.enqueue(seg('d', 3000))).toBe(false);
    queue.setEnabled(true);
    expect(queue.enqueue(seg('e', 3000))).toBe(false);
  });

  it('encodes each request as an independent 16 kHz WAV', async () => {
    const wavs: ArrayBuffer[] = [];
    const { queue } = setup({
      transcribe: async (wav) => {
        wavs.push(wav);
        return ok('x');
      },
    });
    queue.enqueue(seg('a', 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(wavs).toHaveLength(1);
    const view = new DataView(wavs[0]!);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(wavs[0]!.byteLength).toBe(44 + 16000 * 2);
  });

  it('review#5: a hung transcription is aborted by the watchdog and reported as a failure, not just "slow"', async () => {
    const signals: AbortSignal[] = [];
    const errors: string[] = [];
    const q = new RecognitionQueue({
      transcribe: (_wav, o) => {
        signals.push(o.signal);
        return new Promise(() => undefined);
      },
      language: 'en',
      onResult: () => undefined,
      onError: (e) => errors.push(e.code),
      requestTimeoutMs: 1_000,
      watchdogGraceMs: 500,
      maxAttempts: 1,
    });
    q.enqueue(seg('a', 5000));
    q.enqueue(seg('b', 5000));
    await vi.advanceTimersByTimeAsync(1_499);
    expect(signals[0]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(errors).toEqual(['asr-request-watchdog']);
    expect(q.status()).toMatchObject({ state: 'error', failedSegments: 1, inFlight: false });
    // 退避后继续处理下一段，不再被卡住
    await vi.advanceTimersByTimeAsync(1_000);
    expect(signals).toHaveLength(2);
  });

  it('503 model_unavailable shows as unavailable', async () => {
    const { queue, calls } = setup();
    queue.enqueue(seg('a', 3000));
    calls[0]!.reject(
      new AppError({
        code: 'asr-local-model-unavailable',
        category: 'server',
        retryable: true,
        message: 'x',
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(queue.status().state).toBe('unavailable');
  });
});

import { mergeRanges, type TimeRange } from '../domain/cue';
import { toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import type { YoutubePreloadResult } from '../providers/asr/youtube-preload';

export interface AudioPreloader {
  update(positionMs: number, durationMs: number, seek?: boolean): void;
  pause(): void;
  resume(): void;
  retry(): void;
  dispose(): void;
  ranges(): readonly TimeRange[];
  error(): AppErrorInfo | undefined;
}

/** One bounded request at a time; seeking invalidates callbacks even if abort is ignored. */
export function createAudioPreloader(deps: {
  load(startMs: number, durationMs: number, signal: AbortSignal): Promise<YoutubePreloadResult>;
  onResult(result: YoutubePreloadResult): void;
  onChange(): void;
  aheadMs?: number;
}): AudioPreloader {
  let position = 0;
  let duration = 0;
  let paused = false;
  let disposed = false;
  let generation = 0;
  let current: { abort: AbortController; generation: number } | undefined;
  let coverage: TimeRange[] = [];
  let failure: AppErrorInfo | undefined;
  const ahead = deps.aheadMs ?? 45_000;

  function cancel() {
    generation++;
    current?.abort.abort();
    current = undefined;
  }
  function pump() {
    if (disposed || paused || current || failure || duration <= 0) return;
    const limit = Math.min(duration, position + ahead);
    let start = Math.floor(position);
    let gapEnd = duration;
    for (const range of coverage) {
      if (range.startMs > start + 1) {
        gapEnd = Math.min(gapEnd, range.startMs);
        break;
      }
      if (range.endMs > start) start = range.endMs;
    }
    if (start >= limit - 100 || start >= duration - 100) return;
    // Seeks may leave disjoint known ranges. Read only the actual gap, including
    // sub-second gaps, rather than re-recognizing an already transcribed range.
    const length = Math.max(1, Math.round(Math.min(20_000, gapEnd - start)));
    const operation = { abort: new AbortController(), generation };
    current = operation;
    void deps
      .load(start, length, operation.abort.signal)
      .then((result) => {
        if (disposed || paused || current !== operation || generation !== operation.generation)
          return;
        // onResult inserts every recognized cue before this range becomes playable.
        deps.onResult(result);
        const end = Math.min(duration, start + result.durationMs);
        if (end <= start) throw new Error('Audio preloader made no progress');
        coverage = mergeRanges([
          ...coverage,
          { startMs: start, endMs: duration - end < 100 ? duration : end },
        ]);
        // Retain bounded coverage for seeking; transcript data lives in the session repository.
        if (coverage.length > 200) coverage = coverage.slice(-200);
        current = undefined;
        deps.onChange();
        pump();
      })
      .catch((error) => {
        if (disposed || paused || current !== operation || generation !== operation.generation)
          return;
        current = undefined;
        failure = toAppErrorInfo(error, {
          code: 'audio-preload-failed',
          category: 'asr',
          message: '音频预读失败，请重试或切换为「连续播放」。',
        });
        deps.onChange();
      });
  }
  return {
    update(nextPosition, nextDuration, seek = false) {
      if (disposed) return;
      position = Math.max(0, nextPosition);
      duration = Math.max(0, nextDuration);
      if (seek) {
        cancel();
        failure = undefined;
      }
      pump();
    },
    pause() {
      paused = true;
      cancel();
    },
    resume() {
      if (disposed) return;
      paused = false;
      pump();
    },
    retry() {
      if (disposed) return;
      const wasFailed = !!failure;
      failure = undefined;
      if (wasFailed) deps.onChange();
      pump();
    },
    dispose() {
      disposed = true;
      cancel();
      coverage = [];
    },
    ranges: () => coverage,
    error: () => failure,
  };
}

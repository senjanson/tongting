import { mergeRanges, type TimeRange } from '../domain/cue';
import { AppError, toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import { PreloadRangeError, type YoutubePreloadResult } from '../providers/asr/youtube-preload';
import { isAutoRetryable, retryDelay } from './retry';

export interface AudioPreloader {
  update(positionMs: number, durationMs: number, seek?: boolean): void;
  pause(): void;
  resume(): void;
  retry(): void;
  dispose(): void;
  ranges(): readonly TimeRange[];
  error(): AppErrorInfo | undefined;
}

/**
 * 旧版服务只知道整秒时长，音轨也可能比播放器时长略短：这段结尾内的越界（416）或取不到音频
 * 视为读到结尾，而不是阻塞播放。离结尾更远的同类错误仍按失败处理。
 */
const END_TOLERANCE_MS = 2_000;
/** 模型加载、排队已满与网络抖动会自行恢复：连续失败超过次数、或要求等待过久才作为终止失败。 */
const MAX_AUTO_RETRIES = 5;
const MAX_RETRY_AFTER_MS = 60_000;
const RETRY_BACKOFF = { baseDelayMs: 1_000, maxDelayMs: 10_000 };

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
  // Consecutive retryable failures: reset by success, seek or explicit retry, not by pause.
  let retries = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const ahead = deps.aheadMs ?? 45_000;

  function clearRetryTimer() {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }
  /** Pausing, seeking and disposal also drop a pending retry; the next pump starts afresh. */
  function cancel() {
    generation++;
    current?.abort.abort();
    current = undefined;
    clearRetryTimer();
  }
  /** The server has no audio at or after startMs: nothing more can be read before the video ends. */
  function reachedEnd(startMs: number, error: unknown): boolean {
    if (error instanceof PreloadRangeError && error.mediaEndMs !== undefined)
      return startMs >= error.mediaEndMs;
    const code = error instanceof AppError ? error.info.code : undefined;
    return (
      (code === 'preload-range-unavailable' || code === 'preload-audio-failed') &&
      startMs >= duration - END_TOLERANCE_MS
    );
  }
  function cover(range: TimeRange) {
    coverage = mergeRanges([...coverage, range]);
    // Retain bounded coverage for seeking; transcript data lives in the session repository.
    if (coverage.length > 200) coverage = coverage.slice(-200);
    current = undefined;
    retries = 0;
    deps.onChange();
    pump();
  }
  function pump() {
    if (disposed || paused || current || failure || retryTimer !== undefined || duration <= 0)
      return;
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
    const stale = () =>
      disposed || paused || current !== operation || generation !== operation.generation;
    current = operation;
    void deps
      .load(start, length, operation.abort.signal)
      .then((result) => {
        if (stale()) return;
        // onResult inserts every recognized cue before this range becomes playable.
        deps.onResult(result);
        if (stale()) return;
        const end = Math.min(duration, start + result.durationMs);
        const atEnd = start >= duration - END_TOLERANCE_MS;
        if (end <= start && !atEnd) throw new Error('Audio preloader made no progress');
        cover({ startMs: start, endMs: end <= start || duration - end < 100 ? duration : end });
      })
      .catch((error) => {
        if (stale()) return;
        current = undefined;
        if (reachedEnd(start, error)) {
          cover({ startMs: start, endMs: duration });
          return;
        }
        const info = toAppErrorInfo(error, {
          code: 'audio-preload-failed',
          category: 'asr',
          message: '音频预读失败，请重试或切换为「连续播放」。',
        });
        if (
          isAutoRetryable(info) &&
          retries < MAX_AUTO_RETRIES &&
          (info.retryAfterMs ?? 0) <= MAX_RETRY_AFTER_MS
        ) {
          retries++;
          // Waiting is not a failure: the buffer stays in preparation. The timer only wakes pump(),
          // which plans the request from the latest position rather than replaying this one.
          retryTimer = setTimeout(
            () => {
              retryTimer = undefined;
              pump();
            },
            retryDelay(info, retries, RETRY_BACKOFF, Math.random),
          );
          return;
        }
        failure = info;
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
        retries = 0;
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
      retries = 0;
      clearRetryTimer();
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

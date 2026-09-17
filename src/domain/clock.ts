/**
 * 跨文档共享的 epoch 时钟。
 *
 * 页面、offscreen 文档、service worker 与扩展页面之间传递的时间戳（PlayerState.sampledAtEpochMs、
 * MediaAnchor.epochMs、捕获时间、配音调度的 now）一律使用本时钟：系统时间 Date.now() 基准的毫秒数。
 *
 * 不使用 `performance.timeOrigin + performance.now()`：不同文档各自的 performance 时钟在系统睡眠期间
 * （macOS/Linux）可能停走，长寿命文档还会逐渐漂移，跨文档比较会出现秒级到小时级偏差。
 *
 * 文档内部需要高精度相对时间（例如 AudioContext.getOutputTimestamp().performanceTime）时，
 * 用 perfToEpochMs 在转换时现测偏移，不缓存偏移量。
 */

export interface PerformanceLike {
  now(): number;
}

export interface EpochClockSource {
  dateNow(): number;
  performance: PerformanceLike;
}

const defaultSource: EpochClockSource = {
  dateNow: () => Date.now(),
  performance: globalThis.performance,
};

/** 当前 epoch 毫秒（跨文档可比较）。 */
export function epochNowMs(source: EpochClockSource = defaultSource): number {
  return source.dateNow();
}

/**
 * 把本文档的 performance 时间戳换算为 epoch 毫秒。偏移在调用时现测，
 * 因此睡眠或漂移后换算结果仍与其他文档的 epochNowMs 对齐（误差约 ±1 ms）。
 */
export function perfToEpochMs(perfMs: number, source: EpochClockSource = defaultSource): number {
  return source.dateNow() - source.performance.now() + perfMs;
}

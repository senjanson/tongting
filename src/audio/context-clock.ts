/**
 * AudioContext 时间 ↔ 跨文档 epoch 毫秒（Date.now() 基准，见 domain/clock.ts）换算。
 *
 * 不使用 performance.timeOrigin：文档的 performance 时钟可能在系统睡眠时停走或长期漂移。
 * getOutputTimestamp().performanceTime 用 perfToEpochMs 在采样时现测偏移换算。
 *
 * 换算：contextTime c 的样本在 performanceTime p 由输出设备播放，进入处理图约早 (baseLatency + outputLatency)：
 *   captureEpoch(t) ≈ perfToEpochMs(p) + (t − c) × 1000 − latency × 1000
 * 标签页 → offscreen 的捕获传输延迟未计入（P0 实测总误差约 +40 ms）。
 *
 * 偏移 = epoch − contextTime × 1000。小抖动用指数平滑；与当前偏移相差超过 resetThresholdMs（系统睡眠、
 * 设备切换、AudioContext 挂起恢复导致音频时钟停走）时直接重置到新值，不做平滑过渡。
 * AudioContext statechange 时调用 reset()，下一次采样重新建立偏移。
 */
import { perfToEpochMs, type EpochClockSource } from '../domain/clock';

export interface ContextClockSource {
  getOutputTimestamp?: () => { contextTime?: number; performanceTime?: number };
  currentTime: () => number;
  baseLatency?: () => number;
  outputLatency?: () => number;
  /** 可注入的 epoch/performance 时钟（测试用）；默认全局 Date.now 与 performance。 */
  clock?: EpochClockSource;
}

export interface ContextClock {
  sample(): void;
  reset(): void;
  contextTimeToEpochMs(contextTimeSec: number): number;
  epochMsToContextTime(epochMs: number): number;
  readonly source: 'output-timestamp' | 'current-time' | 'none';
  readonly offsetMs: number | undefined;
  /** 因偏移突变而重置的次数（诊断用）。 */
  readonly resets: number;
}

const defaultClock = (): EpochClockSource => ({
  dateNow: () => Date.now(),
  performance: globalThis.performance,
});

export function createContextClock(
  src: ContextClockSource,
  options: { smoothing?: number; resetThresholdMs?: number } = {},
): ContextClock {
  const alpha = options.smoothing ?? 0.1;
  const threshold = options.resetThresholdMs ?? 40;
  const clock = src.clock ?? defaultClock();
  let offset: number | undefined;
  let source: ContextClock['source'] = 'none';
  let resets = 0;

  const latencyMs = () => (safe(src.baseLatency?.()) + safe(src.outputLatency?.())) * 1000;

  const measure = ():
    { value: number; source: 'output-timestamp' | 'current-time' } | undefined => {
    const nowPerf = clock.performance.now();
    try {
      const ts = src.getOutputTimestamp?.();
      const c = ts?.contextTime;
      const p = ts?.performanceTime;
      if (
        typeof c === 'number' &&
        typeof p === 'number' &&
        c > 0 &&
        p > 0 &&
        Math.abs(nowPerf - p) < 1_000
      ) {
        return {
          value: perfToEpochMs(p, clock) - c * 1000 - latencyMs(),
          source: 'output-timestamp',
        };
      }
    } catch {
      // 回退
    }
    const ct = src.currentTime();
    if (typeof ct === 'number' && Number.isFinite(ct))
      return { value: clock.dateNow() - ct * 1000, source: 'current-time' };
    return undefined;
  };

  const api: ContextClock = {
    sample() {
      const m = measure();
      if (!m) return;
      if (source === 'output-timestamp' && m.source === 'current-time') return;
      if (offset === undefined || source !== m.source) {
        offset = m.value;
        source = m.source;
        return;
      }
      if (Math.abs(m.value - offset) > threshold) {
        offset = m.value;
        resets++;
        return;
      }
      offset += alpha * (m.value - offset);
    },
    reset() {
      offset = undefined;
      source = 'none';
    },
    contextTimeToEpochMs(t) {
      if (offset === undefined) api.sample();
      return (offset ?? clock.dateNow() - src.currentTime() * 1000) + t * 1000;
    },
    epochMsToContextTime(e) {
      if (offset === undefined) api.sample();
      return (e - (offset ?? clock.dateNow() - src.currentTime() * 1000)) / 1000;
    },
    get source() {
      return source;
    },
    get offsetMs() {
      return offset;
    },
    get resets() {
      return resets;
    },
  };
  return api;
}

function safe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
}

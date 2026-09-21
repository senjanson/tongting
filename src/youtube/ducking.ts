/**
 * 原声 ducking（player/duck）。
 *
 * - active=true：记住用户基准音量，设置 volume = 基准 × level，并记住自己设置的值；
 * - 混音期间用户调音量会交还控制；全程静音期间保存新基准并继续静音，结束后恢复新基准；
 * - active=false：只有音量仍等于自己设置的值时才恢复为用户最新基准，不用过时快照覆盖（T17）；
 * - 目标只认当前 video 元素；旧元素/已卸载页面上的迟到调用直接忽略，不抛异常（T40）。
 */

export interface VolumeTarget {
  volume: number;
}

export type DuckOutcome =
  | { applied: true; volume: number }
  | { applied: false; reason: 'stale-target' | 'not-active' | 'user-override' | 'error' };

export interface DuckController {
  /** 切换到新的 video 元素（或 null）；放弃旧元素上的 ducking 状态，不触碰旧元素。 */
  attach(target: VolumeTarget | null): void;
  duck(target: VolumeTarget, level: number): DuckOutcome;
  /** 会话持有原声缩放；结束朗读仍保留 originalVolume，release 才归还音量。 */
  configure(target: VolumeTarget, originalVolume: number, duckLevel: number): DuckOutcome;
  release(target: VolumeTarget): DuckOutcome;
  /** 在当前元素上结束 ducking（导航、会话结束、上下文失效时调用）。 */
  releaseCurrent(): DuckOutcome;
  onVolumeChange(target: VolumeTarget): void;
  readonly active: boolean;
  readonly baseVolume: number | undefined;
}

const EPSILON = 0.001;

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function createDuckController(): DuckController {
  let current: VolumeTarget | null = null;
  let active = false;
  let base: number | undefined;
  let applied: number | undefined;
  let holdSilence = false;
  /** 最近一次 ducking 被用户音量调整覆盖（release 时回报 user-override，便于 worker 感知）。 */
  let overridden = false;

  function readVolume(t: VolumeTarget): number | undefined {
    try {
      const v = t.volume;
      return Number.isFinite(v) ? v : undefined;
    } catch {
      return undefined;
    }
  }

  function release(target: VolumeTarget): DuckOutcome {
    if (target !== current) return { applied: false, reason: 'stale-target' };
    if (!active) {
      if (overridden) {
        overridden = false;
        return { applied: false, reason: 'user-override' };
      }
      return { applied: false, reason: 'not-active' };
    }
    active = false;
    holdSilence = false;
    const now = readVolume(target);
    if (now === undefined || applied === undefined) return { applied: false, reason: 'error' };
    if (Math.abs(now - applied) > EPSILON) {
      // 用户已改过音量（事件可能尚未派发）：保留用户的值。
      base = now;
      applied = undefined;
      return { applied: false, reason: 'user-override' };
    }
    try {
      target.volume = clamp01(base ?? now);
      applied = undefined;
      return { applied: true, volume: target.volume };
    } catch {
      return { applied: false, reason: 'error' };
    }
  }

  function configure(target: VolumeTarget, originalVolume: number, duckLevel: number): DuckOutcome {
    if (target !== current) return { applied: false, reason: 'stale-target' };
    const now = readVolume(target);
    if (now === undefined) return { applied: false, reason: 'error' };
    if (!active || applied === undefined || Math.abs(now - applied) > EPSILON) base = now;
    try {
      overridden = false;
      target.volume = clamp01((base ?? now) * clamp01(originalVolume) * clamp01(duckLevel));
      applied = target.volume;
      active = true;
      holdSilence = originalVolume === 0;
      return { applied: true, volume: applied };
    } catch {
      return { applied: false, reason: 'error' };
    }
  }

  return {
    get active() {
      return active;
    },
    get baseVolume() {
      return base;
    },
    attach(target) {
      if (target === current) return;
      current = target;
      active = false;
      holdSilence = false;
      overridden = false;
      base = undefined;
      applied = undefined;
    },
    duck(target, level) {
      return configure(target, 1, level);
    },
    configure,
    release,
    releaseCurrent() {
      return current ? release(current) : { applied: false, reason: 'not-active' };
    },
    onVolumeChange(target) {
      if (target !== current || !active || applied === undefined) return;
      const now = readVolume(target);
      if (now === undefined) return;
      if (Math.abs(now - applied) > EPSILON) {
        base = now;
        if (holdSilence) {
          // 记住播放器的新音量以便停止后恢复；同传期间不能让它恢复外语声音。
          try {
            target.volume = 0;
            applied = target.volume;
            return;
          } catch {
            // 无法继续控制时交还音量，不阻止页面处理自己的事件。
          }
        }
        active = false;
        applied = undefined;
        overridden = true;
      }
    },
  };
}

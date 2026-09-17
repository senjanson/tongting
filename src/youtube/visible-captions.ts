/**
 * 当前显示字幕观察器（增量来源）：只在启用时观察播放器子树中 .ytp-caption-window-container 的变化，
 * 合并短时间内的多次 DOM 变化后读取文本；文本变化（包括清空）才回调。
 */
import { YT_SELECTORS, readVisibleCaptionText } from './selectors';

export interface VisibleCaptionObserverOptions {
  /** heartbeat=true 表示文本未变化的定期重报（让组装器判断稳定并延长结束时间）。 */
  onText(text: string, info: { heartbeat: boolean }): void;
  /** 文本非空时的心跳间隔；0 表示关闭。 */
  heartbeatMs?: number;
  setInterval?(fn: () => void, ms: number): unknown;
  clearInterval?(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  createObserver?(cb: MutationCallback): MutationObserver;
  coalesceMs?: number;
}

export interface VisibleCaptionObserver {
  readonly enabled: boolean;
  enable(root: HTMLElement | null): void;
  disable(): void;
  /** 播放器根节点变化时调用（启用状态下重新绑定）。 */
  setRoot(root: HTMLElement | null): void;
  /** 当前是否能看到原生字幕容器及文本。 */
  snapshot(): { present: boolean; text: string };
  dispose(): void;
}

export function createVisibleCaptionObserver(
  opts: VisibleCaptionObserverOptions,
): VisibleCaptionObserver {
  const coalesceMs = opts.coalesceMs ?? 60;
  const heartbeatMs = opts.heartbeatMs ?? 300;
  let heartbeat: unknown;
  let enabled = false;
  let root: HTMLElement | null = null;
  let observer: MutationObserver | null = null;
  let timer: unknown;
  let lastText: string | undefined;

  const read = () => {
    timer = undefined;
    if (!enabled) return;
    const { text } = readVisibleCaptionText(root);
    if (text === lastText) return;
    lastText = text;
    opts.onText(text, { heartbeat: false });
  };

  const beat = () => {
    if (!enabled || !lastText) return;
    const { text } = readVisibleCaptionText(root);
    if (text !== lastText) {
      read();
      return;
    }
    opts.onText(text, { heartbeat: true });
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = opts.setTimeout(read, coalesceMs);
  };

  const relevant = (records: MutationRecord[]) =>
    records.some((r) => {
      const node = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
      if (node?.closest(YT_SELECTORS.captionWindowContainer)) return true;
      for (const n of [...r.addedNodes, ...r.removedNodes]) {
        if (
          n.nodeType === 1 &&
          ((n as Element).matches(YT_SELECTORS.captionWindowContainer) ||
            (n as Element).querySelector(YT_SELECTORS.captionWindowContainer))
        ) {
          return true;
        }
      }
      return false;
    });

  const unbind = () => {
    observer?.disconnect();
    observer = null;
    if (heartbeat !== undefined)
      (opts.clearInterval ?? ((id) => clearInterval(id as number)))(heartbeat);
    heartbeat = undefined;
    if (timer !== undefined) opts.clearTimeout(timer);
    timer = undefined;
  };

  const bind = () => {
    unbind();
    if (!enabled || !root) return;
    const create = opts.createObserver ?? ((cb: MutationCallback) => new MutationObserver(cb));
    observer = create((records) => {
      if (relevant(records)) schedule();
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    if (heartbeatMs > 0) {
      heartbeat = (opts.setInterval ?? ((fn, ms) => setInterval(fn, ms)))(beat, heartbeatMs);
    }
    schedule();
  };

  return {
    get enabled() {
      return enabled;
    },
    enable(nextRoot) {
      root = nextRoot;
      if (enabled) {
        bind();
        return;
      }
      enabled = true;
      lastText = undefined;
      bind();
    },
    disable() {
      enabled = false;
      lastText = undefined;
      unbind();
    },
    setRoot(nextRoot) {
      if (nextRoot === root) return;
      root = nextRoot;
      if (enabled) bind();
    },
    snapshot() {
      return readVisibleCaptionText(root);
    },
    dispose() {
      enabled = false;
      unbind();
      root = null;
    },
  };
}

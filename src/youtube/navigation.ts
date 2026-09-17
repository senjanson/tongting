/**
 * YouTube SPA 导航识别。
 *
 * 信号：yt-navigate-start / yt-navigate-finish / yt-page-data-updated、popstate、URL 轮询兜底。
 * - navigationId 在内容脚本内单调递增；视频身份（kind + videoId）变化一定产生新导航，A→B→A 的第二个 A 也是新导航；
 * - 同一视频重新进入（点击当前视频）：有 yt-navigate-start 在先的 yt-navigate-finish 产生新导航；
 * - 重复事件合并：兜底来源（轮询/popstate/page-data）已提交的导航，随后到达的 finish 只「认领」不再新建；
 *   没有 start 的重复 finish、同身份的 page-data/轮询事件都合并。
 */
import { parseYoutubeUrl, type PageKind } from './video-id';
import { YT_EVENTS } from './selectors';

export type NavigationSource =
  'init' | 'yt-navigate-finish' | 'yt-page-data-updated' | 'popstate' | 'poll';

export interface NavigationState {
  navigationId: number;
  url: string;
  videoId: string | null;
  kind: PageKind;
  source: NavigationSource;
}

export interface NavigationTracker {
  readonly current: NavigationState;
  markNavigateStart(): void;
  /** 返回新导航；被合并时返回 null。 */
  observe(url: string, source: Exclude<NavigationSource, 'init'>): NavigationState | null;
}

/** 兜底来源提交后，这段时间内到达的 finish 视为同一次导航。 */
export const FINISH_CLAIM_WINDOW_MS = 3_000;
/** yt-navigate-start 之后超过该时间仍未 finish，视为已放弃。 */
export const START_EXPIRY_MS = 30_000;

export function createNavigationTracker(
  initialUrl: string,
  now: () => number = Date.now,
): NavigationTracker {
  let nextId = 1;
  let committedAt = now();
  let claimedByFinish = false;
  let pendingStartAt: number | undefined;

  const identity = (s: { kind: PageKind; videoId: string | null }) =>
    `${s.kind}:${s.videoId ?? ''}`;

  const commit = (url: string, source: NavigationSource): NavigationState => {
    const info = parseYoutubeUrl(url);
    current = { navigationId: nextId++, url, videoId: info.videoId, kind: info.kind, source };
    committedAt = now();
    claimedByFinish = source === 'yt-navigate-finish';
    return current;
  };

  let current: NavigationState = {
    navigationId: 0,
    url: initialUrl,
    videoId: null,
    kind: 'other',
    source: 'init',
  };
  commit(initialUrl, 'init');

  return {
    get current() {
      return current;
    },
    markNavigateStart() {
      pendingStartAt = now();
    },
    observe(url, source) {
      const info = parseYoutubeUrl(url);
      const sameIdentity = identity(info) === identity(current);
      if (source === 'yt-navigate-finish') {
        const hadStart = pendingStartAt !== undefined && now() - pendingStartAt <= START_EXPIRY_MS;
        pendingStartAt = undefined;
        if (!sameIdentity) return commit(url, source);
        if (!hadStart) {
          claimedByFinish = true;
          return null; // 重复 finish
        }
        if (!claimedByFinish && now() - committedAt <= FINISH_CLAIM_WINDOW_MS) {
          // 兜底来源已提交这次导航（例如 popstate 或轮询先看到 URL 变化）。
          claimedByFinish = true;
          return null;
        }
        return commit(url, source); // 同一视频重新进入
      }
      if (!sameIdentity) return commit(url, source);
      return null;
    },
  };
}

export interface NavigationWatcherOptions {
  win: Window;
  doc: Document;
  tracker: NavigationTracker;
  onNavigate(state: NavigationState): void;
  pollMs?: number;
}

/** 绑定页面导航事件；返回释放函数（可重复调用）。 */
export function watchNavigation(opts: NavigationWatcherOptions): () => void {
  const { win, doc, tracker, onNavigate } = opts;
  const ac = new AbortController();
  const signal = ac.signal;
  const observe = (source: Exclude<NavigationSource, 'init'>) => {
    if (signal.aborted) return;
    const nav = tracker.observe(win.location.href, source);
    if (nav) onNavigate(nav);
  };
  doc.addEventListener(YT_EVENTS.navigateStart, () => tracker.markNavigateStart(), { signal });
  doc.addEventListener(YT_EVENTS.navigateFinish, () => observe('yt-navigate-finish'), { signal });
  doc.addEventListener(YT_EVENTS.pageDataUpdated, () => observe('yt-page-data-updated'), {
    signal,
  });
  win.addEventListener('popstate', () => observe('popstate'), { signal });
  let lastHref = win.location.href;
  const timer = win.setInterval(() => {
    const href = win.location.href;
    if (href === lastHref) return;
    lastHref = href;
    observe('poll');
  }, opts.pollMs ?? 500);
  return () => {
    ac.abort();
    win.clearInterval(timer);
  };
}

/**
 * YouTube 页面结构的集中封装。选择器、class 名与事件名都只在这里出现，页面改版时只改此文件。
 *
 * 以下均基于公开可见的页面结构整理，尚未在当前环境中对真实 YouTube 页面核对（youtube.com 不可达）。
 */
import type { PageKind } from './video-id';

export const YT_SELECTORS = {
  /** 普通观看页/直播页播放器根节点（同时带 .html5-video-player）。 */
  watchPlayer: '#movie_player',
  /** Shorts 当前激活的播放器。 */
  shortsPlayer: 'ytd-reel-video-renderer[is-active] #shorts-player',
  shortsPlayerFallback: '#shorts-player',
  genericPlayer: '.html5-video-player',
  mainVideo: 'video.html5-main-video',
  anyVideo: 'video',
  captionWindowContainer: '.ytp-caption-window-container',
  captionVisualLine: '.caption-visual-line',
  captionSegment: '.ytp-caption-segment',
  chromeBottom: '.ytp-chrome-bottom',
} as const;

export const YT_PLAYER_CLASSES = {
  /** 广告播放中（主内容被广告替换）。 */
  adShowing: 'ad-showing',
  adInterrupting: 'ad-interrupting',
  /** 控制栏已自动隐藏。 */
  autohide: 'ytp-autohide',
  fullscreen: 'ytp-fullscreen',
} as const;

export const YT_EVENTS = {
  navigateStart: 'yt-navigate-start',
  navigateFinish: 'yt-navigate-finish',
  pageDataUpdated: 'yt-page-data-updated',
} as const;

/** 同听写入页面 DOM 的属性，仅用于限定作用域的样式与去重。 */
export const TT_ATTRS = {
  hideNative: 'data-tongting-hide-native',
  overlayHost: 'data-tongting-overlay',
  nativeStyle: 'data-tongting-native-style',
} as const;

export function findPlayerRoot(doc: Document, kind: PageKind): HTMLElement | null {
  const selectors =
    kind === 'shorts'
      ? [YT_SELECTORS.shortsPlayer, YT_SELECTORS.shortsPlayerFallback]
      : [YT_SELECTORS.watchPlayer];
  for (const sel of selectors) {
    const el = doc.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

export function findVideo(root: Element): HTMLVideoElement | null {
  return (
    root.querySelector<HTMLVideoElement>(YT_SELECTORS.mainVideo) ??
    root.querySelector<HTMLVideoElement>(YT_SELECTORS.anyVideo)
  );
}

export function isAdShowing(root: Element | null): boolean {
  if (!root) return false;
  return (
    root.classList.contains(YT_PLAYER_CLASSES.adShowing) ||
    root.classList.contains(YT_PLAYER_CLASSES.adInterrupting)
  );
}

export function areControlsHidden(root: Element | null): boolean {
  return !!root && root.classList.contains(YT_PLAYER_CLASSES.autohide);
}

export function isPlayerFullscreen(doc: Document, root: Element | null): boolean {
  if (!root) return false;
  const fs = doc.fullscreenElement;
  if (fs && (fs === root || fs.contains(root) || root.contains(fs))) return true;
  return root.classList.contains(YT_PLAYER_CLASSES.fullscreen);
}

/** 读取当前可见的原生字幕文本：按可视行拼接，行间以换行分隔。 */
export function readVisibleCaptionText(root: Element | null): { text: string; present: boolean } {
  if (!root) return { text: '', present: false };
  const container = root.querySelector(YT_SELECTORS.captionWindowContainer);
  if (!container) return { text: '', present: false };
  const lines = container.querySelectorAll(YT_SELECTORS.captionVisualLine);
  const out: string[] = [];
  if (lines.length) {
    for (const line of lines) {
      const segs = line.querySelectorAll(YT_SELECTORS.captionSegment);
      const text = segs.length
        ? Array.from(segs, (s) => s.textContent ?? '').join('')
        : (line.textContent ?? '');
      if (text.trim()) out.push(text);
    }
  } else {
    for (const seg of container.querySelectorAll(YT_SELECTORS.captionSegment)) {
      const text = seg.textContent ?? '';
      if (text.trim()) out.push(text);
    }
  }
  return { text: out.join('\n').slice(0, 2_000), present: true };
}

export function chromeBottomHeight(root: Element | null): number {
  const el = root?.querySelector<HTMLElement>(YT_SELECTORS.chromeBottom);
  const h = el?.offsetHeight ?? 0;
  return Number.isFinite(h) && h > 0 && h < 400 ? h : 48;
}

/**
 * 限定作用域地隐藏 YouTube 原生字幕层：只在播放器根节点加 data 属性，样式规则只匹配带该属性的子树。
 * 使用 visibility:hidden，DOM 文本仍可被「当前显示字幕」观察器读取。不修改 YouTube 自身样式或 class。
 */
import { TT_ATTRS, YT_SELECTORS } from './selectors';

export interface NativeCaptionHider {
  set(root: Element | null, hidden: boolean): void;
  readonly hiddenRoot: Element | null;
  dispose(): void;
}

export function createNativeCaptionHider(doc: Document): NativeCaptionHider {
  let style: HTMLStyleElement | null = null;
  let hiddenRoot: Element | null = null;

  const ensureStyle = () => {
    if (style?.isConnected) return;
    style = doc.createElement('style');
    style.setAttribute(TT_ATTRS.nativeStyle, '');
    style.textContent = `[${TT_ATTRS.hideNative}] ${YT_SELECTORS.captionWindowContainer}{visibility:hidden !important;}`;
    (doc.head ?? doc.documentElement).appendChild(style);
  };

  const clear = () => {
    try {
      hiddenRoot?.removeAttribute(TT_ATTRS.hideNative);
    } catch {
      /* 节点可能已被移除 */
    }
    hiddenRoot = null;
  };

  return {
    get hiddenRoot() {
      return hiddenRoot;
    },
    set(root, hidden) {
      if (!hidden || !root) {
        clear();
        return;
      }
      if (hiddenRoot !== root) clear();
      ensureStyle();
      root.setAttribute(TT_ATTRS.hideNative, '');
      hiddenRoot = root;
    },
    dispose() {
      clear();
      style?.remove();
      style = null;
    },
  };
}

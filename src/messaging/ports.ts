import type { Browser } from 'wxt/browser';

export const PORT_CONTENT = 'tongting:content';
export const PORT_UI = 'tongting:ui';
export const PORT_OFFSCREEN = 'tongting:offscreen';

/** 受信任的扩展页面（打包后路径）。 */
export const TRUSTED_UI_PAGES = [
  '/popup.html',
  '/sidepanel.html',
  '/options.html',
  '/workspace.html',
] as const;
export const OFFSCREEN_PAGE = '/offscreen.html';

export const YOUTUBE_ORIGINS = ['https://www.youtube.com', 'https://m.youtube.com'] as const;
export const CONTENT_SCRIPT_ORIGINS = ['https://www.youtube.com'] as const;

export type SenderKind = 'content' | 'ui' | 'offscreen';

export interface VerifiedContentSender {
  kind: 'content';
  tabId: number;
  frameId: number;
  documentId: string | undefined;
  url: string;
}
export interface VerifiedExtensionSender {
  kind: 'ui' | 'offscreen';
  path: string;
  tabId: number | undefined;
}

/**
 * 根据 MessageSender 判定发送方身份。payload 自报的信息不可信；返回 null 表示拒绝。
 */
export function verifySender(
  sender: Browser.runtime.MessageSender | undefined,
  expected: SenderKind,
  runtimeId: string,
  extensionOrigin: string,
): VerifiedContentSender | VerifiedExtensionSender | null {
  if (!sender || sender.id !== runtimeId || !sender.url) return null;
  let url: URL;
  try {
    url = new URL(sender.url);
  } catch {
    return null;
  }
  if (expected === 'content') {
    if (!(CONTENT_SCRIPT_ORIGINS as readonly string[]).includes(url.origin)) return null;
    if (sender.tab?.id === undefined || sender.tab.id < 0) return null;
    if (sender.frameId !== 0) return null;
    return {
      kind: 'content',
      tabId: sender.tab.id,
      frameId: sender.frameId,
      documentId: sender.documentId,
      url: sender.url,
    };
  }
  // 非特殊 scheme 的 URL.origin 在部分运行时为 "null"，因此比较 protocol + host。
  if (`${url.protocol}//${url.host}` !== extensionOrigin.replace(/\/$/, '')) return null;
  if (expected === 'offscreen') {
    if (url.pathname !== OFFSCREEN_PAGE) return null;
    return { kind: 'offscreen', path: url.pathname, tabId: undefined };
  }
  if (!(TRUSTED_UI_PAGES as readonly string[]).includes(url.pathname)) return null;
  return { kind: 'ui', path: url.pathname, tabId: sender.tab?.id };
}

export function randomId(prefix = ''): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

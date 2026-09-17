/**
 * 唤醒消息：service worker 被浏览器回收后，内容脚本按需重连端口，可能长时间不重连。
 * 扩展页面（侧栏、弹窗）或 worker 可用 chrome.tabs.sendMessage(tabId, { type: CONTENT_WAKE_MESSAGE_TYPE })
 * 请求该标签页的内容脚本立即重连并重放页面状态。
 *
 * 内容脚本只接受 sender.id === runtime.id 且没有 sender.tab（来自扩展页面或 worker）的唤醒消息；
 * 唤醒不携带任何数据，也不能触发除「重连并上报当前状态」以外的行为。
 *
 * offscreen 另有自己的唤醒消息（见 src/audio/offscreen/wake.ts），UI 与内容脚本应忽略它。
 */
export const CONTENT_WAKE_MESSAGE_TYPE = 'tongting:content-wake';

export interface ContentWakeMessage {
  type: typeof CONTENT_WAKE_MESSAGE_TYPE;
}

export function isContentWakeMessage(message: unknown): message is ContentWakeMessage {
  return (
    !!message &&
    typeof message === 'object' &&
    (message as { type?: unknown }).type === CONTENT_WAKE_MESSAGE_TYPE &&
    Object.keys(message).length === 1
  );
}

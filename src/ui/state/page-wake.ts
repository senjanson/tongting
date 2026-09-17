/**
 * 唤醒当前标签页的内容脚本。
 *
 * worker 被回收后内容脚本可能不会立即重连，快照里就没有该标签页。侧栏/弹窗确定活动标签页后，
 * 若快照中没有该 tabId，发送唤醒消息（按标签页节流），并在短时间内显示「正在连接页面…」，
 * 而不是立即判定为非 YouTube 页面。不读取标签页 URL，不依赖 tabs 权限。
 *
 * 新打开的标签页在激活时页面尚未加载、内容脚本还不存在，第一次唤醒必然没有接收方：
 * 标签页加载完成（tabs.onUpdated status=complete，无需 tabs 权限）时再唤醒一次，
 * 并在页面仍未登记期间按固定间隔有限次重试。
 */
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { CONTENT_WAKE_MESSAGE_TYPE } from '../../messaging/wake';

export const WAKE_THROTTLE_MS = 5_000;
export const WAKE_GRACE_MS = 1_500;
export const WAKE_RETRY_INTERVAL_MS = 2_000;
export const WAKE_RETRY_LIMIT = 8;

const lastWakeAt = new Map<number, number>();

export function resetPageWakeForTests(): void {
  lastWakeAt.clear();
}

/** 发送唤醒；节流期内返回 false。「无接收方」等错误被忽略。 */
export function wakeTab(tabId: number, now = Date.now()): boolean {
  const last = lastWakeAt.get(tabId);
  if (last !== undefined && now - last < WAKE_THROTTLE_MS) return false;
  lastWakeAt.set(tabId, now);
  Promise.resolve()
    .then(() => browser.tabs.sendMessage(tabId, { type: CONTENT_WAKE_MESSAGE_TYPE }))
    .catch(() => undefined);
  return true;
}

/**
 * @param tabId 当前活动标签页
 * @param hasPage 快照中是否已有该标签页
 * @param enabled 已连接 worker 且处于真实模式
 * @returns 是否处于唤醒后的等待期
 */
export function usePageWake(
  tabId: number | undefined,
  hasPage: boolean,
  enabled: boolean,
): boolean {
  const [waitingTab, setWaitingTab] = useState<number | null>(null);

  useEffect(() => {
    if (!enabled || tabId === undefined || hasPage) return undefined;
    const now = Date.now();
    wakeTab(tabId, now);
    // 页面加载完成或定时重试时绕过节流（次数有界）。
    const forceWake = () => {
      lastWakeAt.delete(tabId);
      wakeTab(tabId);
    };
    let retries = 0;
    const retryTimer = setInterval(() => {
      if (++retries > WAKE_RETRY_LIMIT) {
        clearInterval(retryTimer);
        return;
      }
      forceWake();
    }, WAKE_RETRY_INTERVAL_MS);
    const onUpdated = (updatedId: number, change: { status?: string }) => {
      if (updatedId === tabId && change.status === 'complete') forceWake();
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    // 节流期内（包括 React 严格模式的重复执行）仍按最近一次唤醒计算剩余等待时间。
    const remaining = WAKE_GRACE_MS - (now - (lastWakeAt.get(tabId) ?? now));
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (remaining > 0) {
      queueMicrotask(() => {
        if (!cancelled) setWaitingTab(tabId);
      });
      timer = setTimeout(() => {
        if (!cancelled) setWaitingTab((current) => (current === tabId ? null : current));
      }, remaining);
    }
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearInterval(retryTimer);
      browser.tabs.onUpdated.removeListener(onUpdated);
      setWaitingTab((current) => (current === tabId ? null : current));
    };
  }, [tabId, hasPage, enabled]);

  return enabled && !hasPage && tabId !== undefined && waitingTab === tabId;
}

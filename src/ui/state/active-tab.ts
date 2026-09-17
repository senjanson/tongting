/**
 * 当前窗口的活动标签页（侧栏与弹窗使用）。
 * 不依赖 tabs 权限：URL 可能拿不到，页面身份以 worker 快照中的 pages 为准。
 */
import { useEffect, useState } from 'react';
import { browser, type Browser } from 'wxt/browser';
import type { ActiveTabInfo } from './derive';

export interface ActiveTabState {
  tab: ActiveTabInfo | null;
  loading: boolean;
}

function toInfo(tab: Browser.tabs.Tab | undefined): ActiveTabInfo | null {
  if (!tab || tab.id === undefined || tab.id < 0) return null;
  return { tabId: tab.id, windowId: tab.windowId, url: tab.url, title: tab.title };
}

export function useActiveTab(): ActiveTabState {
  const [state, setState] = useState<ActiveTabState>({ tab: null, loading: true });

  useEffect(() => {
    let disposed = false;
    let seq = 0;
    let windowId: number | undefined;
    let tabId: number | undefined;

    const refresh = async () => {
      const mine = ++seq;
      try {
        const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
        if (disposed || mine !== seq) return;
        const info = toInfo(tab);
        windowId = info?.windowId ?? windowId;
        tabId = info?.tabId;
        setState({ tab: info, loading: false });
      } catch {
        if (disposed || mine !== seq) return;
        tabId = undefined;
        setState({ tab: null, loading: false });
      }
    };

    const onActivated = (info: { tabId: number; windowId: number }) => {
      if (windowId === undefined || info.windowId === windowId) void refresh();
    };
    const onUpdated = (
      updatedId: number,
      change: { url?: string; title?: string; status?: string },
    ) => {
      if (
        updatedId === tabId &&
        (change.url !== undefined || change.title !== undefined || change.status !== undefined)
      ) {
        void refresh();
      }
    };
    const onRemoved = (removedId: number) => {
      if (removedId === tabId) void refresh();
    };

    browser.tabs.onActivated.addListener(onActivated);
    browser.tabs.onUpdated.addListener(onUpdated);
    browser.tabs.onRemoved.addListener(onRemoved);
    void refresh();
    return () => {
      disposed = true;
      browser.tabs.onActivated.removeListener(onActivated);
      browser.tabs.onUpdated.removeListener(onUpdated);
      browser.tabs.onRemoved.removeListener(onRemoved);
    };
  }, []);

  return state;
}

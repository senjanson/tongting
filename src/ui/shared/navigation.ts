/**
 * 打开扩展页面与标签页操作。失败时抛出，由调用方提示。
 */
import { browser } from 'wxt/browser';

export async function openOptionsPage(): Promise<void> {
  await browser.runtime.openOptionsPage();
}

export function workspaceUrl(videoId?: string): string {
  const base = browser.runtime.getURL('/workspace.html');
  return videoId ? `${base}?videoId=${encodeURIComponent(videoId)}` : base;
}

export async function openWorkspace(videoId?: string): Promise<void> {
  await browser.tabs.create({ url: workspaceUrl(videoId) });
}

export async function openSidepanelDemoTab(): Promise<void> {
  await browser.tabs.create({ url: `${browser.runtime.getURL('/sidepanel.html')}?demo=1` });
}

export async function reloadTab(tabId: number): Promise<void> {
  await browser.tabs.reload(tabId);
}

export async function focusTab(tabId: number): Promise<void> {
  const tab = await browser.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
}

export async function openShortcutSettings(): Promise<void> {
  await browser.tabs.create({ url: 'chrome://extensions/shortcuts' });
}

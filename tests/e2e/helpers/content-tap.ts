/**
 * 内容脚本端口的被动观察器（只读）。
 *
 * 在真实 service worker 中额外注册一个 runtime.onConnect 监听器：Chrome 把同一个 Port 对象分发给所有监听器，
 * 真实协调器照常处理连接、回复与会话；这里只给 tongting:content 端口追加 onMessage/onDisconnect 监听并记录
 * 内容脚本 → worker 的消息，不回复、不发送、不断开，也不替换任何产品逻辑。
 * worker 被终止后全局变量丢失，观察器随之失效（需在新 worker 中重新安装）。
 */
import type { Worker } from '@playwright/test';

/** Playwright Worker，或 helpers/cdp.ts 的 cdpEvaluator（worker 重启后 Playwright 不再提供句柄时使用）。 */
export type SwEval = <R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A) => Promise<R>;
export type SwTarget = Worker | SwEval;

function evalIn(target: SwTarget): SwEval {
  if (typeof target === 'function') return target;
  // Worker.evaluate 的重载按参数是否存在区分；这里统一按「带一个参数」调用（undefined 参数等价于无参数）。
  const evaluate = target.evaluate.bind(target) as unknown as <R, A>(
    fn: (arg: A) => R | Promise<R>,
    arg: A,
  ) => Promise<R>;
  return <R, A>(fn: (arg: A) => R | Promise<R>, arg?: A) => evaluate<R, A>(fn, arg as A);
}

export type TapMessage = Record<string, unknown> & {
  type: string;
  __conn: number;
  __at: number;
  __frameId?: number;
  __tabId?: number;
};

export interface TapState {
  connects: number;
  disconnects: number;
  messages: TapMessage[];
}

export async function installContentTap(sw: SwTarget): Promise<void> {
  await evalIn(sw)(() => {
    const g = globalThis as unknown as { __e2eTap?: TapState };
    if (g.__e2eTap) return;
    const tap: TapState = { connects: 0, disconnects: 0, messages: [] };
    g.__e2eTap = tap;
    type P = {
      name: string;
      sender?: { frameId?: number; tab?: { id?: number } };
      onMessage: { addListener(cb: (m: Record<string, unknown>) => void): void };
      onDisconnect: { addListener(cb: () => void): void };
    };
    const runtime = (
      globalThis as unknown as {
        chrome: { runtime: { onConnect: { addListener(cb: (port: P) => void): void } } };
      }
    ).chrome.runtime;
    runtime.onConnect.addListener((port) => {
      if (port.name !== 'tongting:content') return;
      const conn = tap.connects++;
      port.onMessage.addListener((m) => {
        tap.messages.push({
          ...(m as { type: string }),
          __conn: conn,
          __at: Date.now(),
          __frameId: port.sender?.frameId,
          __tabId: port.sender?.tab?.id,
        });
        if (tap.messages.length > 5_000) tap.messages.splice(0, 1_000);
      });
      port.onDisconnect.addListener(() => {
        tap.disconnects++;
      });
    });
  });
}

export async function tapState(sw: SwTarget): Promise<TapState> {
  return evalIn(sw)(() => (globalThis as unknown as { __e2eTap: TapState }).__e2eTap);
}

export async function tapMessages(sw: SwTarget): Promise<TapMessage[]> {
  return (await tapState(sw)).messages;
}

/** 从扩展 worker 发送产品定义的唤醒消息（与侧栏/弹窗、协调器 wakePage 使用的消息相同）。 */
export async function wakeContent(sw: SwTarget, tabId: number): Promise<void> {
  await evalIn(sw)(
    (id) =>
      (
        globalThis as unknown as {
          chrome: { tabs: { sendMessage(id: number, m: unknown): Promise<unknown> } };
        }
      ).chrome.tabs
        .sendMessage(id, { type: 'tongting:content-wake' })
        .then(
          () => undefined,
          () => undefined,
        ),
    tabId,
  );
}

/** 当前活动标签页 ID（调用前先 page.bringToFront()；不需要 tabs 权限读取 URL）。 */
export async function activeTabId(sw: SwTarget): Promise<number> {
  return evalIn(sw)(async () => {
    const tabs = (
      globalThis as unknown as {
        chrome: {
          tabs: { query(q: object): Promise<Array<{ id?: number }>> };
        };
      }
    ).chrome.tabs;
    const [tab] = await tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id === undefined) throw new Error('no active tab');
    return tab.id;
  });
}

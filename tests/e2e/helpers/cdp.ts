/**
 * 通过 --remote-debugging-port 的 CDP 端点在任意目标中求值（只读诊断用）。
 *
 * Playwright 不会为被终止后重新启动的扩展 service worker 提供新的 Worker 句柄，也不暴露 offscreen 文档，
 * 因此这两类目标用 /json/list + WebSocket Runtime.evaluate 访问。
 */
import { createServer } from 'node:net';

export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export async function cdpTargets(port: number): Promise<CdpTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return (await res.json()) as CdpTarget[];
}

/** 在第一个匹配的目标中求值表达式（自动 await Promise），返回 JSON 值；找不到目标时返回 { __noTarget: true }。 */
export async function cdpEvaluate<T = unknown>(
  port: number,
  match: (t: CdpTarget) => boolean,
  expression: string,
  timeoutMs = 15_000,
): Promise<T> {
  const target = (await cdpTargets(port)).find((t) => match(t) && t.webSocketDebuggerUrl);
  if (!target) return { __noTarget: true } as T;
  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`CDP evaluate timeout (${target.url})`)),
        timeoutMs,
      );
      ws.onmessage = (m) => {
        const data = JSON.parse(String(m.data)) as {
          id?: number;
          result?: {
            result?: { value?: unknown };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          };
          error?: { message?: string };
        };
        if (data.id !== 1) return;
        clearTimeout(timer);
        if (data.error) return reject(new Error(data.error.message));
        const ex = data.result?.exceptionDetails;
        if (ex) return reject(new Error(ex.exception?.description ?? ex.text ?? 'evaluate failed'));
        resolve(data.result?.result?.value as T);
      };
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  } finally {
    ws.close();
  }
}

/** 与 Playwright evaluate 相同的调用形式：把函数源码与 JSON 参数拼成表达式。 */
export function cdpEvaluator(port: number, match: (t: CdpTarget) => boolean) {
  return <R, A = undefined>(fn: (arg: A) => R | Promise<R>, arg?: A): Promise<R> =>
    cdpEvaluate<R>(
      port,
      match,
      `(${fn.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`,
    );
}

export const isExtensionWorker = (extensionId: string) => (t: CdpTarget) =>
  t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extensionId}/`);

export const isOffscreen = (extensionId: string) => (t: CdpTarget) =>
  t.url === `chrome-extension://${extensionId}/offscreen.html`;

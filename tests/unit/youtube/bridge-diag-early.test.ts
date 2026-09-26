// @vitest-environment happy-dom
/**
 * MAIN world 桥的诊断记录：内容脚本（document_idle）就绪前产生的记录先暂存，
 * 收到内容脚本的第一条消息后补发（标记 early），之后不再重复补发。
 */
import { describe, expect, it } from 'vitest';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';

type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;
const A = 'AAAAAAAAAAA';
const posted: Array<Record<string, unknown>> = [];

const proxy: HappyWindow = new Proxy(realWin, {
  get(target, prop) {
    if (prop === 'postMessage') {
      return (data: unknown) => {
        const d = structuredClone(data) as Record<string, unknown>;
        if (d.dir === 'to-isolated') posted.push(d);
        else
          setTimeout(
            () =>
              target.dispatchEvent(
                new target.MessageEvent('message', { data: d, source: proxy as unknown as Window }),
              ),
            0,
          );
      };
    }
    const v = Reflect.get(target, prop, target);
    return typeof v === 'function' && typeof prop === 'string' && /^[a-z]/.test(prop)
      ? v.bind(target)
      : v;
  },
  set: (target, prop, value) => Reflect.set(target, prop, value, target),
});

realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
realWin.fetch = (async () => new realWin.Response('', { status: 200 })) as unknown as typeof fetch;
installMainWorldBridge(proxy);

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const send = (msg: Record<string, unknown>) =>
  proxy.postMessage({ __tongting: BRIDGE_TAG, dir: 'to-main', ...msg }, 'https://www.youtube.com');
const diagLogs = () =>
  posted.filter((m) => m.type === 'diag' && m.event === 'timedtext.response') as Array<{
    data: Record<string, unknown>;
  }>;

describe('bridge diagnostics before the content script is ready', () => {
  it('replays early entries once when the content script first talks to the bridge', async () => {
    await proxy.fetch(`/api/timedtext?v=${A}&lang=en&fmt=json3&pot=P`);
    await tick();
    expect(diagLogs()).toHaveLength(1);
    expect(diagLogs()[0]!.data.early).toBeUndefined();

    send({ type: 'request-player-response', videoId: A });
    await tick();
    expect(diagLogs()).toHaveLength(2);
    expect(diagLogs()[1]!.data).toMatchObject({ bodyLength: 0, early: true });

    // 之后的记录不再暂存或重复补发。
    send({ type: 'request-player-response', videoId: A });
    await proxy.fetch(`/api/timedtext?v=${A}&lang=en&fmt=json3&pot=P`);
    await tick();
    expect(diagLogs()).toHaveLength(3);
    expect(diagLogs()[2]!.data.early).toBeUndefined();
  });
});

// @vitest-environment happy-dom
/**
 * MAIN world 桥：原始字幕状态保存、目标轨道已激活/自动翻译时强制重新请求、正文缓存重放。
 * happy-dom 的 MessageEvent.source 不等于 window，用代理窗口模拟（同 controller.test）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';

type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;
const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
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

const player = {
  videoId: A,
  track: null as null | Record<string, unknown>,
  calls: [] as unknown[],
};
realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
let fetchBody = '';
// 桥安装时包装当前 fetch；之后只改 fetchBody，不替换 window.fetch。
realWin.fetch = (async () =>
  new realWin.Response(fetchBody, { status: 200 })) as unknown as typeof fetch;
installMainWorldBridge(proxy);

function buildPlayer() {
  document.body.replaceChildren();
  const root = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
  root.id = 'movie_player';
  document.body.append(root);
  root.getPlayerResponse = () => ({
    videoDetails: { videoId: player.videoId },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            languageCode: 'en',
            vssId: '.en',
            baseUrl: `/api/timedtext?v=${player.videoId}&lang=en`,
          },
        ],
      },
    },
  });
  root.loadModule = () => undefined;
  root.unloadModule = () => player.calls.push('unload');
  root.getOption = (_m: string, o: string) =>
    o === 'track' ? (player.track ? { ...player.track } : {}) : undefined;
  root.setOption = (_m: string, _o: string, v: Record<string, unknown>) => {
    player.calls.push(v);
    player.track = v && v.languageCode ? { ...v } : null;
    if (v?.languageCode)
      void proxy.fetch(`/api/timedtext?v=${player.videoId}&lang=en&fmt=json3&pot=P`);
  };
}

const send = (msg: Record<string, unknown>) =>
  proxy.postMessage({ __tongting: BRIDGE_TAG, dir: 'to-main', ...msg }, 'https://www.youtube.com');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  posted.length = 0;
  player.calls.length = 0;
  buildPlayer();
});

describe('MAIN world bridge', () => {
  it('forces a re-request when the target track is already active or auto-translated, and keeps the first original state for restore', async () => {
    player.track = {
      languageCode: 'en',
      kind: '',
      translationLanguage: { languageCode: 'zh-Hans' },
    };
    fetchBody = '{"events":[]}';

    send({ type: 'load-track', commandId: 'c1', videoId: A, languageCode: 'en', kind: 'standard' });
    await tick(50);
    expect(player.calls[0]).toEqual({});
    expect(player.calls[1]).toEqual({ languageCode: 'en' });
    // 切到 B 后再次改动：原始状态（带自动翻译的 en）不被覆盖。
    realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${B}`);
    player.videoId = B;
    send({ type: 'load-track', commandId: 'c2', videoId: B, languageCode: 'en', kind: 'standard' });
    await tick(50);
    player.calls.length = 0;
    send({ type: 'restore-captions', commandId: 'r1', videoId: A });
    await tick();
    expect(player.calls).toEqual([
      { languageCode: 'en', kind: '', translationLanguage: { languageCode: 'zh-Hans' } },
    ]);
    realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
    player.videoId = A;
  });

  it('replays cached bodies on request and serves load-track from the cache without touching the player', async () => {
    send({ type: 'replay-bodies', videoId: A });
    await tick();
    const replayed = posted.filter((m) => m.type === 'timedtext' && m.via === 'replay');
    expect(replayed.length).toBeGreaterThan(0);
    posted.length = 0;
    player.calls.length = 0;
    send({ type: 'load-track', commandId: 'c3', videoId: A, languageCode: 'en', kind: 'standard' });
    await tick();
    expect(player.calls).toEqual([]);
    expect(posted.map((m) => [m.type, m.via ?? m.ok])).toEqual([
      ['timedtext', 'replay'],
      ['command-result', true],
    ]);
  });
});

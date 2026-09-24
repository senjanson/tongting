// @vitest-environment happy-dom
/**
 * 内容脚本总控的集成测试：真实的 MAIN world 桥 + ISOLATED 控制器 + 假端口，运行在同一个 happy-dom 窗口中。
 *
 * happy-dom 的 MessageEvent.source 不等于全局 window，因此用一个转发代理充当 window，
 * 让 postMessage 事件的 source 指向该代理；生产代码仍严格检查 event.source === window。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CONTENT_PROTOCOL_VERSION } from '@src/messaging/content-protocol';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { startYoutubeContent, type YoutubeContentController } from '@src/youtube/controller';
import type { PortLike } from '@src/youtube/port-client';
import { TT_ATTRS } from '@src/youtube/selectors';

const A = 'AAAAAAAAAAA';
const json3 = readFileSync(
  resolve(import.meta.dirname, '../../fixtures/youtube/manual.json3'),
  'utf8',
);

type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;

function makeWindowShim(): HappyWindow {
  const proxy: HappyWindow = new Proxy(realWin, {
    get(target, prop) {
      if (prop === 'postMessage') {
        return (data: unknown, origin: string) => {
          if (origin !== target.location.origin) throw new Error('origin mismatch');
          const cloned = structuredClone(data);
          setTimeout(
            () =>
              target.dispatchEvent(
                new target.MessageEvent('message', {
                  data: cloned,
                  origin,
                  source: proxy as unknown as Window,
                }),
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
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
  return proxy;
}

class FakePort implements PortLike {
  sent: Array<Record<string, unknown>> = [];
  private msg = new Set<(m: unknown) => void>();
  private disc = new Set<() => void>();
  onMessage = {
    addListener: (cb: (m: unknown) => void) => void this.msg.add(cb),
    removeListener: (cb: (m: unknown) => void) => void this.msg.delete(cb),
  };
  onDisconnect = {
    addListener: (cb: () => void) => void this.disc.add(cb),
    removeListener: (cb: () => void) => void this.disc.delete(cb),
  };
  postMessage(m: unknown) {
    this.sent.push(structuredClone(m) as Record<string, unknown>);
  }
  disconnect() {}
  receive(m: unknown) {
    for (const l of [...this.msg]) l(m);
  }
  remoteDisconnect() {
    for (const l of [...this.disc]) l();
  }
  ofType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

function buildPage(win: HappyWindow) {
  document.body.replaceChildren();
  const root = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
  root.id = 'movie_player';
  root.className = 'html5-video-player';
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  root.append(video);
  const bottom = document.createElement('div');
  bottom.className = 'ytp-chrome-bottom';
  root.append(bottom);
  document.body.append(root);
  const player = {
    videoId: A,
    setOptionCalls: [] as unknown[],
    unloadCalls: 0,
  };
  root.getPlayerResponse = () => ({
    videoDetails: {
      videoId: player.videoId,
      title: `Title ${player.videoId}`,
      author: 'Channel',
      lengthSeconds: '30',
      isLive: false,
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: `https://www.youtube.com/api/timedtext?v=${player.videoId}&lang=en&signature=SECRET`,
            name: { simpleText: 'English' },
            vssId: '.en',
            languageCode: 'en',
          },
        ],
      },
    },
  });
  root.loadModule = () => undefined;
  root.unloadModule = () => {
    player.unloadCalls++;
  };
  root.getOption = () => undefined;
  root.setOption = (_m: string, _o: string, value: { languageCode?: string }) => {
    player.setOptionCalls.push(value);
    if (value?.languageCode) {
      // 模拟播放器自己请求 timedtext（带签名参数）。
      void win.fetch(
        `/api/timedtext?v=${player.videoId}&lang=${value.languageCode}&fmt=json3&signature=SECRET`,
      );
    }
  };
  return { root, video, player };
}

let controllers: YoutubeContentController[] = [];

// 桥在一个窗口中只能安装一次（安装标记防止重复包装 fetch/XHR），因此整个文件共用同一个 window 代理与 fetch 桩。
realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
const sharedWin = makeWindowShim();
const defaultFetch = async (_input?: unknown, _init?: unknown): Promise<Response> =>
  new realWin.Response(json3, { status: 200 });
const fetchStub = vi.fn(defaultFetch);
realWin.fetch = ((input: unknown, init?: unknown) =>
  fetchStub(input, init)) as unknown as typeof fetch;
installMainWorldBridge(sharedWin);

beforeEach(() => {
  realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
});

afterEach(() => {
  for (const c of controllers) c.dispose();
  controllers = [];
});

function start(opts: { connect?: boolean; videoId?: string } = {}) {
  // 桥的正文缓存在整个文件内共享：需要「未缓存」轨道的用例使用独立 videoId。
  if (opts.videoId) realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${opts.videoId}`);
  let wakeCb: (() => void) | undefined;
  const win = sharedWin;
  fetchStub.mockReset();
  fetchStub.mockImplementation(defaultFetch);
  const page = buildPage(win);
  if (opts.videoId) page.player.videoId = opts.videoId;
  const ports: FakePort[] = [];
  let invalidate: (() => void) | undefined;
  let valid = true;
  const controller = startYoutubeContent({
    win,
    doc: document,
    connect: () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    isContextValid: () => valid,
    onInvalidated: (cb) => {
      invalidate = cb;
    },
    pageInstanceId: 'pg-test-0001',
    onWakeMessage: (cb) => {
      wakeCb = cb;
      return () => {
        wakeCb = undefined;
      };
    },
    // 轮询间隔调大：用例只依赖事件驱动，不依赖 30ms 轮询的时序。
    timings: {
      metadataRequestSchedule: [0, 50],
      welcomeSessionTimeoutMs: 100,
      overlayCheckMs: 20,
      passiveTrackThrottleMs: 100,
      playerPollMs: 60_000,
      navigationPollMs: 60_000,
      startingMetadataPollMs: 100,
    },
  });
  controllers.push(controller);
  // 无会话时内容脚本不主动唤醒 worker；模拟扩展页面发来的可信唤醒以建立连接。
  if (opts.connect !== false) wakeCb?.();
  const port = () => ports[ports.length - 1]!;
  const request = (requestId: string, request: Record<string, unknown>) =>
    port().receive({ type: 'request', requestId, request });
  const workerHandshake = (session: Record<string, unknown> | null) => {
    port().receive({
      type: 'welcome',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      workerInstanceId: 'w-1',
      locale: 'zh-CN',
    });
    port().receive({
      type: 'display/settings',
      captions: {
        enabled: true,
        bilingual: true,
        position: 'bottom',
        fontSizePx: 22,
        backgroundOpacity: 0.75,
        offsetMs: 0,
      },
      targetLanguage: 'zh-CN',
      locale: 'zh-CN',
    });
    port().receive({ type: 'session/state', session });
  };
  return {
    win,
    ...page,
    ports,
    port,
    request,
    workerHandshake,
    controller,
    fetchStub,
    wake: () => wakeCb?.(),
    invalidate: () => {
      valid = false;
      invalidate?.();
    },
  };
}

const sessionA = {
  sessionId: 'session-A-001',
  epoch: 0,
  videoId: A,
  phase: 'running',
  outputMode: 'subtitle',
};

const waitTracks = async (t: ReturnType<typeof start>) => {
  await vi.waitFor(() =>
    expect(
      t
        .port()
        .ofType('captions/tracks')
        .some((m) => m.availability === 'available'),
    ).toBe(true),
  );
};
const waitReply = async (t: ReturnType<typeof start>, requestId: string) => {
  await vi.waitFor(() =>
    expect(
      t
        .port()
        .ofType('reply')
        .some((m) => m.requestId === requestId && m.ok),
    ).toBe(true),
  );
};

it('R10: cached native captions are hidden on takeover and exposed again when display stops', async () => {
  const id = 'CCCReview01';
  const t = start({ videoId: id });
  await waitTracks(t);
  t.root.getOption = (_m: string, option: string) =>
    option === 'track' ? { languageCode: 'en' } : undefined;
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=en&fmt=json3`);
  await new Promise((r) => setTimeout(r, 30));
  t.workerHandshake({ ...sessionA, videoId: id });
  t.request('r1', { kind: 'captions/load-track', videoId: id, trackKey: '.en' });
  await waitReply(t, 'r1');
  expect(t.player.setOptionCalls).toEqual([]);
  expect(t.root.hasAttribute(TT_ATTRS.hideNative)).toBe(true);
  t.port().receive({ type: 'session/state', session: null });
  expect(t.root.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
  expect(t.player.setOptionCalls).toEqual([]);
  expect(t.player.unloadCalls).toBe(0);
});

it('R12: invalidation during a page request restores the CC switch before that request completes', async () => {
  const id = 'DDDReview02';
  const t = start({ videoId: id });
  let resolveFetch!: (response: Response) => void;
  t.fetchStub.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  );
  t.workerHandshake({ ...sessionA, videoId: id });
  await waitTracks(t);
  t.request('r2', { kind: 'captions/load-track', videoId: id, trackKey: '.en' });
  await vi.waitFor(() => expect(t.player.setOptionCalls).toHaveLength(1));
  t.invalidate();
  await vi.waitFor(() => expect(t.player.unloadCalls).toBe(1));
  resolveFetch(new realWin.Response(json3, { status: 200 }) as unknown as Response);
  await new Promise((r) => setTimeout(r, 40));
  expect(t.player.unloadCalls).toBe(1);
  expect(t.port().ofType('captions/track-data')).toHaveLength(0);
});

it('R11: repeated cached language changes, including a switch without a new request, keep the last choice', async () => {
  const id = 'EEEReview03';
  const t = start({ videoId: id });
  let selected = 'en';
  t.root.getPlayerResponse = () => ({
    videoDetails: { videoId: id },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: ['en', 'ja'].map((languageCode) => ({
          languageCode,
          vssId: `.${languageCode}`,
          baseUrl: `/api/timedtext?v=${id}&lang=${languageCode}`,
        })),
      },
    },
  });
  t.root.getOption = (_m: string, option: string) =>
    option === 'track' ? { languageCode: selected } : undefined;
  sharedWin.postMessage(
    { __tongting: BRIDGE_TAG, dir: 'to-main', type: 'request-player-response', videoId: id },
    realWin.location.origin,
  );
  await vi.waitFor(() =>
    expect(
      t
        .port()
        .ofType('captions/tracks')
        .some((m) => (m.tracks as unknown[])?.length === 2),
    ).toBe(true),
  );
  for (const lang of ['en', 'ja']) await sharedWin.fetch(`/api/timedtext?v=${id}&lang=${lang}`);
  await new Promise((r) => setTimeout(r, 30));
  t.workerHandshake({ ...sessionA, videoId: id });
  t.request('en-initial', { kind: 'captions/load-track', videoId: id, trackKey: '.en' });
  await waitReply(t, 'en-initial');
  const lastKey = () =>
    (t.port().ofType('captions/track-data').at(-1)?.track as { trackKey?: string })?.trackKey;
  for (const lang of ['ja', 'en', 'ja', 'en', 'ja']) {
    selected = lang;
    // 已缓存轨道没有新的 timedtext 网络请求；桥只读选择仍应识别。
    await vi.waitFor(() => expect(lastKey()).toBe(`.${lang}`));
  }
  selected = 'en';
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=en`);
  selected = 'ja';
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=ja`);
  selected = 'en';
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=en`);
  await vi.waitFor(() => expect(lastKey()).toBe('.en'));
  await new Promise((r) => setTimeout(r, 150));
  expect(lastKey()).toBe('.en');
  const count = t.port().ofType('captions/track-data').length;
  selected = 'ja';
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=ja`);
  t.port().receive({ type: 'session/state', session: null });
  await new Promise((r) => setTimeout(r, 150));
  expect(t.port().ofType('captions/track-data')).toHaveLength(count);
});

it('R8: original volume and ducking use one baseline, update on user input, and release on stop', async () => {
  const t = start({ videoId: 'FFFReview04' });
  t.workerHandshake({ ...sessionA, videoId: 'FFFReview04', outputMode: 'both' });
  t.video.volume = 0.8;
  t.request('scale', {
    kind: 'player/duck',
    videoId: 'FFFReview04',
    active: false,
    originalVolume: 0.5,
    level: 0.3,
  });
  expect(t.video.volume).toBeCloseTo(0.4);
  t.request('duck', {
    kind: 'player/duck',
    videoId: 'FFFReview04',
    active: true,
    originalVolume: 0.5,
    level: 0.3,
  });
  expect(t.video.volume).toBeCloseTo(0.12);
  t.request('speech-end', {
    kind: 'player/duck',
    videoId: 'FFFReview04',
    active: false,
    originalVolume: 0.5,
    level: 0.3,
  });
  expect(t.video.volume).toBeCloseTo(0.4);
  t.video.volume = 0.6;
  t.video.dispatchEvent(new Event('volumechange'));
  t.request('mute', {
    kind: 'player/duck',
    videoId: 'FFFReview04',
    active: false,
    originalVolume: 0,
    level: 0.3,
  });
  expect(t.video.volume).toBe(0);
  t.port().receive({ type: 'session/state', session: null });
  expect(t.video.volume).toBeCloseTo(0.6);
});

it('R11: a slower explicit track load cannot overwrite the later selection in the same video', async () => {
  const id = 'GGGReview05';
  const t = start({ videoId: id });
  t.root.getPlayerResponse = () => ({
    videoDetails: { videoId: id },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: ['en', 'ja'].map((languageCode) => ({
          languageCode,
          vssId: `.${languageCode}`,
          baseUrl: `/api/timedtext?v=${id}&lang=${languageCode}`,
        })),
      },
    },
  });
  sharedWin.postMessage(
    { __tongting: BRIDGE_TAG, dir: 'to-main', type: 'request-player-response', videoId: id },
    realWin.location.origin,
  );
  await vi.waitFor(() =>
    expect(
      t
        .port()
        .ofType('captions/tracks')
        .some((m) => (m.tracks as unknown[])?.length === 2),
    ).toBe(true),
  );
  await sharedWin.fetch(`/api/timedtext?v=${id}&lang=ja`);
  await new Promise((r) => setTimeout(r, 30));
  let resolveFetch!: (response: Response) => void;
  t.fetchStub.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
  );
  t.workerHandshake({ ...sessionA, videoId: id });
  t.request('old-en', { kind: 'captions/load-track', videoId: id, trackKey: '.en' });
  await vi.waitFor(() => expect(t.player.setOptionCalls).toHaveLength(1));
  t.request('new-ja', { kind: 'captions/load-track', videoId: id, trackKey: '.ja' });
  await waitReply(t, 'new-ja');
  resolveFetch(new realWin.Response(json3, { status: 200 }) as unknown as Response);
  await vi.waitFor(() =>
    expect(
      t
        .port()
        .ofType('reply')
        .find((m) => m.requestId === 'old-en'),
    ).toMatchObject({ ok: false, error: { code: 'cancelled' } }),
  );
  expect(
    t
      .port()
      .ofType('captions/track-data')
      .map((m) => (m.track as { trackKey: string }).trackKey),
  ).toEqual(['.ja']);
});

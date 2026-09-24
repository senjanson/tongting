// @vitest-environment happy-dom
/**
 * 内容脚本总控的集成测试：真实的 MAIN world 桥 + ISOLATED 控制器 + 假端口，运行在同一个 happy-dom 窗口中。
 *
 * happy-dom 的 MessageEvent.source 不等于全局 window，因此用一个转发代理充当 window，
 * 让 postMessage 事件的 source 指向该代理；生产代码仍严格检查 event.source === window。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLocale } from '@src/i18n';
import { CONTENT_PROTOCOL_VERSION } from '@src/messaging/content-protocol';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { startYoutubeContent, type YoutubeContentController } from '@src/youtube/controller';
import type { PortLike } from '@src/youtube/port-client';
import { TT_ATTRS } from '@src/youtube/selectors';

const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
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

function start(opts: { connect?: boolean; videoId?: string; uiLanguage?: string } = {}) {
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
    uiLanguage: opts.uiLanguage,
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
      overlayCheckMs: 50,
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

async function navigate(url: string) {
  document.dispatchEvent(new Event('yt-navigate-start'));
  realWin.happyDOM.setURL(url);
  document.dispatchEvent(new Event('yt-navigate-finish'));
  await new Promise((r) => setTimeout(r, 5));
}

describe('youtube content controller', () => {
  it('does not wake the worker without a session; a trusted wake connects (throttled) with hello first', async () => {
    const t = start({ connect: false });
    t.video.dispatchEvent(new Event('play'));
    t.video.dispatchEvent(new Event('seeked'));
    await new Promise((r) => setTimeout(r, 30));
    expect(t.ports).toHaveLength(0);
    t.wake();
    t.wake();
    t.wake();
    expect(t.ports).toHaveLength(1);
    expect(t.port().sent[0]).toMatchObject({
      type: 'hello',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      pageInstanceId: 'pg-test-0001',
    });
    expect(t.port().sent[1]).toMatchObject({
      type: 'page/video',
      navigationId: 1,
      videoId: A,
      isShorts: false,
    });
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('captions/tracks')
          .some((m) => m.availability === 'available'),
      ).toBe(true),
    );
    const video = t.port().ofType('page/video').pop()!;
    expect(video).toMatchObject({
      navigationId: 1,
      videoId: A,
      title: `Title ${A}`,
      channel: 'Channel',
      durationMs: 30_000,
    });
    const tracks = t.port().ofType('captions/tracks').pop()!;
    expect(tracks.tracks).toEqual([
      { trackKey: '.en', languageCode: 'en', label: 'English', kind: 'manual' },
    ]);
    expect(JSON.stringify(t.port().sent)).not.toContain('SECRET');
  });

  it('loads a track via the player, sends track-data on every request, and hides native captions only during the session', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('captions/tracks')
          .some((m) => m.availability === 'available'),
      ).toBe(true),
    );
    t.request('r1', { kind: 'captions/load-track', videoId: A, trackKey: '.en' });
    await vi.waitFor(
      () =>
        expect(
          t
            .port()
            .ofType('reply')
            .find((m) => m.requestId === 'r1'),
        ).toBeTruthy(),
      { timeout: 3_000 },
    );
    expect(t.player.setOptionCalls).toEqual([{ languageCode: 'en' }]);
    const data = t.port().ofType('captions/track-data');
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      navigationId: 1,
      videoId: A,
      format: 'json3',
      complete: true,
      track: { trackKey: '.en' },
    });
    expect((data[0]!.cues as unknown[]).length).toBeGreaterThan(5);
    expect(
      t
        .port()
        .ofType('reply')
        .find((m) => m.requestId === 'r1'),
    ).toMatchObject({ ok: true, data: { trackKey: '.en' } });
    expect(JSON.stringify(t.port().sent)).not.toContain('SECRET');
    expect(t.root.hasAttribute(TT_ATTRS.hideNative)).toBe(true);

    t.request('r2', { kind: 'captions/load-track', videoId: A, trackKey: '.en' });
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('reply')
          .find((m) => m.requestId === 'r2'),
      ).toBeTruthy(),
    );
    expect(t.port().ofType('captions/track-data')).toHaveLength(2);
    expect(t.player.setOptionCalls).toHaveLength(1);

    t.port().receive({ type: 'session/state', session: null });
    expect(t.root.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
    await vi.waitFor(() => expect(t.player.unloadCalls).toBe(1)); // 恢复为打开前的「字幕关闭」
  });

  it('rejects requests for a stale video and handles seek and duck', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    t.request('s1', { kind: 'player/seek', videoId: B, timeMs: 1000 });
    t.request('s2', { kind: 'player/seek', videoId: A, timeMs: 2500 });
    t.video.volume = 0.8;
    t.request('d1', { kind: 'player/duck', videoId: A, active: true, level: 0.5 });
    t.request('q1', { kind: 'player/query' });
    await vi.waitFor(() => expect(t.port().ofType('reply')).toHaveLength(4));
    const replies = Object.fromEntries(
      t
        .port()
        .ofType('reply')
        .map((m) => [m.requestId, m]),
    );
    expect(replies.s1).toMatchObject({ ok: false, error: { code: 'stale-video' } });
    expect(replies.s2).toMatchObject({ ok: true });
    expect(t.video.currentTime).toBe(2.5);
    expect(replies.d1).toMatchObject({ ok: true, data: { applied: true, volume: 0.4 } });
    expect(replies.q1).toMatchObject({ ok: true, data: { video: { videoId: A } } });
    t.request('d2', { kind: 'player/duck', videoId: A, active: false, level: 0.5 });
    await vi.waitFor(() => expect(t.video.volume).toBe(0.8));
  });

  it('A→B→A navigation yields increasing navigationIds and cancels in-flight loads for the old video', async () => {
    const D = 'DDDDDDDDDDD';
    const t = start({ videoId: D });
    t.workerHandshake({ ...sessionA, videoId: D });
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('captions/tracks')
          .some((m) => m.availability === 'available'),
      ).toBe(true),
    );
    // 让播放器不再自动请求，使加载处于等待中。
    t.root.setOption = () => undefined;
    t.fetchStub.mockImplementation(async () => new realWin.Response('', { status: 200 }));
    t.request('slow', { kind: 'captions/load-track', videoId: D, trackKey: '.en' });
    await new Promise((r) => setTimeout(r, 20));
    t.player.videoId = B;
    await navigate(`https://www.youtube.com/watch?v=${B}`);
    t.player.videoId = D;
    await navigate(`https://www.youtube.com/watch?v=${D}`);
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('reply')
          .find((m) => m.requestId === 'slow'),
      ).toBeTruthy(),
    );
    expect(
      t
        .port()
        .ofType('reply')
        .find((m) => m.requestId === 'slow'),
    ).toMatchObject({ ok: false, error: { code: 'navigation-changed' } });
    const navs = t
      .port()
      .ofType('page/video')
      .map((m) => [m.navigationId, m.videoId]);
    const distinct = [...new Map(navs.map(([id, v]) => [id, v])).entries()];
    expect(distinct).toEqual([
      [1, D],
      [2, B],
      [3, D],
    ]);
    expect(t.port().ofType('captions/track-data')).toHaveLength(0);
  });

  it('does not reconnect for player events without a session; a wake reconnects and replays full state', async () => {
    const t = start();
    t.workerHandshake(null);
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('captions/tracks')
          .some((m) => m.availability === 'available'),
      ).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 80)); // 让排定的元数据请求全部结束
    t.port().remoteDisconnect();
    expect(t.controller.debug().connected).toBe(false);
    t.video.dispatchEvent(new Event('timeupdate'));
    t.video.dispatchEvent(new Event('volumechange'));
    t.video.dispatchEvent(new Event('ratechange'));
    await new Promise((r) => setTimeout(r, 50));
    expect(t.ports).toHaveLength(1); // 无会话：播放器事件不唤醒
    await new Promise((r) => setTimeout(r, 2_000)); // 越过唤醒节流窗口
    t.wake();
    expect(t.ports).toHaveLength(2);
    expect(t.port().sent.map((m) => m.type)).toEqual([
      'hello',
      'page/video',
      'captions/tracks',
      'player/state',
    ]);
  });

  it('clears a stale overlay session when a restarted worker does not confirm it after welcome', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    await vi.waitFor(() =>
      expect(t.root.querySelector(`[${TT_ATTRS.overlayHost}]`)).not.toBeNull(),
    );
    t.port().remoteDisconnect();
    t.video.dispatchEvent(new Event('pause'));
    t.port().receive({
      type: 'welcome',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      workerInstanceId: 'w-2',
      locale: 'zh-CN',
    });
    await vi.waitFor(() => expect(t.root.querySelector(`[${TT_ATTRS.overlayHost}]`)).toBeNull());
  });

  it('releases everything on context invalidation and ignores later events', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    t.request('r1', { kind: 'captions/load-track', videoId: A, trackKey: '.en' });
    await vi.waitFor(() => expect(t.port().ofType('reply')).toHaveLength(1), { timeout: 3_000 });
    expect(document.querySelector(`[${TT_ATTRS.overlayHost}]`)).not.toBeNull();
    t.video.volume = 1;
    t.request('d1', { kind: 'player/duck', videoId: A, active: true, level: 0.25 });
    await vi.waitFor(() => expect(t.video.volume).toBe(0.25));
    const sentBefore = t.port().sent.length;
    t.invalidate();
    expect(t.controller.disposed).toBe(true);
    expect(document.querySelector(`[${TT_ATTRS.overlayHost}]`)).toBeNull();
    expect(document.querySelector(`style[${TT_ATTRS.nativeStyle}]`)).toBeNull();
    expect(t.root.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
    expect(t.video.volume).toBe(1);
    t.video.dispatchEvent(new Event('play'));
    await navigate(`https://www.youtube.com/watch?v=${B}`);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.ports).toHaveLength(1);
    expect(t.port().sent.length).toBe(sentBefore);
    t.controller.dispose();
  });
});

describe('review fixes: navigation, requests and metadata retry', () => {
  it('C1/C2: on navigation page/video precedes tracks, and the old local session is cleared (A→B→A)', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    t.port().receive({
      type: 'session/cues',
      sessionId: sessionA.sessionId,
      epoch: 0,
      cueVersion: 1,
      full: true,
      cues: [
        {
          id: 'old-1',
          revision: 0,
          startMs: 0,
          endMs: 60_000,
          sourceText: 'old',
          translatedText: '旧',
          translationState: 'done',
          stability: 'final',
        },
      ],
    });
    await vi.waitFor(() => expect(t.controller.debug().overlayMounted).toBe(true));
    const before = t.port().sent.length;
    t.player.videoId = B;
    await navigate(`https://www.youtube.com/watch?v=${B}`);
    const nav2 = t
      .port()
      .sent.slice(before)
      .filter((m) => m.navigationId === 2);
    expect(nav2.slice(0, 2).map((m) => m.type)).toEqual(['page/video', 'captions/tracks']);
    t.player.videoId = A;
    await navigate(`https://www.youtube.com/watch?v=${A}`);
    expect(t.controller.debug()).toMatchObject({
      navigationId: 3,
      videoId: A,
      sessionId: null,
      overlayMounted: false,
    });
  });

  it('rejects a request whose navigationId does not match the current navigation', async () => {
    const t = start();
    t.workerHandshake(sessionA);
    t.port().receive({
      type: 'request',
      requestId: 'old-nav',
      navigationId: 99,
      request: { kind: 'player/seek', videoId: A, timeMs: 1000 },
    });
    await vi.waitFor(() =>
      expect(
        t
          .port()
          .ofType('reply')
          .find((m) => m.requestId === 'old-nav'),
      ).toBeTruthy(),
    );
    expect(t.port().ofType('reply')[0]).toMatchObject({
      ok: false,
      error: { code: 'stale-video' },
    });
    expect(t.video.currentTime).toBe(0);
  });

  it('M1: retries metadata on play after the fixed schedule when the player initializes late', async () => {
    // 本文件共用 MAIN bridge，独立视频避免上一用例已发布的元数据干扰初始化时序。
    const t = start({ videoId: 'LLLLLLLLLLL' });
    const gpr = t.root.getPlayerResponse;
    delete (t.root as Record<string, unknown>).getPlayerResponse;
    t.workerHandshake(null);
    await new Promise((r) => setTimeout(r, 200));
    expect(t.controller.debug().availability).toBe('unknown');
    t.root.getPlayerResponse = gpr;
    await new Promise((r) => setTimeout(r, 1_100)); // 越过首次重试的退避时间
    t.video.dispatchEvent(new Event('play'));
    await vi.waitFor(() => expect(t.controller.debug().availability).toBe('available'));
  });

  it('polls player data at a fixed interval only while the worker session is starting', async () => {
    const id = 'MMMMMMMMMMM';
    const t = start({ videoId: id });
    const gpr = t.root.getPlayerResponse;
    delete (t.root as Record<string, unknown>).getPlayerResponse;
    // 会话已在运行（例如语音识别来源）：不轮询，没有播放器事件时可用性保持 unknown。
    t.workerHandshake({ ...sessionA, videoId: id });
    await new Promise((r) => setTimeout(r, 200));
    t.root.getPlayerResponse = gpr;
    await new Promise((r) => setTimeout(r, 400));
    expect(t.controller.debug().availability).toBe('unknown');

    // 会话处于 starting（worker 正在等待轨道）：不依赖播放器事件也能在播放器就绪后拿到轨道。
    t.port().receive({
      type: 'session/state',
      session: { ...sessionA, videoId: id, phase: 'starting' },
    });
    await vi.waitFor(() => expect(t.controller.debug().availability).toBe('available'));
    const tracks = t.port().ofType('captions/tracks').at(-1) as { availability?: string };
    expect(tracks.availability).toBe('available');
  });

  it('shows overlay labels in the locale sent by the worker and switches when it changes', async () => {
    const t = start({ uiLanguage: 'en-US' });
    expect(getLocale()).toBe('en');
    t.workerHandshake(sessionA);
    const badge = () =>
      t.root
        .querySelector(`[${TT_ATTRS.overlayHost}]`)
        ?.shadowRoot?.querySelector<HTMLElement>('.badge')?.textContent;
    // worker 下发的是中文（用户在设置中选择了中文），优先于浏览器界面语言。
    await vi.waitFor(() => expect(badge()).toBe('同听 · 运行中'));
    t.port().receive({
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
      locale: 'en',
    });
    await vi.waitFor(() => expect(badge()).toBe('Tongting · Running'));
    expect(getLocale()).toBe('en');
  });
});

// @vitest-environment happy-dom
/**
 * 内容脚本总控 + 缓冲闸门的回归测试：真实 MAIN world 桥、播放器适配器与闸门，worker 用假端口模拟。
 *
 * - 广告状态是页面事实：welcome / 会话清空重置闸门后，正在播放的片头广告不能被暂停；
 * - starting 阶段拖动进度条：闸门等待 worker 用新 epoch 确认跳转，缓冲足够后自动恢复播放。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_PROTOCOL_VERSION } from '@src/messaging/content-protocol';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { startYoutubeContent, type YoutubeContentController } from '@src/youtube/controller';
import type { PortLike } from '@src/youtube/port-client';

const A = 'AAAAAAAAAAA';
type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;

/** happy-dom 的 MessageEvent.source 不等于全局 window：用转发代理充当 window（同 controller.test.ts）。 */
function makeWindowShim(): HappyWindow {
  const proxy: HappyWindow = new Proxy(realWin, {
    get(target, prop) {
      if (prop === 'postMessage') {
        return (data: unknown, origin: string) => {
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
}

// 桥在一个窗口中只能安装一次，整个文件共用同一个 window 代理与 fetch 桩。
realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${A}`);
const sharedWin = makeWindowShim();
realWin.fetch = (async () =>
  new realWin.Response('{"events":[]}', { status: 200 })) as unknown as typeof fetch;
installMainWorldBridge(sharedWin);

let controllers: YoutubeContentController[] = [];
afterEach(() => {
  for (const c of controllers) c.dispose();
  controllers = [];
});

/** 播放中的视频（3 秒处）；paused / currentTime / play / pause 由测试控制，不依赖 happy-dom 媒体实现。 */
function buildPage(opts: { ad?: boolean } = {}) {
  document.body.replaceChildren();
  const root = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
  root.id = 'movie_player';
  root.className = `html5-video-player${opts.ad ? ' ad-showing' : ''}`;
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  const media = { paused: false, currentTime: 3 };
  Object.defineProperty(video, 'paused', { get: () => media.paused, configurable: true });
  Object.defineProperty(video, 'duration', { get: () => 300, configurable: true });
  Object.defineProperty(video, 'currentTime', {
    get: () => media.currentTime,
    set: (v: number) => {
      media.currentTime = v;
    },
    configurable: true,
  });
  const pause = vi.fn(() => {
    media.paused = true;
  });
  const play = vi.fn(() => {
    media.paused = false;
    return Promise.resolve();
  });
  Object.assign(video, { pause, play });
  root.append(video);
  document.body.append(root);
  root.getPlayerResponse = () => ({
    videoDetails: { videoId: A, lengthSeconds: '300' },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: `https://www.youtube.com/api/timedtext?v=${A}&lang=en`,
            name: { simpleText: 'English' },
            vssId: '.en',
            languageCode: 'en',
          },
        ],
      },
    },
  });
  root.getOption = () => undefined;
  root.setOption = () => undefined;
  root.loadModule = () => undefined;
  root.unloadModule = () => undefined;
  return { root, video, media, pause, play };
}

function start() {
  const ports: FakePort[] = [];
  let wake: (() => void) | undefined;
  const controller = startYoutubeContent({
    win: sharedWin,
    doc: document,
    connect: () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    isContextValid: () => true,
    onInvalidated: () => undefined,
    pageInstanceId: 'pg-test-0001',
    onWakeMessage: (cb) => {
      wake = cb;
      return () => {
        wake = undefined;
      };
    },
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
  // 模拟弹窗 / 侧栏打开时发来的可信唤醒：建立连接。
  wake?.();
  const port = () => ports[ports.length - 1]!;
  const welcome = () =>
    port().receive({
      type: 'welcome',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      workerInstanceId: 'w-1',
      locale: 'zh-CN',
    });
  const session = (phase: 'starting' | 'running', epoch: number, readyUntilMs: number) =>
    port().receive({
      type: 'session/state',
      session: {
        sessionId: 'session-buffer-01',
        epoch,
        videoId: A,
        phase,
        outputMode: 'subtitle',
        playbackBuffer: { readyUntilMs, targetMs: 10_000, blocked: false },
      },
    });
  const clear = () => port().receive({ type: 'session/state', session: null });
  /** 同一会话继续运行，但 worker 不再下发闸门（同步优先退回边播边译）。 */
  const ungated = (
    phase: 'running' | 'paused' = 'running',
    sourceMode: 'incremental-captions' | 'asr' | 'full-track' = 'incremental-captions',
  ) =>
    port().receive({
      type: 'session/state',
      session: {
        sessionId: 'session-buffer-01',
        epoch: 0,
        videoId: A,
        phase,
        outputMode: 'subtitle',
        sourceMode,
      },
    });
  return { controller, welcome, session, clear, ungated };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('buffer gate inside the content controller', () => {
  it('a pre-roll ad already showing when the worker connects is not paused after welcome', async () => {
    const page = buildPage({ ad: true });
    const t = start();
    t.welcome();
    t.session('starting', 0, 3_000);
    await settle(150);
    expect(page.pause).not.toHaveBeenCalled();
    // 会话清空（闸门 update(null)）后广告未结束时再次开始翻译。
    t.clear();
    t.session('starting', 0, 3_000);
    await settle(150);
    expect(page.pause).not.toHaveBeenCalled();
    // 广告结束后闸门重新接管正片：缓冲不足时暂停等待翻译。
    page.root.classList.remove('ad-showing');
    await vi.waitFor(() => expect(page.pause).toHaveBeenCalledTimes(1));
  });

  it('a seek while the session is starting resumes once the worker acknowledges it and the buffer is ready', async () => {
    const page = buildPage();
    const t = start();
    t.welcome();
    t.session('starting', 0, 3_000);
    await settle();
    expect(page.pause).toHaveBeenCalledTimes(1);
    // starting 期间拖动进度条到 100 秒。
    page.media.currentTime = 100;
    page.video.dispatchEvent(new Event('seeking'));
    page.video.dispatchEvent(new Event('seeked'));
    // worker 确认跳转前的旧 epoch 覆盖范围不能让视频在新位置提前播放。
    t.session('starting', 0, 200_000);
    await settle(150);
    expect(page.play).not.toHaveBeenCalled();
    // worker 在 starting 阶段递增 epoch 确认跳转；新位置尚未准备好，继续等待。
    t.session('starting', 1, 100_000);
    await settle(150);
    expect(page.play).not.toHaveBeenCalled();
    expect(page.media.paused).toBe(true);
    // 进入 running 且新位置之后已缓冲足够：自动恢复播放。
    t.session('running', 1, 111_000);
    await vi.waitFor(() => expect(page.play).toHaveBeenCalledTimes(1));
    expect(page.media.paused).toBe(false);
  });

  it('falling back to live translation restarts the video the gate paused while preparing', async () => {
    const page = buildPage();
    const t = start();
    t.welcome();
    t.session('starting', 0, 3_000);
    await settle();
    expect(page.pause).toHaveBeenCalledTimes(1);
    expect(page.media.paused).toBe(true);
    // 完整轨道读不到：会话继续运行，但不再保持视频。
    t.ungated();
    await vi.waitFor(() => expect(page.play).toHaveBeenCalledTimes(1));
    expect(page.media.paused).toBe(false);
    await settle(150);
    expect(page.pause).toHaveBeenCalledTimes(1);
  });

  it('a video the user had paused before translation stays paused after the fallback', async () => {
    const page = buildPage();
    page.media.paused = true;
    const t = start();
    t.welcome();
    t.session('starting', 0, 3_000);
    await settle();
    t.ungated();
    await settle(150);
    expect(page.play).not.toHaveBeenCalled();
    expect(page.media.paused).toBe(true);
  });

  it('falling back to live recognition also restarts the held video', async () => {
    const page = buildPage();
    const t = start();
    t.welcome();
    t.session('starting', 0, 3_000);
    await settle();
    expect(page.media.paused).toBe(true);
    t.ungated('running', 'asr');
    await vi.waitFor(() => expect(page.play).toHaveBeenCalledTimes(1));
  });

  it('switching to continuous playback, pausing or stopping the session leaves a held video paused', async () => {
    const page = buildPage();
    const t = start();
    t.welcome();
    t.session('running', 0, 3_000);
    await settle();
    expect(page.media.paused).toBe(true);
    // 用户改成「连续播放」：完整轨道会话不再下发闸门。
    t.ungated('running', 'full-track');
    await settle(150);
    t.session('running', 0, 3_000);
    await settle();
    t.ungated('paused');
    await settle(150);
    t.clear();
    await settle(150);
    expect(page.play).not.toHaveBeenCalled();
    expect(page.media.paused).toBe(true);
  });
});

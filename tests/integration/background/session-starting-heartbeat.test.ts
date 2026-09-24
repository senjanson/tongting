/**
 * 缓冲模式 starting 阶段的心跳：启动早期（权限检查、首次协议探测）耗时超过闸门 10 秒租约时，
 * 内容端仍须每秒收到 session/state，闸门不因过期而放弃保持，缓冲足够后自动恢复播放；
 * 启动失败或停止后心跳立即停止。
 *
 * worker 发往内容端的 session/state 直接驱动真实的缓冲闸门（映射与 controller.applySession 相同），
 * 视频为假对象；使用假定时器推进时间。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundToContent } from '@src/messaging/content-protocol';
import { createPlaybackBufferController } from '@src/youtube/playback-buffer';
import {
  configure,
  createHarness,
  FakeScheduler,
  type ContentClient,
  type Harness,
} from './harness';

const active: Harness[] = [];
const releases: (() => void)[] = [];
function harness() {
  const h = createHarness();
  active.push(h);
  return h;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  releases.push(resolve);
  return { promise, resolve };
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const h of active.splice(0)) {
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(10_000);
    await h.coordinator.idle();
  }
  vi.useRealTimers();
});

const latest = (h: Harness) => h.coordinator.buildSnapshot(1).sessions[0];
const heartbeats = (c: ContentClient) =>
  c.messages('session/state').filter((m) => m.session !== null).length;

function fakeVideo(currentTime: number) {
  const video = {
    paused: false,
    currentTime,
    duration: 600,
    seeking: false,
    ended: false,
    pause: vi.fn(() => {
      video.paused = true;
    }),
    play: vi.fn(() => {
      video.paused = false;
      return Promise.resolve();
    }),
  };
  return video;
}

/** 把 worker 发给内容端的 session/state 交给真实闸门（同 controller.applySession 的策略映射）。 */
function attachGate(c: ContentClient, video: ReturnType<typeof fakeVideo>) {
  const gate = createPlaybackBufferController({
    getVideo: () => video as unknown as HTMLVideoElement,
  });
  const onPost = c.port.onPost;
  c.port.onPost = (m) => {
    onPost?.(m);
    const msg = m as BackgroundToContent;
    if (msg.type !== 'session/state') return;
    const s = msg.session;
    gate.update(
      s?.playbackBuffer && s.videoId === c.videoId
        ? {
            sessionId: s.sessionId,
            epoch: s.epoch,
            videoId: s.videoId,
            enabled: true,
            active: s.phase === 'starting' || s.phase === 'running',
            ...s.playbackBuffer,
          }
        : null,
    );
  };
  return gate;
}

async function openBuffered(h: Harness) {
  await configure(h, { buffered: true });
  const c = h.content(1);
  c.hello();
  c.navigate('aaaaaaaaaaa');
  c.player({ currentTimeMs: 3_000 }, 'tick');
  // 闸门在创建时捕获 Date.now：先启用假定时器再创建，租约才按假时间计算。
  vi.useFakeTimers();
  const video = fakeVideo(3);
  const gate = attachGate(c, video);
  return { c, video, gate };
}

describe('buffer heartbeat while a buffered session is starting', () => {
  it('keeps the content gate alive through a permission check longer than its lease and resumes once ready', async () => {
    const h = harness();
    const { c, video, gate } = await openBuffered(h);
    const permission = deferred();
    h.permissionGranted.delay = permission.promise;
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(latest(h)?.phase).toBe('starting');
    expect(video.paused).toBe(true);
    expect(gate.stats().holding).toBe(true);

    const before = heartbeats(c);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(latest(h)?.phase).toBe('starting');
    expect(FakeScheduler.all).toHaveLength(0);
    // 每秒一次心跳；调度器尚未建立，心跳只报「准备中」，不谎报就绪。
    expect(heartbeats(c) - before).toBeGreaterThanOrEqual(14);
    expect(c.messages('session/state').at(-1)?.session?.playbackBuffer).toEqual({
      readyUntilMs: 3_000,
      targetMs: 10_000,
      blocked: false,
    });
    expect(latest(h)?.playbackBuffer?.state).toBe('preparing');
    expect(gate.stats().holding).toBe(true);
    expect(video.play).not.toHaveBeenCalled();

    permission.resolve();
    h.permissionGranted.delay = undefined;
    await vi.advanceTimersByTimeAsync(10);
    c.trackData();
    await vi.advanceTimersByTimeAsync(10);
    expect(latest(h)?.phase).toBe('running');
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit(
      scheduler.cues.map((cue) => ({
        cueId: cue.id,
        cueRevision: cue.revision,
        state: 'done',
        translatedText: '测试译文',
      })),
    );
    await vi.advanceTimersByTimeAsync(1_100);
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
  });

  it('stops the heartbeat when the start fails after a slow permission check', async () => {
    const h = harness();
    const { c } = await openBuffered(h);
    const permission = deferred();
    h.permissionGranted.delay = permission.promise;
    h.permissionGranted.value = false;
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(heartbeats(c)).toBeGreaterThanOrEqual(3);
    permission.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(latest(h)?.phase).toBe('error');
    expect(c.messages('session/state').at(-1)?.session).toBeNull();
    const after = heartbeats(c);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeats(c)).toBe(after);
  });

  it('stops the heartbeat when the user stops during the permission check', async () => {
    const h = harness();
    const { c } = await openBuffered(h);
    const permission = deferred();
    h.permissionGranted.delay = permission.promise;
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await vi.advanceTimersByTimeAsync(2_000);
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await vi.advanceTimersByTimeAsync(100);
    const after = heartbeats(c);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(heartbeats(c)).toBe(after);
    expect(c.messages('session/state').at(-1)?.session ?? null).toBeNull();
  });
});

/**
 * 缓冲模式会话在 starting 阶段（权限检查、等待字幕轨道）内的跳转：
 * 内容端闸门跳转后只在 epoch 递增后才恢复播放，因此 worker 在 starting 阶段也要为跳转递增 epoch，
 * 并让调度器从新的播放位置开始（调度器可能尚未建立）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayerState } from '@src/domain/session';
import {
  configure,
  createHarness,
  FakeScheduler,
  wait,
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
    await h.coordinator.idle();
  }
});

const latest = (h: Harness) => h.coordinator.buildSnapshot(1).sessions[0]!;
/** 内容端最近收到的会话状态（缓冲闸门据此更新策略）。 */
const contentSession = (c: ContentClient) => c.messages('session/state').at(-1)?.session;

async function openBuffered(h: Harness) {
  await configure(h, { buffered: true });
  const c = h.content(1);
  c.hello();
  c.navigate('aaaaaaaaaaa');
  c.player({ currentTimeMs: 3_000 }, 'tick');
  await wait(10);
  return c;
}

/** 原生拖动进度条：seeking 期间排队的 pause 已采样到目标位置，随后 seeked。 */
function dragTo(c: ContentClient, currentTimeMs: number) {
  const at: Partial<PlayerState> = { currentTimeMs, paused: true };
  c.player({ ...at, seeking: true }, 'pause');
  c.player({ ...at, seeking: true }, 'seeking');
  c.player(at, 'seeked');
}

describe('seeking while a buffered session is starting', () => {
  it('advances the epoch once, tells the content gate, and schedules the track from the new position', async () => {
    const h = harness();
    const c = await openBuffered(h);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    // 仍在等待字幕轨道正文：会话处于 starting，闸门已按 starting 策略暂停视频。
    expect(latest(h).phase).toBe('starting');
    const scheduler = FakeScheduler.all.at(-1)!;
    expect(scheduler.playheads.at(-1)).toBe(3_000);
    const epoch = latest(h).identity.epoch;
    const playheadAtSetCues: (number | undefined)[] = [];
    const setCues = scheduler.setCues.bind(scheduler);
    scheduler.setCues = (cues, identity) => {
      playheadAtSetCues.push(scheduler.playheads.at(-1));
      setCues(cues, identity);
    };

    dragTo(c, 100_000);
    await wait(10);
    expect(latest(h).identity.epoch).toBe(epoch + 1);
    expect(scheduler.epochs.at(-1)).toBe(epoch + 1);
    expect(scheduler.playheads.at(-1)).toBe(100_000);
    // 缓冲心跳把新 epoch 带给内容端闸门（闸门据此放下跳转前的旧覆盖范围）。
    await vi.waitFor(
      () => expect(contentSession(c)).toMatchObject({ phase: 'starting', epoch: epoch + 1 }),
      { timeout: 2_000 },
    );

    c.trackData();
    await wait(20);
    expect(latest(h).phase).toBe('running');
    expect(latest(h).identity.epoch).toBe(epoch + 1);
    expect(scheduler.identity.epoch).toBe(epoch + 1);
    expect(playheadAtSetCues).toEqual([100_000]);
    expect(scheduler.playheads.at(-1)).toBe(100_000);
  });

  it('a seek before the scheduler exists is applied when the scheduler is created', async () => {
    const h = harness();
    const c = await openBuffered(h);
    const permission = deferred();
    h.permissionGranted.delay = permission.promise;
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    expect(latest(h).phase).toBe('starting');
    expect(FakeScheduler.all).toHaveLength(0);
    const epoch = latest(h).identity.epoch;
    dragTo(c, 100_000);
    await wait(10);
    expect(latest(h).identity.epoch).toBe(epoch + 1);
    permission.resolve();
    h.permissionGranted.delay = undefined;
    await wait(20);
    const scheduler = FakeScheduler.all.at(-1)!;
    expect(scheduler.identity.epoch).toBe(epoch + 1);
    expect(scheduler.playheads[0]).toBe(100_000);
    c.trackData();
    await wait(20);
    expect(latest(h).phase).toBe('running');
    expect(scheduler.playheads.at(-1)).toBe(100_000);
    expect(contentSession(c)).toMatchObject({ phase: 'running', epoch: epoch + 1 });
  });

  it('player events without a seek do not advance the epoch while starting', async () => {
    const h = harness();
    const c = await openBuffered(h);
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(20);
    const epoch = latest(h).identity.epoch;
    c.player({ currentTimeMs: 3_100, paused: true }, 'pause');
    c.player({ currentTimeMs: 3_100, paused: true, volume: 0.5 }, 'volumechange');
    await wait(10);
    expect(latest(h).phase).toBe('starting');
    expect(latest(h).identity.epoch).toBe(epoch);
  });
});

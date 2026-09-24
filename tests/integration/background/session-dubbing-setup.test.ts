/**
 * 配音控制器的生命周期：启动期间（权限检查、协议探测、等待字幕轨道）修改音频设置，
 * 任何时候最多一个未释放的配音控制器，且启动完成后生效的是最新设置。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configure, createHarness, FakeDubbing, wait, type Harness } from './harness';

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

const live = () => FakeDubbing.all.filter((d) => !d.disposed);
const latest = (h: Harness) => h.coordinator.buildSnapshot(1).sessions[0]!;

async function startVoice(h: Harness) {
  const ui = await configure(h);
  await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
  const c = h.content(1);
  c.hello();
  c.navigate('aaaaaaaaaaa');
  return { ui, c };
}

describe('dubbing controller during session start', () => {
  it('an audio change while the host permission check is pending leaves one controller with the new volume', async () => {
    const h = harness();
    const { ui, c } = await startVoice(h);
    const permission = deferred();
    h.permissionGranted.delay = permission.promise;
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(20);
    await ui.command({ kind: 'settings/update', patch: { audio: { dubVolume: 0.2 } } });
    expect(latest(h).phase).toBe('starting');
    expect(live().length).toBeLessThanOrEqual(1);
    permission.resolve();
    h.permissionGranted.delay = undefined;
    await wait(20);
    c.trackData();
    await wait(50);
    expect(latest(h).phase).toBe('running');
    expect(live()).toHaveLength(1);
    expect(live()[0]!.configs.at(-1)?.volume).toBe(0.2);
    // 被替换的控制器（若曾创建）必须已释放。
    expect(FakeDubbing.all.every((d) => d === live()[0] || d.disposed)).toBe(true);
    await ui.command({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
    expect(live()).toHaveLength(0);
  });

  it('a voice change during protocol detection replaces rather than leaks the controller', async () => {
    const h = harness();
    const { ui, c } = await startVoice(h);
    await ui.command({ kind: 'settings/update', patch: { provider: { protocol: 'auto' } } });
    const detection = deferred();
    const check = h.deps.runTextConnectionCheck;
    h.deps.runTextConnectionCheck = async (input) => {
      await detection.promise;
      return check(input);
    };
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(20);
    await ui.command({
      kind: 'settings/update',
      patch: { audio: { voiceName: 'Tingting', rate: 1.3 } },
    });
    await ui.command({ kind: 'settings/update', patch: { audio: { voiceName: 'Meijia' } } });
    expect(latest(h).phase).toBe('starting');
    expect(live().length).toBeLessThanOrEqual(1);
    detection.resolve();
    await wait(20);
    c.trackData();
    await wait(50);
    expect(latest(h).phase).toBe('running');
    expect(live()).toHaveLength(1);
    expect(live()[0]!.configs.at(-1)).toMatchObject({ voiceName: 'Meijia', rate: 1.3 });
  });

  it('changes after the controller exists (waiting for the track) reconfigure the same single controller', async () => {
    const h = harness();
    const { ui, c } = await startVoice(h);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(20);
    expect(latest(h).phase).toBe('starting');
    expect(live()).toHaveLength(1);
    const controller = live()[0]!;
    await ui.command({
      kind: 'settings/update',
      patch: { audio: { dubVolume: 0.4 }, pauseDubWithVideo: false },
    });
    c.trackData();
    await wait(50);
    expect(latest(h).phase).toBe('running');
    expect(live()).toEqual([controller]);
    expect(controller.configs.at(-1)).toMatchObject({ volume: 0.4, pauseWithVideo: false });
  });
});

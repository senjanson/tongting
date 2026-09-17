import { describe, expect, it } from 'vitest';
import { createDuckController, type VolumeTarget } from '@src/youtube/ducking';

function target(volume: number): VolumeTarget {
  return { volume };
}

describe('duck controller', () => {
  it('ducks relative to the user volume and restores it when nothing changed', () => {
    const d = createDuckController();
    const v = target(0.8);
    d.attach(v);
    expect(d.duck(v, 0.25)).toEqual({ applied: true, volume: 0.2 });
    expect(v.volume).toBeCloseTo(0.2);
    d.onVolumeChange(v); // 自己设置触发的事件
    expect(d.active).toBe(true);
    expect(d.release(v)).toEqual({ applied: true, volume: 0.8 });
    expect(v.volume).toBe(0.8);
    expect(d.active).toBe(false);
  });

  it('T17: a user volume change during ducking becomes the new intent and is not overwritten', () => {
    const d = createDuckController();
    const v = target(1);
    d.attach(v);
    d.duck(v, 0.3);
    v.volume = 0.5; // 用户拖动音量
    d.onVolumeChange(v);
    expect(d.active).toBe(false);
    expect(d.baseVolume).toBe(0.5);
    // 被用户覆盖：release 回报 user-override（worker 可感知），且不恢复旧快照。
    expect(d.release(v)).toEqual({ applied: false, reason: 'user-override' });
    expect(v.volume).toBe(0.5);
    expect(d.release(v)).toEqual({ applied: false, reason: 'not-active' });
  });

  it('T17: release before the volumechange event is dispatched still keeps the user value', () => {
    const d = createDuckController();
    const v = target(0.9);
    d.attach(v);
    d.duck(v, 0.5);
    v.volume = 0.7;
    expect(d.release(v)).toEqual({ applied: false, reason: 'user-override' });
    expect(v.volume).toBe(0.7);
  });

  it('a new duck after a user change uses the latest user volume as base', () => {
    const d = createDuckController();
    const v = target(1);
    d.attach(v);
    d.duck(v, 0.5);
    v.volume = 0.6; // 事件尚未处理
    expect(d.duck(v, 0.5)).toEqual({ applied: true, volume: 0.3 });
    expect(d.release(v)).toEqual({ applied: true, volume: 0.6 });
  });

  it('repeated duck with a new level keeps the original base', () => {
    const d = createDuckController();
    const v = target(0.8);
    d.attach(v);
    d.duck(v, 0.5);
    d.duck(v, 0.25);
    expect(v.volume).toBeCloseTo(0.2);
    d.release(v);
    expect(v.volume).toBe(0.8);
  });

  it('T40: late calls on an old video element do not touch the new element and do not throw', () => {
    const d = createDuckController();
    const oldVideo = target(1);
    d.attach(oldVideo);
    d.duck(oldVideo, 0.2);
    const newVideo = target(0.9);
    d.attach(newVideo);
    expect(d.release(oldVideo)).toEqual({ applied: false, reason: 'stale-target' });
    expect(d.duck(oldVideo, 0.1)).toEqual({ applied: false, reason: 'stale-target' });
    d.onVolumeChange(oldVideo);
    expect(newVideo.volume).toBe(0.9);
    expect(d.release(newVideo)).toEqual({ applied: false, reason: 'not-active' });
  });

  it('survives throwing volume accessors and clamps levels', () => {
    const d = createDuckController();
    const broken = {
      get volume(): number {
        throw new Error('detached');
      },
      set volume(_v: number) {
        throw new Error('detached');
      },
    };
    d.attach(broken);
    expect(d.duck(broken, 0.5)).toEqual({ applied: false, reason: 'error' });
    const v = target(0.5);
    d.attach(v);
    expect(d.duck(v, 7)).toEqual({ applied: true, volume: 0.5 });
    expect(d.releaseCurrent()).toEqual({ applied: true, volume: 0.5 });
    d.attach(null);
    expect(d.releaseCurrent()).toEqual({ applied: false, reason: 'not-active' });
  });
});

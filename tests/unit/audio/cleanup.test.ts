import { describe, expect, it, vi } from 'vitest';
import { releaseAll, releaseAllSync, ResourceBag, stopAllTracks } from '@src/audio/cleanup';

describe('cleanup (T26)', () => {
  it('continues releasing after sync and async failures', async () => {
    const calls: string[] = [];
    const report = await releaseAll([
      ['a', () => void calls.push('a')],
      [
        'b',
        () => {
          calls.push('b');
          throw new Error('boom');
        },
      ],
      [
        'c',
        async () => {
          calls.push('c');
          throw new Error('async boom');
        },
      ],
      ['skip', null],
      ['d', async () => void calls.push('d')],
    ]);
    expect(calls).toEqual(['a', 'b', 'c', 'd']);
    expect(report.released).toEqual(['a', 'd']);
    expect(report.failed.map((f) => f.name)).toEqual(['b', 'c']);
    const sync = releaseAllSync([
      [
        'x',
        () => {
          throw new Error('x');
        },
      ],
      ['y', () => void calls.push('y')],
    ]);
    expect(sync.failed).toHaveLength(1);
    expect(calls).toContain('y');
  });

  it('ResourceBag releases in reverse order, once, and supports individual release', async () => {
    const bag = new ResourceBag();
    const order: string[] = [];
    bag.add('first', () => void order.push('first'));
    const releaseSecond = bag.add('second', () => void order.push('second'));
    bag.add('third', () => {
      order.push('third');
      throw new Error('fail');
    });
    await releaseSecond();
    await releaseSecond();
    expect(bag.names()).toEqual(['first', 'third']);
    const report = await bag.releaseAll();
    expect(order).toEqual(['second', 'third', 'first']);
    expect(report.failed.map((f) => f.name)).toEqual(['third']);
    expect((await bag.releaseAll()).released).toEqual([]);
    expect(bag.size).toBe(0);
  });

  it('stopAllTracks stops every track even if one throws', () => {
    const good = { stop: vi.fn() };
    const bad = {
      stop: vi.fn(() => {
        throw new Error('x');
      }),
    };
    const other = { stop: vi.fn() };
    const stream = { getTracks: () => [good, bad, other] as unknown as MediaStreamTrack[] };
    expect(stopAllTracks(stream)).toBe(2);
    expect(good.stop).toHaveBeenCalled();
    expect(other.stop).toHaveBeenCalled();
    expect(stopAllTracks(null)).toBe(0);
    expect(
      stopAllTracks({
        getTracks: () => {
          throw new Error('gone');
        },
      }),
    ).toBe(0);
  });
});

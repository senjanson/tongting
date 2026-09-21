import { describe, expect, it } from 'vitest';
import { maxRequestOverlap } from './request-overlap';

describe('HTTP concurrency observation', () => {
  it('counts serial requests correctly even when a later start shares an earlier request timestamp', () => {
    const requests = [
      { receivedAt: 100, finishedAt: 100, startedOrder: 1, finishedOrder: 2 },
      { receivedAt: 100, finishedAt: 101, startedOrder: 3, finishedOrder: 4 },
    ];
    expect(maxRequestOverlap(requests)).toBe(1);
  });

  it('detects real overlap even when both requests begin and finish in the same millisecond', () => {
    const requests = [
      { receivedAt: 100, finishedAt: 100, startedOrder: 1, finishedOrder: 3 },
      { receivedAt: 100, finishedAt: 100, startedOrder: 2, finishedOrder: 4 },
    ];
    expect(maxRequestOverlap(requests)).toBe(2);
  });

  it('includes unfinished requests and handles an empty selection', () => {
    expect(maxRequestOverlap([])).toBe(0);
    expect(maxRequestOverlap([{ startedOrder: 1 }, { startedOrder: 2, finishedOrder: 3 }])).toBe(2);
  });
});

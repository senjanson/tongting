import { describe, expect, it } from 'vitest';
import {
  applyCuesMessage,
  resyncCuesState,
  subscribeCuesState,
  IDLE_CUES_STATE,
} from '@src/ui/state/cues';
import { parseBackgroundMessage, shouldAcceptSnapshot } from '@src/ui/state/snapshot';
import type { CuesMessage } from '@src/ui/state/snapshot';
import { makeCue, makeSnapshot } from './fixtures';

function cuesMessage(
  partial: Partial<CuesMessage> & Pick<CuesMessage, 'cueVersion' | 'full' | 'cues'>,
): CuesMessage {
  return { type: 'cues', sessionId: 'session-00000001', ...partial };
}

describe('snapshot ordering', () => {
  it('accepts only newer snapshots from the same worker instance', () => {
    const v5 = makeSnapshot({ snapshotVersion: 5 });
    expect(shouldAcceptSnapshot(null, v5)).toBe(true);
    expect(shouldAcceptSnapshot(v5, makeSnapshot({ snapshotVersion: 4 }))).toBe(false);
    expect(shouldAcceptSnapshot(v5, makeSnapshot({ snapshotVersion: 5 }))).toBe(false);
    expect(shouldAcceptSnapshot(v5, makeSnapshot({ snapshotVersion: 6 }))).toBe(true);
  });

  it('treats a new workerInstanceId as a restarted sequence', () => {
    const old = makeSnapshot({ snapshotVersion: 90, workerInstanceId: 'worker-a' });
    expect(
      shouldAcceptSnapshot(old, makeSnapshot({ snapshotVersion: 1, workerInstanceId: 'worker-b' })),
    ).toBe(true);
  });

  it('rejects malformed inbound messages', () => {
    expect(
      parseBackgroundMessage({ type: 'snapshot', snapshot: { snapshotVersion: 'x' } }),
    ).toBeNull();
    expect(parseBackgroundMessage({ type: 'unknown' })).toBeNull();
    expect(parseBackgroundMessage(null)).toBeNull();
    const ok = parseBackgroundMessage({ type: 'snapshot', snapshot: makeSnapshot() });
    expect(ok?.type).toBe('snapshot');
    // 快照中出现 Key 等未知字段会被 schema 剥离，不会进入 UI 状态
    const withSecret = parseBackgroundMessage({
      type: 'snapshot',
      snapshot: { ...makeSnapshot(), apiKey: 'sk-secret-value-123' },
    });
    expect(JSON.stringify(withSecret)).not.toContain('sk-secret');
  });
});

describe('cue mirror', () => {
  it('ignores deltas until a full baseline arrives, then applies ordered deltas', () => {
    let state = subscribeCuesState('session-00000001');
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 3, full: false, cues: [makeCue('x', 0)] }),
    );
    expect(state.status).toBe('loading');
    expect(state.cues).toHaveLength(0);

    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 3, full: true, cues: [makeCue('b', 5_000), makeCue('a', 1_000)] }),
    );
    expect(state.status).toBe('ready');
    expect(state.cues.map((c) => c.id)).toEqual(['a', 'b']);
    const untouched = state.cues[1];

    // 增量：更新 a 的译文、新增 c（插到中间）、删除不存在的 id 不报错
    state = applyCuesMessage(
      state,
      cuesMessage({
        cueVersion: 4,
        full: false,
        cues: [makeCue('a', 1_000, { translatedText: '新译文' }), makeCue('c', 3_000)],
        removedIds: ['zzz'],
      }),
    );
    expect(state.cues.map((c) => c.id)).toEqual(['a', 'c', 'b']);
    expect(state.cues[0]!.translatedText).toBe('新译文');
    expect(state.cues[2]).toBe(untouched);

    // 过期或重复版本被忽略
    const before = state;
    expect(
      applyCuesMessage(state, cuesMessage({ cueVersion: 4, full: false, cues: [makeCue('d', 0)] })),
    ).toBe(before);
    expect(applyCuesMessage(state, cuesMessage({ cueVersion: 2, full: true, cues: [] }))).toBe(
      before,
    );

    // 删除
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 5, full: false, cues: [], removedIds: ['c'] }),
    );
    expect(state.cues.map((c) => c.id)).toEqual(['a', 'b']);

    // 修订改变时间后重新排序
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 6, full: false, cues: [makeCue('b', 0, { revision: 1 })] }),
    );
    expect(state.cues.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('ignores messages for other sessions and when idle', () => {
    const state = subscribeCuesState('session-00000001');
    expect(
      applyCuesMessage(state, {
        ...cuesMessage({ cueVersion: 1, full: true, cues: [] }),
        sessionId: 'other-session',
      }),
    ).toBe(state);
    expect(
      applyCuesMessage(IDLE_CUES_STATE, cuesMessage({ cueVersion: 1, full: true, cues: [] })),
    ).toBe(IDLE_CUES_STATE);
  });

  it('after resync (reconnect / worker restart) accepts a full baseline with a lower cueVersion', () => {
    let state = subscribeCuesState('session-00000001');
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 50, full: true, cues: [makeCue('a', 0)] }),
    );
    state = resyncCuesState(state);
    expect(state.status).toBe('loading');
    expect(state.cues).toHaveLength(1); // 保留旧内容直到新基线到达
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 50, full: false, cues: [makeCue('late', 0)] }),
    );
    expect(state.cues.map((c) => c.id)).toEqual(['a']);
    state = applyCuesMessage(
      state,
      cuesMessage({ cueVersion: 1, full: true, cues: [makeCue('n', 0)] }),
    );
    expect(state).toMatchObject({ status: 'ready', cueVersion: 1 });
    expect(state.cues.map((c) => c.id)).toEqual(['n']);
  });
});

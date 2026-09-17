import { describe, expect, it } from 'vitest';
import type { DisplayCue } from '@src/messaging/content-protocol';
import {
  createCueStore,
  type OverlaySession,
  type SessionCuesMsg,
} from '@src/youtube/overlay/cue-store';

const session = (over: Partial<OverlaySession> = {}): OverlaySession => ({
  sessionId: 's1-aaaaaaaa',
  epoch: 1,
  videoId: 'AAAAAAAAAAA',
  phase: 'running',
  outputMode: 'subtitle',
  ...over,
});

const cue = (id: string, startMs: number, over: Partial<DisplayCue> = {}): DisplayCue => ({
  id,
  revision: 0,
  startMs,
  endMs: startMs + 1000,
  sourceText: `text ${id}`,
  translationState: 'pending',
  stability: 'final',
  ...over,
});

const cues = (over: Partial<SessionCuesMsg>): SessionCuesMsg => ({
  type: 'session/cues',
  sessionId: 's1-aaaaaaaa',
  epoch: 1,
  cueVersion: 1,
  full: true,
  cues: [],
  ...over,
});

describe('overlay cue store', () => {
  it('drops cues without a session or for another session', () => {
    const s = createCueStore();
    expect(s.applyCues(cues({ cues: [cue('a', 0)] }))).toBe(false);
    s.setSession(session());
    expect(s.applyCues(cues({ sessionId: 'other-session', cues: [cue('a', 0)] }))).toBe(false);
    expect(s.applyCues(cues({ cues: [cue('a', 0)] }))).toBe(true);
    expect(s.cues.map((c) => c.id)).toEqual(['a']);
  });

  it('drops stale cueVersion and older epochs, follows newer epochs', () => {
    const s = createCueStore();
    s.setSession(session({ epoch: 2 }));
    expect(s.applyCues(cues({ epoch: 1, cueVersion: 5, cues: [cue('old', 0)] }))).toBe(false);
    expect(
      s.applyCues(cues({ epoch: 2, cueVersion: 5, cues: [cue('b', 1000), cue('a', 0)] })),
    ).toBe(true);
    expect(s.cues.map((c) => c.id)).toEqual(['a', 'b']);
    expect(
      s.applyCues(cues({ epoch: 2, cueVersion: 5, full: false, cues: [cue('c', 3000)] })),
    ).toBe(false);
    expect(
      s.applyCues(cues({ epoch: 3, cueVersion: 6, full: false, cues: [cue('c', 3000)] })),
    ).toBe(true);
    expect(s.session?.epoch).toBe(3);
    expect(
      s.applyCues(cues({ epoch: 2, cueVersion: 7, full: false, cues: [cue('d', 4000)] })),
    ).toBe(false);
  });

  it('applies incremental upserts by revision and removals', () => {
    const s = createCueStore();
    s.setSession(session());
    s.applyCues(cues({ cueVersion: 1, cues: [cue('a', 0, { revision: 2 }), cue('b', 1000)] }));
    s.applyCues(
      cues({
        cueVersion: 2,
        full: false,
        cues: [cue('a', 0, { revision: 1, sourceText: 'older' })],
      }),
    );
    expect(s.cues[0]!.revision).toBe(2);
    s.applyCues(
      cues({
        cueVersion: 3,
        full: false,
        cues: [cue('a', 0, { revision: 3, translatedText: '译文', translationState: 'done' })],
        removedIds: ['b'],
      }),
    );
    expect(s.cues).toHaveLength(1);
    expect(s.cues[0]!.translatedText).toBe('译文');
  });

  it('clears on session change or null and re-establishes the version baseline after reconnect', () => {
    const s = createCueStore();
    s.setSession(session());
    s.applyCues(cues({ cueVersion: 10, cues: [cue('a', 0)] }));
    expect(s.setSession(session({ phase: 'paused' })).cleared).toBe(false);
    expect(s.cues).toHaveLength(1);
    // worker 重启后 cueVersion 从更小的值开始。
    expect(s.applyCues(cues({ cueVersion: 2, cues: [cue('x', 0)] }))).toBe(false);
    s.resetVersionBaseline();
    expect(s.applyCues(cues({ cueVersion: 2, cues: [cue('x', 0)] }))).toBe(true);
    expect(s.setSession(session({ sessionId: 's2-bbbbbbbb' })).cleared).toBe(true);
    expect(s.cues).toHaveLength(0);
    s.applyCues(cues({ sessionId: 's2-bbbbbbbb', cueVersion: 1, cues: [cue('y', 0)] }));
    expect(s.setSession(null).cleared).toBe(true);
    expect(s.cues).toHaveLength(0);
    expect(s.session).toBeNull();
  });
});

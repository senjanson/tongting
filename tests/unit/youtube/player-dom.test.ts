// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlayerStateSchema } from '@src/domain/session';
import {
  createPlayerAdapter,
  readMediaSnapshot,
  type PlayerAdapter,
} from '@src/youtube/player-adapter';
import { readVisibleCaptionText } from '@src/youtube/selectors';
import { createVisibleCaptionObserver } from '@src/youtube/visible-captions';

function buildPlayer() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'movie_player';
  root.className = 'html5-video-player';
  const video = document.createElement('video');
  video.className = 'html5-main-video';
  root.append(video);
  document.body.append(root);
  return { root, video };
}

function addCaptions(root: HTMLElement, lines: string[]) {
  root.querySelector('.ytp-caption-window-container')?.remove();
  const container = document.createElement('div');
  container.className = 'ytp-caption-window-container';
  const win = document.createElement('div');
  win.className = 'caption-window';
  for (const line of lines) {
    const visual = document.createElement('span');
    visual.className = 'caption-visual-line';
    const seg = document.createElement('span');
    seg.className = 'ytp-caption-segment';
    seg.textContent = line;
    visual.append(seg);
    win.append(visual);
  }
  container.append(win);
  root.append(container);
  return container;
}

let adapters: PlayerAdapter[] = [];
afterEach(() => {
  for (const a of adapters) a.dispose();
  adapters = [];
});

describe('player adapter', () => {
  it('reports media events and unbinds listeners from a replaced video element (T37)', () => {
    const { video } = buildPlayer();
    const events: Array<[string, HTMLVideoElement | null]> = [];
    const adapter = createPlayerAdapter({
      doc: document,
      win: window,
      getPageKind: () => 'watch',
      onEvent: (e) => events.push([e.reason, e.video]),
      pollMs: 10_000,
    });
    adapters.push(adapter);
    expect(adapter.video).toBe(video);
    expect(events).toEqual([['video-replaced', video]]);
    video.dispatchEvent(new Event('play'));
    video.dispatchEvent(new Event('seeked'));
    expect(events.map((e) => e[0])).toEqual(['video-replaced', 'play', 'seeked']);

    const replacement = document.createElement('video');
    replacement.className = 'html5-main-video';
    video.replaceWith(replacement);
    adapter.scan();
    expect(adapter.video).toBe(replacement);
    events.length = 0;
    video.dispatchEvent(new Event('pause')); // 旧元素的事件不再上报
    replacement.dispatchEvent(new Event('pause'));
    expect(events).toEqual([['pause', replacement]]);
  });

  it('detects ads from the player root class and produces schema-valid snapshots', async () => {
    const { root, video } = buildPlayer();
    const reasons: string[] = [];
    const adapter = createPlayerAdapter({
      doc: document,
      win: window,
      getPageKind: () => 'watch',
      onEvent: (e) => reasons.push(e.reason),
      pollMs: 10_000,
    });
    adapters.push(adapter);
    root.classList.add('ad-showing');
    await vi.waitFor(() => expect(reasons).toContain('ad-start'));
    root.classList.remove('ad-showing');
    await vi.waitFor(() => expect(reasons).toContain('ad-end'));
    video.currentTime = 12.3456;
    const snap = readMediaSnapshot(video, root, document, false, 123);
    expect(snap.currentTimeMs).toBe(12_346);
    const state = { ...snap, videoId: 'AAAAAAAAAAA', isLive: false, isShorts: false };
    expect(PlayerStateSchema.safeParse(state).success).toBe(true);
  });

  it('stops everything on dispose', () => {
    const { video } = buildPlayer();
    const onEvent = vi.fn();
    const adapter = createPlayerAdapter({
      doc: document,
      win: window,
      getPageKind: () => 'watch',
      onEvent,
      pollMs: 10_000,
    });
    onEvent.mockClear();
    adapter.dispose();
    adapter.dispose();
    video.dispatchEvent(new Event('play'));
    adapter.scan();
    expect(onEvent).not.toHaveBeenCalled();
    expect(adapter.video).toBeNull();
  });
});

describe('visible caption observer', () => {
  it('reads caption lines and emits only on change, including clearing', async () => {
    const { root } = buildPlayer();
    const texts: string[] = [];
    const obs = createVisibleCaptionObserver({
      onText: (t) => texts.push(t),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id as number),
      coalesceMs: 5,
      heartbeatMs: 0,
    });
    const container = addCaptions(root, ['hello <b>world</b>', 'second']);
    expect(readVisibleCaptionText(root)).toEqual({
      text: 'hello <b>world</b>\nsecond',
      present: true,
    });
    obs.enable(root);
    await vi.waitFor(() => expect(texts).toEqual(['hello <b>world</b>\nsecond']));
    container.querySelector('.ytp-caption-segment')!.textContent = 'hello <b>world</b> again';
    await vi.waitFor(() => expect(texts).toHaveLength(2));
    container.remove();
    await vi.waitFor(() =>
      expect(texts).toEqual(['hello <b>world</b>\nsecond', 'hello <b>world</b> again\nsecond', '']),
    );
    obs.disable();
    addCaptions(root, ['ignored while disabled']);
    await new Promise((r) => setTimeout(r, 30));
    expect(texts).toHaveLength(3);
    obs.dispose();
  });
});

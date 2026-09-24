import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlaybackBufferController,
  type PlaybackBufferController,
  type PlaybackBufferPolicy,
} from '@src/youtube/playback-buffer';

function fakeVideo(paused = false) {
  const video = {
    paused,
    currentTime: 20,
    duration: 300,
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

function policy(overrides: Partial<PlaybackBufferPolicy> = {}): PlaybackBufferPolicy {
  return {
    sessionId: 'session-a',
    epoch: 1,
    videoId: 'video-a',
    enabled: true,
    active: true,
    readyUntilMs: 25_000,
    targetMs: 10_000,
    blocked: false,
    ...overrides,
  };
}

describe('playback buffer controller', () => {
  let video: ReturnType<typeof fakeVideo>;
  let current: ReturnType<typeof fakeVideo> | null;
  let gate: PlaybackBufferController;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    video = fakeVideo();
    current = video;
    gate = createPlaybackBufferController({
      getVideo: () => current as unknown as HTMLVideoElement | null,
    });
  });

  afterEach(() => {
    gate.dispose();
    vi.useRealTimers();
  });

  it('holds startup until the target is ready and ignores its own pause event', async () => {
    gate.update(policy());
    expect(video.paused).toBe(true);
    expect(gate.stats()).toEqual({ holding: true, userPaused: false });
    gate.onMediaEvent('pause');
    gate.update(policy({ readyUntilMs: 29_999 }));
    expect(video.play).not.toHaveBeenCalled();
    gate.update(policy({ readyUntilMs: 30_000 }));
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
    expect(gate.stats().holding).toBe(false);
  });

  it('does not interrupt a sentence three seconds early; rebuffering starts at 500ms', async () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    video.currentTime = 27;
    vi.advanceTimersByTime(100);
    expect(video.pause).not.toHaveBeenCalled();
    video.currentTime = 29.499;
    vi.advanceTimersByTime(100);
    expect(video.pause).not.toHaveBeenCalled();
    video.currentTime = 29.5;
    vi.advanceTimersByTime(100);
    expect(video.paused).toBe(true);
    gate.update(policy({ readyUntilMs: 35_000 }));
    expect(video.play).not.toHaveBeenCalled();
    gate.update(policy({ readyUntilMs: 39_500 }));
    await Promise.resolve();
    expect(video.paused).toBe(false);
  });

  it('allows the final short tail and does not attempt to restart an ended video', () => {
    video.currentTime = 296;
    gate.update(policy({ readyUntilMs: 299_900 }));
    expect(video.pause).not.toHaveBeenCalled();
    video.ended = true;
    video.paused = true;
    gate.onMediaEvent('ended');
    gate.update(policy({ readyUntilMs: 300_000 }));
    expect(video.play).not.toHaveBeenCalled();
  });

  it('never starts a video that was paused before translation began', () => {
    video.paused = true;
    gate.update(policy());
    gate.update(policy({ readyUntilMs: 300_000 }));
    vi.advanceTimersByTime(500);
    expect(video.play).not.toHaveBeenCalled();
    expect(gate.stats()).toEqual({ holding: false, userPaused: true });
  });

  it('explicit pause while held revokes auto-resume even without a new native pause event', () => {
    gate.update(policy());
    gate.userIntent('pause');
    gate.onMediaEvent('pause'); // delayed event from the gate's pause
    gate.update(policy({ readyUntilMs: 30_000 }));
    expect(video.play).not.toHaveBeenCalled();
    expect(gate.stats()).toEqual({ holding: false, userPaused: true });
  });

  it('an explicit play hands control to the native player before buffering again', async () => {
    gate.update(policy());
    gate.onMediaEvent('pause');
    gate.userIntent('play');
    expect(gate.stats().holding).toBe(false);
    // Only the player's actual play event grants new buffering ownership.
    video.paused = false;
    gate.onMediaEvent('play');
    expect(gate.stats().holding).toBe(true);
    gate.onMediaEvent('pause');
    gate.update(policy({ readyUntilMs: 30_000 }));
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('does not autoplay ahead of a delayed native picture-click toggle', async () => {
    video.paused = true;
    gate.update(policy({ readyUntilMs: 40_000 }));
    gate.userIntent('play');
    // A picture click can wait for a possible double-click before toggling.
    // Both the 100ms gate timer and a worker heartbeat run in that interval.
    await vi.advanceTimersByTimeAsync(200);
    gate.update(policy({ readyUntilMs: 40_000 }));
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
    video.paused = !video.paused;
    gate.onMediaEvent(video.paused ? 'pause' : 'play');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(video.paused).toBe(false);
    expect(gate.stats()).toEqual({ holding: false, userPaused: false });
  });

  it('does not turn a cancelled picture click into an automatic play', () => {
    gate.update(policy());
    gate.onMediaEvent('pause');
    gate.userIntent('play');
    // Fullscreen/double-click can consume the gesture without a native play.
    gate.update(policy({ readyUntilMs: 40_000 }));
    vi.advanceTimersByTime(1_000);
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
  });

  it('does not pause ahead of a delayed native pause toggle at the low-water mark', () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    video.currentTime = 29.5;
    gate.userIntent('pause');
    vi.advanceTimersByTime(200);
    gate.update(policy({ readyUntilMs: 30_000 }));
    expect(video.pause).not.toHaveBeenCalled();
    video.paused = !video.paused;
    gate.onMediaEvent(video.paused ? 'pause' : 'play');
    gate.update(policy({ readyUntilMs: 45_000 }));
    vi.advanceTimersByTime(1_000);
    expect(video.paused).toBe(true);
    expect(video.play).not.toHaveBeenCalled();
    expect(gate.stats()).toEqual({ holding: false, userPaused: true });
  });

  it('resumes buffer supervision when a pause gesture is cancelled without pausing', () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    video.currentTime = 29.5;
    gate.userIntent('pause');
    vi.advanceTimersByTime(500);
    expect(video.pause).not.toHaveBeenCalled();
    // No native pause follows (for example, a double-click opens fullscreen).
    vi.advanceTimersByTime(500);
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(gate.stats()).toEqual({ holding: true, userPaused: false });
    gate.onMediaEvent('pause');
    gate.update(policy({ readyUntilMs: 45_000 }));
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('does not race the native toggle when a capture-phase listener records play', () => {
    video.paused = true;
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.userIntent('play');
    expect(video.play).not.toHaveBeenCalled();
    // YouTube processes the click after the extension's capture-phase listener.
    video.paused = !video.paused;
    gate.onMediaEvent('play');
    vi.advanceTimersByTime(100);
    expect(video.paused).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('recognizes an external pause after its own queued media events', async () => {
    gate.update(policy());
    gate.onMediaEvent('pause');
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.onMediaEvent('play');
    await Promise.resolve();
    video.paused = true;
    gate.onMediaEvent('pause');
    gate.update(policy({ readyUntilMs: 40_000 }));
    expect(gate.stats().userPaused).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it('seeking carries current play intent only into the new epoch and ignores old coverage', async () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.userIntent('seek');
    video.currentTime = 100;
    video.seeking = true;
    gate.onMediaEvent('seeking');
    gate.update(policy({ readyUntilMs: 300_000 }));
    expect(video.play).not.toHaveBeenCalled();
    gate.update(policy({ epoch: 2, readyUntilMs: 105_000 }));
    video.seeking = false;
    gate.onMediaEvent('seeked');
    gate.update(policy({ readyUntilMs: 300_000 })); // late epoch 1
    expect(video.play).not.toHaveBeenCalled();
    gate.update(policy({ epoch: 2, readyUntilMs: 110_000 }));
    await Promise.resolve();
    expect(video.paused).toBe(false);
  });

  it('a seek while user-paused or a pause during seeking never auto-resumes', () => {
    video.paused = true;
    gate.update(policy());
    gate.userIntent('seek');
    gate.update(policy({ epoch: 2, readyUntilMs: 300_000 }));
    gate.onMediaEvent('seeked');
    expect(video.play).not.toHaveBeenCalled();
    gate.userIntent('play');
    gate.userIntent('seek');
    gate.userIntent('pause');
    gate.update(policy({ epoch: 3, readyUntilMs: 300_000 }));
    gate.onMediaEvent('seeked');
    expect(video.paused).toBe(true);
  });

  it('accepts the next seek when the preceding seeked event preceded its policy update', async () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.userIntent('seek');
    video.currentTime = 100;
    gate.onMediaEvent('seeking');
    gate.onMediaEvent('seeked');
    gate.update(policy({ epoch: 2, readyUntilMs: 110_000 }));
    gate.onMediaEvent('play');
    await Promise.resolve();
    gate.userIntent('seek');
    video.currentTime = 200;
    gate.onMediaEvent('seeking');
    gate.onMediaEvent('seeked');
    gate.update(policy({ epoch: 3, readyUntilMs: 210_000 }));
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(2);
    expect(video.paused).toBe(false);
  });

  it.each([false, true])(
    'two completed seeks before policy acknowledgement preserve only the latest intent (user pause: %s)',
    async (pauseDuringSeek) => {
      gate.update(policy({ epoch: 0, readyUntilMs: 30_000 }));
      gate.userIntent('seek');
      video.currentTime = 65;
      gate.onMediaEvent('seeking');
      gate.onMediaEvent('seeked');
      gate.userIntent('seek');
      video.currentTime = 80;
      gate.onMediaEvent('seeking');
      gate.onMediaEvent('seeked');
      if (pauseDuringSeek) gate.userIntent('pause');
      // Earlier seek's coverage may extend past the new location, but its
      // acknowledgement must not start the video under the wrong epoch.
      gate.update(policy({ epoch: 1, readyUntilMs: 300_000 }));
      vi.advanceTimersByTime(200);
      expect(video.play).not.toHaveBeenCalled();
      gate.update(policy({ epoch: 2, readyUntilMs: 85_000 }));
      expect(video.play).not.toHaveBeenCalled();
      gate.update(policy({ epoch: 2, readyUntilMs: 90_000 }));
      await Promise.resolve();
      expect(video.play).toHaveBeenCalledTimes(pauseDuringSeek ? 0 : 1);
      expect(video.paused).toBe(pauseDuringSeek);
    },
  );

  it('coalesced seek controls with a single native seeked need only one new epoch', async () => {
    gate.update(policy({ epoch: 0, readyUntilMs: 30_000 }));
    gate.userIntent('seek');
    video.currentTime = 65;
    gate.onMediaEvent('seeking');
    gate.userIntent('seek');
    video.currentTime = 80;
    gate.onMediaEvent('seeking');
    gate.onMediaEvent('seeked');
    gate.update(policy({ epoch: 1, readyUntilMs: 90_000 }));
    await Promise.resolve();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.paused).toBe(false);
  });

  it.each(['enabled', 'active'] as const)(
    'turning %s off releases ownership without autoplay',
    (key) => {
      gate.update(policy());
      gate.update(policy({ [key]: false, readyUntilMs: 300_000 }));
      expect(gate.stats().holding).toBe(false);
      expect(video.paused).toBe(true);
      expect(video.play).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      gate.userIntent('play');
      video.paused = false;
      vi.advanceTimersByTime(1_000);
      expect(video.paused).toBe(false);
    },
  );

  it('a permanent failure holds once, allows an explicit override, and never auto-resumes', () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.update(policy({ blocked: true }));
    expect(video.paused).toBe(true);
    expect(gate.stats().holding).toBe(false);
    gate.userIntent('play');
    video.paused = false;
    gate.onMediaEvent('play');
    gate.update(policy({ blocked: true }));
    vi.advanceTimersByTime(500);
    expect(video.paused).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it('changing epoch, session or video never reuses a held pause from the previous owner', () => {
    gate.update(policy());
    gate.update(policy({ epoch: 2, readyUntilMs: 300_000 }));
    expect(video.play).not.toHaveBeenCalled();
    gate.update(policy({ sessionId: 'session-b', readyUntilMs: 300_000 }));
    gate.update(policy({ readyUntilMs: 300_000 })); // retired session A
    expect(video.play).not.toHaveBeenCalled();
    current = fakeVideo(true);
    gate.onMediaEvent('video-replaced');
    gate.update(policy({ sessionId: 'session-c', videoId: 'video-c', readyUntilMs: 300_000 }));
    expect(current.play).not.toHaveBeenCalled();
  });

  it('a replaced element cannot be paused using an old policy before a fresh update', () => {
    gate.update(policy({ readyUntilMs: 30_000 }));
    current = fakeVideo();
    current.currentTime = 100;
    vi.advanceTimersByTime(100);
    expect(current.pause).not.toHaveBeenCalled();
    gate.update(policy({ sessionId: 'session-b', readyUntilMs: 101_000 }));
    expect(current.paused).toBe(true);
  });

  it('ads revoke held ownership; ad completion does not start a paused video', () => {
    gate.update(policy());
    gate.onMediaEvent('ad-start');
    gate.update(policy({ readyUntilMs: 300_000 }));
    gate.onMediaEvent('ad-end');
    expect(video.play).not.toHaveBeenCalled();
    expect(gate.stats().holding).toBe(false);
  });

  it('an ad survives reset and a cleared session, so a new policy never pauses the playing ad', () => {
    gate.onMediaEvent('video-replaced');
    gate.onMediaEvent('ad-start');
    // welcome resets the gate; a cleared session arrives as update(null).
    gate.reset();
    gate.update(policy({ readyUntilMs: 0 }));
    gate.update(null);
    gate.update(policy({ sessionId: 'session-b', readyUntilMs: 0 }));
    vi.advanceTimersByTime(500);
    expect(video.pause).not.toHaveBeenCalled();
    // After the ad the gate supervises the main video again.
    gate.onMediaEvent('ad-end');
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(gate.stats().holding).toBe(true);
  });

  it('a live ad reader is authoritative even when no ad event reached the gate', () => {
    gate.dispose();
    let adShowing = true;
    gate = createPlaybackBufferController({
      getVideo: () => current as unknown as HTMLVideoElement | null,
      isAdShowing: () => adShowing,
    });
    gate.update(policy({ readyUntilMs: 0 }));
    gate.reset();
    gate.update(policy({ readyUntilMs: 0 }));
    vi.advanceTimersByTime(500);
    expect(video.pause).not.toHaveBeenCalled();
    adShowing = false;
    vi.advanceTimersByTime(100);
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it('worker silence revokes auto-resume while a periodic heartbeat preserves ownership', () => {
    gate.update(policy());
    vi.advanceTimersByTime(9_000);
    gate.update(policy());
    vi.advanceTimersByTime(9_000);
    expect(gate.stats().holding).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(gate.stats().holding).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    gate.update(policy({ readyUntilMs: 30_000 }));
    expect(video.play).not.toHaveBeenCalled();
  });

  it('worker silence does not stop a normally playing video', () => {
    gate.update(policy({ readyUntilMs: 300_000 }));
    vi.advanceTimersByTime(10_000);
    expect(video.paused).toBe(false);
    expect(video.pause).not.toHaveBeenCalled();
  });

  it('late old epochs do not renew the worker lease', () => {
    gate.update(policy({ epoch: 2 }));
    vi.advanceTimersByTime(9_000);
    gate.update(policy({ readyUntilMs: 300_000 }));
    vi.advanceTimersByTime(1_000);
    expect(gate.stats().holding).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
  });

  it.each(['reset', 'dispose'] as const)(
    '%s leaves the held video paused and removes timers',
    (method) => {
      gate.update(policy());
      gate[method]();
      vi.advanceTimersByTime(10_000);
      expect(video.play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['pause', 'seek', 'epoch', 'session', 'ad', 'disable', 'reset', 'dispose'] as const)(
    'cancels real playback from a late play promise after %s',
    async (reason) => {
      let finish!: () => void;
      video.play.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              video.paused = false;
              resolve();
            };
          }),
      );
      gate.update(policy());
      gate.update(policy({ readyUntilMs: 30_000 }));
      if (reason === 'pause' || reason === 'seek') gate.userIntent(reason);
      else if (reason === 'epoch') gate.update(policy({ epoch: 2 }));
      else if (reason === 'session') gate.update(policy({ sessionId: 'session-b' }));
      else if (reason === 'ad') gate.onMediaEvent('ad-start');
      else if (reason === 'disable') gate.update(policy({ enabled: false }));
      else gate[reason]();
      finish();
      await Promise.resolve();
      expect(video.paused).toBe(true);
    },
  );

  it('an old play completion does not pause a newer explicit user play', async () => {
    let finish!: () => void;
    video.play.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    gate.update(policy());
    gate.update(policy({ readyUntilMs: 30_000 }));
    gate.userIntent('pause');
    gate.update(policy({ enabled: false }));
    gate.userIntent('play');
    video.paused = false;
    finish();
    await Promise.resolve();
    expect(video.paused).toBe(false);
  });

  it('cancels late playback on the old element without touching a replacement', async () => {
    let finish!: () => void;
    video.play.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            video.paused = false;
            resolve();
          };
        }),
    );
    gate.update(policy());
    gate.update(policy({ readyUntilMs: 30_000 }));
    current = fakeVideo();
    gate.onMediaEvent('video-replaced');
    gate.update(policy({ sessionId: 'session-b', readyUntilMs: 30_000 }));
    finish();
    await Promise.resolve();
    expect(video.paused).toBe(true);
    expect(current.paused).toBe(false);
    expect(current.pause).not.toHaveBeenCalled();
  });

  it('autoplay rejection and a throwing pause do not produce retry loops', async () => {
    video.play.mockRejectedValue(new Error('autoplay blocked'));
    gate.update(policy());
    gate.update(policy({ readyUntilMs: 30_000 }));
    await Promise.resolve();
    vi.advanceTimersByTime(1_000);
    gate.update(policy({ readyUntilMs: 40_000 }));
    expect(video.play).toHaveBeenCalledTimes(1);
    gate.reset();
    video.paused = false;
    video.pause.mockImplementation(() => {
      throw new Error('detached player');
    });
    const before = video.pause.mock.calls.length;
    gate.update(policy());
    vi.advanceTimersByTime(1_000);
    expect(video.pause).toHaveBeenCalledTimes(before + 1);
  });

  it('notifies status changes without publishing every supervision tick', () => {
    gate.dispose();
    const onStatus = vi.fn();
    gate = createPlaybackBufferController({
      getVideo: () => video as unknown as HTMLVideoElement,
      onStatus,
    });
    gate.update(policy());
    vi.advanceTimersByTime(1_000);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith({ holding: true, userPaused: false });
  });

  it('does not begin playback if a status subscriber cancels during the resume notification', () => {
    gate.dispose();
    gate = createPlaybackBufferController({
      getVideo: () => video as unknown as HTMLVideoElement,
      onStatus: (status) => {
        if (!status.holding) gate.reset();
      },
    });
    gate.update(policy());
    gate.update(policy({ readyUntilMs: 30_000 }));
    expect(video.play).not.toHaveBeenCalled();
    expect(video.paused).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

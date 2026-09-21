/** A media-time gate for already translated video. It never fetches or reads audio. */
export interface PlaybackBufferPolicy {
  sessionId: string;
  epoch: number;
  videoId: string;
  enabled: boolean;
  active: boolean;
  readyUntilMs: number;
  targetMs: number;
  /** An unrecoverable preparation error, not an ordinary pending translation. */
  blocked: boolean;
}

export interface PlaybackBufferStats {
  holding: boolean;
  userPaused: boolean;
}

export interface PlaybackBufferController {
  update(policy: PlaybackBufferPolicy | null): void;
  onMediaEvent(reason: string): void;
  userIntent(intent: 'play' | 'pause' | 'seek'): void;
  /** Release ownership without starting a video which is currently paused. */
  reset(): void;
  dispose(): void;
  stats(): PlaybackBufferStats;
}

interface PendingPlay {
  video: HTMLVideoElement;
  revision: number;
  valid: boolean;
}

const TICK_MS = 100;
const LEASE_MS = 10_000;
const LOW_WATER_MS = 500;
// Give a deferred picture toggle time to finish without losing supervision if
// a double-click/fullscreen gesture consumes the intended native pause instead.
const NATIVE_TOGGLE_GRACE_MS = 1_000;

/**
 * `update` is a heartbeat as well as a coverage update. The caller must supply
 * only policies for the current page/video and increase epoch after a seek.
 *
 * Native pause events alone cannot detect clicking pause while we already hold
 * the video. Forward explicit player controls through `userIntent` as well.
 * Disabling, losing the worker lease, or resetting leaves a held video paused:
 * the next explicit play belongs to the user, not to the previous buffer gate.
 */
export function createPlaybackBufferController(opts: {
  getVideo(): HTMLVideoElement | null;
  now?(): number;
  onStatus?(status: PlaybackBufferStats): void;
}): PlaybackBufferController {
  const now = opts.now ?? Date.now;
  let policy: PlaybackBufferPolicy | null = null;
  let video: HTMLVideoElement | null = null;
  let holding = false;
  let userPaused = false;
  let pauseIntentUntil = 0;
  let primed = false;
  let disposed = false;
  let expired = false;
  let ad = false;
  let blockedAcknowledged = false;
  let awaitingVideoPolicy = false;
  let seeking = false;
  // A second native seek can finish before the worker acknowledges the first.
  // Track the expected epoch independently of the latest policy so that an
  // intermediate acknowledgement cannot consume the newest resume intent.
  let completedSeekEpoch = 0;
  let inProgressSeekEpoch: number | null = null;
  let pauseFailed = false;
  let lastUpdate = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let pendingPlay: PendingPlay | null = null;
  let seekIntent: { sessionId: string; epoch: number; video: HTMLVideoElement } | null = null;
  const retiredSessions = new Set<string>();
  const ownPauseEvents = new WeakMap<HTMLVideoElement, number>();
  const ownPlayEvents = new WeakMap<HTMLVideoElement, number>();
  const playRevisions = new WeakMap<HTMLVideoElement, number>();
  let lastStatus: PlaybackBufferStats = { holding: false, userPaused: false };

  function publish() {
    if (holding === lastStatus.holding && userPaused === lastStatus.userPaused) return;
    lastStatus = { holding, userPaused };
    try {
      opts.onStatus?.({ ...lastStatus });
    } catch {
      // UI notification failures must not interrupt media cleanup.
    }
  }

  function consume(events: WeakMap<HTMLVideoElement, number>, target: HTMLVideoElement) {
    const count = events.get(target) ?? 0;
    if (!count) return false;
    events.set(target, count - 1);
    return true;
  }

  function pause(target: HTMLVideoElement) {
    if (target.paused) return true;
    ownPauseEvents.set(target, (ownPauseEvents.get(target) ?? 0) + 1);
    try {
      target.pause();
      return target.paused;
    } catch {
      consume(ownPauseEvents, target);
      return false;
    }
  }

  function nextPlayRevision(target: HTMLVideoElement) {
    const revision = (playRevisions.get(target) ?? 0) + 1;
    playRevisions.set(target, revision);
    return revision;
  }

  function stopCancelledPlay(operation: PendingPlay) {
    // A later explicit play or a newer, valid automatic play owns this element.
    // Otherwise also undo a browser play() which completed after cancellation.
    if (playRevisions.get(operation.video) === operation.revision) pause(operation.video);
  }

  function release() {
    const previous = pendingPlay;
    pendingPlay = null;
    if (previous) {
      previous.valid = false;
      stopCancelledPlay(previous);
    }
    holding = false;
    seekIntent = null;
    primed = false;
    seeking = false;
    pauseFailed = false;
  }

  function stopTimer() {
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  function syncVideo() {
    const current = opts.getVideo();
    if (current !== video) {
      awaitingVideoPolicy = video !== null;
      release();
      video = current;
      completedSeekEpoch = policy?.epoch ?? 0;
      inProgressSeekEpoch = null;
      userPaused = !!current?.paused;
      pauseIntentUntil = 0;
      blockedAcknowledged = false;
      publish();
    }
    return current;
  }

  function resume(target: HTMLVideoElement) {
    if (pendingPlay || disposed || userPaused) return;
    const operation: PendingPlay = {
      video: target,
      revision: nextPlayRevision(target),
      valid: true,
    };
    pendingPlay = operation;
    holding = false;
    primed = true;
    ownPlayEvents.set(target, (ownPlayEvents.get(target) ?? 0) + 1);
    publish();
    if (!operation.valid || disposed || opts.getVideo() !== target) {
      consume(ownPlayEvents, target);
      return;
    }
    let result: Promise<void>;
    try {
      result = target.play();
    } catch {
      consume(ownPlayEvents, target);
      pendingPlay = null;
      operation.valid = false;
      stopCancelledPlay(operation);
      return;
    }
    void Promise.resolve(result).then(
      () => {
        if (!operation.valid || disposed || opts.getVideo() !== target) {
          stopCancelledPlay(operation);
        }
        if (pendingPlay === operation) pendingPlay = null;
      },
      () => {
        consume(ownPlayEvents, target);
        if (pendingPlay === operation) pendingPlay = null;
        operation.valid = false;
        stopCancelledPlay(operation);
        // Autoplay rejection is terminal for this attempt; a new user play may retry.
      },
    );
  }

  function evaluate() {
    if (disposed || !policy || !policy.enabled || !policy.active || expired) return;
    if (now() - lastUpdate >= LEASE_MS) {
      expired = true;
      release();
      stopTimer();
      publish();
      return;
    }
    const target = syncVideo();
    if (!target || ad || awaitingVideoPolicy || pauseFailed) return;
    if (target.ended) {
      release();
      publish();
      return;
    }
    if (policy.blocked) {
      if (!blockedAcknowledged) {
        release();
        pause(target);
        blockedAcknowledged = true;
        publish();
      }
      return;
    }
    if (seekIntent || target.seeking) return;
    // A picture-click toggle may be deferred while the player distinguishes it
    // from a double-click. Do not clear pause intent while its handler is pending.
    // If the gesture is consumed without pausing, resume normal supervision.
    if (!target.paused && now() >= pauseIntentUntil) userPaused = false;
    if (userPaused || (target.paused && !holding) || pendingPlay) return;
    const positionMs = target.currentTime * 1_000;
    if (!Number.isFinite(positionMs) || !Number.isFinite(policy.readyUntilMs)) return;
    const remaining = policy.readyUntilMs - positionMs;
    const durationMs = target.duration * 1_000;
    const coveredEnd =
      Number.isFinite(durationMs) && durationMs > 0 && policy.readyUntilMs >= durationMs - 100;
    const enough = coveredEnd || remaining >= Math.max(0, policy.targetMs);
    if (holding) {
      if (enough) resume(target);
    } else if ((!primed && !enough) || (primed && !coveredEnd && remaining <= LOW_WATER_MS)) {
      holding = pause(target);
      pauseFailed = !holding;
      primed = false;
    } else {
      primed = true;
    }
    publish();
  }

  function beginSeek() {
    const target = syncVideo();
    if (!policy || !target || seeking) return;
    const resumeAfterSeek = !userPaused && (holding || !!pendingPlay || !target.paused);
    const expectedEpoch = Math.max(policy.epoch, completedSeekEpoch) + 1;
    release();
    seeking = true;
    inProgressSeekEpoch = expectedEpoch;
    if (resumeAfterSeek && policy.enabled && policy.active && !policy.blocked && !expired && !ad) {
      seekIntent = { sessionId: policy.sessionId, epoch: expectedEpoch - 1, video: target };
      holding = pause(target);
      pauseFailed = !holding;
      if (!holding) seekIntent = null;
    }
    publish();
  }

  function userIntent(intent: 'play' | 'pause' | 'seek') {
    if (disposed) return;
    const target = syncVideo();
    if (intent === 'seek') {
      beginSeek();
      return;
    }
    if (intent === 'pause') {
      release();
      userPaused = true;
      pauseIntentUntil = now() + NATIVE_TOGGLE_GRACE_MS;
    } else {
      if (target) nextPlayRevision(target);
      release();
      userPaused = false;
      pauseIntentUntil = 0;
      if (policy?.blocked) blockedAcknowledged = true;
      // The native player owns this play gesture. Do not claim its paused video
      // as a buffer hold: a timer/heartbeat could otherwise call play() before
      // a delayed picture-click toggle, turning that toggle into a pause.
      // Its actual play event will evaluate coverage and acquire a hold if needed.
    }
    publish();
  }

  function reset() {
    release();
    policy = null;
    video = null;
    userPaused = false;
    pauseIntentUntil = 0;
    expired = false;
    ad = false;
    blockedAcknowledged = false;
    awaitingVideoPolicy = false;
    completedSeekEpoch = 0;
    inProgressSeekEpoch = null;
    stopTimer();
    publish();
  }

  return {
    update(next) {
      if (disposed) return;
      if (!next) {
        reset();
        return;
      }
      if (retiredSessions.has(next.sessionId)) return;
      if (policy?.sessionId === next.sessionId && next.epoch < policy.epoch) return;
      syncVideo();
      awaitingVideoPolicy = false;
      const changed =
        !policy ||
        next.sessionId !== policy.sessionId ||
        next.epoch !== policy.epoch ||
        next.videoId !== policy.videoId;
      if (changed) {
        const seekStillInProgress = seeking;
        const pendingSeek = seekIntent;
        const nativeSeekEpoch = inProgressSeekEpoch;
        const sameSeek =
          pendingSeek &&
          next.sessionId === pendingSeek.sessionId &&
          next.videoId === policy?.videoId &&
          opts.getVideo() === pendingSeek.video;
        completedSeekEpoch =
          next.sessionId === policy?.sessionId
            ? Math.max(completedSeekEpoch, next.epoch)
            : next.epoch;
        if (policy && next.sessionId !== policy.sessionId) retiredSessions.add(policy.sessionId);
        release();
        if (sameSeek) {
          holding = true;
          seeking = seekStillInProgress;
          inProgressSeekEpoch = nativeSeekEpoch;
          // Retain a later seek across an acknowledgement for an earlier one.
          if (next.epoch <= pendingSeek.epoch) seekIntent = pendingSeek;
        } else {
          inProgressSeekEpoch = null;
        }
        blockedAcknowledged = false;
      } else if (policy?.blocked !== next.blocked) {
        blockedAcknowledged = false;
      }
      policy = { ...next };
      expired = false;
      lastUpdate = now();
      if (!next.enabled || !next.active) {
        release();
        stopTimer();
      } else {
        if (timer === null) timer = setInterval(evaluate, TICK_MS);
        evaluate();
      }
      publish();
    },
    onMediaEvent(reason) {
      if (disposed) return;
      const target = syncVideo();
      if (reason === 'pause') {
        if (!target || consume(ownPauseEvents, target)) return;
        userIntent('pause');
      } else if (reason === 'play') {
        if (!target || consume(ownPlayEvents, target)) return;
        userIntent('play');
      } else if (reason === 'seeking') {
        beginSeek();
      } else if (reason === 'seeked') {
        completedSeekEpoch = Math.max(completedSeekEpoch, inProgressSeekEpoch ?? 0);
        inProgressSeekEpoch = null;
        seeking = false;
      } else if (reason === 'ad-start') {
        ad = true;
        release();
      } else if (reason === 'ad-end') {
        ad = false;
      } else if (reason === 'ended' || reason === 'video-replaced' || reason === 'emptied') {
        release();
        if (reason !== 'ended') awaitingVideoPolicy = true;
      }
      evaluate();
      publish();
    },
    userIntent,
    reset,
    dispose() {
      if (disposed) return;
      reset();
      disposed = true;
      retiredSessions.clear();
    },
    stats: () => ({ holding, userPaused }),
  };
}

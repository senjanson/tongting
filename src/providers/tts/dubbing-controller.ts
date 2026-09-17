/**
 * 配音同步控制器（worker，纯逻辑，时钟与定时器可注入）。政策见 EXECUTION_PLAN §8.6。
 *
 * - 只朗读 stability=final 且 translationState=done、目标语言与配置一致的 cue；同一 cue id 在一个播放代内只读一次（T33）。
 * - 播放点进入 cue 起点附近（leadMs）才开始；错过起点超过 maxStartLatenessMs 或整个原时段已过的句子按「过期」跳过并记录。
 * - 视频暂停/缓冲（pauseWithVideo）、跳转、广告、结束：立即停播；恢复时仅在当前句剩余足够时从句首重读，不连播旧积压（T16）。
 * - invalidate/跳转：旧朗读令牌失效，迟到的引擎回调不会发声，也不会发出 speaking（T15）。
 * - 倍速：语速按播放速率有界调整（[minRateFactor, maxRateBoost] × 用户语速），迟到时小幅加速；
 *   当前句超出原时段 maxOverrunMs 且下一句已到期时截断，超出 hardOverrunMs 无条件截断。
 * - 到期未读积压超过 maxDueBacklog 时只保留最新几句，其余记为 backlog 跳过。
 * - 目标语言没有可用声音时 state='unavailable'，并给出原因（T31）。
 * - speaking 事件只在引擎真正开始发声时发出；idle 在完成后短暂宽限（避免句间反复 ducking），
 *   在取消、暂停、跳转、错误时立即发出。worker 据此应用/恢复原声 ducking。
 */
import { epochNowMs } from '../../domain/clock';
import { AppError, toAppErrorInfo, type AppErrorInfo } from '../../domain/errors';
import type { Cue } from '../../domain/cue';
import { findTargetLanguage, isSameLanguage } from '../../domain/languages';
import type { PlayerState } from '../../domain/session';
import type {
  DubbingConfig,
  DubbingController,
  DubbingEvent,
  DubbingStats,
  TtsEngine,
  TtsEngineEvent,
} from './types';
import { selectVoice } from './voices';

type TimerHandle = unknown;

export interface DubbingPolicy {
  leadMs: number;
  maxStartLatenessMs: number;
  maxOverrunMs: number;
  hardOverrunMs: number;
  resumeMinRemainingMs: number;
  maxDueBacklog: number;
  minRateFactor: number;
  maxRateBoost: number;
  catchUpBoostPerSec: number;
  maxCatchUpBoost: number;
  jumpThresholdMs: number;
  idleGraceMs: number;
  startTimeoutMs: number;
  maxUtteranceMs: number;
  maxErrorStreak: number;
  staleAfterMs: number;
  skipEventWindowMs: number;
  supervisorIntervalMs: number;
  maxSpokenMemory: number;
}

export function defaultDubbingPolicy(engineKind: TtsEngine['kind']): DubbingPolicy {
  const cloud = engineKind === 'sub2api';
  return {
    leadMs: cloud ? 700 : 150,
    maxStartLatenessMs: 1_500,
    maxOverrunMs: 2_000,
    hardOverrunMs: 6_000,
    resumeMinRemainingMs: 800,
    maxDueBacklog: 2,
    minRateFactor: 0.8,
    maxRateBoost: 1.6,
    catchUpBoostPerSec: 0.15,
    maxCatchUpBoost: 0.25,
    jumpThresholdMs: 2_500,
    idleGraceMs: 250,
    startTimeoutMs: cloud ? 15_000 : 5_000,
    maxUtteranceMs: 30_000,
    maxErrorStreak: 3,
    staleAfterMs: 60_000,
    skipEventWindowMs: 30_000,
    supervisorIntervalMs: 250,
    maxSpokenMemory: 5_000,
  };
}

export interface DubbingControllerDeps {
  engine: TtsEngine;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  policy?: Partial<DubbingPolicy>;
}

interface CurrentUtterance {
  cue: Cue;
  token: number;
  utteranceId: string;
  phase: 'pending' | 'speaking';
  issuedAt: number;
  startedAt?: number;
  rate: number;
}

function isPlaying(p: PlayerState): boolean {
  return !p.paused && !p.buffering && !p.seeking && !p.ended && !p.ad;
}

export function createDubbingController(deps: DubbingControllerDeps): DubbingController {
  const engine = deps.engine;
  // 与 PlayerState.sampledAtEpochMs 同一跨文档时钟（Date.now() 基准）。
  const now = deps.now ?? (() => epochNowMs());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: TimerHandle) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const policy: DubbingPolicy = { ...defaultDubbingPolicy(engine.kind), ...deps.policy };

  let config: DubbingConfig | null = null;
  let voiceRevision = 0;
  let voice: {
    status: 'unknown' | 'checking' | 'ok' | 'unavailable';
    key: string;
    voiceName?: string;
    error?: AppErrorInfo;
  } = {
    status: 'unknown',
    key: '',
  };
  let player: PlayerState | null = null;
  let epoch = -1;
  let generation = 0;
  const cues = new Map<string, Cue>();
  const spoken = new Set<string>();
  let current: CurrentUtterance | null = null;
  let resumable: Cue | null = null;
  /** 暂停前被打断、恢复后允许从句首重读的 cue id。 */
  let resumeCandidate: string | null = null;
  let tokenCounter = 0;
  let skipped = 0;
  let errorStreak = 0;
  let lastError: AppErrorInfo | undefined;
  let speakingAnnounced = false;
  let disposed = false;
  let scheduleTimer: TimerHandle | null = null;
  let idleTimer: TimerHandle | null = null;
  const listeners = new Set<(event: DubbingEvent) => void>();

  const emit = (event: DubbingEvent) => {
    for (const l of Array.from(listeners)) {
      try {
        l(event);
      } catch {
        // 监听器错误不影响控制器
      }
    }
  };

  const clearSchedule = () => {
    if (scheduleTimer !== null) {
      clearTimer(scheduleTimer);
      scheduleTimer = null;
    }
  };
  const clearIdle = () => {
    if (idleTimer !== null) {
      clearTimer(idleTimer);
      idleTimer = null;
    }
  };

  const announceIdleNow = () => {
    clearIdle();
    if (speakingAnnounced) {
      speakingAnnounced = false;
      emit({ type: 'idle' });
    }
  };

  const announceIdleSoon = () => {
    if (!speakingAnnounced || idleTimer !== null) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (!current || current.phase === 'pending') announceIdleNow();
    }, policy.idleGraceMs);
  };

  const rememberSpoken = (id: string) => {
    spoken.delete(id);
    spoken.add(id);
    if (spoken.size > policy.maxSpokenMemory) {
      const oldest = spoken.values().next().value;
      if (oldest !== undefined) spoken.delete(oldest);
    }
  };

  const playhead = (): number | undefined => {
    if (!player) return undefined;
    if (!isPlaying(player)) return player.currentTimeMs;
    return (
      player.currentTimeMs + Math.max(0, now() - player.sampledAtEpochMs) * player.playbackRate
    );
  };

  const skip = (
    cue: Cue,
    reason: 'stale' | 'too-late' | 'backlog' | 'seek',
    ph: number | undefined,
  ) => {
    cues.delete(cue.id);
    rememberSpoken(cue.id);
    // 远早于当前位置的句子（例如中途开启配音）静默移除，不计入跳过。
    if (ph !== undefined && cue.endMs < ph - policy.skipEventWindowMs && reason !== 'seek') return;
    skipped++;
    emit({ type: 'skipped', cueId: cue.id, reason });
  };

  /** 停止当前朗读：先解除令牌，再调用引擎 stop，迟到事件因令牌不符被忽略。 */
  const stopCurrent = (opts: {
    skipReason?: 'seek' | 'too-late' | 'stale';
    markSpoken?: boolean;
    resumable?: boolean;
  }) => {
    const target = current;
    current = null;
    if (target) {
      try {
        engine.stop();
      } catch {
        // 继续清理
      }
      if (opts.resumable) resumable = target.cue;
      else if (opts.skipReason) skip(target.cue, opts.skipReason, playhead());
      else if (opts.markSpoken) rememberSpoken(target.cue.id);
    }
    announceIdleNow();
  };

  const computeRate = (ph: number, cue: Cue): number => {
    const base = config?.rate ?? 1;
    const playbackRate = player?.playbackRate ?? 1;
    const factor = Math.min(policy.maxRateBoost, Math.max(policy.minRateFactor, playbackRate));
    const lateMs = Math.max(0, ph - cue.startMs);
    const boost = 1 + Math.min(policy.maxCatchUpBoost, (lateMs / 1000) * policy.catchUpBoostPerSec);
    const rate = base * Math.min(policy.maxRateBoost, factor * boost);
    return Math.min(3, Math.max(0.5, rate));
  };

  const onEngineEvent = (token: number, event: TtsEngineEvent) => {
    if (disposed || !current || current.token !== token) return;
    const target = current;
    switch (event.type) {
      case 'start':
        if (target.phase === 'speaking') return;
        target.phase = 'speaking';
        target.startedAt = now();
        clearIdle();
        speakingAnnounced = true;
        emit({ type: 'speaking', cueId: target.cue.id });
        return;
      case 'end':
      case 'interrupted':
        current = null;
        rememberSpoken(target.cue.id);
        errorStreak = 0;
        tick();
        {
          // tick() 可能已开始下一句；TS 的窄化无法感知函数调用中的赋值。
          const next = current as CurrentUtterance | null;
          if (!next || next.phase === 'pending') announceIdleSoon();
        }
        return;
      case 'error':
        current = null;
        rememberSpoken(target.cue.id);
        errorStreak++;
        lastError = event.error;
        emit({ type: 'error', cueId: target.cue.id, error: event.error });
        announceIdleNow();
        tick();
        return;
    }
  };

  const speak = (cue: Cue, ph: number) => {
    if (!config) return;
    cues.delete(cue.id);
    const token = ++tokenCounter;
    const utterance: CurrentUtterance = {
      cue,
      token,
      utteranceId: `dub-${generation}-${token}`,
      phase: 'pending',
      issuedAt: now(),
      rate: computeRate(ph, cue),
    };
    current = utterance;
    try {
      engine.speak(
        {
          utteranceId: utterance.utteranceId,
          text: cue.translatedText!.trim(),
          lang: config.lang,
          // 只有系统语音使用选出的声音名；云端引擎在朗读时读取最新路由中的声音。
          voiceName: engine.kind === 'system' ? voice.voiceName : undefined,
          rate: utterance.rate,
          volume: config.volume,
        },
        (event) => onEngineEvent(token, event),
      );
    } catch (error) {
      onEngineEvent(token, {
        type: 'error',
        utteranceId: utterance.utteranceId,
        error: toAppErrorInfo(error, {
          code: 'tts-speak-failed',
          category: 'tts',
          message: '配音朗读启动失败',
        }),
      });
    }
  };

  const schedule = (delayMs: number) => {
    clearSchedule();
    if (disposed) return;
    scheduleTimer = setTimer(
      () => {
        scheduleTimer = null;
        tick();
      },
      Math.max(20, Math.min(60_000, Math.round(delayMs))),
    );
  };

  const refreshVoices = () => {
    if (!config) return;
    // 缓存键包含引擎的声音配置版本（云端路由的地址/模型/声音），设置变化后重新检测。
    const key = `${config.lang}|${config.voiceName ?? ''}|${engine.voiceKey?.() ?? ''}`;
    if (voice.key === key && (voice.status === 'ok' || voice.status === 'checking')) return;
    const rev = ++voiceRevision;
    voice = { status: 'checking', key };
    const lang = config.lang;
    const preferred = config.voiceName;
    engine.getVoices().then(
      (voices) => {
        if (disposed || rev !== voiceRevision) return;
        const selection = selectVoice(voices, lang, preferred, {
          allowUnlabeled: engine.kind !== 'system',
        });
        if (selection.ok) {
          voice = { status: 'ok', key, voiceName: selection.voice.voiceName };
        } else {
          const label = findTargetLanguage(lang)?.label ?? lang;
          voice = {
            status: 'unavailable',
            key,
            error: new AppError({
              code: 'tts-no-voice',
              category: 'unsupported',
              retryable: false,
              message: `没有可用于「${label}」的配音声音，配音不可用，字幕仍可正常使用。可在设置中改用其他配音服务。`,
            }).info,
          };
          lastError = voice.error;
          stopCurrent({});
        }
        tick();
      },
      (error: unknown) => {
        if (disposed || rev !== voiceRevision) return;
        voice = {
          status: 'unavailable',
          key,
          error: toAppErrorInfo(error, {
            code: 'tts-voices-failed',
            category: 'tts',
            message: '无法读取可用配音声音列表',
          }),
        };
        lastError = voice.error;
        stopCurrent({});
        tick();
      },
    );
  };

  function tick(): void {
    if (disposed) return;
    clearSchedule();
    const cfg = config;
    if (!cfg || !cfg.enabled) {
      if (current) stopCurrent({ resumable: false });
      return;
    }
    if (voice.status !== 'ok') {
      if (current) stopCurrent({});
      return;
    }
    if (errorStreak >= policy.maxErrorStreak) {
      if (current) stopCurrent({});
      return;
    }
    const p = player;
    if (!p) return;

    if (!isPlaying(p)) {
      if (current) {
        const interruptible =
          p.ended || p.ad || p.seeking || (cfg.pauseWithVideo && (p.paused || p.buffering));
        if (interruptible) {
          const canResume = !p.ended && !p.ad && !p.seeking;
          stopCurrent({
            resumable: canResume,
            skipReason: p.seeking ? 'seek' : undefined,
            markSpoken: !canResume && !p.seeking,
          });
        } else {
          schedule(policy.supervisorIntervalMs);
        }
      }
      if (p.ended || p.ad || p.seeking) resumable = null;
      return;
    }

    const t = now();
    if (t - p.sampledAtEpochMs > policy.staleAfterMs) return;
    const ph = playhead()!;

    if (resumable) {
      const c = resumable;
      resumable = null;
      if (!spoken.has(c.id)) {
        if (ph <= c.endMs - policy.resumeMinRemainingMs) {
          // 恢复播放且当前句剩余足够：从句首重读，不受起点迟到限制。
          cues.set(c.id, c);
          resumeCandidate = c.id;
        } else {
          skip(c, 'stale', ph);
        }
      }
    }

    if (current) {
      const overrun = ph - current.cue.endMs;
      const nextDue = Array.from(cues.values()).some((c) => c.startMs <= ph + policy.leadMs);
      if (current.phase === 'pending' && t - current.issuedAt > policy.startTimeoutMs) {
        const target = current;
        stopCurrent({ markSpoken: true });
        errorStreak++;
        lastError = new AppError({
          code: 'tts-start-timeout',
          category: 'tts',
          retryable: true,
          message: '配音引擎长时间没有开始朗读，已跳过该句。',
        }).info;
        emit({ type: 'error', cueId: target.cue.id, error: lastError });
        if (errorStreak >= policy.maxErrorStreak) return;
      } else if (
        (overrun > policy.maxOverrunMs && nextDue) ||
        overrun > policy.hardOverrunMs ||
        (current.startedAt !== undefined && t - current.startedAt > policy.maxUtteranceMs)
      ) {
        stopCurrent({ skipReason: 'too-late' });
      } else {
        schedule(policy.supervisorIntervalMs);
        return;
      }
    }

    const ordered = Array.from(cues.values()).sort(
      (a, b) => a.startMs - b.startMs || a.endMs - b.endMs,
    );
    const due: Cue[] = [];
    let nextFuture: Cue | undefined;
    for (const c of ordered) {
      if (c.startMs > ph + policy.leadMs) {
        nextFuture = c;
        break;
      }
      if (c.id === resumeCandidate) {
        if (c.endMs - ph >= policy.resumeMinRemainingMs) due.push(c);
        else skip(c, 'stale', ph);
      } else if (c.endMs <= ph || ph - c.startMs > policy.maxStartLatenessMs)
        skip(c, 'too-late', ph);
      else due.push(c);
    }
    while (due.length > policy.maxDueBacklog) skip(due.shift()!, 'backlog', ph);
    const next = due[0];
    if (next) {
      const resumed = next.id === resumeCandidate;
      resumeCandidate = null;
      speak(next, resumed ? next.startMs : ph);
      if (current) schedule(policy.supervisorIntervalMs);
      return;
    }
    if (nextFuture) {
      schedule((nextFuture.startMs - policy.leadMs - ph) / Math.max(0.0625, p.playbackRate));
    }
  }

  return {
    setConfig(next) {
      if (disposed) return;
      const prev = config;
      config = { ...next };
      if (prev && prev.lang !== next.lang) {
        stopCurrent({});
        resumable = null;
        for (const [id, c] of cues)
          if (!isSameLanguage(c.targetLanguage, next.lang)) cues.delete(id);
      }
      if (!next.enabled) {
        stopCurrent({ markSpoken: false });
        resumable = null;
      } else {
        errorStreak = 0;
        refreshVoices();
      }
      tick();
    },
    upsertCues(list) {
      if (disposed) return;
      for (const cue of list) {
        const eligible =
          cue.stability === 'final' &&
          cue.translationState === 'done' &&
          !!cue.translatedText &&
          cue.translatedText.trim().length > 0;
        const existing = cues.get(cue.id);
        if (!eligible) {
          // 新修订尚未完成翻译：旧译文作废，不再朗读。
          if (existing && cue.revision > existing.revision) cues.delete(cue.id);
          continue;
        }
        if (config && !isSameLanguage(cue.targetLanguage, config.lang)) continue;
        if (spoken.has(cue.id)) continue;
        if (current?.cue.id === cue.id || resumable?.id === cue.id) continue;
        if (existing && existing.revision > cue.revision) continue;
        cues.set(cue.id, cue);
      }
      tick();
    },
    onPlayer(state, reason) {
      if (disposed) return;
      const prev = player;
      player = state;
      // 以新状态的采样时刻推算旧状态下应处的位置，偏差过大视为跳转。
      const jumped =
        !!prev &&
        isPlaying(prev) &&
        isPlaying(state) &&
        Math.abs(
          state.currentTimeMs -
            (prev.currentTimeMs +
              Math.max(0, state.sampledAtEpochMs - prev.sampledAtEpochMs) * prev.playbackRate),
        ) > policy.jumpThresholdMs;
      if (jumped || reason === 'seek' || reason === 'seeked') {
        resumable = null;
        resumeCandidate = null;
        if (current) stopCurrent({ skipReason: 'seek' });
      }
      tick();
    },
    invalidate(nextEpoch) {
      if (disposed || nextEpoch < epoch) return;
      epoch = nextEpoch;
      generation++;
      stopCurrent({ skipReason: 'seek' });
      cues.clear();
      spoken.clear();
      resumable = null;
      resumeCandidate = null;
      errorStreak = 0;
      tick();
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stats(): DubbingStats {
      const ph = playhead();
      let backlog = 0;
      if (ph !== undefined)
        for (const c of cues.values()) if (c.startMs <= ph + policy.leadMs) backlog++;
      let state: DubbingStats['state'];
      if (disposed || !config?.enabled) state = 'disabled';
      else if (voice.status === 'unavailable') state = 'unavailable';
      else if (errorStreak >= policy.maxErrorStreak) state = 'error';
      else if (current) state = 'speaking';
      else if (player && !isPlaying(player) && (player.paused || player.buffering || player.ad))
        state = 'paused';
      else state = 'idle';
      return {
        state,
        backlog,
        skipped,
        lastError: state === 'unavailable' ? (voice.error ?? lastError) : lastError,
      };
    },
    dispose() {
      if (disposed) return;
      stopCurrent({});
      disposed = true;
      // 控制器负责调用引擎 dispose：云端引擎释放事件订阅；共享的系统语音引擎为空操作。
      try {
        engine.dispose?.();
      } catch {
        // 继续清理
      }
      clearSchedule();
      clearIdle();
      cues.clear();
      spoken.clear();
      resumable = null;
      listeners.clear();
    },
  };
}

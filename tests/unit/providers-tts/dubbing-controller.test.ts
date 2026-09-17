import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import type { Cue } from '@src/domain/cue';
import type { PlayerState } from '@src/domain/session';
import { createDubbingController } from '@src/providers/tts/dubbing-controller';
import type {
  DubbingConfig,
  DubbingEvent,
  TtsEngine,
  TtsEngineEvent,
  TtsUtterance,
  TtsVoice,
} from '@src/providers/tts/types';

class FakeEngine implements TtsEngine {
  spoken: { utterance: TtsUtterance; listener: (e: TtsEngineEvent) => void }[] = [];
  stops = 0;
  voices: TtsVoice[] | Error = [{ voiceName: 'Tingting', lang: 'zh-CN' }];
  constructor(readonly kind: TtsEngine['kind'] = 'system') {}
  async getVoices() {
    if (this.voices instanceof Error) throw this.voices;
    return this.voices;
  }
  speak(utterance: TtsUtterance, listener: (e: TtsEngineEvent) => void) {
    this.spoken.push({ utterance, listener });
  }
  stop() {
    this.stops++;
  }
  disposed = 0;
  key = 'v1';
  dispose() {
    this.disposed++;
  }
  voiceKey() {
    return this.key;
  }
  last() {
    return this.spoken.at(-1)!;
  }
  fire(type: 'start' | 'end' | 'interrupted', index = this.spoken.length - 1) {
    const s = this.spoken[index]!;
    s.listener({ type, utteranceId: s.utterance.utteranceId });
  }
  fail(index = this.spoken.length - 1) {
    const s = this.spoken[index]!;
    s.listener({
      type: 'error',
      utteranceId: s.utterance.utteranceId,
      error: { code: 'x', category: 'tts', retryable: false, message: 'x' },
    });
  }
  texts() {
    return this.spoken.map((s) => s.utterance.text);
  }
}

function cue(id: string, startMs: number, endMs: number, p: Partial<Cue> = {}): Cue {
  return {
    id,
    revision: 0,
    startMs,
    endMs,
    sourceText: `src ${id}`,
    translatedText: `译文${id}`,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'asr',
    stability: 'final',
    translationState: 'done',
    ...p,
  };
}

const config = (p: Partial<DubbingConfig> = {}): DubbingConfig => ({
  enabled: true,
  lang: 'zh-CN',
  rate: 1,
  volume: 0.9,
  pauseWithVideo: true,
  ...p,
});

function player(currentTimeMs: number, p: Partial<PlayerState> = {}): PlayerState {
  return {
    videoId: 'abcdefghijk',
    currentTimeMs,
    paused: false,
    buffering: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    ad: false,
    volume: 1,
    muted: false,
    isLive: false,
    isShorts: false,
    fullscreen: false,
    sampledAtEpochMs: Date.now(),
    ...p,
  };
}

async function setup(engineKind: TtsEngine['kind'] = 'system', cfg = config()) {
  const engine = new FakeEngine(engineKind);
  const controller = createDubbingController({ engine, now: () => Date.now() });
  const events: DubbingEvent[] = [];
  controller.onEvent((e) => events.push(e));
  controller.setConfig(cfg);
  await vi.advanceTimersByTimeAsync(0);
  return { engine, controller, events };
}

const kinds = (events: DubbingEvent[]) =>
  events.map((e) =>
    e.type === 'skipped'
      ? `skipped:${e.cueId}:${e.reason}`
      : e.type === 'speaking'
        ? `speaking:${e.cueId}`
        : e.type,
  );

describe('DubbingController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => vi.useRealTimers());

  it('starts speaking only when playback reaches the cue start (with small lead)', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 2_000, 4_000)]);
    await vi.advanceTimersByTimeAsync(1_800);
    expect(engine.spoken).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.spoken).toHaveLength(1);
    expect(engine.last().utterance).toMatchObject({
      text: '译文a',
      lang: 'zh-CN',
      voiceName: 'Tingting',
      rate: 1,
      volume: 0.9,
    });
    expect(controller.stats().state).toBe('speaking');
  });

  it('accepts only final + done cues in the configured target language', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(1_000), 'play');
    controller.upsertCues([
      cue('interim', 1_000, 3_000, { stability: 'interim' }),
      cue('pending', 1_000, 3_000, { translationState: 'pending' }),
      cue('failed', 1_000, 3_000, { translationState: 'failed' }),
      cue('empty', 1_000, 3_000, { translatedText: '  ' }),
      cue('english', 1_000, 3_000, { targetLanguage: 'en' }),
    ]);
    expect(engine.spoken).toHaveLength(0);
    controller.upsertCues([cue('ok', 1_000, 3_000)]);
    expect(engine.texts()).toEqual(['译文ok']);
  });

  it('T33: revisions of the same cue are read once', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([
      cue('a', 0, 3_000, { stability: 'interim', translationState: 'pending' }),
    ]);
    controller.upsertCues([cue('a', 0, 3_000, { revision: 1 })]);
    controller.upsertCues([cue('a', 0, 3_000, { revision: 2, translatedText: '修订' })]);
    expect(engine.spoken).toHaveLength(1);
    engine.fire('start');
    engine.fire('end');
    controller.upsertCues([cue('a', 0, 3_000, { revision: 3, translatedText: '再修订' })]);
    await vi.advanceTimersByTimeAsync(500);
    expect(engine.spoken).toHaveLength(1);
    // 未读之前被新修订作废（新修订尚未翻译完成）则不朗读旧译文
    controller.upsertCues([cue('b', 5_000, 7_000)]);
    controller.upsertCues([cue('b', 5_000, 7_000, { revision: 1, translationState: 'running' })]);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.spoken).toHaveLength(1);
  });

  it('emits speaking only on real start; idle after completion (grace) — ducking signals', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 1_000)]);
    expect(kinds(events)).toEqual([]);
    engine.fire('start');
    expect(kinds(events)).toEqual(['speaking:a']);
    engine.fire('end');
    expect(kinds(events)).toEqual(['speaking:a']);
    await vi.advanceTimersByTimeAsync(300);
    expect(kinds(events)).toEqual(['speaking:a', 'idle']);
  });

  it('does not flap idle between back-to-back sentences', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 1_000), cue('b', 1_000, 2_000)]);
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(1_000);
    engine.fire('end');
    expect(engine.spoken).toHaveLength(2);
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(500);
    expect(kinds(events)).toEqual(['speaking:a', 'speaking:b']);
  });

  it('T15: invalidate stops immediately; late engine callbacks never produce sound events', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 3_000), cue('b', 4_000, 6_000)]);
    const stale = engine.spoken[0]!;
    controller.invalidate(5);
    expect(engine.stops).toBe(1);
    stale.listener({ type: 'start', utteranceId: stale.utterance.utteranceId });
    stale.listener({ type: 'end', utteranceId: stale.utterance.utteranceId });
    expect(kinds(events)).toEqual(['skipped:a:seek']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.spoken).toHaveLength(1); // 旧队列已清空
    controller.invalidate(4); // 过期 epoch 被忽略
    controller.upsertCues([cue('a', 10_000, 12_000)]);
    expect(engine.spoken).toHaveLength(2); // 新播放代可以重新朗读同 id
  });

  it('T16: pause stops immediately, resume re-reads the current sentence without replaying old backlog', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 5_000), cue('b', 5_000, 8_000)]);
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(2_000);
    controller.onPlayer(player(2_000, { paused: true }), 'pause');
    expect(engine.stops).toBe(1);
    expect(kinds(events)).toEqual(['speaking:a', 'idle']);
    expect(controller.stats().state).toBe('paused');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.spoken).toHaveLength(1);
    controller.onPlayer(player(2_000), 'play');
    expect(engine.spoken).toHaveLength(2);
    expect(engine.last().utterance.text).toBe('译文a');
    expect(engine.last().utterance.rate).toBe(1); // 从句首重读，不因迟到加速
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(2_000);
    // 快结束时暂停，剩余不足 → 恢复后不再重读
    controller.onPlayer(player(4_600, { paused: true }), 'pause');
    controller.onPlayer(player(4_600), 'play');
    expect(engine.last().utterance.text).toBe('译文a');
    expect(kinds(events)).toContain('skipped:a:stale');
    await vi.advanceTimersByTimeAsync(400);
    expect(engine.last().utterance.text).toBe('译文b');
  });

  it('pauseWithVideo=false keeps the current sentence but starts nothing new while paused', async () => {
    const { engine, controller } = await setup('system', config({ pauseWithVideo: false }));
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 1_000), cue('b', 1_000, 2_000)]);
    engine.fire('start');
    controller.onPlayer(player(500, { paused: true }), 'pause');
    expect(engine.stops).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);
    engine.fire('end');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine.spoken).toHaveLength(1);
  });

  it('detects a seek from the player position and stops the stale sentence', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 4_000), cue('far', 60_000, 62_000)]);
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(1_000);
    controller.onPlayer(player(59_950), 'timeupdate');
    expect(engine.stops).toBe(1);
    expect(kinds(events)).toContain('skipped:a:seek');
    expect(engine.last().utterance.text).toBe('译文far');
  });

  it('skips sentences whose start was missed; silently drops very old ones', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(100_000), 'play');
    controller.upsertCues([
      cue('ancient', 10_000, 12_000),
      cue('late', 97_000, 101_000),
      cue('now', 99_500, 102_000),
    ]);
    expect(kinds(events)).toEqual(['skipped:late:too-late']);
    expect(engine.texts()).toEqual(['译文now']);
    expect(controller.stats().skipped).toBe(1);
  });

  it('bounds the due backlog and reports backlog skips', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 900)]);
    controller.upsertCues(
      ['b', 'c', 'd', 'e', 'f'].map((id, i) => cue(id, 1_000 + i * 200, 5_000)),
    );
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(1_900);
    expect(engine.spoken).toHaveLength(1);
    engine.fire('end');
    expect(kinds(events).filter((k) => k.startsWith('skipped'))).toEqual([
      'skipped:b:backlog',
      'skipped:c:backlog',
      'skipped:d:backlog',
    ]);
    expect(engine.last().utterance.text).toBe('译文e');
  });

  it('T19: adjusts speech rate within bounds for playback speed and lateness', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(0, { playbackRate: 2 }), 'rate');
    controller.upsertCues([cue('fast', 0, 2_000)]);
    expect(engine.last().utterance.rate).toBeCloseTo(1.6, 5);
    controller.invalidate(1);
    controller.onPlayer(player(10_000, { playbackRate: 0.75 }), 'rate');
    controller.upsertCues([cue('slow', 10_000, 12_000)]);
    expect(engine.last().utterance.rate).toBeCloseTo(0.8, 5);
    controller.invalidate(2);
    controller.onPlayer(player(21_000, { playbackRate: 1 }), 'rate');
    controller.upsertCues([cue('late', 20_000, 23_000)]);
    expect(engine.last().utterance.rate).toBeCloseTo(1.15, 5);
    controller.invalidate(3);
    controller.setConfig(config({ rate: 1.5 }));
    controller.onPlayer(player(30_000, { playbackRate: 2 }), 'rate');
    controller.upsertCues([cue('capped', 30_000, 32_000)]);
    expect(engine.last().utterance.rate).toBeCloseTo(2.4, 5);
  });

  it('cuts an overrunning sentence when the next is due, and hard-cuts without a next', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 1_000), cue('b', 3_000, 5_000)]);
    engine.fire('start');
    await vi.advanceTimersByTimeAsync(3_050);
    expect(engine.stops).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(engine.stops).toBe(1);
    expect(kinds(events)).toContain('skipped:a:too-late');
    expect(engine.last().utterance.text).toBe('译文b');
    engine.fire('start');
    // b 结束于 5000；无下一句时，超出 hardOverrunMs(6000) 即播放点 > 11000 才截断
    await vi.advanceTimersByTimeAsync(7_000);
    expect(engine.stops).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.stops).toBe(2);
    expect(controller.stats().state).toBe('idle');
  });

  it('T31: no voice for the target language → unavailable with reason, no speech', async () => {
    const engine = new FakeEngine();
    engine.voices = [{ voiceName: 'Samantha', lang: 'en-US' }];
    const controller = createDubbingController({ engine, now: () => Date.now() });
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 2_000)]);
    expect(engine.spoken).toHaveLength(0);
    expect(controller.stats()).toMatchObject({
      state: 'unavailable',
      lastError: { code: 'tts-no-voice', category: 'unsupported' },
    });
    expect(controller.stats().lastError?.message).toContain('简体中文');
    // 安装声音后重新设置配置会重新检测
    engine.voices = [{ voiceName: 'Tingting', lang: 'zh-CN' }];
    controller.setConfig(config({ rate: 1.1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.stats().state).not.toBe('unavailable');
    expect(engine.spoken).toHaveLength(1);
  });

  it('voice list failure is reported as unavailable', async () => {
    const engine = new FakeEngine();
    engine.voices = new Error('tts api missing');
    const controller = createDubbingController({ engine, now: () => Date.now() });
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.stats()).toMatchObject({
      state: 'unavailable',
      lastError: { code: 'tts-voices-failed' },
    });
  });

  it('cloud engines accept voices without a language tag and use a larger lead', async () => {
    const engine = new FakeEngine('sub2api');
    engine.voices = [{ voiceName: 'alloy', remote: true }];
    const controller = createDubbingController({ engine, now: () => Date.now() });
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 1_000, 3_000)]);
    await vi.advanceTimersByTimeAsync(250);
    expect(engine.spoken).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.spoken).toHaveLength(1);
    // 云端引擎在朗读时读取最新路由中的声音，控制器不传缓存的声音名
    expect(engine.last().utterance.voiceName).toBeUndefined();
  });

  it('stops dubbing after repeated engine errors until configuration changes', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([
      cue('a', 0, 5_000),
      cue('b', 1_000, 6_000),
      cue('c', 2_000, 7_000),
      cue('d', 3_000, 8_000),
    ]);
    engine.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    engine.fail();
    await vi.advanceTimersByTimeAsync(1_000);
    engine.fail();
    expect(engine.texts()).toEqual(['译文a', '译文b', '译文c']);
    expect(controller.stats().state).toBe('error');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.spoken).toHaveLength(3);
    controller.setConfig(config({ volume: 0.5 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.texts()).toEqual(['译文a', '译文b', '译文c', '译文d']);
  });

  it('times out an utterance that never starts', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 20_000)]);
    await vi.advanceTimersByTimeAsync(5_300);
    expect(engine.stops).toBe(1);
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      cueId: 'a',
      error: { code: 'tts-start-timeout' },
    });
  });

  it('T18: ads and end of video stop speech; the interrupted sentence is not resumed after the ad', async () => {
    const { engine, controller, events } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 5_000), cue('z', 30_000, 31_000)]);
    engine.fire('start');
    controller.onPlayer(player(1_000, { ad: true }), 'ad');
    expect(engine.stops).toBe(1);
    expect(kinds(events).at(-1)).toBe('idle');
    controller.onPlayer(player(1_000), 'ad-end');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine.spoken).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(28_000);
    expect(engine.spoken).toHaveLength(2);
    controller.onPlayer(player(30_500, { ended: true }), 'ended');
    expect(engine.stops).toBe(2);
  });

  it('T13: language change stops current speech and drops other-language cues', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 3_000), cue('b', 4_000, 6_000)]);
    engine.voices = [{ voiceName: 'Meijia', lang: 'zh-TW' }];
    controller.setConfig(config({ lang: 'zh-TW' }));
    expect(engine.stops).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.spoken).toHaveLength(1);
    controller.upsertCues([cue('b2', 5_000, 7_000, { targetLanguage: 'zh-TW' })]);
    expect(engine.last().utterance).toMatchObject({
      text: '译文b2',
      lang: 'zh-TW',
      voiceName: 'Meijia',
    });
  });

  it('disable and dispose stop speech; no events afterwards; listener errors are isolated', async () => {
    const { engine, controller, events } = await setup();
    controller.onEvent(() => {
      throw new Error('listener bug');
    });
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 3_000)]);
    engine.fire('start');
    controller.setConfig(config({ enabled: false }));
    expect(engine.stops).toBe(1);
    expect(controller.stats().state).toBe('disabled');
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    controller.upsertCues([cue('b', 0, 3_000)]);
    const count = events.length;
    controller.dispose();
    engine.fire('start');
    controller.upsertCues([cue('c', 0, 3_000)]);
    controller.onPlayer(player(0), 'play');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.length).toBe(count);
    expect(controller.stats().state).toBe('disabled');
  });

  it('review#1: after invalidate, re-upserting the same id and revision is spoken again', async () => {
    const { engine, controller } = await setup();
    controller.onPlayer(player(0), 'play');
    controller.upsertCues([cue('a', 0, 3_000)]);
    engine.fire('start');
    engine.fire('end');
    controller.invalidate(1);
    controller.onPlayer(player(0), 'seeked');
    controller.upsertCues([cue('a', 0, 3_000)]);
    expect(engine.texts()).toEqual(['译文a', '译文a']);
  });

  it('review#6: dispose calls engine.dispose', async () => {
    const { engine, controller } = await setup();
    controller.dispose();
    controller.dispose();
    expect(engine.disposed).toBe(1);
  });

  it('review#12: voice detection cache includes the engine voice key; not-configured is not reported as "no voice"', async () => {
    const engine = new FakeEngine('sub2api');
    engine.voices = new AppError({
      code: 'tts-not-configured',
      category: 'config',
      retryable: false,
      message: '未配置',
    });
    const controller = createDubbingController({ engine, now: () => Date.now() });
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.stats()).toMatchObject({
      state: 'unavailable',
      lastError: { code: 'tts-not-configured' },
    });
    engine.voices = [{ voiceName: '', remote: true }];
    engine.key = 'v2';
    controller.setConfig(config());
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.stats().state).not.toBe('unavailable');
  });

  it.each([
    ['2 hours', 2 * 3600_000],
    ['2 seconds', 2_000],
  ])(
    'review#2: default now uses the Date.now epoch even when performance.now lags by %s',
    async (_label, lag) => {
      const perf = vi
        .spyOn(performance, 'now')
        .mockImplementation(() => Date.now() - 1_000_000_000_000 - lag);
      try {
        const engine = new FakeEngine();
        const controller = createDubbingController({ engine });
        controller.setConfig(config());
        await vi.advanceTimersByTimeAsync(0);
        // 页面以 epochNowMs（Date.now）采样
        controller.onPlayer(player(10_000, { sampledAtEpochMs: Date.now() }), 'tick');
        controller.upsertCues([cue('a', 10_500, 13_000)]);
        expect(engine.spoken).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(400);
        expect(engine.texts()).toEqual(['译文a']);
      } finally {
        perf.mockRestore();
      }
    },
  );
});

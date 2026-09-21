import { describe, expect, it, vi } from 'vitest';
import { TranslationSession } from '@src/background/session';
import type { DubbingController, DubbingEvent } from '@src/providers/tts/types';
import type { SettingsPatch } from '@src/domain/settings';
import type { PlayerState } from '@src/domain/session';
import { configure, createHarness, wait } from './harness';

async function fixture(asr = false) {
  const h = createHarness();
  const controllers: { emit(event: DubbingEvent): void }[] = [];
  h.deps.createDubbingController = () => {
    let listener: (event: DubbingEvent) => void = () => undefined;
    const controller: DubbingController = {
      setConfig: () => undefined,
      upsertCues: () => undefined,
      onPlayer: () => undefined,
      invalidate: () => listener({ type: 'idle' }),
      onEvent: (fn) => {
        listener = fn;
        return () => {
          listener = () => undefined;
        };
      },
      stats: () => ({ state: 'idle', backlog: 0, skipped: 0 }),
      dispose: () => undefined,
    };
    controllers.push({ emit: (event) => listener(event) });
    return controller;
  };
  const ui = await configure(h, { asr });
  await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
  const content = h.content(1);
  content.hello();
  content.navigate('aaaaaaaaaaa', { tracks: !asr });
  await wait(10);
  const session = new TranslationSession(h.coordinator, {
    sessionId: 'session-original-audio',
    tabId: 1,
    documentId: 'doc-1',
    videoId: 'aaaaaaaaaaa',
    navigationId: content.navigationId,
  });
  const start = session.start({ stillWanted: () => true });
  if (!asr) {
    await vi.waitFor(() => expect(content.requestKinds()).toContain('captions/load-track'));
    await session.onTrackData({
      type: 'captions/track-data',
      navigationId: content.navigationId,
      videoId: 'aaaaaaaaaaa',
      track: { trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' },
      format: 'json3',
      cues: [{ startMs: 0, endMs: 1000, text: 'Hello' }],
      complete: true,
      rejectedCount: 0,
    });
  }
  await start;
  const change = async (patch: SettingsPatch) => {
    const old = h.coordinator.settings();
    await ui.command({ kind: 'settings/update', patch });
    session.onNonTranslationSettingsChanged(old, h.coordinator.settings());
  };
  const player = (patch: Partial<PlayerState> = {}): PlayerState => ({
    videoId: 'aaaaaaaaaaa',
    currentTimeMs: 0,
    paused: false,
    buffering: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    ad: false,
    volume: 0.8,
    muted: false,
    isLive: false,
    isShorts: false,
    fullscreen: false,
    sampledAtEpochMs: Date.now(),
    ...patch,
  });
  return { h, ui, content, session, controllers, change, player };
}

describe('continuous silence during interpretation', () => {
  it('keeps caption playback silent before speech, between phrases, during seeks and transient TTS errors; restores on pause/stop/subtitles', async () => {
    const { content, session, controllers, change, player } = await fixture();
    const requests = () =>
      content.requests.map((r) => r.request).filter((r) => r.kind === 'player/duck');
    try {
      expect(requests().at(-1)).toMatchObject({ originalVolume: 0, release: false });
      for (const event of [
        { type: 'speaking', cueId: 'one' },
        { type: 'idle' },
        {
          type: 'error',
          error: { code: 'tts-network', category: 'network', retryable: true, message: '合成失败' },
        },
      ] as DubbingEvent[])
        controllers[0]!.emit(event);
      session.onPlayerState(player({ currentTimeMs: 10000 }), 'seeked');
      expect(
        requests()
          .filter((r) => !r.release)
          .every((r) => r.originalVolume === 0),
      ).toBe(true);
      const beforeVoiceChange = requests().length;
      await change({ audio: { voiceName: 'another voice' } });
      expect(
        requests()
          .slice(beforeVoiceChange)
          .every((r) => !r.release && r.originalVolume === 0),
      ).toBe(true);
      await session.pause();
      expect(requests().at(-1)?.release).toBe(true);
      await session.resume({ stillWanted: () => true });
      expect(requests().at(-1)).toMatchObject({ originalVolume: 0, release: false });
      session.onPlayerState(player({ ended: true }), 'ended');
      expect(requests().at(-1)?.release).toBe(true);
      session.onPlayerState(player(), 'play');
      expect(requests().at(-1)).toMatchObject({ originalVolume: 0, release: false });
      await change({ outputMode: 'subtitle' });
      expect(requests().at(-1)?.release).toBe(true);
      await change({ outputMode: 'subtitle-voice' });
      expect(requests().at(-1)).toMatchObject({ originalVolume: 0, release: false });
      await change({ tts: { backend: 'none' } });
      expect(requests().at(-1)?.release).toBe(true);
      await change({ tts: { backend: 'system' } });
    } finally {
      await session.stop('done');
    }
    expect(requests().at(-1)?.release).toBe(true);
  });

  it('mutes only the captured playback gain, leaves player input untouched, and restores after pause', async () => {
    const { h, session, content, controllers, change } = await fixture(true);
    try {
      expect(h.offscreen.requests.find((r) => r.kind === 'capture/start')).toMatchObject({
        originalVolume: 0,
      });
      controllers[0]!.emit({ type: 'speaking', cueId: 'one' });
      controllers[0]!.emit({ type: 'idle' });
      const gains = h.offscreen.requests.filter((r) => r.kind === 'audio/original-gain');
      expect(gains.length).toBeGreaterThan(0);
      expect(gains.every((r) => r.gain === 0)).toBe(true);
      expect(
        content.requests.some((r) => r.request.kind === 'player/duck' && !r.request.release),
      ).toBe(false);
      await change({ audio: { originalMode: 'mix', originalVolume: 0.8 } });
      expect(h.offscreen.requests.at(-1)).toMatchObject({ kind: 'audio/original-gain', gain: 0.8 });
      controllers[0]!.emit({ type: 'speaking', cueId: 'two' });
      expect(h.offscreen.requests.at(-1)).toMatchObject({
        kind: 'audio/original-gain',
        gain: 0.24,
      });
      controllers[0]!.emit({ type: 'idle' });
      expect(h.offscreen.requests.at(-1)).toMatchObject({ kind: 'audio/original-gain', gain: 0.8 });
      await change({ audio: { originalMode: 'mute' } });
      expect(h.offscreen.requests.at(-1)).toMatchObject({ kind: 'audio/original-gain', gain: 0 });
      await session.pause();
      expect(h.offscreen.requests.some((r) => r.kind === 'capture/stop')).toBe(true);
      await session.resume({ stillWanted: () => true });
      expect(h.offscreen.requests.filter((r) => r.kind === 'capture/start').at(-1)).toMatchObject({
        originalVolume: 0,
      });
    } finally {
      await session.stop('done');
    }
  });
});

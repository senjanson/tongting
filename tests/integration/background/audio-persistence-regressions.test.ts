import { describe, expect, it } from 'vitest';
import { TranslationSession } from '@src/background/session';
import { createDubbingController } from '@src/providers/tts/dubbing-controller';
import type { TtsUtterance } from '@src/providers/tts/types';
import type { OffscreenRequest } from '@src/messaging/offscreen-protocol';
import type { TranscriptRecord } from '@src/storage/db';
import { FakeDubbing, FakeScheduler, configure, createHarness, wait } from './harness';

async function fixture(asr = false) {
  const h = createHarness();
  h.deps.timings = { transcriptSaveDebounceMs: 20, stopStepTimeoutMs: 80 };
  const ui = await configure(h, { asr });
  const content = h.content(1);
  content.hello();
  content.navigate('aaaaaaaaaaa', { tracks: !asr });
  await wait(20);
  const make = (sessionId = 'session-audio-regression') =>
    new TranslationSession(h.coordinator, {
      sessionId,
      tabId: 1,
      documentId: 'doc-1',
      videoId: 'aaaaaaaaaaa',
      navigationId: content.navigationId,
    });
  return { h, ui, content, make };
}
const track = (navigationId: number) => ({
  type: 'captions/track-data' as const,
  navigationId,
  videoId: 'aaaaaaaaaaa',
  track: { trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' as const },
  format: 'json3' as const,
  cues: [{ startMs: 0, endMs: 5000, text: 'Before' }],
  complete: true,
  rejectedCount: 0,
});

describe('audio and persistence review regressions', () => {
  it('restores cumulative ASR history and appends new results across repeated worker recovery', async () => {
    const { h, make } = await fixture(true);
    const first = make();
    await first.start({ stillWanted: () => true });
    const emit = (
      session: TranslationSession,
      segmentId: string,
      text: string,
      startMs: number,
    ) => {
      const req = h.offscreen.requests.filter((r) => r.kind === 'capture/start').at(-1) as Extract<
        OffscreenRequest,
        { kind: 'capture/start' }
      >;
      session.onOffscreenEvent({
        kind: 'asr/result',
        leaseId: req.leaseId,
        owner: req.owner,
        segmentId,
        text,
        startMs,
        endMs: startMs + 2000,
        revision: 0,
        final: true,
        language: 'en',
        endEstimated: false,
      });
    };
    emit(first, 'before', 'Before restart', 0);
    const cue = FakeScheduler.all.at(-1)!.cues[0]!;
    FakeScheduler.all.at(-1)!.emit([
      {
        cueId: cue.id,
        cueRevision: cue.revision,
        state: 'done',
        translatedText: '重启前',
        translationKey: 'k',
      },
    ]);
    await first.stop('worker-restart');
    const restored = make();
    await restored.start({ stillWanted: () => true, recovery: {} });
    expect(restored.sortedCues()).toMatchObject([
      { sourceText: 'Before restart', translatedText: '重启前' },
    ]);
    emit(restored, 'after', 'After restart', 5000);
    // 捕获重启后重新识别相同区间，不能新增同一条历史。
    emit(restored, 'duplicate', 'Before restart', 0);
    await restored.stop('worker-restart');
    const again = make();
    await again.start({ stillWanted: () => true, recovery: {} });
    expect(again.sortedCues().map((c) => c.sourceText)).toEqual([
      'Before restart',
      'After restart',
    ]);
    expect(again.coverage().ranges).toEqual([
      { startMs: 0, endMs: 2000 },
      { startMs: 5000, endMs: 7000 },
    ]);
    await again.stop('done');
    expect(([...h.transcripts.values()][0] as TranscriptRecord).cues).toHaveLength(2);
  });

  it('passes fresh ASR translations to the real dubbing controller while preserving source timestamps', async () => {
    const { h, ui, content, make } = await fixture(true);
    const spoken: TtsUtterance[] = [];
    h.deps.systemTts = {
      kind: 'system',
      getVoices: async () => [{ voiceName: 'Tingting', lang: 'zh-CN' }],
      speak: (utterance, listener) => {
        spoken.push(utterance);
        listener({ type: 'start', utteranceId: utterance.utteranceId });
      },
      stop: () => undefined,
    };
    h.deps.createDubbingController = createDubbingController;
    await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
    const session = make();
    await session.start({ stillWanted: () => true });
    session.onPlayerState(
      {
        videoId: 'aaaaaaaaaaa',
        currentTimeMs: 6500,
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
      },
      'play',
    );
    const req = h.offscreen.requests.find((r) => r.kind === 'capture/start') as Extract<
      OffscreenRequest,
      { kind: 'capture/start' }
    >;
    session.onOffscreenEvent({
      kind: 'asr/result',
      leaseId: req.leaseId,
      owner: req.owner,
      segmentId: 'normal-latency',
      text: 'Hello world',
      startMs: 0,
      endMs: 5000,
      revision: 0,
      final: true,
      language: 'en',
      endEstimated: false,
    });
    const cue = FakeScheduler.all.at(-1)!.cues[0]!;
    FakeScheduler.all.at(-1)!.emit([
      {
        cueId: cue.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好世界',
        translationKey: 'k',
      },
    ]);
    await wait(5);
    expect(spoken.map((u) => u.text)).toEqual(['你好世界']);
    expect(session.sortedCues()[0]).toMatchObject({ startMs: 0, endMs: 5000 });
    await session.stop('done');
    expect(
      content.requests.some((r) => r.request.kind === 'player/duck' && !r.request.release),
    ).toBe(false);
  });

  it('restores ASR source history but invalidates translations after the model configuration changes', async () => {
    const { h, ui, make } = await fixture(true);
    const first = make();
    await first.start({ stillWanted: () => true });
    const req = h.offscreen.requests.find((r) => r.kind === 'capture/start') as Extract<
      OffscreenRequest,
      { kind: 'capture/start' }
    >;
    first.onOffscreenEvent({
      kind: 'asr/result',
      leaseId: req.leaseId,
      owner: req.owner,
      segmentId: 'before',
      text: 'Before',
      startMs: 0,
      endMs: 2000,
      revision: 0,
      final: true,
      language: 'en',
      endEstimated: false,
    });
    const cue = FakeScheduler.all.at(-1)!.cues[0]!;
    FakeScheduler.all.at(-1)!.emit([
      {
        cueId: cue.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '旧译文',
        translationKey: 'old',
      },
    ]);
    await first.stop('worker-restart');
    await ui.command({ kind: 'settings/update', patch: { provider: { model: 'new-model' } } });
    const restored = make();
    await restored.start({ stillWanted: () => true, recovery: {} });
    expect(restored.sortedCues()).toMatchObject([
      { sourceText: 'Before', translationState: 'pending' },
    ]);
    expect(restored.sortedCues()[0]?.translatedText).toBeUndefined();
    await restored.stop('done');
  });

  it('freezes title and language while a save is debounced or waiting for storage', async () => {
    const { h, ui, content, make } = await fixture();
    const session = make();
    session.phase = 'running';
    await session.onTrackData(track(content.navigationId));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalGet = h.deps.transcripts.getTranscript;
    h.deps.transcripts.getTranscript = async (id) => {
      await gate;
      return originalGet(id);
    };
    await wait(30);
    await ui.command({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    session.onTranslationConfigChanged(h.coordinator.settings(), 9, {} as never);
    content.navigate('bbbbbbbbbbb');
    await wait(20);
    release();
    await session.stop('navigation');
    const old = h.transcripts.get('aaaaaaaaaaa|zh-CN|track:en') as TranscriptRecord;
    expect(old).toMatchObject({
      videoId: 'aaaaaaaaaaa',
      targetLanguage: 'zh-CN',
      title: 'Video aaaaaaaaaaa',
    });
    expect(old.cues.every((c) => c.targetLanguage === 'zh-CN')).toBe(true);
  });

  it('rebuilds TTS on backend/model changes, disables it while paused and releases original volume ownership', async () => {
    const { h, ui, content, make } = await fixture();
    const session = make();
    session.phase = 'running';
    await session.onTrackData(track(content.navigationId));
    let previous = h.coordinator.settings();
    await ui.command({
      kind: 'settings/update',
      patch: { outputMode: 'subtitle-voice', audio: { originalVolume: 0 } },
    });
    session.onNonTranslationSettingsChanged(previous, h.coordinator.settings());
    expect(content.requests.at(-1)?.request).toMatchObject({
      kind: 'player/duck',
      originalVolume: 0,
      release: false,
    });
    const countBeforeReplacement = content.requests.filter(
      (r) => r.request.kind === 'player/duck',
    ).length;
    session.onPlayerState(
      {
        videoId: 'aaaaaaaaaaa',
        currentTimeMs: 0,
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
      },
      'video-replaced',
    );
    expect(content.requests.filter((r) => r.request.kind === 'player/duck')).toHaveLength(
      countBeforeReplacement + 1,
    );
    expect(content.requests.at(-1)?.request).toMatchObject({
      kind: 'player/duck',
      originalVolume: 0,
      release: false,
    });
    const system = FakeDubbing.all.at(-1)!;
    previous = h.coordinator.settings();
    await ui.command({
      kind: 'settings/update',
      patch: { tts: { backend: 'sub2api', sub2apiModel: 'speech-a' } },
    });
    session.onNonTranslationSettingsChanged(previous, h.coordinator.settings());
    expect(system.disposed).toBe(true);
    const cloud = FakeDubbing.all.at(-1)!;
    await session.pause();
    previous = h.coordinator.settings();
    await ui.command({ kind: 'settings/update', patch: { tts: { sub2apiModel: 'speech-b' } } });
    session.onNonTranslationSettingsChanged(previous, h.coordinator.settings());
    expect(cloud.disposed).toBe(true);
    expect(FakeDubbing.all.at(-1)?.configs.at(-1)?.enabled).toBe(false);
    expect(content.requests.at(-1)?.request).toMatchObject({ kind: 'player/duck', release: true });
    await session.resume({ stillWanted: () => true });
    expect(FakeDubbing.all.at(-1)?.configs.at(-1)?.enabled).toBe(true);
    previous = h.coordinator.settings();
    await ui.command({ kind: 'settings/update', patch: { tts: { backend: 'none' } } });
    session.onNonTranslationSettingsChanged(previous, h.coordinator.settings());
    expect(FakeDubbing.all.at(-1)?.disposed).toBe(true);
    expect(content.requests.at(-1)?.request).toMatchObject({ kind: 'player/duck', release: true });
    await session.stop('done');
  });
});

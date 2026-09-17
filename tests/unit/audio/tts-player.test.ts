import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenEvent } from '@src/messaging/offscreen-protocol';
import { TtsPlayer, type TtsPlayRequest } from '@src/audio/offscreen/tts-player';
import { deferred, FakeAudioContext, type FakeBufferSource } from './fakes';

function req(id: string, text = `你好-${id}`): TtsPlayRequest {
  return {
    kind: 'tts/play',
    utteranceId: id,
    owner: { sessionId: 'session-0001', tabId: 1, epoch: 0 },
    baseUrl: 'https://api.example.com',
    apiKey: 'k',
    model: 'm',
    voice: 'v',
    text,
    speed: 1,
    volume: 0.7,
  };
}

function setup() {
  const events: OffscreenEvent[] = [];
  const contexts: FakeAudioContext[] = [];
  const synth: {
    d: ReturnType<typeof deferred<{ audio: ArrayBuffer }>>;
    signal: AbortSignal;
    resolved?: boolean;
  }[] = [];
  const player = new TtsPlayer({
    createAudioContext: () => {
      const c = new FakeAudioContext();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
    synthesize: (r) => {
      const d = deferred<{ audio: ArrayBuffer }>();
      synth.push({ d, signal: r.signal });
      return d.promise;
    },
    emit: (e) => events.push(e),
    idleCloseMs: 1000,
  });
  const lastSource = () =>
    contexts[0]!.createBufferSource.mock.results.at(-1)?.value as FakeBufferSource | undefined;
  return { player, events, contexts, synth, lastSource };
}

const kinds = (events: OffscreenEvent[]) =>
  events.map((e) => (e.kind === 'tts/event' ? `${e.utteranceId}:${e.event}` : e.kind));

describe('TtsPlayer (offscreen cloud dubbing)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('synthesizes, decodes, plays through its own gain and reports start/end', async () => {
    const { player, events, contexts, synth, lastSource } = setup();
    player.play(req('u1'));
    expect(player.pendingRequests).toBe(1);
    synth[0]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    const source = lastSource()!;
    expect(source.started).toBe(true);
    expect(contexts[0]!.gains[0]!.gain.value).toBe(0.7);
    expect(kinds(events)).toEqual(['u1:start']);
    source.finish();
    expect(kinds(events)).toEqual(['u1:start', 'u1:end']);
    expect(source.disconnect).toHaveBeenCalled();
    expect(source.onended).toBeNull();
    expect(player.busy).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(contexts[0]!.state).toBe('closed');
  });

  it('T15: stop during synthesis aborts the request and a late result never plays', async () => {
    const { player, events, contexts, synth } = setup();
    player.play(req('u1'));
    expect(player.stop('other')).toBe(false);
    expect(player.stop('u1')).toBe(true);
    expect(synth[0]!.signal.aborted).toBe(true);
    synth[0]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts).toHaveLength(0);
    expect(kinds(events)).toEqual(['u1:interrupted']);
  });

  it('T15: stop during decode discards the decoded buffer', async () => {
    const { player, events, contexts, synth } = setup();
    player.play(req('u1'));
    synth[0]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    // 已播放；再来一个 play，其解码被挂起
    const gate = deferred<unknown>();
    contexts[0]!.decodeImpl = () => gate.promise;
    player.play(req('u2'));
    synth[1]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    player.stop();
    gate.resolve({ duration: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(contexts[0]!.createBufferSource).toHaveBeenCalledTimes(1);
    expect(kinds(events)).toEqual(['u1:start', 'u1:interrupted', 'u2:interrupted']);
  });

  it('reports synthesis/decode errors and recovers for the next utterance', async () => {
    const { player, events, contexts, synth } = setup();
    player.play(req('u1'));
    synth[0]!.d.reject(new Error('network'));
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({
      utteranceId: 'u1',
      event: 'error',
      error: { code: 'tts-play-failed' },
    });
    expect(player.state).toBe('error');
    player.play(req('u2'));
    synth[1]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    contexts[0]!.decodeImpl = async () => {
      throw new Error('bad mp3');
    };
    player.play(req('u3'));
    synth[2]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({
      utteranceId: 'u3',
      event: 'error',
      error: { code: 'tts-decode-failed' },
    });
  });

  it('dispose stops playback and closes the context', async () => {
    const { player, events, contexts, synth, lastSource } = setup();
    player.play(req('u1'));
    synth[0]!.d.resolve({ audio: new ArrayBuffer(8) });
    await vi.advanceTimersByTimeAsync(0);
    await player.dispose();
    expect(lastSource()!.stop).toHaveBeenCalled();
    expect(contexts[0]!.state).toBe('closed');
    expect(kinds(events)).toEqual(['u1:start', 'u1:interrupted']);
    await player.dispose();
  });

  it('review#3: rejects a play that arrives after a stop for the same utterance id', async () => {
    const { player, events, synth } = setup();
    expect(player.stop('late-1')).toBe(false);
    expect(() => player.play(req('late-1'))).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'tts-utterance-stopped' }) }),
    );
    expect(synth).toHaveLength(0);
    expect(events).toHaveLength(0);
    player.play(req('u2'));
    player.stop();
    expect(player.isStopped('u2')).toBe(true);
  });

  it('review#13: caches synthesized audio (LRU, bounded) and clears it on session change and dispose', async () => {
    const { player, synth, lastSource } = setup();
    const playAndFinish = async (id: string, text: string, sessionId = 'session-0001') => {
      player.play({ ...req(id, text), owner: { sessionId, tabId: 1, epoch: 0 } });
      if (synth.length > 0 && !synth.at(-1)!.resolved) {
        synth.at(-1)!.resolved = true;
        synth.at(-1)!.d.resolve({ audio: new Uint8Array([1, 2, 3, 4]).buffer });
      }
      await vi.advanceTimersByTimeAsync(0);
      lastSource()?.finish();
    };
    await playAndFinish('a1', '同一句');
    expect(synth).toHaveLength(1);
    await playAndFinish('a2', '同一句');
    expect(synth).toHaveLength(1); // 命中缓存，没有再次合成
    expect(player.cacheSize.entries).toBe(1);
    await playAndFinish('a3', '另一句');
    expect(synth).toHaveLength(2);
    await playAndFinish('b1', '同一句', 'session-0002');
    expect(synth).toHaveLength(3); // 会话变化清空缓存
    expect(player.cacheSize.entries).toBe(1);
    await player.dispose();
    expect(player.cacheSize).toEqual({ entries: 0, bytes: 0 });
  });

  it('cache respects the entry cap', async () => {
    const events: OffscreenEvent[] = [];
    const player = new TtsPlayer({
      createAudioContext: () => new FakeAudioContext() as unknown as AudioContext,
      synthesize: async () => ({ audio: new Uint8Array(10).buffer }),
      emit: (e) => events.push(e),
      cacheMaxEntries: 2,
    });
    for (const t of ['一', '二', '三']) {
      player.play(req(`c-${t}`, t));
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(player.cacheSize).toEqual({ entries: 2, bytes: 20 });
    await player.dispose();
  });
});

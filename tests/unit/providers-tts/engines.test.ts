import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenClient } from '@src/audio/types';
import type { OffscreenEvent, OffscreenRequest } from '@src/messaging/offscreen-protocol';
import { createDubbingController } from '@src/providers/tts/dubbing-controller';
import { createSub2apiTtsEngine } from '@src/providers/tts/sub2api-engine';
import { synthesizeSpeech } from '@src/providers/tts/sub2api-speech';
import {
  createSystemTtsEngine,
  type ChromeTtsLike,
  type ChromeTtsOptionsLike,
} from '@src/providers/tts/system-engine';
import type { TtsEngineEvent, TtsUtterance } from '@src/providers/tts/types';
import { selectVoice } from '@src/providers/tts/voices';

const utt = (id: string, p: Partial<TtsUtterance> = {}): TtsUtterance => ({
  utteranceId: id,
  text: '你好',
  lang: 'zh-CN',
  rate: 1,
  volume: 1,
  ...p,
});

describe('selectVoice', () => {
  const voices = [
    { voiceName: 'Meijia', lang: 'zh-TW' },
    { voiceName: 'Sinji', lang: 'zh-HK' },
    { voiceName: 'Google 普通话', lang: 'zh-CN', remote: true },
    { voiceName: 'Tingting', lang: 'zh_CN' },
    { voiceName: 'Samantha', lang: 'en-US' },
  ];
  it('prefers exact language, local voices, and never Cantonese for zh-CN', () => {
    expect(selectVoice(voices, 'zh-CN')).toMatchObject({
      ok: true,
      voice: { voiceName: 'Tingting' },
    });
    expect(selectVoice([{ voiceName: 'Sinji', lang: 'zh-HK' }], 'zh-CN')).toEqual({
      ok: false,
      reason: 'no-voice-for-language',
    });
    expect(selectVoice([{ voiceName: 'Meijia', lang: 'zh-TW' }], 'zh-CN')).toMatchObject({
      ok: true,
      voice: { voiceName: 'Meijia' },
    });
    expect(selectVoice(voices, 'zh-TW')).toMatchObject({ voice: { voiceName: 'Meijia' } });
    expect(selectVoice(voices, 'ja')).toEqual({ ok: false, reason: 'no-voice-for-language' });
  });
  it('honours a preferred voice only when it matches the target language', () => {
    expect(selectVoice(voices, 'zh-CN', 'Google 普通话')).toMatchObject({
      voice: { voiceName: 'Google 普通话' },
      usedPreferred: true,
    });
    expect(selectVoice(voices, 'zh-CN', 'Samantha')).toMatchObject({
      voice: { voiceName: 'Tingting' },
      usedPreferred: false,
    });
  });
  it('accepts unlabeled voices only for cloud engines', () => {
    expect(selectVoice([{ voiceName: 'alloy' }], 'zh-CN').ok).toBe(false);
    expect(
      selectVoice([{ voiceName: 'alloy' }], 'zh-CN', undefined, { allowUnlabeled: true }).ok,
    ).toBe(true);
  });
});

class FakeChromeTts implements ChromeTtsLike {
  calls: { text: string; options: ChromeTtsOptionsLike }[] = [];
  stops = 0;
  speakImpl: () => Promise<void> | void = () => undefined;
  voices: Array<{ voiceName?: string; lang?: string; remote?: boolean }> = [];
  speak(text: string, options: ChromeTtsOptionsLike) {
    this.calls.push({ text, options });
    return this.speakImpl();
  }
  stop() {
    this.stops++;
  }
  async getVoices() {
    return this.voices;
  }
  fire(i: number, type: string, errorMessage?: string) {
    this.calls[i]!.options.onEvent!({ type, errorMessage });
  }
}

describe('system TTS engine (chrome.tts)', () => {
  it('speaks with enqueue:false and forwards start/end for the current utterance', () => {
    const api = new FakeChromeTts();
    const engine = createSystemTtsEngine(api);
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('a', { voiceName: 'Tingting', rate: 20, volume: 3 }), (e) => events.push(e));
    expect(api.calls[0]!.options).toMatchObject({
      enqueue: false,
      lang: 'zh-CN',
      voiceName: 'Tingting',
      rate: 10,
      volume: 1,
    });
    api.fire(0, 'start');
    api.fire(0, 'start');
    api.fire(0, 'word');
    api.fire(0, 'end');
    api.fire(0, 'end');
    expect(events).toEqual([
      { type: 'start', utteranceId: 'a' },
      { type: 'end', utteranceId: 'a' },
    ]);
  });

  it('T15: after stop, late events from the old utterance are ignored', () => {
    const api = new FakeChromeTts();
    const engine = createSystemTtsEngine(api);
    const oldEvents: TtsEngineEvent[] = [];
    engine.speak(utt('old'), (e) => oldEvents.push(e));
    engine.stop();
    expect(api.stops).toBe(1);
    api.fire(0, 'start');
    api.fire(0, 'interrupted');
    api.fire(0, 'end');
    expect(oldEvents).toEqual([]);
    // 新句子打断旧句子时，旧句子的 interrupted 不会串到新 listener
    const newEvents: TtsEngineEvent[] = [];
    engine.speak(utt('new1'), () => undefined);
    engine.speak(utt('new2'), (e) => newEvents.push(e));
    api.fire(1, 'interrupted');
    api.fire(2, 'start');
    expect(newEvents).toEqual([{ type: 'start', utteranceId: 'new2' }]);
  });

  it('maps error events and speak() failures without leaking details', async () => {
    const api = new FakeChromeTts();
    const engine = createSystemTtsEngine(api);
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('a'), (e) => events.push(e));
    api.fire(0, 'error', 'voice unavailable token=abc123');
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'tts-system-error', category: 'tts' },
    });
    expect(JSON.stringify(events[0])).not.toContain('abc123');
    api.speakImpl = () => Promise.reject(new Error('Invalid voice'));
    engine.speak(utt('b'), (e) => events.push(e));
    await Promise.resolve();
    await Promise.resolve();
    expect(events[1]).toMatchObject({
      type: 'error',
      utteranceId: 'b',
      error: { code: 'tts-system-speak-failed' },
    });
    api.speakImpl = () => {
      throw new Error('sync');
    };
    engine.speak(utt('c'), (e) => events.push(e));
    engine.stop();
    await Promise.resolve();
    expect(events).toHaveLength(2);
  });

  it('lists real voices only', async () => {
    const api = new FakeChromeTts();
    api.voices = [{ voiceName: 'Tingting', lang: 'zh-CN', remote: false }, { lang: 'en' }];
    await expect(createSystemTtsEngine(api).getVoices()).resolves.toEqual([
      { voiceName: 'Tingting', lang: 'zh-CN', remote: false, extensionId: undefined },
    ]);
  });
});

function fakeOffscreen() {
  const listeners = new Set<(e: OffscreenEvent) => void>();
  const requests: OffscreenRequest[] = [];
  let impl: (r: OffscreenRequest) => Promise<unknown> = async () => ({ accepted: true });
  const client = {
    ensure: vi.fn(),
    queryStatus: vi.fn(),
    request: vi.fn((r: OffscreenRequest) => {
      requests.push(r);
      return impl(r);
    }),
    onEvent: (l: (e: OffscreenEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    onHello: vi.fn(),
    closeIfIdle: vi.fn(),
  };
  return {
    client: client as unknown as OffscreenClient,
    requests,
    setImpl: (f: typeof impl) => (impl = f),
    emit: (e: OffscreenEvent) => listeners.forEach((l) => l(e)),
  };
}

describe('sub2api TTS engine (via offscreen, unverified against real service)', () => {
  const route = {
    baseUrl: 'https://api.example.com',
    apiKey: 'sk-x',
    model: 'tts-model',
    voice: 'alloy',
  };
  const owner = { sessionId: 'session-0001', tabId: 1, epoch: 2 };

  it('sends tts/play with a unique remote id and forwards matching events', async () => {
    const off = fakeOffscreen();
    const engine = createSub2apiTtsEngine({
      offscreen: off.client,
      getRoute: () => route,
      getOwner: () => owner,
    });
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('cue-1', { rate: 9, volume: 0.5 }), (e) => events.push(e));
    const play = off.requests[0] as Extract<OffscreenRequest, { kind: 'tts/play' }>;
    expect(play).toMatchObject({
      kind: 'tts/play',
      owner,
      model: 'tts-model',
      voice: 'alloy',
      speed: 4,
      volume: 0.5,
      text: '你好',
    });
    expect(play.utteranceId).not.toBe('cue-1');
    off.emit({ kind: 'tts/event', utteranceId: 'cue-1', event: 'start' });
    expect(events).toEqual([]);
    off.emit({ kind: 'tts/event', utteranceId: play.utteranceId, event: 'start' });
    off.emit({ kind: 'tts/event', utteranceId: play.utteranceId, event: 'end' });
    expect(events).toEqual([
      { type: 'start', utteranceId: 'cue-1' },
      { type: 'end', utteranceId: 'cue-1' },
    ]);
  });

  it('T15: stop sends tts/stop and blocks late events, even for a reused caller id', async () => {
    const off = fakeOffscreen();
    const engine = createSub2apiTtsEngine({
      offscreen: off.client,
      getRoute: () => route,
      getOwner: () => owner,
    });
    const first: TtsEngineEvent[] = [];
    engine.speak(utt('same'), (e) => first.push(e));
    const firstId = (off.requests[0] as { utteranceId: string }).utteranceId;
    engine.stop();
    expect(off.requests[1]).toEqual({ kind: 'tts/stop', utteranceId: firstId });
    const second: TtsEngineEvent[] = [];
    engine.speak(utt('same'), (e) => second.push(e));
    off.emit({ kind: 'tts/event', utteranceId: firstId, event: 'start' });
    expect(first).toEqual([]);
    expect(second).toEqual([]);
  });

  it('review #7: rebuilding an engine never reuses a stopped physical operation id', () => {
    const off = fakeOffscreen();
    const params = { offscreen: off.client, getRoute: () => route, getOwner: () => owner };
    const first = createSub2apiTtsEngine(params);
    first.speak(utt('dub-0-1'), () => undefined);
    const oldId = (off.requests[0] as { utteranceId: string }).utteranceId;
    first.stop();
    first.dispose?.();
    const second = createSub2apiTtsEngine(params);
    const events: TtsEngineEvent[] = [];
    second.speak(utt('dub-0-1'), (e) => events.push(e));
    const newId = (off.requests.at(-1) as { utteranceId: string }).utteranceId;
    expect(newId).not.toBe(oldId);
    off.emit({ kind: 'tts/event', utteranceId: oldId, event: 'interrupted' });
    expect(events).toEqual([]);
    off.emit({ kind: 'tts/event', utteranceId: newId, event: 'start' });
    expect(events).toEqual([{ type: 'start', utteranceId: 'dub-0-1' }]);
    second.dispose?.();
  });

  it('reports configuration and request errors asynchronously', async () => {
    const off = fakeOffscreen();
    let r: typeof route | null = null;
    let o: typeof owner | null = owner;
    const engine = createSub2apiTtsEngine({
      offscreen: off.client,
      getRoute: () => r,
      getOwner: () => o,
    });
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('a'), (e) => events.push(e));
    expect(events).toEqual([]);
    await Promise.resolve();
    expect(events[0]).toMatchObject({
      type: 'error',
      error: { code: 'tts-not-configured', category: 'config' },
    });
    r = route;
    o = null;
    engine.speak(utt('b'), (e) => events.push(e));
    await Promise.resolve();
    expect(events[1]).toMatchObject({ error: { code: 'tts-no-owner' } });
    o = owner;
    off.setImpl(async () => Promise.reject(new Error('offscreen gone')));
    engine.speak(utt('c'), (e) => events.push(e));
    await new Promise((res) => setTimeout(res, 0));
    expect(events[2]).toMatchObject({
      type: 'error',
      utteranceId: 'c',
      error: { code: 'sub2api-tts-request-failed' },
    });
    expect(off.requests.every((q) => q.kind === 'tts/play')).toBe(true);
    await expect(engine.getVoices()).resolves.toEqual([{ voiceName: 'alloy', remote: true }]);
  });
});

describe('synthesizeSpeech (unverified against real service)', () => {
  const base = {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-1',
    model: 'tts-1',
    voice: 'alloy',
    text: '你好',
    speed: 1,
  };
  it('posts documented fields only and returns audio', async () => {
    const fetchImpl = vi.fn(
      async (_u: RequestInfo | URL, _i?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'audio/mpeg' } }),
    );
    const r = await synthesizeSpeech({ ...base, signal: new AbortController().signal, fetchImpl });
    expect(r.audio.byteLength).toBe(3);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/audio/speech');
    expect(init).toMatchObject({ redirect: 'error', method: 'POST' });
    expect(JSON.parse(init!.body as string)).toEqual({
      model: 'tts-1',
      input: '你好',
      response_format: 'mp3',
      voice: 'alloy',
    });
    await synthesizeSpeech({
      ...base,
      voice: '',
      speed: 1.5,
      signal: new AbortController().signal,
      fetchImpl,
    });
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]!.body as string)).toEqual({
      model: 'tts-1',
      input: '你好',
      response_format: 'mp3',
      speed: 1.5,
    });
  });
  it('rejects non-audio, empty, error and redirect responses', async () => {
    const signal = new AbortController().signal;
    await expect(
      synthesizeSpeech({
        ...base,
        signal,
        fetchImpl: async () =>
          new Response('{}', { headers: { 'content-type': 'application/json' } }),
      }),
    ).rejects.toMatchObject({ info: { code: 'sub2api-tts-bad-response' } });
    await expect(
      synthesizeSpeech({
        ...base,
        signal,
        fetchImpl: async () =>
          new Response(new Uint8Array(), { headers: { 'content-type': 'audio/mpeg' } }),
      }),
    ).rejects.toMatchObject({ info: { code: 'sub2api-tts-empty' } });
    await expect(
      synthesizeSpeech({
        ...base,
        signal,
        fetchImpl: async () =>
          new Response('{"error":{"code":"invalid_api_key"}}', { status: 401 }),
      }),
    ).rejects.toMatchObject({ info: { code: 'auth-invalid', category: 'auth' } });
    await expect(
      synthesizeSpeech({
        ...base,
        signal,
        fetchImpl: async () =>
          new Response(null, { status: 307, headers: { location: 'https://other.example' } }),
      }),
    ).rejects.toMatchObject({ info: { code: 'redirect-blocked' } });
    await expect(
      synthesizeSpeech({ ...base, baseUrl: 'http://api.example.com', signal, fetchImpl: vi.fn() }),
    ).rejects.toMatchObject({ info: { code: 'base-url-insecure' } });
  });
});

describe('fake timers guard', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('system engine does not rely on timers', () => {
    const api = new FakeChromeTts();
    createSystemTtsEngine(api).speak(utt('x'), () => undefined);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('review#6/#12: sub2api engine lifecycle and routing', () => {
  it('dispose removes the offscreen event subscription (listeners back to 0) and stops the current utterance', async () => {
    const listeners = new Set<(e: OffscreenEvent) => void>();
    const requests: OffscreenRequest[] = [];
    const off = {
      ensure: vi.fn(),
      queryStatus: vi.fn(),
      request: vi.fn(async (r: OffscreenRequest) => {
        requests.push(r);
        return {};
      }),
      onEvent: (l: (e: OffscreenEvent) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      onHello: vi.fn(),
      closeIfIdle: vi.fn(),
    } as unknown as OffscreenClient;
    for (let i = 0; i < 5; i++) {
      const engine = createSub2apiTtsEngine({
        offscreen: off,
        getRoute: () => ({ baseUrl: 'https://a.example', apiKey: 'k', model: 'm', voice: 'v' }),
        getOwner: () => ({ sessionId: 'session-0001', tabId: 1, epoch: 0 }),
      });
      const c = createDubbingController({ engine, now: () => Date.now() });
      engine.speak(utt('u'), () => undefined);
      c.dispose();
    }
    expect(listeners.size).toBe(0);
    expect(requests.filter((r) => r.kind === 'tts/stop')).toHaveLength(5);
  });

  it('speak after dispose reports tts-engine-disposed without requests', async () => {
    const off = fakeOffscreen();
    const engine = createSub2apiTtsEngine({
      offscreen: off.client,
      getRoute: () => ({ baseUrl: 'https://a.example', apiKey: 'k', model: 'm', voice: '' }),
      getOwner: () => ({ sessionId: 'session-0001', tabId: 1, epoch: 0 }),
    });
    engine.dispose?.();
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('x'), (e) => events.push(e));
    await Promise.resolve();
    expect(events[0]).toMatchObject({ type: 'error', error: { code: 'tts-engine-disposed' } });
    expect(off.requests).toHaveLength(0);
  });

  it('uses the current route voice (empty allowed), exposes voiceKey, and getVoices reports tts-not-configured', async () => {
    const off = fakeOffscreen();
    let route: { baseUrl: string; apiKey: string; model: string; voice: string } | null = {
      baseUrl: 'https://a.example',
      apiKey: 'k',
      model: 'm',
      voice: '',
    };
    const engine = createSub2apiTtsEngine({
      offscreen: off.client,
      getRoute: () => route,
      getOwner: () => ({ sessionId: 'session-0001', tabId: 1, epoch: 0 }),
    });
    await expect(engine.getVoices()).resolves.toEqual([{ voiceName: '', remote: true }]);
    engine.speak(utt('x', { voiceName: 'Tingting' }), () => undefined);
    expect(off.requests[0]).toMatchObject({ kind: 'tts/play', voice: '' });
    const key1 = engine.voiceKey?.();
    route = { ...route, voice: 'nova' };
    expect(engine.voiceKey?.()).not.toBe(key1);
    route = null;
    await expect(engine.getVoices()).rejects.toMatchObject({
      info: { code: 'tts-not-configured' },
    });
  });

  it('system engine dispose is a no-op for the shared engine', () => {
    const api = new FakeChromeTts();
    const engine = createSystemTtsEngine(api);
    const events: TtsEngineEvent[] = [];
    engine.speak(utt('preview'), (e) => events.push(e));
    engine.dispose?.();
    expect(api.stops).toBe(0);
    api.fire(0, 'start');
    expect(events).toEqual([{ type: 'start', utteranceId: 'preview' }]);
  });
});

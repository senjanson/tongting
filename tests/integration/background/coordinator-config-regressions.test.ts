import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSystemTtsEngine, type ChromeTtsOptionsLike } from '@src/providers/tts/system-engine';
import { loadSecret } from '@src/background/settings-store';
import { configure, createHarness, FakeScheduler, wait, type Harness } from './harness';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const active: Harness[] = [];
function harness() {
  const h = createHarness();
  active.push(h);
  return h;
}

async function start(h: Harness, asr = false) {
  await configure(h, { asr });
  const content = h.content(1);
  content.hello();
  content.navigate('aaaaaaaaaaa', { tracks: !asr });
  await wait(20);
  await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
  await wait(20);
  if (!asr) content.trackData();
  await h.coordinator.idle();
  return content;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const h of active.splice(0)) {
    h.coordinator.cancelVoicePreview();
    await h.coordinator.handleCommand({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  }
});

describe('review #3/#6: authoritative configuration and credential mutations', () => {
  it('serializes overlapping patches through storage and overlay without dropping fields', async () => {
    const h = harness();
    const content = await start(h);
    const gate = deferred();
    const set = h.local.set.bind(h.local);
    let first = true;
    h.local.set = async (items) => {
      if ('settings' in items && first) {
        first = false;
        await gate.promise;
      }
      return set(items);
    };
    const older = h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 30 } },
    });
    await wait(10);
    const newer = h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 40 }, targetLanguage: 'ja' },
    });
    gate.resolve();
    await Promise.all([older, newer]);
    expect(h.coordinator.settings().captions.fontSizePx).toBe(40);
    expect(h.coordinator.settings().targetLanguage).toBe('ja');
    expect(h.local.data.get('settings')).toEqual(h.coordinator.settings());
    expect(content.messages('display/settings').at(-1)).toMatchObject({
      captions: { fontSizePx: 40 },
      targetLanguage: 'ja',
    });
  });

  it.each(['apiKey', 'asrToken'] as const)(
    'clear %s cancels immediately and prevents a delayed older save from restoring it',
    async (kind) => {
      const h = harness();
      await start(h, kind === 'asrToken');
      const gate = deferred();
      const set = h.session.set.bind(h.session);
      h.session.set = async (items) => {
        if (`secret.${kind}` in items) await gate.promise;
        return set(items);
      };
      const older = h.coordinator
        .handleCommand(
          kind === 'apiKey'
            ? { kind: 'credentials/set', apiKey: 'new-secret-value', remember: false }
            : { kind: 'asr/set-token', token: 'new-secret-value' },
        )
        .catch((error: unknown) => error);
      await wait(10);
      const clear = h.coordinator.handleCommand(
        kind === 'apiKey' ? { kind: 'credentials/clear' } : { kind: 'asr/clear-token' },
      );
      await wait(20);
      const snapshot = h.coordinator.buildSnapshot(1);
      expect(
        kind === 'apiKey' ? snapshot.credential.configured : snapshot.asrToken.configured,
      ).toBe(false);
      if (kind === 'apiKey') expect(FakeScheduler.all.at(-1)!.disposed).toBe(true);
      else expect(h.offscreen.kinds()).toContain('capture/stop');
      // 即使 worker 此刻退出，也不能恢复尚未清理的旧副本。
      expect((await loadSecret(h.deps.storage, kind)).value).toBeUndefined();
      gate.resolve();
      await Promise.all([older, clear]);
      expect((await loadSecret(h.deps.storage, kind)).value).toBeUndefined();
      const latest =
        kind === 'apiKey'
          ? { kind: 'credentials/set' as const, apiKey: 'latest-secret-value', remember: false }
          : { kind: 'asr/set-token' as const, token: 'latest-secret-value' };
      await h.coordinator.handleCommand(latest);
      expect((await loadSecret(h.deps.storage, kind)).value).toBe('latest-secret-value');
    },
  );

  it('reports failed deletion, never reloads the revoked key, and permits cleanup retry', async () => {
    const h = harness();
    await configure(h);
    const remove = h.session.remove.bind(h.session);
    h.session.remove = async () => {
      throw new Error('storage unavailable');
    };
    await expect(h.coordinator.handleCommand({ kind: 'credentials/clear' })).rejects.toMatchObject({
      info: { code: 'secret-cleanup-incomplete' },
    });
    expect(h.coordinator.buildSnapshot(1).credential).toMatchObject({
      configured: false,
      cleanupPending: true,
    });
    expect(await loadSecret(h.deps.storage, 'apiKey')).toMatchObject({
      value: undefined,
      cleanupPending: true,
    });
    h.session.remove = remove;
    await h.coordinator.handleCommand({ kind: 'credentials/clear' });
    expect(h.coordinator.buildSnapshot(2).credential.cleanupPending).toBe(false);
    expect(h.session.data.has('secret.apiKey')).toBe(false);
  });

  it('clear wins over an in-flight remember migration, including its worker-restart view', async () => {
    const h = harness();
    await configure(h);
    const gate = deferred();
    const set = h.secureLocal.set.bind(h.secureLocal);
    h.secureLocal.set = async (items) => {
      if ('secret.apiKey' in items) await gate.promise;
      return set(items);
    };
    const migration = h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { rememberCredentials: true },
    });
    await wait(10);
    const clear = h.coordinator.handleCommand({ kind: 'credentials/clear' });
    await wait(10);
    expect((await loadSecret(h.deps.storage, 'apiKey')).value).toBeUndefined();
    gate.resolve();
    await Promise.all([migration, clear]);
    expect(h.coordinator.apiKey()).toBeUndefined();
    expect((await loadSecret(h.deps.storage, 'apiKey')).value).toBeUndefined();
    await h.coordinator.handleCommand({
      kind: 'credentials/set',
      apiKey: 'new-after-clear',
      remember: true,
    });
    expect((await loadSecret(h.deps.storage, 'apiKey')).value).toBe('new-after-clear');
  });
});

describe('review #2/#14/#15: routing, capability identity and permission cleanup', () => {
  it('keeps the latest ASR route while resume is waiting for a stream id', async () => {
    const h = harness();
    await start(h, true);
    await h.coordinator.handleCommand({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    const gate = deferred();
    let first = true;
    h.deps.tabCapture.getMediaStreamId = async () => {
      if (first) {
        first = false;
        await gate.promise;
      }
      return 'new-stream';
    };
    await h.coordinator.handleCommand({ kind: 'session/resume', tabId: 1 });
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { sourceLanguage: 'ja', asr: { segmentMs: 5000 } },
    });
    await h.coordinator.idle();
    gate.resolve();
    await wait(10);
    const starts = h.offscreen.requests.filter((r) => r.kind === 'capture/start');
    expect(starts).toHaveLength(2);
    expect(starts.at(-1)).toMatchObject({ language: 'ja', segmentMs: 5000 });
    expect(h.coordinator.buildSnapshot(1).sessions[0]?.phase).toBe('running');
  });

  it('stops active ASR immediately when captions-only is selected', async () => {
    const h = harness();
    await start(h, true);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { sourceStrategy: 'captions-only' },
    });
    await h.coordinator.idle();
    expect(h.offscreen.kinds()).toContain('capture/stop');
    expect(h.coordinator.buildSnapshot(1).sessions[0]?.sourceMode).not.toBe('asr');
  });

  it('changes ASR language and segment size by releasing and replacing physical capture', async () => {
    const h = harness();
    await start(h, true);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { sourceLanguage: 'ja', asr: { segmentMs: 5000 } },
    });
    await h.coordinator.idle();
    const starts = h.offscreen.requests.filter((r) => r.kind === 'capture/start');
    expect(starts).toHaveLength(2);
    expect(starts.at(-1)).toMatchObject({ language: 'ja', segmentMs: 5000 });
    expect(h.offscreen.kinds()).toContain('capture/stop');
  });

  it('changes the source strategy immediately while running and defers paused restart until resume', async () => {
    const h = harness();
    await start(h, true);
    await h.coordinator.handleCommand({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    const starts = h.offscreen.kinds().filter((k) => k === 'capture/start').length;
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { sourceStrategy: 'captions-only' },
    });
    await h.coordinator.idle();
    expect(h.offscreen.kinds().filter((k) => k === 'capture/start')).toHaveLength(starts);
    expect(h.coordinator.buildSnapshot(1).sessions[0]?.desiredState).toBe('paused');
    await h.coordinator.handleCommand({ kind: 'session/resume', tabId: 1 });
    await h.coordinator.idle();
    expect(h.coordinator.buildSnapshot(2).sessions[0]?.sourceMode).not.toBe('asr');
    expect(h.offscreen.kinds().filter((k) => k === 'capture/start')).toHaveLength(starts);
  });

  it('invalidates an audio capability and rejects an old probe across model A→B→A', async () => {
    const h = harness();
    await configure(h);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { tts: { backend: 'sub2api', sub2apiModel: 'model-a' } },
    });
    await h.coordinator.handleCommand({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: true,
    });
    expect(h.coordinator.buildSnapshot(1).capabilities.tts?.status).toBe('verified');
    const gate = deferred();
    h.deps.probeSub2apiSpeech = async () => {
      await gate.promise;
      return { bytes: 100, contentType: 'audio/mpeg', latencyMs: 1 };
    };
    const probe = h.coordinator
      .handleCommand({ kind: 'connection/check', scope: 'tts', allowBilledAudioProbe: true })
      .catch((error: unknown) => error);
    await wait(10);
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { tts: { sub2apiModel: 'model-b' } },
    });
    expect(h.coordinator.buildSnapshot(2).capabilities.tts).toBeUndefined();
    expect(h.coordinator.buildSnapshot(2).lastConnectionReport).toBeUndefined();
    await h.coordinator.handleCommand({
      kind: 'settings/update',
      patch: { tts: { sub2apiModel: 'model-a' } },
    });
    gate.resolve();
    expect(await probe).toMatchObject({ info: { code: 'check-superseded' } });
    expect(h.coordinator.buildSnapshot(3).capabilities.tts).toBeUndefined();
  });

  it.each(['provider', 'local'] as const)(
    'revoking %s permission stops active capture and scheduler',
    async (route) => {
      const h = harness();
      await start(h, true);
      h.deps.permissions.contains = async (origin) =>
        route === 'local' ? !origin.includes('127.0.0.1') : !origin.includes('api.example.com');
      await h.coordinator.handleCommand({ kind: 'permissions/changed' });
      await h.coordinator.idle();
      expect(h.coordinator.buildSnapshot(1).sessions[0]?.error?.code).toBe(
        'host-permission-revoked',
      );
      expect(h.offscreen.kinds()).toContain('capture/stop');
      expect(FakeScheduler.all.at(-1)!.disposed).toBe(true);
    },
  );

  it('revokes an in-flight initial local permission check before it can start capture', async () => {
    const h = harness();
    await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(10);
    const gate = deferred();
    let first = true;
    h.deps.permissions.contains = async (origin) => {
      if (!origin.includes('127.0.0.1')) return true;
      if (first) {
        first = false;
        await gate.promise;
        return true;
      }
      return false;
    };
    await h.coordinator.handleCommand({ kind: 'session/start', tabId: 1 });
    await wait(10);
    await h.coordinator.handleCommand({ kind: 'permissions/changed' });
    gate.resolve();
    await h.coordinator.idle();
    expect(h.offscreen.kinds()).not.toContain('capture/start');
    expect(h.coordinator.buildSnapshot(1).sessions[0]?.phase).toBe('error');
  });
});

describe('review #13: preview engine ownership', () => {
  it('replaces a pending preview and isolates late end callbacks and the old timeout', async () => {
    const h = harness();
    await h.coordinator.ready;
    const listeners: Parameters<Harness['deps']['systemTts']['speak']>[1][] = [];
    const stop = vi.fn();
    h.deps.systemTts = {
      kind: 'mock',
      getVoices: async () => [],
      stop,
      speak: (_utterance, listener) => {
        listeners.push(listener);
      },
    };
    vi.useFakeTimers();
    const first = h.coordinator
      .handleCommand({ kind: 'tts/preview' })
      .catch((error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    const second = h.coordinator
      .handleCommand({ kind: 'tts/preview' })
      .catch((error: unknown) => error);
    await Promise.resolve();
    expect(await first).toMatchObject({ info: { category: 'cancelled' } });
    listeners[0]!({ type: 'end', utteranceId: 'stale' });
    await vi.advanceTimersByTimeAsync(3000);
    expect(stop).toHaveBeenCalledTimes(1);
    listeners[1]!({ type: 'start', utteranceId: 'current' });
    await second;
    await vi.advanceTimersByTimeAsync(3000);
    expect(stop).toHaveBeenCalledTimes(1);
    await h.coordinator.handleCommand({ kind: 'tts/stop-preview' });
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('times out and releases only its own silent preview', async () => {
    const h = harness();
    await h.coordinator.ready;
    const stop = vi.fn();
    h.deps.systemTts = { kind: 'mock', getVoices: async () => [], stop, speak: () => undefined };
    vi.useFakeTimers();
    const preview = h.coordinator
      .handleCommand({ kind: 'tts/preview' })
      .catch((error: unknown) => error);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(await preview).toMatchObject({ info: { code: 'tts-start-timeout' } });
    await h.coordinator.handleCommand({ kind: 'tts/stop-preview' });
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'session takeover before/after preview starts (%s) isolates its timer and stop button',
    async (started) => {
      const h = harness();
      await h.coordinator.ready;
      const calls: ChromeTtsOptionsLike[] = [];
      const stop = vi.fn();
      h.deps.systemTts = createSystemTtsEngine({
        getVoices: async () => [],
        speak: (_text, options) => {
          calls.push(options);
        },
        stop,
      });
      vi.useFakeTimers();
      const preview = h.coordinator
        .handleCommand({ kind: 'tts/preview' })
        .catch((error: unknown) => error);
      await Promise.resolve();
      calls[0]!.onEvent?.({ type: started ? 'start' : 'word' });
      h.coordinator.cancelVoicePreview();
      h.deps.systemTts.speak(
        { utteranceId: 'session', text: 'session', lang: 'zh-CN', rate: 1, volume: 1 },
        () => undefined,
      );
      const before = stop.mock.calls.length;
      calls[0]!.onEvent?.({ type: 'end' });
      await vi.advanceTimersByTimeAsync(6000);
      await h.coordinator.handleCommand({ kind: 'tts/stop-preview' });
      expect(stop).toHaveBeenCalledTimes(before);
      await preview;
    },
  );
});

/**
 * 诊断日志：脱敏、存储（环形上限、持久化、页面记录校验与限速）、状态变化记录、内容脚本暂存发送。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SessionSnapshot } from '@src/domain/session';
import { applySettingsPatch, defaultSettings } from '@src/domain/settings';
import { createContentDiagSender } from '@src/diagnostics/content-sink';
import { buildDiagnosticsText } from '@src/diagnostics/export';
import { diag, releaseDiagSink, setDiagSink, type DiagRecord } from '@src/diagnostics/log';
import { redact, redactString, redactUrl, REDACTED } from '@src/diagnostics/redact';
import { createStateTracer } from '@src/diagnostics/state-trace';
import { createDiagnosticsStore, DIAG_STORAGE_KEY } from '@src/diagnostics/store';
import type { KeyValueArea } from '@src/background/deps';

class Area implements KeyValueArea {
  data = new Map<string, unknown>();
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>) {
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }
}

afterEach(() => setDiagSink(undefined));

describe('redact', () => {
  it('strips URL parameter values, keys, bearer tokens and long tokens', () => {
    expect(redactUrl('https://www.youtube.com/api/timedtext?v=abc&pot=SECRET&pot=2')).toBe(
      'https://www.youtube.com/api/timedtext?{v,pot}',
    );
    expect(redactUrl('https://api.example.com')).toBe('https://api.example.com');
    const s = redactString(
      'failed https://x.example/v1/a?key=K1 Authorization: Bearer abc.def sk-live-1234567890 ' +
        'A'.repeat(48),
    );
    expect(s).toBe(
      `failed https://x.example/v1/a?{key} Authorization: Bearer ${REDACTED} ${REDACTED} ${REDACTED}`,
    );
  });

  it('redacts sensitive field names, keeps booleans, and bounds size', () => {
    const out = redact({
      apiKey: 'plain',
      token: 'plain',
      authorization: 'plain',
      credentialConfigured: true,
      nested: { deep: { deeper: { deepest: { x: 1 } } } },
      list: Array.from({ length: 25 }, (_, i) => i),
      long: 'ab '.repeat(150),
      n: Number.NaN,
      err: new Error('boom https://a.example/p?sig=1'),
    }) as Record<string, unknown>;
    expect(out.apiKey).toBe(REDACTED);
    expect(out.token).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.credentialConfigured).toBe(true);
    expect(out.nested).toEqual({ deep: { deeper: { deepest: '[…]' } } });
    expect(out.list).toHaveLength(21);
    expect((out.list as unknown[]).at(-1)).toBe('…(+5)');
    expect((out.long as string).length).toBe(301);
    expect(out.n).toBe('NaN');
    expect(out.err).toEqual({ name: 'Error', message: 'boom https://a.example/p?{sig}' });
  });
});

describe('diag entry point', () => {
  it('is a no-op without a sink and redacts data with one; release only clears its own sink', () => {
    diag('nobody.listens', { apiKey: 'x' });
    const got: DiagRecord[] = [];
    const sink = (r: DiagRecord) => got.push(r);
    setDiagSink(sink);
    diag('audio.original', { apiKey: 'x', volume: 0 }, 'warn');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      level: 'warn',
      event: 'audio.original',
      data: { apiKey: REDACTED, volume: 0 },
    });
    releaseDiagSink(() => undefined);
    diag('still.here');
    expect(got).toHaveLength(2);
    releaseDiagSink(sink);
    diag('gone');
    expect(got).toHaveLength(2);
  });
});

describe('diagnostics store', () => {
  it('keeps the newest entries within the count and size limits and persists them', async () => {
    const area = new Area();
    const store = createDiagnosticsStore({ area, maxEntries: 3, saveDelayMs: 1 });
    await store.ready;
    for (let i = 0; i < 5; i++) store.add({ t: i, src: 'bg', level: 'info', event: `e${i}` });
    expect(store.entries().map((e) => e.event)).toEqual(['e2', 'e3', 'e4']);
    await store.flush();
    const saved = area.data.get(DIAG_STORAGE_KEY) as { entries: Array<{ event: string }> };
    expect(saved.entries.map((e) => e.event)).toEqual(['e2', 'e3', 'e4']);

    const small = createDiagnosticsStore({ area: new Area(), maxChars: 250, saveDelayMs: 1 });
    for (let i = 0; i < 5; i++)
      small.add({ t: i, src: 'bg', level: 'info', event: `e${i}`, data: 'x'.repeat(60) });
    expect(small.entries().length).toBeLessThan(5);
    expect(small.entries().at(-1)?.event).toBe('e4');
  });

  it('loads earlier entries before the ones recorded during startup', async () => {
    const area = new Area();
    area.data.set(DIAG_STORAGE_KEY, {
      v: 1,
      entries: [
        { t: 1, src: 'bg', level: 'info', event: 'old' },
        { t: 2, src: 'nope', level: 'info', event: 'invalid' },
      ],
    });
    const store = createDiagnosticsStore({ area, saveDelayMs: 1 });
    store.add({ t: 3, src: 'bg', level: 'info', event: 'new' });
    await store.ready;
    expect(store.entries().map((e) => e.event)).toEqual(['old', 'new']);
    await store.clear();
    expect(store.entries()).toEqual([]);
    expect((area.data.get(DIAG_STORAGE_KEY) as { entries: unknown[] }).entries).toEqual([]);
  });

  it('validates, redacts and rate-limits page entries per tab', async () => {
    let now = 1_000_000;
    const store = createDiagnosticsStore({
      area: new Area(),
      now: () => now,
      pageRatePerMinute: 2,
      saveDelayMs: 1,
    });
    await store.ready;
    store.addFromPage(7, [
      { t: now, src: 'bridge', level: 'warn', event: 'timedtext.response', data: { token: 'T' } },
      { t: now, src: 'bg', level: 'info', event: 'spoofed.worker' },
      { t: now, src: 'page', level: 'info', event: 'bad event' },
      { t: now + 10 * 86_400_000, src: 'page', level: 'loud', event: 'page.ok' },
      { t: now, src: 'page', level: 'info', event: 'over.limit' },
      { t: now, src: 'page', level: 'info', event: 'big', data: 'x'.repeat(3_000) },
    ]);
    expect(store.entries()).toEqual([
      {
        t: now,
        src: 'bridge',
        level: 'warn',
        event: 'timedtext.response',
        tab: 7,
        data: { token: REDACTED },
      },
      { t: now, src: 'page', level: 'info', event: 'page.ok', tab: 7 },
    ]);
    now += 60_000;
    store.addFromPage(7, [
      { t: now, src: 'page', level: 'info', event: 'big', data: { s: 'y'.repeat(250).split('') } },
    ]);
    const events = store.entries().map((e) => e.event);
    expect(events.slice(-2)).toEqual(['diag.page-dropped', 'big']);
    expect(store.entries().at(-2)?.data).toEqual({ tab: 7, dropped: 2 });
  });
});

function session(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    identity: {
      sessionId: 's1',
      tabId: 1,
      documentId: 'd',
      videoId: 'aaaaaaaaaaa',
      navigationId: 1,
      epoch: 0,
    },
    phase: 'starting',
    desiredState: 'running',
    outputMode: 'subtitle-voice',
    targetLanguage: 'zh-CN',
    sourceMode: 'none',
    translation: { total: 0, done: 0, pending: 0, running: 0, failed: 0 },
    resources: {
      capture: 'none',
      asr: 'idle',
      tts: 'idle',
      activeTracks: 0,
      pendingRequests: 0,
    },
    cueVersion: 0,
    startedAt: 0,
    updatedAt: 0,
    ...overrides,
  } as SessionSnapshot;
}

describe('state tracer', () => {
  it('logs only changed fields, progress milestones, first speech and removal', () => {
    const log = vi.fn();
    const tracer = createStateTracer(log);
    tracer.trace([session()], []);
    expect(log).toHaveBeenLastCalledWith(
      'session.new',
      expect.objectContaining({ session: 's1', phase: 'starting', target: 'zh-CN' }),
      'info',
    );
    log.mockClear();
    tracer.trace([session()], []);
    expect(log).not.toHaveBeenCalled();

    tracer.trace(
      [
        session({
          phase: 'running',
          sourceMode: 'incremental-captions',
          notice: { code: 'incremental-captions', message: 'fallback', level: 'warning' },
        }),
      ],
      [],
    );
    expect(log).toHaveBeenCalledWith(
      'session.state',
      {
        session: 's1',
        tab: 1,
        video: 'aaaaaaaaaaa',
        phase: 'running',
        source: 'incremental-captions',
        notice: 'incremental-captions: fallback',
      },
      'warn',
    );

    log.mockClear();
    const speaking = session({
      phase: 'running',
      sourceMode: 'incremental-captions',
      notice: { code: 'incremental-captions', message: 'fallback', level: 'warning' },
      translation: { total: 30, done: 20, pending: 10, running: 0, failed: 0 },
      resources: {
        capture: 'none',
        asr: 'idle',
        tts: 'speaking',
        activeTracks: 0,
        pendingRequests: 0,
      },
    });
    tracer.trace([speaking], []);
    expect(log.mock.calls.map((c) => c[0])).toEqual(['session.progress', 'session.first-speech']);
    log.mockClear();
    // 配音在 speaking / idle 之间切换不产生记录。
    tracer.trace([{ ...speaking, resources: { ...speaking.resources, tts: 'idle' } }], []);
    expect(log).not.toHaveBeenCalled();

    tracer.trace(
      [],
      [
        {
          tabId: 1,
          videoId: 'aaaaaaaaaaa',
          navigationId: 1,
          captionsAvailability: 'available',
          tracks: [{ trackKey: '.en', languageCode: 'en', label: 'English', kind: 'manual' }],
          isLive: false,
        },
      ],
    );
    expect(log.mock.calls.map((c) => c[0])).toEqual(['session.gone', 'page.state']);
    expect(log.mock.calls[1]![1]).toMatchObject({ tab: 1, tracks: 'en:manual' });
  });

  it('marks errors as error level', () => {
    const log = vi.fn();
    createStateTracer(log).trace(
      [
        session({
          phase: 'error',
          error: {
            code: 'auth-failed',
            category: 'auth',
            retryable: false,
            message: 'bad key',
            at: 0,
          },
        }),
      ],
      [],
    );
    expect(log).toHaveBeenCalledWith(
      'session.new',
      expect.objectContaining({ error: 'auth-failed: bad key' }),
      'error',
    );
  });
});

describe('diagnostics export', () => {
  it('sorts entries by time and keeps only the service origin and non-sensitive settings', () => {
    const settings = applySettingsPatch(defaultSettings(), {
      provider: { baseUrl: 'https://api.example.com/v1/secret-path?key=abc' },
      asr: { localUrl: 'http://127.0.0.1:8765/x' },
      glossary: [{ source: 'a', target: 'b' }],
    });
    const text = buildDiagnosticsText({
      version: '1.2.3',
      userAgent: 'UA',
      uiLanguage: 'zh-CN',
      generatedAt: 0,
      settings,
      credentialConfigured: true,
      asrTokenConfigured: false,
      hostPermission: { origin: 'https://api.example.com/*', granted: true },
      sessions: [],
      pages: [],
      entries: [
        { t: 30, src: 'bg', level: 'info', event: 'third' },
        { t: 10, src: 'page', tab: 2, level: 'warn', event: 'first' },
        { t: 20, src: 'bridge', tab: 2, level: 'info', event: 'second' },
      ],
    });
    const events = text
      .split('\n')
      .filter((l) => /(first|second|third)$/.test(l))
      .map((l) => l.split(' ').at(-1));
    expect(events).toEqual(['first', 'second', 'third']);
    expect(text).toContain('"baseUrl":"https://api.example.com"');
    expect(text).toContain('"localUrl":"http://127.0.0.1:8765"');
    expect(text).toContain('"glossaryEntries":1');
    expect(text).not.toMatch(/secret-path|key=abc|"source":"a"/);
    expect(text).toMatch(/page#2 +WARN +first/);
  });
});

describe('content diagnostics sender', () => {
  it('buffers while disconnected, sends batches once ready, and keeps only the newest entries', () => {
    let ready = false;
    const sent: number[] = [];
    const timers: Array<() => void> = [];
    const out = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sender = createContentDiagSender({
      send: (entries) => {
        sent.push(entries.length);
        return true;
      },
      canSend: () => ready,
      setTimeout: (fn) => timers.push(fn),
      clearTimeout: () => undefined,
      console: out,
      maxBuffer: 120,
    });
    for (let i = 0; i < 130; i++)
      sender.record({ t: i, level: i === 0 ? 'warn' : 'info', event: `e${i}` }, 'page');
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(0);
    expect(sender.pending).toBe(120);
    expect(out.warn).toHaveBeenCalledTimes(1);
    expect(out.info).toHaveBeenCalledTimes(129);

    ready = true;
    sender.flush();
    expect(sent).toEqual([50, 50, 20]);
    expect(sender.pending).toBe(0);

    sender.record({ t: 1, level: 'info', event: 'later' }, 'bridge');
    expect(timers).toHaveLength(1);
    timers[0]!();
    expect(sent).toEqual([50, 50, 20, 1]);
  });

  it('keeps entries when a send fails and drops everything on dispose', () => {
    const sender = createContentDiagSender({
      send: () => false,
      canSend: () => true,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    sender.record({ t: 1, level: 'info', event: 'a' }, 'page');
    sender.flush();
    expect(sender.pending).toBe(1);
    sender.dispose();
    expect(sender.pending).toBe(0);
    sender.record({ t: 2, level: 'info', event: 'b' }, 'page');
    expect(sender.pending).toBe(0);
  });
});

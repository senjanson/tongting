import { describe, expect, it, vi } from 'vitest';
import { encodeWavPcm16 } from '@src/audio/wav';
import {
  joinApiPath,
  mapHttpStatus,
  normalizeLoopbackBaseUrl,
  normalizeServiceBaseUrl,
  parseRetryAfterMs,
} from '@src/providers/asr/http';
import {
  asrLanguageParam,
  checkLocalAsrHealth,
  createLocalAsrProvider,
} from '@src/providers/asr/local-client';
import { createAsrProviderFromRoute } from '@src/providers/asr/route';
import { createSub2apiAsrProvider, supportsVerboseJson } from '@src/providers/asr/sub2api-client';

const wav = () => encodeWavPcm16(new Float32Array(16000), 16000);
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function opts(signal = new AbortController().signal, timeoutMs = 5_000) {
  return { language: 'zh-CN', signal, timeoutMs };
}

describe('asr http helpers', () => {
  it('only allows loopback http for the local service', () => {
    expect(normalizeLoopbackBaseUrl('http://127.0.0.1:8765/')).toBe('http://127.0.0.1:8765');
    for (const bad of [
      'http://localhost:9000',
      'http://127.0.0.1',
      'http://[::1]:8765',
      'https://127.0.0.1:8765',
      'http://192.168.1.2:8765',
      'http://127.0.0.1.evil.com',
      'http://u:p@127.0.0.1',
      'http://127.0.0.1:8765/?x=1',
      'nope',
    ]) {
      expect(() => normalizeLoopbackBaseUrl(bad)).toThrow();
    }
  });

  it('requires https for sub2api except loopback, and avoids duplicate /v1', () => {
    expect(normalizeServiceBaseUrl('https://api.example.com/v1/')).toBe(
      'https://api.example.com/v1',
    );
    expect(() => normalizeServiceBaseUrl('http://api.example.com')).toThrow();
    expect(normalizeServiceBaseUrl('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(() => normalizeServiceBaseUrl('http://localhost:3000')).toThrow();
    expect(joinApiPath('https://api.example.com/v1', '/v1/audio/transcriptions')).toBe(
      'https://api.example.com/v1/audio/transcriptions',
    );
    expect(joinApiPath('https://api.example.com', '/v1/audio/transcriptions')).toBe(
      'https://api.example.com/v1/audio/transcriptions',
    );
    expect(joinApiPath('https://api.example.com/proxy', '/v1/x')).toBe(
      'https://api.example.com/proxy/v1/x',
    );
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfterMs('3', 0)).toBe(3000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(parseRetryAfterMs('soon', 0)).toBeUndefined();
    expect(parseRetryAfterMs(null, 0)).toBeUndefined();
  });

  it.each([
    [400, 'format', false],
    [401, 'auth', false],
    [402, 'quota', false],
    [403, 'permission', false],
    [404, 'unsupported', false],
    [413, 'format', false],
    [415, 'format', false],
    [429, 'rate-limit', true],
    [500, 'server', true],
    [503, 'server', true],
  ] as const)('maps HTTP %i to %s (retryable=%s)', (status, category, retryable) => {
    const e = mapHttpStatus(status, undefined, undefined, 'sub2api-asr', 'https://api.example.com');
    expect(e.info).toMatchObject({ category, retryable, httpStatus: status });
  });

  it('treats 429 insufficient_quota as quota', () => {
    expect(mapHttpStatus(429, 'insufficient_quota', 1000, 'sub2api-asr', 'x').info).toMatchObject({
      category: 'quota',
      retryable: false,
    });
  });
});

describe('local ASR client', () => {
  it('posts WAV with bearer token and language, and validates the response', async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      json({
        text: '你好',
        language: 'zh',
        languageProbability: 0.9,
        durationMs: 1000,
        processingMs: 120,
        segments: [{ startMs: 0, endMs: 900, text: '你好', avgLogprob: -0.2, noSpeechProb: 0.01 }],
      }),
    );
    const provider = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 'pair-token',
      fetchImpl,
    });
    const result = await provider.transcribe(wav(), opts());
    expect(result).toMatchObject({
      text: '你好',
      language: 'zh',
      segments: [{ startMs: 0, endMs: 900 }],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:8765/v1/transcribe?language=zh');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer pair-token');
    expect((init!.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
  });

  it.each([
    [401, 'asr-local-token-invalid', 'auth'],
    [403, 'asr-local-forbidden', 'permission'],
    [413, 'audio-too-large', 'format'],
    [415, 'audio-format-unsupported', 'format'],
    [429, 'local-asr-rate-limited', 'rate-limit'],
  ] as const)('maps %i responses', async (status, code, category) => {
    const fetchImpl = vi.fn(async () =>
      json(
        { error: { code: 'x', message: 'Bearer secret-token should not leak' } },
        { status, headers: { 'retry-after': '2' } },
      ),
    );
    const provider = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl,
    });
    const err = await provider.transcribe(wav(), opts()).catch((e: unknown) => e);
    expect(err).toMatchObject({ info: { code, category, httpStatus: status } });
    expect(JSON.stringify((err as { info: unknown }).info)).not.toContain('secret-token');
    if (status === 429) expect(err).toMatchObject({ info: { retryAfterMs: 2000 } });
  });

  it('maps service-specific 400/403 codes (language unsupported blocks, host_not_allowed)', async () => {
    const make = (status: number, code: string) =>
      createLocalAsrProvider({
        baseUrl: 'http://127.0.0.1:8765',
        token: 't',
        fetchImpl: async () => json({ error: { code, message: 'm' } }, { status }),
      });
    await expect(make(400, 'unsupported_language').transcribe(wav(), opts())).rejects.toMatchObject(
      { info: { code: 'asr-local-language-unsupported', category: 'config', retryable: false } },
    );
    await expect(make(400, 'invalid_language').transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-language-unsupported' },
    });
    await expect(make(400, 'invalid_request').transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'local-asr-bad-request', category: 'format', retryable: false },
    });
    await expect(make(403, 'host_not_allowed').transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-host-not-allowed', category: 'permission' },
    });
    await expect(make(405, 'method_not_allowed').transcribe(wav(), opts())).rejects.toMatchObject({
      info: { httpStatus: 405, retryable: false },
    });
    await expect(make(500, 'internal_error').transcribe(wav(), opts())).rejects.toMatchObject({
      info: { category: 'server', retryable: true },
    });
  });

  it('drops the meaningless language of an empty (no speech) result', async () => {
    const provider = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () =>
        json({
          text: '',
          language: 'en',
          languageProbability: 0.39,
          durationMs: 5000,
          processingMs: 800,
          segments: [],
        }),
    });
    await expect(provider.transcribe(wav(), opts())).resolves.toEqual({
      text: '',
      language: undefined,
      languageProbability: undefined,
      durationMs: 5000,
      processingMs: 800,
      segments: [],
    });
  });

  it('distinguishes model loading (503) from other unavailability', async () => {
    const loading = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () =>
        json(
          { error: { code: 'model_loading', message: 'loading' } },
          { status: 503, headers: { 'retry-after': '5' } },
        ),
    });
    await expect(loading.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-model-loading', retryable: true, retryAfterMs: 5000 },
    });
    const down = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    await expect(down.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-unavailable' },
    });
  });

  it('maps network failure, redirect, timeout and cancellation', async () => {
    const network = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () => Promise.reject(new TypeError('Failed to fetch')),
    });
    await expect(network.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-unreachable', category: 'network', retryable: true },
    });

    const redirect = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () =>
        new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    });
    await expect(redirect.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'redirect-blocked', retryable: false },
    });

    const hanging = (_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) =>
        init!.signal!.addEventListener('abort', () =>
          rej(new DOMException('aborted', 'AbortError')),
        ),
      );
    const slow = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: hanging,
    });
    await expect(
      slow.transcribe(wav(), opts(new AbortController().signal, 20)),
    ).rejects.toMatchObject({ info: { category: 'timeout', retryable: true } });

    const controller = new AbortController();
    const p = slow.transcribe(wav(), opts(controller.signal, 5_000));
    controller.abort();
    await expect(p).rejects.toMatchObject({ info: { category: 'cancelled' } });
    const pre = new AbortController();
    pre.abort();
    await expect(slow.transcribe(wav(), opts(pre.signal))).rejects.toMatchObject({
      info: { category: 'cancelled' },
    });
  });

  it('rejects malformed responses, oversize audio and missing token', async () => {
    const bad = createLocalAsrProvider({
      baseUrl: 'http://127.0.0.1:8765',
      token: 't',
      fetchImpl: async () => json({ text: 1 }),
    });
    await expect(bad.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code: 'asr-local-bad-response', category: 'format' },
    });
    const fetchImpl = vi.fn();
    const p = createLocalAsrProvider({ baseUrl: 'http://127.0.0.1:8765', token: 't', fetchImpl });
    await expect(p.transcribe(new ArrayBuffer(3 * 1024 * 1024), opts())).rejects.toMatchObject({
      info: { code: 'audio-too-large' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(() => createLocalAsrProvider({ baseUrl: 'http://127.0.0.1:8765', token: '' })).toThrow();
    expect(() => createLocalAsrProvider({ baseUrl: 'http://10.0.0.2:8765', token: 't' })).toThrow();
  });

  it('health check: ok, loading, unreachable, invalid url; no token sent', async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        status: 'ok',
        ready: true,
        model: 'small',
        device: 'cpu',
        computeType: 'int8_float32',
        version: '0.1.0',
      }),
    );
    const signal = new AbortController().signal;
    await expect(checkLocalAsrHealth('http://127.0.0.1:8765', signal, fetchImpl)).resolves.toEqual({
      status: 'ok',
      ready: true,
      model: 'small',
      device: 'cpu',
      computeType: 'int8_float32',
      version: '0.1.0',
    });
    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/health');
    expect(init.headers).toBeUndefined();
    await expect(
      checkLocalAsrHealth('http://127.0.0.1:8765', signal, async () =>
        json({ status: 'loading', ready: false }),
      ),
    ).resolves.toMatchObject({ status: 'loading', ready: false });
    await expect(
      checkLocalAsrHealth('http://127.0.0.1:8765', signal, async () =>
        Promise.reject(new TypeError('x')),
      ),
    ).resolves.toMatchObject({
      status: 'unreachable',
      ready: false,
      error: { code: 'asr-local-unreachable' },
    });
    await expect(
      checkLocalAsrHealth('https://example.com', signal, fetchImpl),
    ).resolves.toMatchObject({ status: 'error', error: { code: 'asr-local-url-not-loopback' } });
  });

  it('language parameter uses primary tags', () => {
    expect(asrLanguageParam('auto')).toBe('auto');
    expect(asrLanguageParam('zh-CN')).toBe('zh');
    expect(asrLanguageParam('en')).toBe('en');
    expect(asrLanguageParam('??')).toBe('auto');
  });
});

describe('sub2api ASR client (unverified against a real service)', () => {
  it('sends multipart with model and whisper verbose_json, converts seconds to ms', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      json({
        text: 'hi there',
        language: 'english',
        duration: 1.0,
        segments: [
          { start: 0.1, end: 0.8, text: 'hi there', avg_logprob: -0.3, no_speech_prob: 0.02 },
        ],
      }),
    );
    const provider = createSub2apiAsrProvider({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-abc',
      model: 'whisper-1',
      fetchImpl,
    });
    const r = await provider.transcribe(wav(), { ...opts(), language: 'en' });
    expect(r).toMatchObject({
      text: 'hi there',
      language: 'en',
      durationMs: 1000,
      segments: [{ startMs: 100, endMs: 800 }],
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    const form = init!.body as FormData;
    expect(form.get('model')).toBe('whisper-1');
    expect(form.get('response_format')).toBe('verbose_json');
    expect(form.get('language')).toBe('en');
    expect((form.get('file') as File).type).toBe('audio/wav');
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('uses json for non-whisper models and falls back to WAV duration without segments', async () => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, _i?: RequestInit) =>
      json({ text: '你好' }),
    );
    const provider = createSub2apiAsrProvider({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'gpt-4o-mini-transcribe',
      fetchImpl,
    });
    const r = await provider.transcribe(wav(), { ...opts(), language: 'auto' });
    expect(r).toMatchObject({ text: '你好', durationMs: 1000, segments: [] });
    const form = fetchImpl.mock.calls[0]![1]!.body as FormData;
    expect(form.get('response_format')).toBe('json');
    expect(form.get('language')).toBeNull();
    expect(supportsVerboseJson('Whisper-large')).toBe(true);
  });

  it.each([
    [401, 'auth-invalid'],
    [403, 'permission-denied'],
    [404, 'sub2api-asr-not-found'],
    [413, 'audio-too-large'],
    [429, 'sub2api-asr-rate-limited'],
    [503, 'sub2api-asr-server-error'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const provider = createSub2apiAsrProvider({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'whisper-1',
      fetchImpl: async () => json({ error: { type: 'x' } }, { status }),
    });
    await expect(provider.transcribe(wav(), opts())).rejects.toMatchObject({
      info: { code, httpStatus: status },
    });
  });

  it('health does not make billed calls and reports unknown support', async () => {
    const fetchImpl = vi.fn();
    const provider = createSub2apiAsrProvider({
      baseUrl: 'https://api.example.com',
      apiKey: 'k',
      model: 'whisper-1',
      fetchImpl,
    });
    await expect(provider.health(new AbortController().signal)).resolves.toMatchObject({
      ready: false,
      error: { code: 'health-not-supported' },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('validates configuration and route factory', () => {
    expect(() =>
      createSub2apiAsrProvider({ baseUrl: 'http://api.example.com', apiKey: 'k', model: 'm' }),
    ).toThrow();
    expect(() =>
      createSub2apiAsrProvider({ baseUrl: 'https://api.example.com', apiKey: '', model: 'm' }),
    ).toThrow();
    expect(() =>
      createSub2apiAsrProvider({ baseUrl: 'https://api.example.com', apiKey: 'k', model: ' ' }),
    ).toThrow();
    expect(
      createAsrProviderFromRoute({ backend: 'local', baseUrl: 'http://127.0.0.1:8765', token: 't' })
        .kind,
    ).toBe('local');
    expect(
      createAsrProviderFromRoute({
        backend: 'sub2api',
        baseUrl: 'https://a.example.com',
        apiKey: 'k',
        model: 'whisper-1',
      }).kind,
    ).toBe('sub2api');
  });

  describe('review#5: timeout and cancellation cover the response body', () => {
    /** 响应头已到，但服务端迟迟不发 body；body 读取受 init.signal 控制。 */
    function stalledBodyFetch(record: { signal?: AbortSignal }): typeof fetch {
      return (async (_url: RequestInfo | URL, init?: RequestInit) => {
        record.signal = init?.signal ?? undefined;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
      }) as typeof fetch;
    }

    it('times out while waiting for the body', async () => {
      const record: { signal?: AbortSignal } = {};
      const provider = createLocalAsrProvider({
        baseUrl: 'http://127.0.0.1:8765',
        token: 't',
        fetchImpl: stalledBodyFetch(record),
      });
      await expect(
        provider.transcribe(wav(), opts(new AbortController().signal, 50)),
      ).rejects.toMatchObject({
        info: { category: 'timeout', retryable: true },
      });
      expect(record.signal!.aborted).toBe(true);
    });

    it('caller abort reaches an in-flight body read', async () => {
      const record: { signal?: AbortSignal } = {};
      const provider = createLocalAsrProvider({
        baseUrl: 'http://127.0.0.1:8765',
        token: 't',
        fetchImpl: stalledBodyFetch(record),
      });
      const caller = new AbortController();
      const p = provider.transcribe(wav(), opts(caller.signal, 5_000));
      await new Promise((r) => setTimeout(r, 20));
      caller.abort();
      await expect(p).rejects.toMatchObject({ info: { category: 'cancelled' } });
      expect(record.signal!.aborted).toBe(true);
    });

    it('streams the body with a size cap and cancels the stream when exceeded', async () => {
      let cancelled = false;
      const big = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(256 * 1024).fill(32));
        },
        cancel() {
          cancelled = true;
        },
      });
      const provider = createLocalAsrProvider({
        baseUrl: 'http://127.0.0.1:8765',
        token: 't',
        fetchImpl: async () => new Response(big, { status: 200 }),
      });
      await expect(provider.transcribe(wav(), opts())).rejects.toMatchObject({
        info: { code: 'response-too-large' },
      });
      expect(cancelled).toBe(true);
    });

    it('maps 503 model_unavailable distinctly', async () => {
      const provider = createLocalAsrProvider({
        baseUrl: 'http://127.0.0.1:8765',
        token: 't',
        fetchImpl: async () =>
          json({ error: { code: 'model_unavailable', message: 'x' } }, { status: 503 }),
      });
      await expect(provider.transcribe(wav(), opts())).rejects.toMatchObject({
        info: { code: 'asr-local-model-unavailable', retryable: true },
      });
    });
  });
});

/**
 * 真实 fetch 传输 + 本地模拟 sub2api：协议、流式、故障与安全副作用（T05、T08、T09、T30）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTextProvider } from '@src/providers/text/factory';
import { discoverModels } from '@src/providers/text/models';
import type { TextProviderConfig, TranslateBatchInput } from '@src/providers/text/types';
import {
  MOCK_API_KEY,
  startMockSub2api,
  type MockSub2api,
} from '../../helpers/mock-sub2api/server';

const servers: MockSub2api[] = [];
async function server(options: Parameters<typeof startMockSub2api>[0] = {}) {
  const s = await startMockSub2api(options);
  servers.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const input: TranslateBatchInput = {
  items: [
    { id: 'c1', text: "Tanaka didn't eat 3 onigiri today." },
    { id: 'c2', text: 'Kim Minji will not come to Seoul on Friday.' },
    { id: 'c3', text: 'The meeting starts at 9:30, not at 10.' },
  ],
  context: [{ text: 'Previous line for context.' }],
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  style: 'natural',
  glossary: [],
};

function config(s: MockSub2api, overrides: Partial<TextProviderConfig> = {}): TextProviderConfig {
  return {
    baseUrl: `${s.baseUrl}/v1/`,
    apiKey: MOCK_API_KEY,
    protocol: 'responses',
    model: 'gpt-5.6-terra',
    reasoningEffort: 'omit',
    streaming: false,
    ...overrides,
  };
}

const opts = (timeoutMs = 5_000) => ({ signal: new AbortController().signal, timeoutMs });

describe('provider ↔ mock sub2api: happy paths', () => {
  it.each([
    ['responses', false],
    ['responses', true],
    ['chat', false],
    ['chat', true],
  ] as const)(
    '%s (stream=%s) returns validated translations with one authenticated request',
    async (protocol, streaming) => {
      const s = await server({ streamDeltaSize: 3 });
      const provider = createTextProvider(config(s, { protocol, streaming }));
      const partials: number[] = [];
      const result = await provider.translateBatch(input, {
        ...opts(),
        onPartial: (items) => partials.push(items.length),
      });
      expect(result.items).toEqual(input.items.map((i) => ({ id: i.id, text: `译：${i.text}` })));
      expect(result.protocol).toBe(protocol);
      expect(result.usage?.totalTokens).toBe(30);
      const endpoint = protocol === 'responses' ? 'responses' : 'chat';
      expect(s.requestsTo(endpoint)).toHaveLength(1);
      const req = s.requestsTo(endpoint)[0]!;
      expect(req.path).toBe(protocol === 'responses' ? '/v1/responses' : '/v1/chat/completions');
      expect(req.authorization).toBe(`Bearer ${MOCK_API_KEY}`);
      expect(req.completed).toBe(true);
      if (streaming) expect(partials.length).toBeGreaterThan(0);
      else expect(partials).toHaveLength(0);
      expect(s.inflight()).toBe(0);
    },
  );

  it('discovers models and degrades structured output when the service rejects json_schema', async () => {
    const s = await server({ rejectJsonSchema: true });
    expect(
      await discoverModels({
        baseUrl: s.baseUrl,
        apiKey: MOCK_API_KEY,
        signal: new AbortController().signal,
      }),
    ).toEqual(['gpt-5.6-luna', 'gpt-5.6-terra']);
    const provider = createTextProvider(config(s, { protocol: 'chat' }));
    const result = await provider.translateBatch(input, opts());
    expect(result.items).toHaveLength(3);
    const bodies = s
      .requestsTo('chat')
      .map((r) => (r.body as { response_format?: { type: string } }).response_format?.type);
    expect(bodies).toEqual(['json_schema', 'json_object']);
    await provider.translateBatch(input, opts());
    expect(s.requestsTo('chat')).toHaveLength(3);
  });
});

describe('provider ↔ mock sub2api: failures', () => {
  it('T05: an invalid key yields a non-retryable auth error after exactly one request', async () => {
    const s = await server();
    const provider = createTextProvider(config(s, { apiKey: 'wrong-fake-key' }));
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { category: 'auth', retryable: false, httpStatus: 401 },
    });
    expect(s.requests).toHaveLength(1);
    const forbidden = await server({ allowedModels: ['gpt-5.6-luna'] });
    await expect(
      createTextProvider(config(forbidden)).translateBatch(input, opts()),
    ).rejects.toMatchObject({
      info: { category: 'permission', retryable: false, httpStatus: 403 },
    });
    expect(forbidden.requests).toHaveLength(1);
  });

  it('T08: a stream cut mid-way fails as retryable and never returns half JSON', async () => {
    const s = await server();
    const partialJson = JSON.stringify({
      translations: [
        { id: 'c1', text: '田中今天没有吃3个饭团。' },
        { id: 'c2', text: '金' },
      ],
    }).slice(0, 70);
    s.enqueue('responses', {
      kind: 'sse',
      chunks: [
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r"}}\n\n',
        `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: partialJson })}\n\n`,
        'event: response.output_text.delta\ndata: {"type":"response.output_te',
      ],
      chunkDelayMs: 5,
      end: 'destroy',
    });
    const provider = createTextProvider(config(s, { streaming: true }));
    const partials: { id: string; text: string }[][] = [];
    const error = await provider
      .translateBatch(input, { ...opts(), onPartial: (items) => partials.push(items) })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      info: { code: 'stream-interrupted', category: 'network', retryable: true },
    });
    expect(partials.flat().map((p) => p.id)).toEqual(['c1']);
  });

  it.each([
    [
      'responses',
      true,
      'error event',
      ['event: error\ndata: {"type":"error","error":{"message":"upstream boom"}}\n\n'],
    ],
    [
      'responses',
      true,
      'bad JSON in a protocol event',
      ['event: response.output_text.delta\ndata: {not json}\n\n'],
    ],
    ['chat', true, 'error chunk', ['data: {"error":{"message":"upstream boom"}}\n\n']],
    [
      'responses',
      true,
      'SSE larger than 8 MB',
      Array.from({ length: 9 }, () => `: ${'x'.repeat(1024 * 1024)}\n`),
    ],
    [
      'responses',
      false,
      'JSON body larger than 4 MB',
      Array.from({ length: 5 }, () => 'x'.repeat(1024 * 1024)),
    ],
  ] as const)(
    '%s (stream=%s): %s closes the underlying connection so the server stops generating (review #3)',
    async (protocol, streaming, _label, chunks) => {
      const s = await server();
      s.enqueue(protocol, { kind: 'sse', chunks: [...chunks], end: 'hang' });
      const provider = createTextProvider(config(s, { protocol, streaming }));
      await expect(provider.translateBatch(input, opts(10_000))).rejects.toMatchObject({
        info: { category: expect.any(String) },
      });
      await s.waitFor(() => s.inflight() === 0, 2_000);
      expect(s.requests[0]!.aborted).toBe(true);
      expect(s.requests[0]!.completed).toBe(false);
    },
    15_000,
  );

  it('T08: a stream that closes without the completion event fails clearly', async () => {
    const s = await server();
    const full = JSON.stringify({
      translations: input.items.map((i) => ({ id: i.id, text: `译：${i.text}` })),
    });
    s.enqueue('chat', {
      kind: 'sse',
      chunks: [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: full } }] })}\n\n`,
      ],
      end: 'close',
    });
    const provider = createTextProvider(config(s, { protocol: 'chat', streaming: true }));
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { code: 'stream-interrupted', retryable: true },
    });
  });

  it('T08: a hanging stream times out and the connection is actually closed', async () => {
    const s = await server();
    s.enqueue('responses', { kind: 'sse', chunks: [': ping\n\n'], end: 'hang' });
    const provider = createTextProvider(config(s, { streaming: true }));
    await expect(provider.translateBatch(input, opts(150))).rejects.toMatchObject({
      info: { category: 'timeout' },
    });
    await s.waitFor(() => s.inflight() === 0);
    expect(s.requests[0]!.aborted).toBe(true);
  });

  it('cancel closes the in-flight HTTP request on the server side', async () => {
    const s = await server();
    s.enqueue('responses', { kind: 'hang' });
    const controller = new AbortController();
    const provider = createTextProvider(config(s));
    const promise = provider.translateBatch(input, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    await s.waitFor(() => s.inflight() === 1);
    controller.abort();
    await expect(promise).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await s.waitFor(() => s.inflight() === 0);
    expect(s.requests[0]!.aborted).toBe(true);
  });

  it('T09: missing / duplicate ids and broken JSON trigger at most one repair and never mismatch neighbours', async () => {
    const s = await server();
    // 平移：c1 拿到 c2 的译文，c3 缺失
    const shifted = (items: { id: string; text: string }[]) =>
      items.slice(1).map((it, i) => ({ id: items[i]!.id, text: `译：${it.text}` }));
    s.enqueue(
      'responses',
      { kind: 'translate', transform: shifted },
      { kind: 'translate', transform: shifted },
    );
    const provider = createTextProvider(config(s));
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { category: 'format', retryable: true },
    });
    expect(s.requestsTo('responses')).toHaveLength(2);

    const duplicate = (items: { id: string; text: string }[]) => [
      ...items.map((i) => ({ id: i.id, text: `译：${i.text}` })),
      { id: items[0]!.id, text: '译：别的内容' },
    ];
    s.enqueue('responses', { kind: 'translate', transform: duplicate });
    const repaired = await provider.translateBatch(input, opts());
    expect(repaired.repairAttempts).toBe(1);
    expect(repaired.items).toEqual(input.items.map((i) => ({ id: i.id, text: `译：${i.text}` })));

    s.enqueue('responses', {
      kind: 'translate',
      transform: () => '{"translations": [{"id": "c1", "text": "译',
    });
    const afterBrokenJson = await provider.translateBatch(input, opts());
    expect(afterBrokenJson.items).toHaveLength(3);
    expect(s.requestsTo('responses')).toHaveLength(6);
  });

  it('T30: a cross-origin redirect fails and the Authorization header never reaches the other site', async () => {
    const evil = await server({ apiKey: 'evil-expects-anything' });
    const s = await server();
    s.enqueue('responses', {
      kind: 'redirect',
      location: `${evil.baseUrl.replace('127.0.0.1', 'localhost')}/v1/responses`,
      status: 307,
    });
    s.enqueue('models', { kind: 'redirect', location: `${evil.baseUrl}/v1/models`, status: 302 });
    const provider = createTextProvider(config(s));
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { code: 'redirect-blocked', retryable: false },
    });
    await expect(
      discoverModels({
        baseUrl: s.baseUrl,
        apiKey: MOCK_API_KEY,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      info: { code: 'redirect-blocked' },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(evil.requests).toHaveLength(0);
    expect(s.requests).toHaveLength(2);
  });

  it('a 200 HTML page (wrong Base URL) is a clear format error, not a success', async () => {
    const s = await server();
    s.enqueue('responses', {
      kind: 'raw',
      contentType: 'text/html',
      body: '<html><body>Welcome</body></html>',
    });
    const provider = createTextProvider(config(s));
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { code: 'invalid-json-response', category: 'format' },
    });
  });
});

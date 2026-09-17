import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import { createTextProvider } from '@src/providers/text/factory';
import { createSub2apiTextProvider } from '@src/providers/text/text-provider';
import type {
  HttpTransport,
  TextProviderConfig,
  TranslateBatchInput,
} from '@src/providers/text/types';

const FAKE_KEY = 'unit-fake-key-000';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function scriptedTransport(handlers: ((call: Call) => Response | Promise<Response>)[]) {
  const calls: Call[] = [];
  const transport: HttpTransport & { calls: Call[] } = {
    kind: 'mock',
    calls,
    async fetch(url, init) {
      const call: Call = {
        url,
        init,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      };
      calls.push(call);
      const handler = handlers[Math.min(calls.length - 1, handlers.length - 1)]!;
      return handler(call);
    },
  };
  return transport;
}

function itemsOf(call: Call): { id: string; text: string }[] {
  const input = String(
    call.body.input ??
      (call.body.messages as { content: string }[] | undefined)?.[1]?.content ??
      '',
  );
  return (JSON.parse(input.split('\n').at(-1)!) as { items: { id: string; text: string }[] }).items;
}

function responsesJson(translations: unknown, status = 200): Response {
  const text = typeof translations === 'string' ? translations : JSON.stringify({ translations });
  return new Response(
    JSON.stringify({
      status: 'completed',
      model: 'gpt-5.6-terra-2026',
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

const translateAll = (call: Call) =>
  responsesJson(itemsOf(call).map((i) => ({ id: i.id, text: `译：${i.text}` })));

const config: TextProviderConfig = {
  baseUrl: 'https://api.example.com/v1/',
  apiKey: FAKE_KEY,
  protocol: 'responses',
  model: 'gpt-5.6-terra',
  reasoningEffort: 'omit',
  streaming: false,
};

const input: TranslateBatchInput = {
  items: [
    { id: 'a', text: 'I do not like 3 of these apples.' },
    { id: 'b', text: 'Maria never said that to me.' },
  ],
  context: [],
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  style: 'natural',
  glossary: [],
};

const opts = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });

describe('createTextProvider', () => {
  it('rejects invalid config synchronously and keeps the key out of profileKey', () => {
    expect(() => createTextProvider({ ...config, baseUrl: 'http://evil.example.com' })).toThrow(
      AppError,
    );
    expect(() => createTextProvider({ ...config, apiKey: ' ' })).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'api-key-missing' }) }),
    );
    expect(() => createTextProvider({ ...config, model: '' })).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'model-missing' }) }),
    );
    const provider = createTextProvider(config);
    expect(provider.profileKey).toBe(
      'https://api.example.com|responses|gpt-5.6-terra|reasoning=omit',
    );
    expect(provider.profileKey).not.toContain(FAKE_KEY);
    expect(createTextProvider({ ...config, reasoningEffort: 'low' }).profileKey).not.toBe(
      provider.profileKey,
    );
  });

  it('uses the real fetch transport by default (never a mock) with redirect/credential safety options', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init: RequestInit) =>
      translateAll({
        url: _url,
        init: _init,
        body: JSON.parse(String(_init.body)) as Record<string, unknown>,
      }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const provider = createTextProvider(config);
      await provider.translateBatch(input, opts());
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe('https://api.example.com/v1/responses');
      expect(init).toMatchObject({
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Sub2api text provider (Responses, JSON)', () => {
  it('sends a single well-formed request with safe fetch options and returns validated items', async () => {
    const transport = scriptedTransport([translateAll]);
    const provider = createSub2apiTextProvider(config, transport);
    const result = await provider.translateBatch(input, opts());
    expect(result.items).toEqual([
      { id: 'a', text: '译：I do not like 3 of these apples.' },
      { id: 'b', text: '译：Maria never said that to me.' },
    ]);
    expect(result).toMatchObject({
      protocol: 'responses',
      model: 'gpt-5.6-terra-2026',
      repairAttempts: 0,
      usage: { totalTokens: 15 },
    });
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0]!;
    expect(call.url).toBe('https://api.example.com/v1/responses');
    expect(call.init).toMatchObject({ method: 'POST', redirect: 'manual', credentials: 'omit' });
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(call.body).not.toHaveProperty('reasoning');
    expect(call.body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
  });

  it('repairs only the ids with item-level issues and merges results', async () => {
    const transport = scriptedTransport([
      (call) =>
        responsesJson(
          itemsOf(call).map((i) => ({ id: i.id, text: i.id === 'b' ? i.text : `译：${i.text}` })),
        ),
      translateAll,
    ]);
    const provider = createSub2apiTextProvider(config, transport);
    const result = await provider.translateBatch(input, opts());
    expect(transport.calls).toHaveLength(2);
    expect(itemsOf(transport.calls[1]!).map((i) => i.id)).toEqual(['b']);
    expect(String(transport.calls[1]!.body.input)).toMatch(/^Note: /);
    expect(result.repairAttempts).toBe(1);
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('never assigns a shifted translation: missing id → whole batch repaired, then partial failure is omitted', async () => {
    const shifted = () =>
      responsesJson([{ id: 'a', text: '我不喜欢其中3个苹果，玛丽亚从没对我说过。' }]);
    const transport = scriptedTransport([shifted, shifted]);
    const provider = createSub2apiTextProvider(config, transport);
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { category: 'format', code: 'translation-invalid', retryable: true },
    });
    expect(transport.calls).toHaveLength(2);
    expect(itemsOf(transport.calls[1]!).map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('returns only accepted items when repair is exhausted for item-level issues', async () => {
    const transport = scriptedTransport([
      (call) =>
        responsesJson(
          itemsOf(call).map((i) => ({ id: i.id, text: i.id === 'b' ? '' : `译：${i.text}` })),
        ),
      (call) => responsesJson(itemsOf(call).map((i) => ({ id: i.id, text: '' }))),
    ]);
    const provider = createSub2apiTextProvider(config, transport);
    const result = await provider.translateBatch(input, opts());
    expect(result.items.map((i) => i.id)).toEqual(['a']);
    expect(transport.calls).toHaveLength(2);
  });

  it('degrades json_schema → json_object once the service rejects it, and keeps the degraded mode', async () => {
    const reject = () =>
      new Response(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: 'text.format' json_schema",
            param: 'text.format',
          },
        }),
        {
          status: 400,
          headers: { 'content-type': 'application/json' },
        },
      );
    const transport = scriptedTransport([reject, translateAll, translateAll]);
    const provider = createSub2apiTextProvider(config, transport);
    await provider.translateBatch(input, opts());
    expect(provider.formatMode).toBe('json_object');
    expect(transport.calls[1]!.body.text).toEqual({ format: { type: 'json_object' } });
    await provider.translateBatch(input, opts());
    expect(transport.calls).toHaveLength(3);
    expect(transport.calls[2]!.body.text).toEqual({ format: { type: 'json_object' } });
  });

  it('maps HTTP failures without retrying inside the provider', async () => {
    for (const [status, category] of [
      [401, 'auth'],
      [403, 'permission'],
      [429, 'rate-limit'],
      [500, 'server'],
    ] as const) {
      const transport = scriptedTransport([
        () =>
          new Response('{"error":{"message":"x"}}', { status, headers: { 'retry-after': '1' } }),
      ]);
      const provider = createSub2apiTextProvider(config, transport);
      await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
        info: { category },
      });
      expect(transport.calls).toHaveLength(1);
    }
  });

  it('refuses redirects (does not follow, does not resend Authorization)', async () => {
    const transport = scriptedTransport([
      () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://evil.example/v1/responses' },
        }),
    ]);
    const provider = createSub2apiTextProvider(config, transport);
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { code: 'redirect-blocked' },
    });
    expect(transport.calls).toHaveLength(1);
  });

  it('cancels and times out even when the transport ignores the signal', async () => {
    const hang = () => new Promise<Response>(() => undefined);
    const controller = new AbortController();
    const provider = createSub2apiTextProvider(config, scriptedTransport([hang]));
    const p = provider.translateBatch(input, { signal: controller.signal, timeoutMs: 5_000 });
    controller.abort();
    await expect(p).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await expect(
      provider.translateBatch(input, { signal: new AbortController().signal, timeoutMs: 30 }),
    ).rejects.toMatchObject({
      info: { category: 'timeout' },
    });
  });
});

function sseResponse(chunks: string[], contentType = 'text/event-stream'): Response {
  const encoder = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]!));
      else controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

describe('Sub2api text provider (streaming)', () => {
  const streamConfig: TextProviderConfig = { ...config, protocol: 'chat', streaming: true };

  function chatChunks(text: string, withDone = true): string[] {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += 9) {
      out.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text.slice(i, i + 9) } }] })}\n\n`,
      );
    }
    if (withDone) {
      out.push(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      );
    }
    return out;
  }

  it('emits partial items during streaming but returns only the validated final result', async () => {
    const final = JSON.stringify({
      translations: [
        { id: 'a', text: '我不喜欢其中3个苹果。' },
        { id: 'b', text: '玛丽亚从没对我说过那句话。' },
      ],
    });
    const transport = scriptedTransport([() => sseResponse(chatChunks(final))]);
    const provider = createSub2apiTextProvider(streamConfig, transport);
    const partials: string[][] = [];
    const result = await provider.translateBatch(input, {
      ...opts(),
      onPartial: (items) => partials.push(items.map((i) => i.id)),
    });
    expect(transport.calls[0]!.body).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(partials.length).toBeGreaterThan(0);
    expect(partials[0]).toEqual(['a']);
    expect(result.items).toHaveLength(2);
  });

  it('fails a stream that ends without an end event (half JSON is never returned)', async () => {
    const final = JSON.stringify({
      translations: [
        { id: 'a', text: '我不喜欢其中3个苹果。' },
        { id: 'b', text: '玛丽亚从没对我说过那句话。' },
      ],
    });
    const transport = scriptedTransport([() => sseResponse(chatChunks(final.slice(0, 40), false))]);
    const provider = createSub2apiTextProvider({ ...streamConfig }, transport, {
      maxRepairAttempts: 0,
    });
    await expect(provider.translateBatch(input, opts())).rejects.toMatchObject({
      info: { code: 'stream-interrupted', retryable: true },
    });
  });

  it('falls back to JSON parsing when the service ignores stream=true', async () => {
    const transport = scriptedTransport([
      (call) =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    translations: itemsOf(call).map((i) => ({ id: i.id, text: `译：${i.text}` })),
                  }),
                },
                finish_reason: 'stop',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ]);
    const provider = createSub2apiTextProvider(streamConfig, transport);
    const result = await provider.translateBatch(input, opts());
    expect(result.items).toHaveLength(2);
    expect(transport.calls[0]!.url).toBe('https://api.example.com/v1/chat/completions');
  });
});

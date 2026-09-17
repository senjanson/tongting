import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatAdapter } from '@src/providers/text/chat';
import { responsesAdapter } from '@src/providers/text/responses';
import { readSseStream, SseParser, type SseEvent } from '@src/providers/text/sse';

const FIXTURES = resolve(__dirname, '../../fixtures/sub2api');

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

function parseAll(chunks: string[]): SseEvent[] {
  const parser = new SseParser();
  const events: SseEvent[] = [];
  for (const c of chunks) events.push(...parser.push(c));
  events.push(...parser.finish());
  return events;
}

describe('SseParser', () => {
  it('parses events split at every possible byte-free boundary identically', () => {
    const text = 'event: a\ndata: {"x":1}\n\n: comment\ndata: line1\ndata: line2\nid: 7\n\n';
    const whole = parseAll([text]);
    expect(whole).toEqual([
      { event: 'a', data: '{"x":1}' },
      { event: 'message', data: 'line1\nline2', id: '7' },
    ]);
    for (let cut = 1; cut < text.length; cut++) {
      expect(parseAll([text.slice(0, cut), text.slice(cut)])).toEqual(whole);
    }
    // 逐字符输入
    expect(parseAll([...text])).toEqual(whole);
  });

  it('handles CRLF and bare CR line endings, including CR/LF split across chunks', () => {
    const crlf = 'data: one\r\n\r\ndata: two\r\n\r\n';
    expect(parseAll([crlf]).map((e) => e.data)).toEqual(['one', 'two']);
    expect(parseAll(['data: one\r', '\n\r', '\ndata: two\r\n', '\r\n']).map((e) => e.data)).toEqual(
      ['one', 'two'],
    );
    expect(parseAll(['data: one\r', '', '\n\r\n']).map((e) => e.data)).toEqual(['one']);
    expect(parseAll(['data: a\r\rdata: b\r\r']).map((e) => e.data)).toEqual(['a', 'b']);
  });

  it('ignores comments, empty data-less blocks and unknown fields; strips only one leading space', () => {
    expect(
      parseAll([': ping\n\nretry: 100\nfoo: bar\n\nevent: x\n\ndata:  two spaces\n\n']),
    ).toEqual([{ event: 'message', data: ' two spaces' }]);
    expect(parseAll(['data\n\n'])).toEqual([{ event: 'message', data: '' }]);
  });

  it('returns the unterminated tail on finish so callers can detect truncation', () => {
    const events = parseAll(['data: {"partial": tr']);
    expect(events).toEqual([{ event: 'message', data: '{"partial": tr' }]);
  });
});

describe('readSseStream', () => {
  it('cancels the underlying stream when onEvent throws (review #3)', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: boom\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readSseStream(body, {
        signal: new AbortController().signal,
        onEvent: () => {
          throw new Error('parse failed');
        },
      }),
    ).rejects.toThrow('parse failed');
    expect(cancelled).toBe(true);
  });

  it('cancels the stream when the size limit is exceeded', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(`: ${'x'.repeat(2_000)}\n`));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      readSseStream(body, {
        signal: new AbortController().signal,
        onEvent: () => undefined,
        maxBytes: 1_000,
      }),
    ).rejects.toMatchObject({ info: { code: 'response-too-large' } });
    expect(cancelled).toBe(true);
  });

  it('maps an unparseable event cut off at EOF to a retryable stream-interrupted error (review #18)', async () => {
    const acc = responsesAdapter.createStreamAccumulator();
    const bytes = new TextEncoder().encode(
      'event: response.output_text.delta\ndata: {"type":"response.output_te',
    );
    await expect(
      readSseStream(streamOf([bytes]), {
        signal: new AbortController().signal,
        onEvent: (e) => (acc.handle(e) === 'done' ? 'stop' : undefined),
      }),
    ).rejects.toMatchObject({ info: { code: 'stream-interrupted', retryable: true } });
  });

  it('adapters ignore empty data and unknown keep-alive events but reject bad JSON in protocol events', () => {
    const responses = responsesAdapter.createStreamAccumulator();
    expect(responses.handle({ event: 'ping', data: 'keep-alive' })).toBe('continue');
    expect(responses.handle({ event: 'message', data: '' })).toBe('continue');
    expect(() => responses.handle({ event: 'response.output_text.delta', data: '{bad' })).toThrow();
    const chat = chatAdapter.createStreamAccumulator();
    expect(chat.handle({ event: 'keepalive', data: 'ok' })).toBe('continue');
    expect(chat.handle({ event: 'message', data: '   ' })).toBe('continue');
    expect(() => chat.handle({ event: 'message', data: '{bad' })).toThrow();
  });

  it('decodes UTF-8 characters split across network chunks', async () => {
    const bytes = new TextEncoder().encode('data: 你好，世界\n\n');
    // 在「你」的 3 个字节中间切开
    const chunks = [bytes.slice(0, 7), bytes.slice(7, 8), bytes.slice(8)];
    const events: SseEvent[] = [];
    const result = await readSseStream(streamOf(chunks), {
      signal: new AbortController().signal,
      onEvent: (e) => {
        events.push(e);
      },
    });
    expect(result.stopped).toBe(false);
    expect(events.map((e) => e.data)).toEqual(['你好，世界']);
  });

  it('stops when onEvent reports the end event', async () => {
    const bytes = readFileSync(resolve(FIXTURES, 'chat-stream.sse'));
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 5) chunks.push(new Uint8Array(bytes.subarray(i, i + 5)));
    let count = 0;
    const result = await readSseStream(streamOf(chunks), {
      signal: new AbortController().signal,
      onEvent: (e) => {
        count++;
        return e.data === '[DONE]' ? 'stop' : undefined;
      },
    });
    expect(result.stopped).toBe(true);
    expect(count).toBe(6);
  });

  it('rejects promptly when aborted mid-stream', async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
    });
    const promise = readSseStream(body, {
      signal: controller.signal,
      onEvent: () => {
        controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

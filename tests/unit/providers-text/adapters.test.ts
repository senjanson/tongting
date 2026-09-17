import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppErrorInfo } from '@src/domain/errors';
import { chatAdapter, extractChatOutput } from '@src/providers/text/chat';
import type { ModelCallRequest, ProtocolAdapter } from '@src/providers/text/protocol';
import { extractResponsesOutput, responsesAdapter } from '@src/providers/text/responses';
import { SseParser } from '@src/providers/text/sse';

const FIXTURES = resolve(__dirname, '../../fixtures/sub2api');
const fixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf8'));

const baseReq: ModelCallRequest = {
  model: 'gpt-5.6-terra',
  instructions: 'INSTR',
  input: 'INPUT',
  reasoningEffort: 'omit',
  stream: false,
  format: 'json_schema',
  includeStreamUsage: true,
};

function runStream(adapter: ProtocolAdapter, raw: string) {
  const acc = adapter.createStreamAccumulator();
  const parser = new SseParser();
  const events = [...parser.push(raw), ...parser.finish()];
  let done = false;
  for (const e of events) {
    if (acc.handle(e) === 'done') {
      done = true;
      break;
    }
  }
  return { acc, done };
}

describe('Responses adapter', () => {
  it('builds a minimal body: instructions + input + strict json_schema, reasoning only when set', () => {
    const body = responsesAdapter.buildBody(baseReq);
    expect(Object.keys(body).sort()).toEqual(['input', 'instructions', 'model', 'text']);
    expect(body.text).toMatchObject({
      format: { type: 'json_schema', strict: true, name: 'subtitle_translations' },
    });
    const withReasoning = responsesAdapter.buildBody({
      ...baseReq,
      reasoningEffort: 'low',
      stream: true,
      format: 'prompt',
    });
    expect(withReasoning).toMatchObject({ reasoning: { effort: 'low' }, stream: true });
    expect(withReasoning.text).toBeUndefined();
    expect(withReasoning).not.toHaveProperty('temperature');
    expect(withReasoning).not.toHaveProperty('max_output_tokens');
  });

  it('extracts output_text from output[].content[] (no SDK convenience field)', () => {
    const out = extractResponsesOutput(fixtureJson('responses-completed.json'));
    expect(JSON.parse(out.text)).toMatchObject({ translations: [{ id: 'c1' }, { id: 'c2' }] });
    expect(out.usage).toEqual({ inputTokens: 180, outputTokens: 42, totalTokens: 222 });
    expect(out.model).toBe('gpt-5.6-terra');
  });

  it('maps incomplete / refusal / failed / empty responses to errors', () => {
    expect(() => extractResponsesOutput(fixtureJson('responses-incomplete.json'))).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'output-truncated' }) }),
    );
    expect(() =>
      extractResponsesOutput({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }],
      }),
    ).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'model-refused' }) }),
    );
    expect(() =>
      extractResponsesOutput({
        status: 'failed',
        error: { code: 'rate_limit_exceeded', message: 'slow down' },
      }),
    ).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ category: 'rate-limit' }) }),
    );
    expect(() => extractResponsesOutput({ status: 'completed', output: [] })).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'empty-output' }) }),
    );
  });

  it('accumulates stream deltas and completes only on response.completed', () => {
    const raw = readFileSync(resolve(FIXTURES, 'responses-stream.sse'), 'utf8');
    const { acc, done } = runStream(responsesAdapter, raw);
    expect(done).toBe(true);
    expect(JSON.parse(acc.result().text)).toEqual({
      translations: [{ id: 'c1', text: '你好，世界' }],
    });
    expect(acc.result().usage?.totalTokens).toBe(15);

    const truncated = raw.slice(0, raw.indexOf('event: response.completed'));
    const partial = runStream(responsesAdapter, truncated);
    expect(partial.done).toBe(false);
    expect(partial.acc.completeWithoutEndEvent()).toBe(false);
    expect(partial.acc.text()).toContain('你好');
  });

  it('throws on error / failed stream events', () => {
    expect(() =>
      runStream(
        responsesAdapter,
        'event: error\ndata: {"type":"error","code":"server_error","message":"boom"}\n\n',
      ),
    ).toThrow(
      expect.objectContaining({
        info: expect.objectContaining({ category: 'server', retryable: true }),
      }),
    );
    expect(() =>
      runStream(
        responsesAdapter,
        'data: {"type":"response.failed","response":{"error":{"code":"insufficient_quota","message":"x"}}}\n\n',
      ),
    ).toThrow(expect.objectContaining({ info: expect.objectContaining({ category: 'quota' }) }));
    expect(() =>
      runStream(responsesAdapter, 'data: {"type":"response.output_text.delta","delta":"x"\n\n'),
    ).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'invalid-stream-event' }) }),
    );
  });

  it('degrades json_schema → json_object → prompt only when the service rejects the format parameter', () => {
    const rejection: AppErrorInfo = {
      code: 'unsupported-parameter',
      category: 'unsupported',
      retryable: false,
      message: 'x',
      httpStatus: 400,
      detail: "invalid_request_error text.format Unsupported parameter: 'text.format'",
    };
    expect(responsesAdapter.degrade(rejection, baseReq)).toEqual({ format: 'json_object' });
    expect(responsesAdapter.degrade(rejection, { ...baseReq, format: 'json_object' })).toEqual({
      format: 'prompt',
    });
    expect(responsesAdapter.degrade(rejection, { ...baseReq, format: 'prompt' })).toBeUndefined();
    expect(
      responsesAdapter.degrade({ ...rejection, detail: 'reasoning.effort unsupported' }, baseReq),
    ).toBeUndefined();
    expect(responsesAdapter.degrade({ ...rejection, httpStatus: 500 }, baseReq)).toBeUndefined();
  });
});

describe('Chat Completions adapter', () => {
  it('builds messages with response_format json_schema and optional reasoning_effort/stream_options', () => {
    const body = chatAdapter.buildBody(baseReq);
    expect(body).toMatchObject({
      model: 'gpt-5.6-terra',
      messages: [
        { role: 'system', content: 'INSTR' },
        { role: 'user', content: 'INPUT' },
      ],
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(body).not.toHaveProperty('reasoning_effort');
    expect(body).not.toHaveProperty('stream');
    const streamBody = chatAdapter.buildBody({
      ...baseReq,
      stream: true,
      reasoningEffort: 'none',
      format: 'json_object',
    });
    expect(streamBody).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      reasoning_effort: 'none',
      response_format: { type: 'json_object' },
    });
  });

  it('parses JSON completions and maps finish reasons', () => {
    const out = extractChatOutput(fixtureJson('chat-completion.json'));
    expect(out.usage).toEqual({ inputTokens: 150, outputTokens: 30, totalTokens: 180 });
    expect(() =>
      extractChatOutput({ choices: [{ message: { content: '{"tr' }, finish_reason: 'length' }] }),
    ).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'output-truncated' }) }),
    );
    expect(() =>
      extractChatOutput({
        choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }],
      }),
    ).toThrow(
      expect.objectContaining({ info: expect.objectContaining({ code: 'model-refused' }) }),
    );
    expect(
      extractChatOutput({
        choices: [
          {
            message: {
              content: [
                { type: 'text', text: 'a' },
                { type: 'text', text: 'b' },
              ],
            },
          },
        ],
      }).text,
    ).toBe('ab');
  });

  it('streams with CRLF, usage chunk and [DONE]; missing end is incomplete', () => {
    const raw = readFileSync(resolve(FIXTURES, 'chat-stream.sse'), 'utf8');
    const { acc, done } = runStream(chatAdapter, raw);
    expect(done).toBe(true);
    expect(acc.result()).toMatchObject({
      text: '{"translations":[{"id":"c1","text":"你好，世界"}]}',
      model: 'gpt-5.6-luna',
      usage: { totalTokens: 15 },
    });

    const noEnd = runStream(
      chatAdapter,
      raw.slice(
        0,
        raw.indexOf(
          'data: {"model":"gpt-5.6-luna","choices":[{"index":0,"delta":{},"finish_reason":"stop"',
        ),
      ),
    );
    expect(noEnd.done).toBe(false);
    expect(noEnd.acc.completeWithoutEndEvent()).toBe(false);

    const finishedButNoDone = runStream(chatAdapter, raw.slice(0, raw.indexOf('data: [DONE]')));
    expect(finishedButNoDone.done).toBe(false);
    expect(finishedButNoDone.acc.completeWithoutEndEvent()).toBe(true);
    expect(finishedButNoDone.acc.result().text).toContain('你好');
  });

  it('degrades stream_options first, then response_format', () => {
    const rejection = (detail: string): AppErrorInfo => ({
      code: 'unsupported-parameter',
      category: 'unsupported',
      retryable: false,
      message: 'x',
      httpStatus: 400,
      detail,
    });
    expect(
      chatAdapter.degrade(rejection('Unknown parameter: stream_options'), {
        ...baseReq,
        stream: true,
      }),
    ).toEqual({ includeStreamUsage: false });
    expect(
      chatAdapter.degrade(
        rejection("response_format type 'json_schema' is not supported"),
        baseReq,
      ),
    ).toEqual({ format: 'json_object' });
    expect(chatAdapter.degrade(rejection('temperature unsupported'), baseReq)).toBeUndefined();
  });
});

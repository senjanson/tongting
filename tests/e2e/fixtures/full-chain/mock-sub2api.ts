/**
 * 全链路 E2E 用的模拟 sub2api（node:http，只监听 127.0.0.1 随机端口）。
 *
 * 与 tests/helpers/mock-sub2api/server.ts 的区别：译文按请求中的 target_language 确定性生成
 * （`译[<目标语言>] <原文>`），以便验证切换目标语言后旧译文不混入；并记录每个请求的 Origin、
 * 目标语言、条目与持续时间，支持「持续故障」与一次性脚本回复。
 * 这里的 Key 是测试假值，不是真实凭证。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { extractItemsFromPrompt, type TranslationPair } from '../../../helpers/mock-sub2api/server';

export const E2E_API_KEY = 'e2e-fake-key-NOT-A-SECRET-0000';

export type Endpoint = 'models' | 'responses' | 'chat';

export type Reply =
  | { kind: 'translate'; delayMs?: number }
  | { kind: 'status'; status: number; body?: unknown; headers?: Record<string, string> }
  | { kind: 'redirect'; location: string; status?: number }
  /** 流式：先写出若干原始 SSE 片段，然后强制断开（半截流）。 */
  | { kind: 'sse-truncated'; chunks: string[] }
  | { kind: 'hang' };

export interface RecordedRequest {
  seq: number;
  endpoint: Endpoint | 'other';
  method: string;
  path: string;
  authorization?: string;
  origin?: string;
  host?: string;
  rawBody: string;
  body: unknown;
  stream: boolean;
  targetLanguage?: string;
  items: TranslationPair[];
  receivedAt: number;
  finishedAt?: number;
  status?: number;
  aborted: boolean;
}

export interface E2eMockSub2api {
  readonly baseUrl: string;
  readonly port: number;
  readonly requests: RecordedRequest[];
  /** 持续生效的默认回复（未排队脚本回复时使用）；null 恢复正常翻译。 */
  setDefault(endpoint: Endpoint, reply: Reply | null): void;
  enqueue(endpoint: Endpoint, ...replies: Reply[]): void;
  /** 正常翻译的统一延迟。 */
  setTranslateDelay(ms: number): void;
  translationRequests(): RecordedRequest[];
  inflight(): number;
  maxInflight(): number;
  close(): Promise<void>;
}

/**
 * 确定性译文。带目标文字标记（中日文用「译」、韩文用「번역」），否则产品的译文语言校验会把
 * 「没有任何目标文字的拉丁句子」判为未翻译（这是产品的正确行为）。
 */
export function mockTranslation(targetLanguage: string | undefined, text: string): string {
  const marker = targetLanguage?.toLowerCase().startsWith('ko') ? '번역' : '译';
  return `${marker}[${targetLanguage ?? '?'}] ${text}`;
}

function payloadOf(input: string): { target_language?: string } {
  const lines = input.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line) as { target_language?: string };
    } catch {
      // 继续
    }
  }
  return {};
}

function wait(ms: number, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve(!res.destroyed);
    const timer = setTimeout(() => resolve(!res.destroyed), ms);
    res.once('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function startE2eMockSub2api(
  options: {
    apiKey?: string;
    models?: string[];
    /** 覆盖译文生成，便于截图脚本用可读译文；默认仍是确定性的 mockTranslation。 */
    translate?: (targetLanguage: string | undefined, text: string) => string;
  } = {},
): Promise<E2eMockSub2api> {
  const apiKey = options.apiKey ?? E2E_API_KEY;
  const models = options.models ?? ['gpt-5.6-terra', 'gpt-5.6-luna'];
  const translateText = options.translate ?? mockTranslation;
  const requests: RecordedRequest[] = [];
  const queues: Record<Endpoint, Reply[]> = { models: [], responses: [], chat: [] };
  const defaults: Record<Endpoint, Reply | null> = { models: null, responses: null, chat: null };
  let translateDelay = 0;
  let current = 0;
  let peak = 0;
  let seq = 0;
  const sockets = new Set<Socket>();

  const json = (
    res: ServerResponse,
    record: RecordedRequest,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    if (res.destroyed) return;
    record.status = status;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  async function translate(record: RecordedRequest, res: ServerResponse, delayMs: number) {
    if (delayMs > 0 && !(await wait(delayMs, res))) return;
    const outputText = JSON.stringify({
      translations: record.items.map((i) => ({
        id: i.id,
        text: translateText(record.targetLanguage, i.text),
      })),
    });
    const body = record.body as Record<string, unknown>;
    const model = String(body.model ?? '');
    if (record.stream) {
      record.status = 200;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
      if (record.endpoint === 'responses') {
        for (let i = 0; i < outputText.length; i += 16) {
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: outputText.slice(i, i + 16) })}\n\n`,
          );
        }
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_e2e',
              status: 'completed',
              model,
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: outputText }],
                },
              ],
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: outputText }, finish_reason: 'stop' }] })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }
    if (record.endpoint === 'responses') {
      json(res, record, 200, {
        id: 'resp_e2e',
        object: 'response',
        status: 'completed',
        model,
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: outputText, annotations: [] }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
      });
    } else {
      json(res, record, 200, {
        id: 'chatcmpl_e2e',
        object: 'chat.completion',
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: outputText }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      });
    }
  }

  async function handle(record: RecordedRequest, res: ServerResponse) {
    const endpoint = record.endpoint;
    if (endpoint === 'other')
      return json(res, record, 404, {
        error: { message: 'Not Found', type: 'invalid_request_error' },
      });
    const reply = queues[endpoint].shift() ?? defaults[endpoint] ?? { kind: 'translate' as const };
    switch (reply.kind) {
      case 'status':
        return json(res, record, reply.status, reply.body ?? {}, reply.headers);
      case 'redirect':
        record.status = reply.status ?? 302;
        res.writeHead(record.status, {
          location: reply.location,
          'content-type': 'application/json',
        });
        res.end('{}');
        return;
      case 'hang':
        return;
      case 'sse-truncated':
        record.status = 200;
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        for (const c of reply.chunks) res.write(c);
        setTimeout(() => res.destroy(), 50);
        return;
      default:
        break;
    }
    if (record.authorization !== `Bearer ${apiKey}`) {
      return json(res, record, 401, {
        error: {
          message: 'Invalid API key provided',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    if (endpoint === 'models') {
      return json(res, record, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', owned_by: 'e2e' })),
      });
    }
    const model = String((record.body as Record<string, unknown>)?.model ?? '');
    if (!models.includes(model)) {
      return json(res, record, 404, {
        error: {
          message: `The model \`${model}\` does not exist`,
          type: 'invalid_request_error',
          code: 'model_not_found',
        },
      });
    }
    await translate(
      record,
      res,
      reply.kind === 'translate' ? (reply.delayMs ?? translateDelay) : translateDelay,
    );
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const endpoint: RecordedRequest['endpoint'] =
      method === 'GET' && url.pathname === '/v1/models'
        ? 'models'
        : method === 'POST' && url.pathname === '/v1/responses'
          ? 'responses'
          : method === 'POST' && url.pathname === '/v1/chat/completions'
            ? 'chat'
            : 'other';
    const record: RecordedRequest = {
      seq: ++seq,
      endpoint,
      method,
      path: url.pathname,
      authorization: req.headers.authorization,
      origin: req.headers.origin,
      host: req.headers.host,
      rawBody: '',
      body: undefined,
      stream: false,
      items: [],
      receivedAt: Date.now(),
      aborted: false,
    };
    requests.push(record);
    current++;
    peak = Math.max(peak, current);
    let settled = false;
    const settle = (aborted: boolean) => {
      if (settled) return;
      settled = true;
      record.aborted = aborted;
      record.finishedAt = Date.now();
      current--;
    };
    res.on('finish', () => settle(false));
    res.on('close', () => settle(!res.writableFinished));
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      record.rawBody = Buffer.concat(chunks).toString('utf8');
      if (record.rawBody) {
        try {
          record.body = JSON.parse(record.rawBody);
        } catch {
          record.body = record.rawBody;
        }
      }
      const body = (record.body ?? {}) as Record<string, unknown>;
      record.stream = body.stream === true;
      const input =
        endpoint === 'responses'
          ? String(body.input ?? '')
          : endpoint === 'chat'
            ? String((body.messages as { content?: string }[] | undefined)?.at(-1)?.content ?? '')
            : '';
      if (input) {
        record.items = extractItemsFromPrompt(input);
        record.targetLanguage = payloadOf(input).target_language;
      }
      handle(record, res).catch(() => {
        if (!res.headersSent)
          json(res, record, 500, { error: { message: 'mock failure', type: 'server_error' } });
        else res.destroy();
      });
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    requests,
    setDefault(endpoint, reply) {
      defaults[endpoint] = reply;
    },
    enqueue(endpoint, ...replies) {
      queues[endpoint].push(...replies);
    },
    setTranslateDelay(ms) {
      translateDelay = ms;
    },
    translationRequests: () =>
      requests.filter(
        (r) => (r.endpoint === 'responses' || r.endpoint === 'chat') && r.items.length > 0,
      ),
    inflight: () => current,
    maxInflight: () => peak,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** 记录任何到达请求的简单服务（用作重定向目标，验证凭证未被转发）。 */
export async function startRecorder(): Promise<{
  baseUrl: string;
  requests: Array<{ method: string; path: string; authorization?: string }>;
  close(): Promise<void>;
}> {
  const requests: Array<{ method: string; path: string; authorization?: string }> = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? '',
      path: req.url ?? '',
      authorization: req.headers.authorization,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"translations":[]}');
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

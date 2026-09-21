/**
 * 本地模拟 sub2api（node:http，仅监听 127.0.0.1 随机端口）。
 *
 * 用途：集成测试通过真实 fetch 传输访问它，断言真实副作用（请求次数、在途请求数、是否带 Authorization、
 * 客户端是否中止连接），而不只断言状态文本。这里的「Key」都是测试假值，不是真实凭证。
 *
 * 默认行为：
 * - GET  /v1/models            → `{ data: [{ id }] }`
 * - POST /v1/responses         → 按请求中的 items 返回 `译：<原文>`（JSON 或 SSE）
 * - POST /v1/chat/completions  → 同上（JSON 或 SSE + [DONE]）
 * 通过 enqueue() 为某个端点排入一次性脚本回复以模拟故障。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export type Endpoint = 'models' | 'responses' | 'chat';

export interface RecordedRequest {
  seq: number;
  endpoint: Endpoint | 'other';
  method: string;
  path: string;
  /** 原始 Authorization 头（测试假 Key）。 */
  authorization: string | undefined;
  body: unknown;
  receivedAt: number;
  /** 服务端开始/结束事件共用的严格递增序号，不受毫秒时间戳碰撞影响。 */
  startedOrder: number;
  /** 客户端在响应完成前关闭了连接（取消 / 超时）。 */
  aborted: boolean;
  completed: boolean;
  /** 响应完成或连接关闭的时间。 */
  finishedAt?: number;
  finishedOrder?: number;
}

export interface TranslationPair {
  id: string;
  text: string;
}

export type MockReply =
  | {
      kind: 'translate';
      delayMs?: number;
      /** 修改默认译文：返回数组作为 translations，返回字符串作为原始输出文本。 */
      transform?: (items: TranslationPair[]) => TranslationPair[] | string;
    }
  | {
      kind: 'status';
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
      delayMs?: number;
    }
  | { kind: 'raw'; status?: number; contentType: string; body: string; delayMs?: number }
  | {
      kind: 'sse';
      /** 逐次写出的原始字节片段。 */
      chunks: string[];
      chunkDelayMs?: number;
      /** close：正常结束连接；destroy：强制断开；hang：不结束，等待客户端超时/取消。 */
      end: 'close' | 'destroy' | 'hang';
    }
  | { kind: 'redirect'; location: string; status?: number }
  | { kind: 'hang' };

export interface MockSub2apiOptions {
  apiKey?: string;
  models?: string[];
  /** 有权限的模型；不在列表中的模型返回 403。默认全部允许。 */
  allowedModels?: string[];
  /** 模型存在性：不在 models 中的模型返回 404 model_not_found。默认 true。 */
  enforceModelExists?: boolean;
  supportResponses?: boolean;
  supportChat?: boolean;
  supportModels?: boolean;
  /** 拒绝 json_schema 结构化输出（400 unsupported response_format / text.format）。 */
  rejectJsonSchema?: boolean;
  /** SSE 模式下每个 delta 的字符数。 */
  streamDeltaSize?: number;
}

export interface MockSub2api {
  readonly baseUrl: string;
  readonly origin: string;
  readonly requests: RecordedRequest[];
  /** 当前未完成的请求数。 */
  inflight(): number;
  /** 历史最大并发请求数。 */
  maxInflight(): number;
  enqueue(endpoint: Endpoint, ...replies: MockReply[]): void;
  /** 等待某端点累计收到 n 个请求。 */
  waitForRequests(
    endpoint: Endpoint,
    count: number,
    timeoutMs?: number,
  ): Promise<RecordedRequest[]>;
  /** 等待在途请求数达到条件。 */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  requestsTo(endpoint: Endpoint): RecordedRequest[];
  close(): Promise<void>;
}

export const MOCK_API_KEY = 'test-fake-key-not-a-secret';

function endpointOf(method: string, path: string): Endpoint | 'other' {
  if (method === 'GET' && path === '/v1/models') return 'models';
  if (method === 'POST' && path === '/v1/responses') return 'responses';
  if (method === 'POST' && path === '/v1/chat/completions') return 'chat';
  return 'other';
}

/** 从提示词输入中取出 JSON payload（最后一行）。 */
export function extractItemsFromPrompt(input: string): TranslationPair[] {
  const lines = input.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const payload = JSON.parse(line) as { items?: TranslationPair[] };
      if (Array.isArray(payload.items)) return payload.items;
    } catch {
      // 继续
    }
  }
  return [];
}

function defaultTranslate(items: TranslationPair[]): TranslationPair[] {
  return items.map((item) => ({ id: item.id, text: `译：${item.text}` }));
}

function sleep(ms: number, res: ServerResponse): Promise<boolean> {
  return new Promise((resolve) => {
    if (ms <= 0) return resolve(!res.destroyed);
    const timer = setTimeout(() => resolve(!res.destroyed), ms);
    res.once('close', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

export async function startMockSub2api(options: MockSub2apiOptions = {}): Promise<MockSub2api> {
  const apiKey = options.apiKey ?? MOCK_API_KEY;
  const models = options.models ?? ['gpt-5.6-terra', 'gpt-5.6-luna'];
  const supportResponses = options.supportResponses ?? true;
  const supportChat = options.supportChat ?? true;
  const supportModels = options.supportModels ?? true;
  const enforceModelExists = options.enforceModelExists ?? true;
  const deltaSize = options.streamDeltaSize ?? 7;

  const requests: RecordedRequest[] = [];
  const queues: Record<Endpoint, MockReply[]> = { models: [], responses: [], chat: [] };
  let seq = 0;
  let eventOrder = 0;
  let current = 0;
  let peak = 0;
  const sockets = new Set<Socket>();

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    if (res.destroyed) return;
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };

  const errorBody = (message: string, type: string, code?: string) => ({
    error: { message, type, code },
  });

  async function handleTranslate(
    endpoint: 'responses' | 'chat',
    body: Record<string, unknown>,
    res: ServerResponse,
    reply: Extract<MockReply, { kind: 'translate' }>,
  ) {
    if (reply.delayMs && !(await sleep(reply.delayMs, res))) return;
    const input =
      endpoint === 'responses'
        ? String(body.input ?? '')
        : String((body.messages as { content?: string }[] | undefined)?.[1]?.content ?? '');
    const items = extractItemsFromPrompt(input);
    const transformed = reply.transform ? reply.transform(items) : defaultTranslate(items);
    const outputText =
      typeof transformed === 'string' ? transformed : JSON.stringify({ translations: transformed });
    const model = String(body.model ?? '');

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
      });
      const pieces: string[] = [];
      for (let i = 0; i < outputText.length; i += deltaSize)
        pieces.push(outputText.slice(i, i + deltaSize));
      if (endpoint === 'responses') {
        res.write(
          `event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_mock', status: 'in_progress' } })}\n\n`,
        );
        for (const delta of pieces) {
          if (res.destroyed) return;
          res.write(
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta })}\n\n`,
          );
        }
        res.write(
          `event: response.completed\ndata: ${JSON.stringify({
            type: 'response.completed',
            response: {
              id: 'resp_mock',
              status: 'completed',
              model,
              output: [
                {
                  type: 'message',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: outputText }],
                },
              ],
              usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
            },
          })}\n\n`,
        );
      } else {
        for (const delta of pieces) {
          if (res.destroyed) return;
          res.write(
            `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] })}\r\n\r\n`,
          );
        }
        res.write(
          `data: ${JSON.stringify({ model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({ model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })}\n\n`,
        );
        res.write('data: [DONE]\n\n');
      }
      res.end();
      return;
    }

    if (endpoint === 'responses') {
      send(res, 200, {
        id: 'resp_mock',
        object: 'response',
        status: 'completed',
        model,
        output: [
          { type: 'reasoning', id: 'rs_mock', summary: [] },
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: outputText, annotations: [] }],
          },
        ],
        usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
      });
    } else {
      send(res, 200, {
        id: 'chatcmpl_mock',
        object: 'chat.completion',
        model,
        choices: [
          { index: 0, message: { role: 'assistant', content: outputText }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
      });
    }
  }

  async function handle(record: RecordedRequest, req: IncomingMessage, res: ServerResponse) {
    const endpoint = record.endpoint;
    if (endpoint === 'other') {
      send(res, 404, errorBody('Not Found', 'invalid_request_error'));
      return;
    }
    const reply: MockReply = queues[endpoint].shift() ?? { kind: 'translate' };

    // 脚本化故障优先于默认校验
    switch (reply.kind) {
      case 'status':
        if (reply.delayMs && !(await sleep(reply.delayMs, res))) return;
        send(res, reply.status, reply.body ?? {}, reply.headers);
        return;
      case 'raw':
        if (reply.delayMs && !(await sleep(reply.delayMs, res))) return;
        res.writeHead(reply.status ?? 200, { 'content-type': reply.contentType });
        res.end(reply.body);
        return;
      case 'redirect':
        res.writeHead(reply.status ?? 302, { location: reply.location });
        res.end();
        return;
      case 'hang':
        return;
      case 'sse': {
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
        for (const chunk of reply.chunks) {
          if (reply.chunkDelayMs && !(await sleep(reply.chunkDelayMs, res))) return;
          if (res.destroyed) return;
          res.write(chunk);
        }
        if (reply.end === 'close') res.end();
        else if (reply.end === 'destroy') res.destroy();
        return;
      }
      default:
        break;
    }

    if (record.authorization !== `Bearer ${apiKey}`) {
      send(
        res,
        401,
        errorBody('Invalid API key provided', 'invalid_request_error', 'invalid_api_key'),
      );
      return;
    }
    if (endpoint === 'models') {
      if (!supportModels) {
        send(res, 404, errorBody('Not Found', 'invalid_request_error'));
        return;
      }
      send(res, 200, {
        object: 'list',
        data: models.map((id) => ({ id, object: 'model', owned_by: 'mock' })),
      });
      return;
    }
    if ((endpoint === 'responses' && !supportResponses) || (endpoint === 'chat' && !supportChat)) {
      send(res, 404, errorBody('Invalid URL', 'invalid_request_error'));
      return;
    }
    const body = (record.body ?? {}) as Record<string, unknown>;
    const model = String(body.model ?? '');
    if (enforceModelExists && !models.includes(model)) {
      send(
        res,
        404,
        errorBody(
          `The model \`${model}\` does not exist`,
          'invalid_request_error',
          'model_not_found',
        ),
      );
      return;
    }
    if (options.allowedModels && !options.allowedModels.includes(model)) {
      send(res, 403, errorBody(`Group has no access to model ${model}`, 'permission_error'));
      return;
    }
    if (options.rejectJsonSchema) {
      const format =
        endpoint === 'responses'
          ? (body.text as { format?: { type?: string } } | undefined)?.format?.type
          : (body.response_format as { type?: string } | undefined)?.type;
      if (format === 'json_schema') {
        const param = endpoint === 'responses' ? 'text.format' : 'response_format';
        send(res, 400, {
          error: {
            message: `Unsupported parameter: '${param}' json_schema is not supported`,
            type: 'invalid_request_error',
            param,
          },
        });
        return;
      }
    }
    await handleTranslate(endpoint, body, res, reply);
  }

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const record: RecordedRequest = {
      seq: ++seq,
      endpoint: endpointOf(req.method ?? 'GET', url.pathname),
      method: req.method ?? 'GET',
      path: url.pathname,
      authorization: req.headers.authorization,
      body: undefined,
      receivedAt: Date.now(),
      startedOrder: ++eventOrder,
      aborted: false,
      completed: false,
    };
    requests.push(record);
    current++;
    peak = Math.max(peak, current);
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      record.finishedAt = Date.now();
      record.finishedOrder = ++eventOrder;
      current--;
    };
    res.on('finish', () => {
      record.completed = true;
      settle();
    });
    res.on('close', () => {
      if (!record.completed) record.aborted = true;
      settle();
    });

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text) {
        try {
          record.body = JSON.parse(text);
        } catch {
          record.body = text;
        }
      }
      handle(record, req, res).catch(() => {
        if (!res.headersSent) send(res, 500, errorBody('mock failure', 'server_error'));
        else res.destroy();
      });
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('mock-sub2api waitFor timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  return {
    baseUrl: origin,
    origin,
    requests,
    inflight: () => current,
    maxInflight: () => peak,
    enqueue(endpoint, ...replies) {
      queues[endpoint].push(...replies);
    },
    requestsTo: (endpoint) => requests.filter((r) => r.endpoint === endpoint),
    async waitForRequests(endpoint, count, timeoutMs = 5_000) {
      await waitFor(
        () => requests.filter((r) => r.endpoint === endpoint).length >= count,
        timeoutMs,
      );
      return requests.filter((r) => r.endpoint === endpoint);
    },
    waitFor,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

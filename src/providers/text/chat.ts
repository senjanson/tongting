/**
 * OpenAI Chat Completions 协议适配器：`POST {root}/v1/chat/completions`。
 *
 * - response_format 优先 json_schema（strict）；服务明确拒绝时有限次降级为 json_object，再降级为纯提示词 JSON。
 * - reasoning_effort 仅在不为 omit 时发送。
 * - 流式：`data: {...}` 增量与 `data: [DONE]`；请求 usage 的 stream_options 被拒绝时去掉后重试一次。
 */
import { AppError, type AppErrorInfo } from '../../domain/errors';
import {
  asRecord,
  emptyOutputError,
  errorFromPayload,
  isParameterRejection,
  nextFormatMode,
  refusedError,
  toNumber,
  truncatedOutputError,
  type ModelCallOutput,
  type ModelCallRequest,
  type ProtocolAdapter,
  type StreamAccumulator,
} from './protocol';
import { TRANSLATION_JSON_SCHEMA, TRANSLATION_SCHEMA_NAME } from './prompt';
import type { SseEvent } from './sse';
import type { TokenUsage } from './types';

function parseUsage(value: unknown): TokenUsage | undefined {
  const u = asRecord(value);
  if (!u) return undefined;
  const usage: TokenUsage = {
    inputTokens: toNumber(u.prompt_tokens),
    outputTokens: toNumber(u.completion_tokens),
    totalTokens: toNumber(u.total_tokens),
  };
  return usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
    ? undefined
    : usage;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part);
        return p && typeof p.text === 'string' ? p.text : '';
      })
      .join('');
  }
  return '';
}

function checkFinishReason(reason: unknown): void {
  if (reason === 'length') throw truncatedOutputError();
  if (reason === 'content_filter') throw refusedError('content_filter');
}

export function extractChatOutput(json: unknown): ModelCallOutput {
  const body = asRecord(json);
  if (!body) {
    throw new AppError({
      code: 'invalid-response',
      category: 'format',
      retryable: true,
      message: '服务返回的 Chat Completions 结果格式无法识别。',
    });
  }
  if (body.error && !Array.isArray(body.choices)) throw errorFromPayload(body.error);
  const choice = Array.isArray(body.choices) ? asRecord(body.choices[0]) : undefined;
  if (!choice) throw emptyOutputError();
  checkFinishReason(choice.finish_reason);
  const message = asRecord(choice.message);
  const text = contentToText(message?.content);
  if (!text.trim()) {
    if (typeof message?.refusal === 'string' && message.refusal)
      throw refusedError(message.refusal);
    throw emptyOutputError();
  }
  return {
    text,
    usage: parseUsage(body.usage),
    model: typeof body.model === 'string' ? body.model.slice(0, 200) : undefined,
  };
}

class ChatStreamAccumulator implements StreamAccumulator {
  private content = '';
  private refusal = '';
  private finishReason: string | undefined;
  private usage: TokenUsage | undefined;
  private model: string | undefined;
  private done = false;

  handle(event: SseEvent): 'continue' | 'done' {
    if (event.data.trim() === '[DONE]') {
      this.finalize();
      return 'done';
    }
    if (!event.data.trim()) return 'continue';
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(event.data));
    } catch {
      // Chat 协议事件没有 event 名；带其他 event 名的非 JSON 数据视为保活事件忽略。
      if (event.event !== 'message') return 'continue';
      throw new AppError({
        code: 'invalid-stream-event',
        category: 'format',
        retryable: true,
        message: '流式响应中出现无法解析的事件，本次结果已丢弃。',
      });
    }
    if (!payload) return 'continue';
    if (payload.error) throw errorFromPayload(payload.error);
    if (typeof payload.model === 'string') this.model = payload.model.slice(0, 200);
    const usage = parseUsage(payload.usage);
    if (usage) this.usage = usage;
    if (Array.isArray(payload.choices)) {
      for (const c of payload.choices) {
        const choice = asRecord(c);
        if (!choice || (choice.index !== undefined && choice.index !== 0)) continue;
        const delta = asRecord(choice.delta);
        if (delta) {
          this.content += contentToText(delta.content);
          if (typeof delta.refusal === 'string') this.refusal += delta.refusal;
        }
        if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
          this.finishReason = choice.finish_reason;
        }
      }
    }
    return 'continue';
  }

  private finalize(): void {
    if (this.done) return;
    checkFinishReason(this.finishReason);
    if (!this.content.trim()) {
      if (this.refusal) throw refusedError(this.refusal);
      throw emptyOutputError();
    }
    this.done = true;
  }

  text(): string {
    return this.content;
  }

  completeWithoutEndEvent(): boolean {
    // 没有 [DONE] 但已收到 finish_reason：该 choice 已明确结束。
    if (!this.finishReason) return false;
    this.finalize();
    return true;
  }

  result(): ModelCallOutput {
    if (!this.done) throw new Error('stream not completed');
    return { text: this.content, usage: this.usage, model: this.model };
  }
}

export const chatAdapter: ProtocolAdapter = {
  protocol: 'chat',
  path: '/v1/chat/completions',

  buildBody(req: ModelCallRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: [
        { role: 'system', content: req.instructions },
        { role: 'user', content: req.input },
      ],
    };
    if (req.format === 'json_schema') {
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: TRANSLATION_SCHEMA_NAME,
          schema: TRANSLATION_JSON_SCHEMA,
          strict: true,
        },
      };
    } else if (req.format === 'json_object') {
      body.response_format = { type: 'json_object' };
    }
    if (req.reasoningEffort !== 'omit') body.reasoning_effort = req.reasoningEffort;
    if (req.stream) {
      body.stream = true;
      if (req.includeStreamUsage) body.stream_options = { include_usage: true };
    }
    return body;
  },

  parseResponse: extractChatOutput,

  createStreamAccumulator: () => new ChatStreamAccumulator(),

  degrade(error: AppErrorInfo, req: ModelCallRequest): Partial<ModelCallRequest> | undefined {
    if (!isParameterRejection(error)) return undefined;
    const detail = error.detail ?? '';
    if (req.stream && req.includeStreamUsage && /stream_options|include_usage/i.test(detail)) {
      return { includeStreamUsage: false };
    }
    if (/response_format|json_schema|json_object|structured/i.test(detail)) {
      const next = nextFormatMode(req.format);
      return next ? { format: next } : undefined;
    }
    return undefined;
  },
};

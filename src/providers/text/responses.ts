/**
 * OpenAI Responses 协议适配器：`POST {root}/v1/responses`。
 *
 * - 请求：instructions + input（字符串），text.format 使用严格 json_schema；
 *   reasoning 仅在 reasoningEffort 不为 omit 时发送；不发送 temperature / max_output_tokens 等未验证参数。
 * - 原始 HTTP 响应没有 SDK 的 output_text 便捷字段，需从 output[].content[] 中取 type === 'output_text'。
 * - 流式事件：response.output_text.delta / response.completed / response.failed / response.incomplete / error。
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
    inputTokens: toNumber(u.input_tokens),
    outputTokens: toNumber(u.output_tokens),
    totalTokens: toNumber(u.total_tokens),
  };
  return usage.inputTokens === undefined &&
    usage.outputTokens === undefined &&
    usage.totalTokens === undefined
    ? undefined
    : usage;
}

function incompleteError(response: Record<string, unknown>): AppError {
  const details = asRecord(response.incomplete_details);
  const reason = typeof details?.reason === 'string' ? details.reason : '';
  if (reason === 'content_filter') return refusedError(reason);
  return truncatedOutputError();
}

/** 从完整 response 对象中提取文本（不校验 JSON）。 */
export function extractResponsesOutput(json: unknown): ModelCallOutput {
  const response = asRecord(json);
  if (!response) {
    throw new AppError({
      code: 'invalid-response',
      category: 'format',
      retryable: true,
      message: '服务返回的 Responses 结果格式无法识别。',
    });
  }
  if (response.status === 'failed' || (response.error && !Array.isArray(response.output))) {
    throw errorFromPayload(response.error);
  }
  if (response.status === 'incomplete') throw incompleteError(response);

  let text = '';
  let refusal = '';
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      const it = asRecord(item);
      if (!it || it.type !== 'message' || !Array.isArray(it.content)) continue;
      for (const part of it.content) {
        const p = asRecord(part);
        if (!p) continue;
        if (p.type === 'output_text' && typeof p.text === 'string') text += p.text;
        else if (p.type === 'refusal' && typeof p.refusal === 'string') refusal += p.refusal;
      }
    }
  }
  if (!text && typeof response.output_text === 'string') text = response.output_text;
  if (!text && refusal) throw refusedError(refusal);
  if (!text.trim()) throw emptyOutputError();
  return {
    text,
    usage: parseUsage(response.usage),
    model: typeof response.model === 'string' ? response.model.slice(0, 200) : undefined,
  };
}

class ResponsesStreamAccumulator implements StreamAccumulator {
  private deltas = '';
  private final: ModelCallOutput | undefined;

  handle(event: SseEvent): 'continue' | 'done' {
    if (event.data === '[DONE]') {
      // 部分代理会追加 [DONE]；Responses 协议以 response.completed 为准。
      return this.final ? 'done' : 'continue';
    }
    if (!event.data.trim()) return 'continue';
    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(event.data));
    } catch {
      // 未知的保活事件（例如 event: ping）不是协议事件，忽略；协议事件的坏 JSON 才算错误。
      const known =
        event.event === 'message' || event.event === 'error' || event.event.startsWith('response.');
      if (!known) return 'continue';
      throw new AppError({
        code: 'invalid-stream-event',
        category: 'format',
        retryable: true,
        message: '流式响应中出现无法解析的事件，本次结果已丢弃。',
      });
    }
    if (!payload) return 'continue';
    const type = typeof payload.type === 'string' ? payload.type : event.event;
    switch (type) {
      case 'response.output_text.delta':
        if (typeof payload.delta === 'string') this.deltas += payload.delta;
        return 'continue';
      case 'response.completed': {
        const response = asRecord(payload.response);
        if (response && Array.isArray(response.output) && response.output.length > 0) {
          try {
            this.final = extractResponsesOutput(response);
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              error.info.code !== 'empty-output' ||
              !this.deltas.trim()
            )
              throw error;
            this.final = { text: this.deltas, usage: parseUsage(response.usage) };
          }
        } else {
          if (!this.deltas.trim()) throw emptyOutputError();
          this.final = {
            text: this.deltas,
            usage: parseUsage(response?.usage),
            model: typeof response?.model === 'string' ? response.model.slice(0, 200) : undefined,
          };
        }
        return 'done';
      }
      case 'response.incomplete':
        throw incompleteError(asRecord(payload.response) ?? {});
      case 'response.failed':
        throw errorFromPayload(asRecord(payload.response)?.error);
      case 'error':
        throw errorFromPayload(payload.error ?? payload);
      case 'response.refusal.done':
        throw refusedError(typeof payload.refusal === 'string' ? payload.refusal : undefined);
      default:
        return 'continue';
    }
  }

  text(): string {
    return this.deltas;
  }

  completeWithoutEndEvent(): boolean {
    return this.final !== undefined;
  }

  result(): ModelCallOutput {
    if (!this.final) throw new Error('stream not completed');
    return this.final;
  }
}

export const responsesAdapter: ProtocolAdapter = {
  protocol: 'responses',
  path: '/v1/responses',

  buildBody(req: ModelCallRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model,
      instructions: req.instructions,
      input: req.input,
    };
    if (req.format === 'json_schema') {
      body.text = {
        format: {
          type: 'json_schema',
          name: TRANSLATION_SCHEMA_NAME,
          schema: TRANSLATION_JSON_SCHEMA,
          strict: true,
        },
      };
    } else if (req.format === 'json_object') {
      body.text = { format: { type: 'json_object' } };
    }
    if (req.reasoningEffort !== 'omit') body.reasoning = { effort: req.reasoningEffort };
    if (req.stream) body.stream = true;
    return body;
  },

  parseResponse: extractResponsesOutput,

  createStreamAccumulator: () => new ResponsesStreamAccumulator(),

  degrade(error: AppErrorInfo, req: ModelCallRequest): Partial<ModelCallRequest> | undefined {
    if (!isParameterRejection(error)) return undefined;
    const detail = error.detail ?? '';
    if (
      /json_schema|json_object|text\.format|response_format|structured|\bformat\b/i.test(detail)
    ) {
      const next = nextFormatMode(req.format);
      return next ? { format: next } : undefined;
    }
    return undefined;
  },
};

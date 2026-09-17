/**
 * 协议适配器公共定义。适配器只负责「请求体构造、响应解析、流式事件累积、参数降级判断」，
 * 网络、超时、校验与修复由 text-provider.ts 统一处理。
 */
import { AppError, type AppErrorInfo } from '../../domain/errors';
import type { SseEvent } from './sse';
import type { TokenUsage } from './types';
import { isQuotaCode, sanitizeDetail } from './http-errors';

/**
 * 输出格式模式：
 * - json_schema：结构化输出（严格 schema），首选；
 * - json_object：服务拒绝 json_schema 时的降级；
 * - prompt：服务连 json_object 也拒绝时，仅靠提示词要求 JSON，并严格校验。
 */
export type FormatMode = 'json_schema' | 'json_object' | 'prompt';

export interface ModelCallRequest {
  model: string;
  instructions: string;
  input: string;
  reasoningEffort: 'omit' | 'none' | 'low';
  stream: boolean;
  format: FormatMode;
  /** 仅 Chat：流式时请求 usage（stream_options.include_usage）。 */
  includeStreamUsage: boolean;
}

export interface ModelCallOutput {
  text: string;
  usage?: TokenUsage;
  model?: string;
}

export interface StreamAccumulator {
  /** 处理一个 SSE 事件；收到协议结束事件时返回 'done'。错误事件直接抛出 AppError。 */
  handle(event: SseEvent): 'continue' | 'done';
  /** 当前累积的（未校验）文本，仅用于 partial。 */
  text(): string;
  /** 连接在没有显式结束事件时关闭，是否仍可认定输出完整（例如 Chat 已收到 finish_reason）。 */
  completeWithoutEndEvent(): boolean;
  /** 结束后的输出；未结束时调用会抛出。 */
  result(): ModelCallOutput;
}

export interface ProtocolAdapter {
  readonly protocol: 'responses' | 'chat';
  readonly path: '/v1/responses' | '/v1/chat/completions';
  buildBody(req: ModelCallRequest): Record<string, unknown>;
  parseResponse(json: unknown): ModelCallOutput;
  createStreamAccumulator(): StreamAccumulator;
  /** 服务明确拒绝某个可选参数时返回降级后的请求字段；否则 undefined。 */
  degrade(error: AppErrorInfo, req: ModelCallRequest): Partial<ModelCallRequest> | undefined;
}

export function nextFormatMode(mode: FormatMode): FormatMode | undefined {
  if (mode === 'json_schema') return 'json_object';
  if (mode === 'json_object') return 'prompt';
  return undefined;
}

/** 服务明确拒绝了本请求发送的可选参数（由 http-errors 按 param / 消息精确判定）。 */
export function isParameterRejection(error: AppErrorInfo): boolean {
  return (
    (error.httpStatus === 400 || error.httpStatus === 422) && error.code === 'unsupported-parameter'
  );
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function toNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function truncatedOutputError(): AppError {
  return new AppError({
    code: 'output-truncated',
    category: 'format',
    retryable: true,
    message: '模型输出被截断，本批结果已丢弃，稍后会以更小的批次重试。',
  });
}

export function refusedError(detail?: string): AppError {
  return new AppError({
    code: 'model-refused',
    category: 'format',
    retryable: true,
    message: '模型拒绝翻译这段字幕，已标记为失败，可稍后重试或更换模型。',
    detail: sanitizeDetail(detail),
  });
}

export function emptyOutputError(): AppError {
  return new AppError({
    code: 'empty-output',
    category: 'format',
    retryable: true,
    message: '模型没有返回译文内容，稍后可重试。',
  });
}

/** 流内 error 事件 / 200 响应中的 error 字段 → AppError。 */
export function errorFromPayload(errorValue: unknown): AppError {
  const e = asRecord(errorValue) ?? {};
  const code = typeof e.code === 'string' ? e.code : '';
  const type = typeof e.type === 'string' ? e.type : '';
  const message =
    typeof e.message === 'string' ? e.message : typeof errorValue === 'string' ? errorValue : '';
  const detail = sanitizeDetail([code || type, message].filter(Boolean).join(' '));
  if (/^rate[_\s-]?limit/i.test(code) || /^rate[_\s-]?limit/i.test(type)) {
    return new AppError({
      code: 'rate-limited',
      category: 'rate-limit',
      retryable: true,
      message: '请求过于频繁（服务在响应中报告限流），已暂停预取并稍后重试。',
      detail,
    });
  }
  if (isQuotaCode(code, type)) {
    return new AppError({
      code: 'quota-exhausted',
      category: 'quota',
      retryable: false,
      message: '服务提示余额或额度不足：请到 sub2api 后台确认余额与分组额度后再试。',
      detail,
    });
  }
  return new AppError({
    code: 'upstream-error',
    category: 'server',
    retryable: true,
    message: '服务在处理过程中返回错误，稍后会自动重试。',
    detail,
  });
}

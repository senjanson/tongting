/**
 * sub2api 文本翻译 provider：组合协议适配器、HTTP 层、提示词、校验与有限修复。
 *
 * 结果语义：
 * - `items` 只包含通过校验的条目；有限修复后仍未通过的 id 不出现在结果中，由调度器标记为可重试的格式失败。
 * - 全部条目都未通过时抛出 format 类 AppError。
 * - partial（onPartial）只来自未校验的流式文本，不进入结果。
 */
import { AppError, cancelledError } from '../../domain/errors';
import { apiEndpoint, normalizeBaseUrl } from './base-url';
import { chatAdapter } from './chat';
import { formatError, streamInterruptedError } from './http-errors';
import { readJsonResponse, sendApiRequest, withRequestSignal } from './http';
import type { FormatMode, ModelCallOutput, ModelCallRequest, ProtocolAdapter } from './protocol';
import { buildTranslationPrompt, languagePromptName, PROMPT_VERSION } from './prompt';
import { responsesAdapter } from './responses';
import { readSseStream } from './sse';
import type {
  HttpTransport,
  TextProvider,
  TextProviderConfig,
  TokenUsage,
  TranslateBatchInput,
  TranslateBatchResult,
  TranslateOptions,
  TranslationItem,
} from './types';
import {
  extractPartialTranslations,
  parseTranslationPayload,
  validateTranslations,
} from './validate';

export type StreamEndKind = 'end-event' | 'finish-reason-only' | 'json-fallback';

/**
 * TranslateOptions 的实现扩展：调用方可以为单次调用降低修复次数（例如调度器的单条重试）。
 * 不认识该字段的 provider 会忽略它；建议契约增加这个可选字段。
 */
export type ExtendedTranslateOptions = TranslateOptions & { maxRepairAttempts?: number };

export interface Sub2apiTextProviderOptions {
  /** 校验失败后的修复请求次数上限（默认 1，最大 2）。 */
  maxRepairAttempts?: number;
  now?: () => number;
}

export interface Sub2apiTextProvider extends TextProvider {
  readonly protocol: 'responses' | 'chat';
  readonly model: string;
  readonly origin: string;
  /** 当前输出格式模式（服务拒绝 json_schema 后会降级并在本实例内保持）。 */
  readonly formatMode: FormatMode;
  /**
   * 最近一次流式请求如何结束：end-event（收到 [DONE] / response.completed）、
   * finish-reason-only（Chat 只有 finish_reason、没有 [DONE]）、json-fallback（服务忽略 stream 返回了 JSON）。
   */
  readonly lastStreamEnd: StreamEndKind | undefined;
}

const MAX_DEGRADE_STEPS = 3;

export function adapterFor(protocol: 'responses' | 'chat'): ProtocolAdapter {
  return protocol === 'responses' ? responsesAdapter : chatAdapter;
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  return {
    inputTokens: sum(a.inputTokens, b.inputTokens),
    outputTokens: sum(a.outputTokens, b.outputTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
}

function configError(code: string, message: string): AppError {
  return new AppError({ code, category: 'config', retryable: false, message });
}

export function computeProfileKey(
  config: Pick<TextProviderConfig, 'protocol' | 'model' | 'reasoningEffort'>,
  baseUrl: string,
): string {
  return `${baseUrl}|${config.protocol}|${config.model}|reasoning=${config.reasoningEffort}`;
}

export function createSub2apiTextProvider(
  config: TextProviderConfig,
  transport: HttpTransport,
  options: Sub2apiTextProviderOptions = {},
): Sub2apiTextProvider {
  const normalized = normalizeBaseUrl(config.baseUrl);
  if (!normalized.ok) throw new AppError(normalized.error);
  if (!config.apiKey || !config.apiKey.trim()) {
    throw configError('api-key-missing', '尚未填写 API Key：请在设置页填写后再开始翻译。');
  }
  const model = config.model.trim();
  if (!model) throw configError('model-missing', '尚未选择模型：请在设置页选择或手动填写模型 ID。');
  if (config.protocol !== 'responses' && config.protocol !== 'chat') {
    throw configError('protocol-invalid', '协议必须是 Responses 或 Chat Completions。');
  }

  const now = options.now ?? (() => Date.now());
  const maxRepairAttempts = Math.min(2, Math.max(0, options.maxRepairAttempts ?? 1));
  const adapter = adapterFor(config.protocol);
  const baseUrl = normalized.baseUrl;
  const origin = normalized.origin;
  const url = apiEndpoint(baseUrl, adapter.path);
  const apiKey = config.apiKey.trim();

  // 服务明确拒绝可选参数后在本实例内保持降级（配置变化会创建新实例）。
  let formatMode: FormatMode = 'json_schema';
  let lastStreamEnd: StreamEndKind | undefined;
  let includeStreamUsage = true;

  async function callModel(
    prompt: { instructions: string; input: string },
    translateOptions: TranslateOptions,
    requestedIds: ReadonlySet<string>,
  ): Promise<ModelCallOutput> {
    for (let step = 0; ; step++) {
      const req: ModelCallRequest = {
        model,
        instructions: prompt.instructions,
        input: prompt.input,
        reasoningEffort: config.reasoningEffort,
        stream: config.streaming,
        format: formatMode,
        includeStreamUsage,
      };
      try {
        return await withRequestSignal(
          translateOptions.signal,
          translateOptions.timeoutMs,
          async (signal) => {
            const response = await sendApiRequest({
              transport,
              url,
              expectedOrigin: origin,
              method: 'POST',
              apiKey,
              body: adapter.buildBody(req),
              accept: req.stream ? 'sse' : 'json',
              signal,
            });
            const contentType = response.headers.get('content-type') ?? '';
            if (!req.stream || /application\/json/i.test(contentType)) {
              // 服务忽略 stream 参数直接返回 JSON 时按非流式处理。
              const parsed = adapter.parseResponse(await readJsonResponse(response));
              if (req.stream) lastStreamEnd = 'json-fallback';
              return parsed;
            }
            if (!response.body) throw streamInterruptedError('empty body');
            const acc = adapter.createStreamAccumulator();
            let lastPartial = '';
            let read: { stopped: boolean; bytes: number };
            try {
              read = await readSseStream(response.body, {
                signal,
                onEvent(event) {
                  const state = acc.handle(event);
                  if (
                    translateOptions.onPartial &&
                    state === 'continue' &&
                    event.data.includes('}')
                  ) {
                    const items = extractPartialTranslations(acc.text(), requestedIds);
                    const signature = JSON.stringify(items);
                    if (items.length > 0 && signature !== lastPartial) {
                      lastPartial = signature;
                      try {
                        translateOptions.onPartial(items);
                      } catch {
                        // partial 回调异常不影响请求
                      }
                    }
                  }
                  return state === 'done' ? 'stop' : undefined;
                },
              });
            } catch (error) {
              // 已开始读取流后连接被关闭（socket 断开等）：属于流中断，可重试，半截内容丢弃。
              if (error instanceof TypeError && !signal.aborted)
                throw streamInterruptedError('connection closed');
              throw error;
            }
            if (!read.stopped && !acc.completeWithoutEndEvent()) {
              throw streamInterruptedError(read.bytes === 0 ? 'no events' : 'missing end event');
            }
            const result = acc.result();
            lastStreamEnd = read.stopped ? 'end-event' : 'finish-reason-only';
            return result;
          },
        );
      } catch (error) {
        if (error instanceof AppError && step < MAX_DEGRADE_STEPS) {
          const patch = adapter.degrade(error.info, req);
          if (patch) {
            if (patch.format) formatMode = patch.format;
            if (patch.includeStreamUsage !== undefined)
              includeStreamUsage = patch.includeStreamUsage;
            continue;
          }
        }
        throw error;
      }
    }
  }

  async function translateBatch(
    input: TranslateBatchInput,
    translateOptions: TranslateOptions,
  ): Promise<TranslateBatchResult> {
    if (translateOptions.signal.aborted) throw cancelledError();
    const started = now();
    const requestedRepair = (translateOptions as ExtendedTranslateOptions).maxRepairAttempts;
    const repairLimit =
      typeof requestedRepair === 'number' && Number.isFinite(requestedRepair)
        ? Math.min(maxRepairAttempts, Math.max(0, Math.floor(requestedRepair)))
        : maxRepairAttempts;
    const ids = new Set<string>();
    for (const item of input.items) {
      if (!item.id || ids.has(item.id)) {
        throw configError('batch-invalid-ids', '翻译批次中的字幕 ID 为空或重复。');
      }
      ids.add(item.id);
    }
    if (input.items.length === 0) {
      return {
        items: [],
        model,
        protocol: adapter.protocol,
        promptVersion: PROMPT_VERSION,
        latencyMs: 0,
        repairAttempts: 0,
      };
    }

    const accepted = new Map<string, string>();
    let pending: TranslationItem[] = [...input.items];
    let repairAttempts = 0;
    let repairNote: string | undefined;
    let usage: TokenUsage | undefined;
    let resultModel = model;
    let lastProblem = '';
    const target = languagePromptName(input.targetLanguage);

    for (;;) {
      const prompt = buildTranslationPrompt(
        { ...input, items: pending },
        { repairNote, jsonShapeHint: formatMode !== 'json_schema' },
      );
      const output = await callModel(prompt, translateOptions, new Set(pending.map((p) => p.id)));
      usage = addUsage(usage, output.usage);
      if (output.model) resultModel = output.model;

      const outcome = validateTranslations(
        pending,
        parseTranslationPayload(output.text),
        input.targetLanguage,
      );
      for (const item of outcome.accepted) accepted.set(item.id, item.text);
      pending = outcome.rejected.map((r) => r.item);
      if (pending.length === 0) break;

      lastProblem =
        outcome.structuralError ?? [...new Set(outcome.rejected.map((r) => r.issue))].join(',');
      if (repairAttempts >= repairLimit) break;
      repairAttempts++;
      repairNote = outcome.structuralError
        ? `Your previous answer was invalid (${outcome.structuralError}). Return exactly one translation for every id in "items", each id exactly once, as the JSON object described.`
        : `Your previous answer had problems (${lastProblem}) for these items. Translate each of them fully into ${target}.`;
    }

    if (accepted.size === 0) {
      throw formatError(
        'translation-invalid',
        '模型返回的译文未通过校验（缺少字幕 ID、重复或格式错误），本批已标记失败，可稍后重试。',
        lastProblem,
      );
    }
    return {
      items: input.items
        .filter((i) => accepted.has(i.id))
        .map((i) => ({ id: i.id, text: accepted.get(i.id)! })),
      model: resultModel,
      protocol: adapter.protocol,
      promptVersion: PROMPT_VERSION,
      usage,
      latencyMs: Math.max(0, now() - started),
      repairAttempts,
    };
  }

  return {
    profileKey: computeProfileKey({ ...config, model }, baseUrl),
    promptVersion: PROMPT_VERSION,
    protocol: adapter.protocol,
    model,
    origin,
    get formatMode() {
      return formatMode;
    },
    get lastStreamEnd() {
      return lastStreamEnd;
    },
    translateBatch,
  };
}

/**
 * 文本翻译提供方契约。UI 与会话协调器只使用这里的领域输入输出，
 * 不直接拼接 Responses 或 Chat Completions 请求。
 */
import type { CapabilityStatus } from '../../domain/capability';
import type { GlossaryEntry, TranslationStyle } from '../../domain/settings';

export interface TranslationItem {
  /** 本批次内唯一的 cue ID。模型输出必须只包含这些 ID。 */
  id: string;
  text: string;
}

export interface TranslationContextLine {
  text: string;
  /** 已确认的前文译文（可选），仅用于保持术语与语气一致。 */
  translation?: string;
}

export interface TranslateBatchInput {
  items: TranslationItem[];
  /** 少量前文，仅供理解，不需要翻译。 */
  context: TranslationContextLine[];
  /** 'auto' 或 BCP-47 语言代码。 */
  sourceLanguage: string;
  targetLanguage: string;
  style: TranslationStyle;
  glossary: GlossaryEntry[];
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface TranslateBatchResult {
  /** 只包含通过校验的条目；修复后仍失败的 id 不出现（调用方需自行识别缺席项）。全部失败时抛出 format 错误。 */
  items: TranslationItem[];
  model: string;
  protocol: 'responses' | 'chat';
  promptVersion: string;
  usage?: TokenUsage;
  latencyMs: number;
  /** 格式修复重试次数。 */
  repairAttempts: number;
}

export interface TranslateOptions {
  signal: AbortSignal;
  timeoutMs: number;
  /** 流式模式下的部分结果，仅可用于可回滚显示，不得进入缓存、导出或配音。 */
  onPartial?: (items: TranslationItem[]) => void;
}

export interface TextProvider {
  /** provider profile 指纹（baseUrl origin + 协议 + 模型 + 参数），用于缓存键。 */
  readonly profileKey: string;
  readonly promptVersion: string;
  translateBatch(
    input: TranslateBatchInput,
    options: TranslateOptions,
  ): Promise<TranslateBatchResult>;
}

/** 可替换的 HTTP 传输层；测试与演示使用 mock，真实模式不得自动回落到 mock。 */
export interface HttpTransport {
  readonly kind: 'fetch' | 'mock';
  fetch(url: string, init: RequestInit): Promise<Response>;
}

export interface TextProviderConfig {
  baseUrl: string;
  apiKey: string;
  protocol: 'responses' | 'chat';
  model: string;
  reasoningEffort: 'omit' | 'none' | 'low';
  streaming: boolean;
}

export interface ConnectionCheckResultItem {
  key:
    | 'reachability'
    | 'auth'
    | 'modelList'
    | 'model'
    | 'translation'
    | 'streaming'
    | 'hostPermission';
  status: CapabilityStatus;
  message: string;
  latencyMs?: number;
  reasonCode?: string;
}

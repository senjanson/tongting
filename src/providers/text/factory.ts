/**
 * 文本 provider 工厂。
 *
 * 未传 transport 时使用真实 fetch 传输；真实模式绝不自动回落到 mock。
 * 配置无效（Base URL、Key、模型、协议）时同步抛出 config 类 AppError。
 * Key 与 Base URL 在创建时绑定：修改任一项必须创建新实例，旧实例的请求由调度器 setConfig 中止，
 * 因此新 Key 不会被发往旧 origin。
 */
import { createFetchTransport } from './http';
import { createSub2apiTextProvider, type Sub2apiTextProvider } from './text-provider';
import type { HttpTransport, TextProviderConfig } from './types';

export function createTextProvider(
  config: TextProviderConfig,
  transport?: HttpTransport,
): Sub2apiTextProvider {
  return createSub2apiTextProvider(config, transport ?? createFetchTransport());
}

export { createFetchTransport } from './http';
export { normalizeBaseUrl } from './base-url';
export { PROMPT_VERSION } from './prompt';
export type { Sub2apiTextProvider } from './text-provider';

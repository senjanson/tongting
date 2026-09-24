/**
 * 模型发现：`GET {root}/v1/models`。
 *
 * 列表只说明服务「列出了」这些 ID，不代表 Key 对每个模型都有权限，也不代表支持翻译或流式；
 * 这些能力必须由连接检查逐项实测。列表失败时允许用户手动填写模型 ID。
 */
import { AppError } from '../../domain/errors';
import { apiEndpoint, normalizeBaseUrl } from './base-url';
import { createFetchTransport, readJsonResponse, sendApiRequest, withRequestSignal } from './http';
import { asRecord } from './protocol';
import type { HttpTransport } from './types';
import { t } from '../../i18n';

export const DEFAULT_MODELS_TIMEOUT_MS = 15_000;
const MAX_MODELS = 1_000;

/** 解析 OpenAI 风格 `{ data: [{ id }] }`，也兼容 `{ models: [...] }` 与字符串数组。 */
export function parseModelList(json: unknown): string[] {
  const body = asRecord(json);
  const list: unknown = Array.isArray(json) ? json : (body?.data ?? body?.models);
  if (!Array.isArray(list)) {
    throw new AppError({
      code: 'model-list-invalid',
      category: 'format',
      retryable: false,
      message: t('background.models.unrecognized'),
    });
  }
  const ids = new Set<string>();
  for (const entry of list) {
    const raw = typeof entry === 'string' ? entry : asRecord(entry)?.id;
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id.length > 200 || /[\s<>]/.test(id)) continue;
    ids.add(id);
    if (ids.size >= MAX_MODELS) break;
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export interface DiscoverModelsParams {
  baseUrl: string;
  /** 为空时发送不带认证的请求（仅用于可达性探测）。 */
  apiKey: string;
  transport?: HttpTransport;
  signal: AbortSignal;
  timeoutMs?: number;
}

export async function discoverModels(params: DiscoverModelsParams): Promise<string[]> {
  const normalized = normalizeBaseUrl(params.baseUrl);
  if (!normalized.ok) throw new AppError(normalized.error);
  const transport = params.transport ?? createFetchTransport();
  return withRequestSignal(
    params.signal,
    params.timeoutMs ?? DEFAULT_MODELS_TIMEOUT_MS,
    async (signal) => {
      const response = await sendApiRequest({
        transport,
        url: apiEndpoint(normalized.baseUrl, '/v1/models'),
        expectedOrigin: normalized.origin,
        method: 'GET',
        apiKey: params.apiKey?.trim() || undefined,
        accept: 'json',
        signal,
      });
      return parseModelList(await readJsonResponse(response));
    },
  );
}

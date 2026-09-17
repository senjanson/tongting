/**
 * 文本服务连接检查（分项、真实调用）。
 *
 * 分项：hostPermission → reachability → auth → modelList → model → translation →（可选）streaming。
 * - 没有实际调用验证的项目保持 unknown，不因模型名存在或列表成功而标记 verified。
 * - 模型列表失败（包括超时、断网、重定向）只影响 modelList 项；仍会实测手动填写的模型（T06），
 *   可达性以翻译探测为准。
 * - auth 只有在翻译接口实际接受了 Key 后才标记 verified；仅模型列表 200 时如实说明「列表接口接受」。
 * - protocol 为 auto 时先试 Responses，确认端点不支持（404/405/501）再试 Chat，并返回 detectedProtocol。
 * - 结构化输出与流式结束方式按实际情况描述（json_schema / 降级；[DONE]/completed / 仅 finish_reason）。
 * - message 是可执行的中文提示；不包含请求头、Key 或完整 URL。
 * - 翻译测试只发送一句极短字幕，不做修复重试，控制费用；流式测试另发一次。
 */
import {
  cancelledError,
  isAbortError,
  toAppErrorInfo,
  type AppErrorInfo,
} from '../../domain/errors';
import type { ProviderSettings } from '../../domain/settings';
import { normalizeBaseUrl } from './base-url';
import { createFetchTransport } from './http';
import { sanitizeDetail } from './http-errors';
import { discoverModels } from './models';
import type { FormatMode } from './protocol';
import { createSub2apiTextProvider } from './text-provider';
import type { ConnectionCheckResultItem, HttpTransport, TranslateBatchInput } from './types';

export interface TextConnectionCheckParams {
  provider: ProviderSettings;
  apiKey: string | undefined;
  hasHostPermission: boolean;
  transport?: HttpTransport;
  signal: AbortSignal;
  includeStreaming?: boolean;
  now?: () => number;
}

export interface TextConnectionCheckResult {
  items: ConnectionCheckResultItem[];
  detectedProtocol?: 'responses' | 'chat';
  models?: string[];
}

type ItemKey = ConnectionCheckResultItem['key'];
type SetItem = (key: ItemKey, item: Omit<ConnectionCheckResultItem, 'key'>) => void;

/** 探测句：含人名、数字、否定，便于观察基本翻译质量。 */
export const PROBE_INPUT: TranslateBatchInput = {
  items: [{ id: 'probe-1', text: "Anna, please don't open the door before 3 pm." }],
  context: [],
  sourceLanguage: 'en',
  targetLanguage: 'zh-CN',
  style: 'natural',
  glossary: [],
};

const PROTOCOL_LABEL = { responses: 'Responses', chat: 'Chat Completions' } as const;

const FORMAT_LABEL: Record<FormatMode, string> = {
  json_schema: '结构化输出 json_schema（严格模式）',
  json_object: 'JSON 模式（服务拒绝了 json_schema，已降级）',
  prompt: '仅靠提示词约束 JSON（服务不支持结构化输出，已降级，格式错误风险更高）',
};

function clip(message: string): string {
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

function withDetail(message: string, error: AppErrorInfo): string {
  const detail = sanitizeDetail(error.detail, 80);
  return clip(detail ? `${message}（服务返回：${detail}）` : message);
}

/** 这些格式错误说明模型确实返回了内容（只是不合格），可以据此确认 Key 与模型被接受。 */
const MODEL_OUTPUT_ERROR_CODES = new Set([
  'translation-invalid',
  'translation-incomplete',
  'output-truncated',
  'model-refused',
  'empty-output',
]);

function isEndpointUnsupported(error: AppErrorInfo): boolean {
  return error.code === 'endpoint-not-found' || error.code === 'endpoint-unsupported';
}

/** 该错误是否说明服务确实返回了 HTTP 响应（因此可达）。重定向被拦截不算可用的响应。 */
function gotHttpResponse(error: AppErrorInfo): boolean {
  if (error.code === 'redirect-blocked') return false;
  return error.httpStatus !== undefined || error.category === 'format';
}

export async function runTextConnectionCheck(
  params: TextConnectionCheckParams,
): Promise<TextConnectionCheckResult> {
  const now = params.now ?? (() => Date.now());
  const includeStreaming = params.includeStreaming ?? false;
  const order: ItemKey[] = [
    'hostPermission',
    'reachability',
    'auth',
    'modelList',
    'model',
    'translation',
  ];
  if (includeStreaming) order.push('streaming');
  const items = new Map<ItemKey, ConnectionCheckResultItem>();
  const set: SetItem = (key, item) => {
    items.set(key, { key, ...item, message: clip(item.message) });
  };
  const finish = (
    extra: Omit<TextConnectionCheckResult, 'items'> = {},
  ): TextConnectionCheckResult => {
    const out: ConnectionCheckResultItem[] = order.map(
      (key) => items.get(key) ?? { key, status: 'unknown', message: '未检查：前置检查未通过。' },
    );
    return { items: out, ...extra };
  };
  const throwIfAborted = () => {
    if (params.signal.aborted) throw cancelledError();
  };
  throwIfAborted();

  // 1. 地址与权限
  const normalized = normalizeBaseUrl(params.provider.baseUrl);
  if (!normalized.ok) {
    set('reachability', {
      status: 'failed',
      message: normalized.error.message,
      reasonCode: normalized.error.code,
    });
    set('hostPermission', { status: 'unknown', message: '未检查：请先填写有效的服务地址。' });
    return finish();
  }
  const origin = normalized.origin;
  if (!params.hasHostPermission) {
    set('hostPermission', {
      status: 'failed',
      message: `尚未授予访问 ${origin} 的权限：请在设置页点击「授权访问」后重新检查。`,
      reasonCode: 'host-permission-missing',
    });
    return finish();
  }
  set('hostPermission', { status: 'verified', message: `已授予访问 ${origin} 的权限。` });

  const apiKey = params.apiKey?.trim() || '';
  const transport = params.transport ?? createFetchTransport();
  const timeoutMs = params.provider.timeoutMs;

  // 2. 模型列表（一次 GET /v1/models）。失败只影响 modelList，不终止后续实测。
  let models: string[] | undefined;
  let reachable = false;
  let listAccepted = false;
  let unreachableError: AppErrorInfo | undefined;
  const listStart = now();
  try {
    models = await discoverModels({
      baseUrl: normalized.baseUrl,
      apiKey,
      transport,
      signal: params.signal,
      timeoutMs,
    });
    const latencyMs = Math.max(0, now() - listStart);
    reachable = true;
    set('reachability', { status: 'verified', message: '服务可以连接。', latencyMs });
    if (apiKey) {
      listAccepted = true;
      set('modelList', {
        status: models.length > 0 ? 'verified' : 'failed',
        message:
          models.length > 0
            ? `服务列出了 ${models.length} 个模型；列表不代表每个模型都有权限，所选模型仍需实测。`
            : '服务返回了空的模型列表，可手动填写模型 ID 继续检查。',
        latencyMs,
        reasonCode: models.length > 0 ? undefined : 'model-list-empty',
      });
    }
  } catch (error) {
    if (isAbortError(error) || params.signal.aborted) throw cancelledError();
    const info = toAppErrorInfo(error);
    const latencyMs = Math.max(0, now() - listStart);
    if (gotHttpResponse(info)) {
      reachable = true;
      set('reachability', {
        status: 'verified',
        message: '服务可以连接（收到了 HTTP 响应）。',
        latencyMs,
      });
    } else {
      unreachableError = info;
    }
    if (info.httpStatus === 401) {
      set('auth', {
        status: 'failed',
        message: apiKey
          ? 'API Key 无效或已失效（401）：请重新填写 Key。'
          : '尚未填写 API Key：请先填写 Key 再检查。',
        reasonCode: apiKey ? info.code : 'api-key-missing',
      });
      return finish();
    }
    if (apiKey) {
      if (!gotHttpResponse(info)) {
        set('modelList', {
          status: 'failed',
          message: withDetail(
            `获取模型列表失败：${info.message} 下面仍会用手动填写的模型实测。`,
            info,
          ),
          reasonCode: info.code,
        });
      } else if (info.httpStatus === 404 || info.httpStatus === 405 || info.httpStatus === 501) {
        set('modelList', {
          status: 'unsupported',
          message: '服务未提供模型列表接口：请手动填写模型 ID，下面的模型检查仍会实测。',
          reasonCode: info.code,
        });
      } else if (info.httpStatus === 403) {
        set('modelList', {
          status: 'failed',
          message: '当前 Key 无权读取模型列表（403）：可手动填写模型 ID，下面的模型检查仍会实测。',
          reasonCode: info.code,
        });
      } else if (info.category === 'format') {
        set('modelList', {
          status: 'failed',
          message:
            '返回的不是模型列表 JSON：请确认 Base URL 指向 API 根地址；可手动填写模型 ID 继续。',
          reasonCode: info.code,
        });
      } else {
        set('modelList', {
          status: 'failed',
          message: withDetail(`获取模型列表失败：${info.message} 可手动填写模型 ID 继续。`, info),
          reasonCode: info.code,
        });
      }
    }
  }
  if (!apiKey) {
    set('auth', {
      status: 'failed',
      message: '尚未填写 API Key：请先填写 Key 再检查。',
      reasonCode: 'api-key-missing',
    });
    if (!reachable && unreachableError) {
      set('reachability', {
        status: 'failed',
        message: withDetail(unreachableError.message, unreachableError),
        reasonCode: unreachableError.code,
      });
    }
    return finish({ models });
  }
  if (listAccepted) {
    set('auth', {
      status: 'unknown',
      message: '模型列表接口接受了该 Key；是否能调用翻译以下方翻译测试为准。',
    });
  }

  // 3. 模型 + 极小翻译调用
  throwIfAborted();
  const model = params.provider.model.trim();
  if (!model) {
    set('model', {
      status: 'failed',
      message: '尚未选择模型：请从列表选择或手动填写模型 ID。',
      reasonCode: 'model-missing',
    });
    if (!reachable && unreachableError) {
      set('reachability', {
        status: 'unknown',
        message: withDetail(
          `模型列表请求未得到响应（${unreachableError.message}），且未填写模型，无法用翻译调用确认可达性。`,
          unreachableError,
        ),
        reasonCode: unreachableError.code,
      });
    }
    return finish({ models });
  }
  const inList = models ? models.includes(model) : undefined;
  const protocols: ('responses' | 'chat')[] =
    params.provider.protocol === 'auto' ? ['responses', 'chat'] : [params.provider.protocol];

  let detectedProtocol: 'responses' | 'chat' | undefined;
  let lastError: AppErrorInfo | undefined;
  let unsupportedCount = 0;
  let translationLatency: number | undefined;
  let translatedText = '';
  let formatMode: FormatMode = 'json_schema';
  for (const protocol of protocols) {
    throwIfAborted();
    const provider = createSub2apiTextProvider(
      {
        baseUrl: normalized.baseUrl,
        apiKey,
        protocol,
        model,
        reasoningEffort: params.provider.reasoningEffort,
        streaming: false,
      },
      transport,
      { maxRepairAttempts: 0, now },
    );
    try {
      const result = await provider.translateBatch(PROBE_INPUT, {
        signal: params.signal,
        timeoutMs,
      });
      detectedProtocol = protocol;
      translationLatency = result.latencyMs;
      translatedText = result.items[0]?.text ?? '';
      formatMode = provider.formatMode;
      lastError = undefined;
      break;
    } catch (error) {
      if (isAbortError(error) || params.signal.aborted) throw cancelledError();
      lastError = toAppErrorInfo(error);
      if (isEndpointUnsupported(lastError)) {
        unsupportedCount++;
        if (params.provider.protocol === 'auto' && protocol === 'responses') continue;
      }
      break;
    }
  }

  // 可达性以翻译探测为准（模型列表没有得到响应时）
  if (!reachable) {
    if (detectedProtocol || (lastError && gotHttpResponse(lastError))) {
      set('reachability', {
        status: 'verified',
        message: '服务可以连接（翻译接口有响应；模型列表请求未成功）。',
        latencyMs: translationLatency,
      });
    } else {
      const reason = lastError ?? unreachableError;
      set('reachability', {
        status: 'failed',
        message: reason ? withDetail(reason.message, reason) : '无法连接到服务。',
        reasonCode: reason?.code,
      });
      set('auth', { status: 'unknown', message: '未能确认：服务不可达。' });
      set('model', { status: 'unknown', message: '未能确认：服务不可达。' });
      set('translation', {
        status: 'failed',
        message: '翻译测试未完成：服务不可达。',
        reasonCode: reason?.code,
      });
      if (includeStreaming) {
        set('streaming', { status: 'unknown', message: '未检查：需先通过翻译测试。' });
      }
      return finish({ models });
    }
  }

  if (detectedProtocol) {
    set('auth', { status: 'verified', message: 'API Key 已通过翻译调用验证。' });
    set('model', {
      status: 'verified',
      message:
        inList === false
          ? `模型 ${model} 可以调用（未出现在模型列表中，但实测可用）。`
          : `模型 ${model} 可以调用。`,
    });
    const keepsNumber = /3|三/.test(translatedText);
    const keepsNegation = /不|没|别|勿|未|无|莫/.test(translatedText);
    const note =
      keepsNumber && keepsNegation ? '' : '；注意：测试译文未保留数字或否定，建议对比其他模型';
    set('translation', {
      status: 'verified',
      message: `翻译测试通过（${PROTOCOL_LABEL[detectedProtocol]}；${FORMAT_LABEL[formatMode]}；结果与目标语言校验通过${note}）。`,
      latencyMs: translationLatency,
      reasonCode: formatMode === 'json_schema' ? undefined : `format-${formatMode}`,
    });
  } else if (lastError) {
    applyTranslationError(set, lastError, model, protocols, unsupportedCount, listAccepted);
    if (includeStreaming) {
      set('streaming', { status: 'unknown', message: '未检查：需先通过翻译测试。' });
    }
    return finish({ models });
  }

  // 4. 流式（可选）
  if (includeStreaming && detectedProtocol) {
    throwIfAborted();
    const provider = createSub2apiTextProvider(
      {
        baseUrl: normalized.baseUrl,
        apiKey,
        protocol: detectedProtocol,
        model,
        reasoningEffort: params.provider.reasoningEffort,
        streaming: true,
      },
      transport,
      { maxRepairAttempts: 0, now },
    );
    let partials = 0;
    try {
      const result = await provider.translateBatch(PROBE_INPUT, {
        signal: params.signal,
        timeoutMs,
        onPartial: () => {
          partials++;
        },
      });
      const end = provider.lastStreamEnd;
      if (end === 'json-fallback' || end === undefined) {
        set('streaming', {
          status: 'unsupported',
          message: '服务忽略了流式参数并返回普通 JSON：请关闭「流式返回」。',
          reasonCode: 'stream-ignored',
        });
      } else if (end === 'finish-reason-only') {
        set('streaming', {
          status: 'verified',
          message: `流式返回内容完整，但只收到 finish_reason、没有收到 [DONE] 结束事件（部分结果 ${partials} 次）；如遇截断请关闭「流式返回」。`,
          latencyMs: result.latencyMs,
          reasonCode: 'stream-no-done',
        });
      } else {
        set('streaming', {
          status: 'verified',
          message: `流式返回正常（收到${detectedProtocol === 'chat' ? ' [DONE]' : ' response.completed'} 结束事件，部分结果 ${partials} 次）。`,
          latencyMs: result.latencyMs,
        });
      }
    } catch (error) {
      if (isAbortError(error) || params.signal.aborted) throw cancelledError();
      const info = toAppErrorInfo(error);
      if (info.code === 'unsupported-parameter' || isEndpointUnsupported(info)) {
        set('streaming', {
          status: 'unsupported',
          message: withDetail('服务不接受流式请求：请关闭「流式返回」。', info),
          reasonCode: info.code,
        });
      } else if (info.code === 'stream-interrupted') {
        set('streaming', {
          status: 'failed',
          message: '流式响应没有正常结束（缺少结束事件或连接中断）：建议关闭「流式返回」。',
          reasonCode: info.code,
        });
      } else {
        set('streaming', {
          status: 'failed',
          message: withDetail(`流式测试失败：${info.message}`, info),
          reasonCode: info.code,
        });
      }
    }
  }

  return finish({ models, detectedProtocol });
}

function applyTranslationError(
  set: SetItem,
  error: AppErrorInfo,
  model: string,
  protocols: ('responses' | 'chat')[],
  unsupportedCount: number,
  listAccepted: boolean,
): void {
  const code = error.code;
  if (error.category !== 'auth' && error.category !== 'format') {
    set('auth', {
      status: 'unknown',
      message: listAccepted
        ? '模型列表接口接受了该 Key，但翻译调用没有成功，无法最终确认。'
        : '未能单独确认 Key 是否有效：请参考下方模型与翻译检查结果。',
    });
  }
  if (unsupportedCount >= protocols.length) {
    set('translation', {
      status: 'unsupported',
      message:
        protocols.length > 1
          ? '服务既不支持 Responses 也不支持 Chat Completions 接口：请确认 Base URL 是否为 sub2api 的 API 地址。'
          : withDetail(
              `服务不支持 ${PROTOCOL_LABEL[protocols[0]!]} 接口：请在设置中切换协议或改为自动检测。`,
              error,
            ),
      reasonCode: code,
    });
    return;
  }
  switch (error.category) {
    case 'auth':
      set('auth', {
        status: 'failed',
        message: 'API Key 无效或已失效（401）：请重新填写 Key。',
        reasonCode: code,
      });
      set('model', { status: 'unknown', message: '未检查：认证未通过。' });
      set('translation', {
        status: 'failed',
        message: '翻译测试未通过：认证失败。',
        reasonCode: code,
      });
      return;
    case 'permission':
      set('model', {
        status: 'failed',
        message: withDetail(
          `没有使用模型 ${model} 的权限（403）：请检查 Key 所属分组的模型权限，或更换模型。`,
          error,
        ),
        reasonCode: code,
      });
      set('translation', {
        status: 'failed',
        message: '翻译测试未通过：模型无权限。',
        reasonCode: code,
      });
      return;
    case 'config':
      set('model', {
        status: 'failed',
        message: withDetail(
          `服务找不到模型 ${model}：请确认模型 ID 拼写，或从模型列表中选择。`,
          error,
        ),
        reasonCode: code,
      });
      set('translation', {
        status: 'failed',
        message: '翻译测试未通过：模型不可用。',
        reasonCode: code,
      });
      return;
    case 'format':
      if (MODEL_OUTPUT_ERROR_CODES.has(code)) {
        // 翻译接口返回了 200 但内容不合格：Key 与模型确实被接受了。
        set('auth', { status: 'verified', message: 'API Key 已被翻译接口接受（返回了内容）。' });
        set('model', {
          status: 'verified',
          message: `模型 ${model} 可以调用，但返回内容未通过校验。`,
        });
        set('translation', {
          status: 'failed',
          message: withDetail(
            '模型返回的译文未通过格式或语言校验：建议更换模型，或将推理参数改为「不发送」后重试。',
            error,
          ),
          reasonCode: code,
        });
      } else {
        // 400 类拒绝（内容审核、上下文等）或响应不是 API JSON（例如网页）：不能据此确认 Key。
        set('auth', {
          status: 'unknown',
          message: '服务拒绝了本次探测请求，无法据此确认 Key 是否可用于翻译。',
        });
        set('model', { status: 'unknown', message: '未能确认：探测请求被拒绝。' });
        set('translation', {
          status: 'failed',
          message: withDetail(`翻译测试未通过：${error.message}`, error),
          reasonCode: code,
        });
      }
      return;
    default:
      set('model', { status: 'unknown', message: '未能确认：翻译测试没有得到模型结果。' });
      set('translation', {
        status: 'failed',
        message: withDetail(`翻译测试失败：${error.message}`, error),
        reasonCode: code,
      });
  }
}

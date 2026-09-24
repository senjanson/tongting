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
import { t } from '../../i18n';

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

function formatLabel(mode: FormatMode): string {
  switch (mode) {
    case 'json_schema':
      return t('background.check.formatJsonSchema');
    case 'json_object':
      return t('background.check.formatJsonObject');
    case 'prompt':
      return t('background.check.formatPrompt');
  }
}

function clip(message: string): string {
  return message.length > 300 ? `${message.slice(0, 297)}…` : message;
}

function withDetail(message: string, error: AppErrorInfo): string {
  const detail = sanitizeDetail(error.detail, 80);
  return clip(detail ? t('background.check.withDetail', { message, detail }) : message);
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
      (key) =>
        items.get(key) ?? { key, status: 'unknown', message: t('background.check.skippedPrereq') },
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
    set('hostPermission', { status: 'unknown', message: t('background.check.skippedBaseUrl') });
    return finish();
  }
  const origin = normalized.origin;
  if (!params.hasHostPermission) {
    set('hostPermission', {
      status: 'failed',
      message: t('background.check.hostPermissionMissing', { origin }),
      reasonCode: 'host-permission-missing',
    });
    return finish();
  }
  set('hostPermission', {
    status: 'verified',
    message: t('background.check.hostPermissionGranted', { origin }),
  });

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
    set('reachability', {
      status: 'verified',
      message: t('background.check.reachable'),
      latencyMs,
    });
    if (apiKey) {
      listAccepted = true;
      set('modelList', {
        status: models.length > 0 ? 'verified' : 'failed',
        message:
          models.length > 0
            ? t('background.check.modelListCount', { count: models.length })
            : t('background.check.modelListEmpty'),
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
        message: t('background.check.reachableHttp'),
        latencyMs,
      });
    } else {
      unreachableError = info;
    }
    if (info.httpStatus === 401) {
      set('auth', {
        status: 'failed',
        message: apiKey ? t('background.check.keyInvalid') : t('background.check.keyMissing'),
        reasonCode: apiKey ? info.code : 'api-key-missing',
      });
      return finish();
    }
    if (apiKey) {
      if (!gotHttpResponse(info)) {
        set('modelList', {
          status: 'failed',
          message: withDetail(
            t('background.check.modelListFailedStillTest', { message: info.message }),
            info,
          ),
          reasonCode: info.code,
        });
      } else if (info.httpStatus === 404 || info.httpStatus === 405 || info.httpStatus === 501) {
        set('modelList', {
          status: 'unsupported',
          message: t('background.check.modelListUnsupported'),
          reasonCode: info.code,
        });
      } else if (info.httpStatus === 403) {
        set('modelList', {
          status: 'failed',
          message: t('background.check.modelListForbidden'),
          reasonCode: info.code,
        });
      } else if (info.category === 'format') {
        set('modelList', {
          status: 'failed',
          message: t('background.check.modelListNotJson'),
          reasonCode: info.code,
        });
      } else {
        set('modelList', {
          status: 'failed',
          message: withDetail(
            t('background.check.modelListFailed', { message: info.message }),
            info,
          ),
          reasonCode: info.code,
        });
      }
    }
  }
  if (!apiKey) {
    set('auth', {
      status: 'failed',
      message: t('background.check.keyMissing'),
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
      message: t('background.check.authListOnly'),
    });
  }

  // 3. 模型 + 极小翻译调用
  throwIfAborted();
  const model = params.provider.model.trim();
  if (!model) {
    set('model', {
      status: 'failed',
      message: t('background.check.modelMissing'),
      reasonCode: 'model-missing',
    });
    if (!reachable && unreachableError) {
      set('reachability', {
        status: 'unknown',
        message: withDetail(
          t('background.check.reachabilityUnconfirmed', { message: unreachableError.message }),
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
        message: t('background.check.reachableViaTranslation'),
        latencyMs: translationLatency,
      });
    } else {
      const reason = lastError ?? unreachableError;
      set('reachability', {
        status: 'failed',
        message: reason ? withDetail(reason.message, reason) : t('background.check.unreachable'),
        reasonCode: reason?.code,
      });
      set('auth', { status: 'unknown', message: t('background.check.unconfirmedUnreachable') });
      set('model', { status: 'unknown', message: t('background.check.unconfirmedUnreachable') });
      set('translation', {
        status: 'failed',
        message: t('background.check.translationUnreachable'),
        reasonCode: reason?.code,
      });
      if (includeStreaming) {
        set('streaming', {
          status: 'unknown',
          message: t('background.check.skippedNeedsTranslation'),
        });
      }
      return finish({ models });
    }
  }

  if (detectedProtocol) {
    set('auth', { status: 'verified', message: t('background.check.authVerified') });
    set('model', {
      status: 'verified',
      message:
        inList === false
          ? t('background.check.modelVerifiedNotListed', { model })
          : t('background.check.modelVerified', { model }),
    });
    const keepsNumber = /3|三/.test(translatedText);
    const keepsNegation = /不|没|别|勿|未|无|莫/.test(translatedText);
    const note = keepsNumber && keepsNegation ? '' : t('background.check.qualityNote');
    set('translation', {
      status: 'verified',
      message: t('background.check.translationPassed', {
        protocol: PROTOCOL_LABEL[detectedProtocol],
        format: formatLabel(formatMode),
        note,
      }),
      latencyMs: translationLatency,
      reasonCode: formatMode === 'json_schema' ? undefined : `format-${formatMode}`,
    });
  } else if (lastError) {
    applyTranslationError(set, lastError, model, protocols, unsupportedCount, listAccepted);
    if (includeStreaming) {
      set('streaming', {
        status: 'unknown',
        message: t('background.check.skippedNeedsTranslation'),
      });
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
          message: t('background.check.streamIgnored'),
          reasonCode: 'stream-ignored',
        });
      } else if (end === 'finish-reason-only') {
        set('streaming', {
          status: 'verified',
          message: t('background.check.streamNoDone', { count: partials }),
          latencyMs: result.latencyMs,
          reasonCode: 'stream-no-done',
        });
      } else {
        set('streaming', {
          status: 'verified',
          message: t('background.check.streamOk', {
            end: detectedProtocol === 'chat' ? '[DONE]' : 'response.completed',
            count: partials,
          }),
          latencyMs: result.latencyMs,
        });
      }
    } catch (error) {
      if (isAbortError(error) || params.signal.aborted) throw cancelledError();
      const info = toAppErrorInfo(error);
      if (info.code === 'unsupported-parameter' || isEndpointUnsupported(info)) {
        set('streaming', {
          status: 'unsupported',
          message: withDetail(t('background.check.streamRejected'), info),
          reasonCode: info.code,
        });
      } else if (info.code === 'stream-interrupted') {
        set('streaming', {
          status: 'failed',
          message: t('background.check.streamInterrupted'),
          reasonCode: info.code,
        });
      } else {
        set('streaming', {
          status: 'failed',
          message: withDetail(t('background.check.streamFailed', { message: info.message }), info),
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
        ? t('background.check.authListButTranslateFailed')
        : t('background.check.authUnconfirmed'),
    });
  }
  if (unsupportedCount >= protocols.length) {
    set('translation', {
      status: 'unsupported',
      message:
        protocols.length > 1
          ? t('background.check.noProtocol')
          : withDetail(
              t('background.check.protocolUnsupported', {
                protocol: PROTOCOL_LABEL[protocols[0]!],
              }),
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
        message: t('background.check.keyInvalid'),
        reasonCode: code,
      });
      set('model', { status: 'unknown', message: t('background.check.skippedAuthFailed') });
      set('translation', {
        status: 'failed',
        message: t('background.check.translationAuthFailed'),
        reasonCode: code,
      });
      return;
    case 'permission':
      set('model', {
        status: 'failed',
        message: withDetail(t('background.check.modelForbidden', { model }), error),
        reasonCode: code,
      });
      set('translation', {
        status: 'failed',
        message: t('background.check.translationModelForbidden'),
        reasonCode: code,
      });
      return;
    case 'config':
      set('model', {
        status: 'failed',
        message: withDetail(t('background.check.modelNotFound', { model }), error),
        reasonCode: code,
      });
      set('translation', {
        status: 'failed',
        message: t('background.check.translationModelUnavailable'),
        reasonCode: code,
      });
      return;
    case 'format':
      if (MODEL_OUTPUT_ERROR_CODES.has(code)) {
        // 翻译接口返回了 200 但内容不合格：Key 与模型确实被接受了。
        set('auth', {
          status: 'verified',
          message: t('background.check.authAcceptedByTranslation'),
        });
        set('model', {
          status: 'verified',
          message: t('background.check.modelOutputInvalid', { model }),
        });
        set('translation', {
          status: 'failed',
          message: withDetail(t('background.check.translationOutputInvalid'), error),
          reasonCode: code,
        });
      } else {
        // 400 类拒绝（内容审核、上下文等）或响应不是 API JSON（例如网页）：不能据此确认 Key。
        set('auth', {
          status: 'unknown',
          message: t('background.check.probeRejected'),
        });
        set('model', {
          status: 'unknown',
          message: t('background.check.unconfirmedProbeRejected'),
        });
        set('translation', {
          status: 'failed',
          message: withDetail(
            t('background.check.translationRejected', { message: error.message }),
            error,
          ),
          reasonCode: code,
        });
      }
      return;
    default:
      set('model', { status: 'unknown', message: t('background.check.unconfirmedNoResult') });
      set('translation', {
        status: 'failed',
        message: withDetail(
          t('background.check.translationFailed', { message: error.message }),
          error,
        ),
        reasonCode: code,
      });
  }
}

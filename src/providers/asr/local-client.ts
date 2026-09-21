/**
 * 本地识别服务客户端（services/asr-local，契约见 ./types.ts 顶部注释）。
 *
 * - 只允许 http://127.0.0.1:<port>：服务只绑定 IPv4 回环并校验 Host 头；localhost 可能解析到 ::1，不支持。
 * - 在 offscreen 文档中调用（音频不经 runtime 消息传输）。
 * - 服务端不返回任何 CORS 头，且除 /health 外（含 OPTIONS 预检）都要求令牌：
 *   扩展只能依靠已授予的主机权限 http://127.0.0.1/*（manifest 中为 optional_host_permissions）访问；
 *   有主机权限时扩展页面的请求不受 CORS 限制、不发送预检。未授权时请求会以网络错误失败。
 * - 超时与取消覆盖到响应体读取完毕；响应体按上限流式读取。
 * - 静音/无语音分段返回 200 且 text、segments 为空，此时 language 无意义（实测会给出 en 0.39），客户端丢弃语言信息。
 * - 服务端同一时刻只做 1 个推理并带小队列，调用方必须串行发送（识别队列并发为 1），429/503 按 Retry-After 退避。
 */
import { z } from 'zod';
import { AppError } from '../../domain/errors';
import { primaryLanguageTag } from '../../domain/languages';
import type { AsrHealth, AsrProvider, AsrTranscription } from './types';
import {
  guardedRequest,
  httpError,
  joinApiPath,
  normalizeLoopbackBaseUrl,
  redactUrl,
} from './http';

/** 识别结果 JSON 上限。 */
const RESULT_MAX_BYTES = 1024 * 1024;

/** 服务端限制请求体 ≤ 2 MB、最长 30 秒。 */
export const LOCAL_ASR_MAX_BYTES = 2 * 1024 * 1024;

const HealthSchema = z.object({
  status: z.enum(['ok', 'loading', 'error']),
  ready: z.boolean(),
  model: z.string().max(200).optional(),
  device: z.string().max(100).optional(),
  computeType: z.string().max(100).optional(),
  version: z.string().max(100).optional(),
});

const SegmentSchema = z.object({
  startMs: z.number().min(0),
  endMs: z.number().min(0),
  text: z.string().max(4_000),
  avgLogprob: z.number().optional(),
  noSpeechProb: z.number().min(0).max(1).optional(),
});

export const TranscriptionSchema = z.object({
  text: z.string().max(8_000),
  language: z.string().max(20).optional(),
  languageProbability: z.number().min(0).max(1).optional(),
  durationMs: z.number().min(0),
  processingMs: z.number().min(0).optional(),
  segments: z.array(SegmentSchema).max(500),
});

/** 识别语言参数：'auto' 或主语言标签（Whisper 使用 ISO 639-1，例如 zh-CN → zh）。 */
export function asrLanguageParam(language: string): string {
  if (!language || language === 'auto') return 'auto';
  const tag = primaryLanguageTag(language);
  return /^[a-z]{2,3}$/.test(tag) ? tag : 'auto';
}

export function createLocalAsrProvider(params: {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}): AsrProvider {
  const base = normalizeLoopbackBaseUrl(params.baseUrl);
  const origin = redactUrl(base);
  const fetchImpl = params.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  if (!params.token) {
    throw new AppError({
      code: 'asr-local-token-missing',
      category: 'config',
      retryable: false,
      message: '尚未与本地识别服务配对',
    });
  }

  return {
    kind: 'local',
    async transcribe(wav, options): Promise<AsrTranscription> {
      if (wav.byteLength > LOCAL_ASR_MAX_BYTES) {
        throw new AppError({
          code: 'audio-too-large',
          category: 'format',
          retryable: false,
          message: '识别分段超过本地服务的大小限制',
        });
      }
      const url = `${joinApiPath(base, '/v1/transcribe')}?language=${encodeURIComponent(asrLanguageParam(options.language))}`;
      const json = await guardedRequest(
        fetchImpl,
        url,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'audio/wav' },
          body: wav,
        },
        { signal: options.signal, timeoutMs: options.timeoutMs, service: 'local-asr', origin },
        async (response, body) => {
          if (!response.ok) throw await httpError(response, body, 'local-asr', origin, Date.now());
          try {
            return await body.json(RESULT_MAX_BYTES);
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw formatError(origin, error);
          }
        },
      );
      const parsed = TranscriptionSchema.safeParse(json);
      if (!parsed.success) throw formatError(origin);
      const t = parsed.data;
      const empty =
        t.text.trim().length === 0 && t.segments.every((seg) => seg.text.trim().length === 0);
      return {
        text: t.text,
        // 无语音结果的语言检测没有意义，不上报。
        language: empty ? undefined : t.language,
        languageProbability: empty ? undefined : t.languageProbability,
        durationMs: t.durationMs,
        processingMs: t.processingMs,
        segments: t.segments.map((s) => ({
          startMs: s.startMs,
          endMs: Math.max(s.startMs, s.endMs),
          text: s.text,
          avgLogprob: s.avgLogprob,
          noSpeechProb: s.noSpeechProb,
        })),
      };
    },
    health(signal) {
      return checkLocalAsrHealth(base, signal, fetchImpl);
    },
  };
}

function formatError(origin: string, cause?: unknown): AppError {
  return new AppError(
    {
      code: 'asr-local-bad-response',
      category: 'format',
      retryable: false,
      message: '本地识别服务返回的数据格式不符合约定',
      detail: origin,
    },
    { cause },
  );
}

/** 健康检查：不需要令牌；网络失败返回 unreachable，不抛出。 */
export async function checkLocalAsrHealth(
  baseUrl: string,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<AsrHealth> {
  let base: string;
  try {
    base = normalizeLoopbackBaseUrl(baseUrl);
  } catch (error) {
    return { status: 'error', ready: false, error: (error as AppError).info };
  }
  const origin = redactUrl(base);
  const impl = fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  try {
    const outcome = await guardedRequest(
      impl,
      joinApiPath(base, '/health'),
      { method: 'GET' },
      { signal, timeoutMs: 3_000, service: 'local-asr', origin },
      async (response, body): Promise<{ error: AppError } | { json: unknown }> => {
        if (!response.ok)
          return { error: await httpError(response, body, 'local-asr', origin, Date.now()) };
        const json = await body.json(64_000).catch((e: unknown) => {
          if (e instanceof AppError) throw e;
          return undefined;
        });
        return { json };
      },
    );
    if ('error' in outcome) return { status: 'error', ready: false, error: outcome.error.info };
    const parsed = HealthSchema.safeParse(outcome.json);
    if (!parsed.success) return { status: 'error', ready: false, error: formatError(origin).info };
    const h = parsed.data;
    return {
      status: h.status,
      ready: h.ready && h.status === 'ok',
      model: h.model,
      device: h.device,
      computeType: h.computeType,
      version: h.version,
    };
  } catch (error) {
    if (error instanceof AppError) {
      if (error.info.category === 'network' || error.info.category === 'timeout') {
        return { status: 'unreachable', ready: false, error: error.info };
      }
      return { status: 'error', ready: false, error: error.info };
    }
    return {
      status: 'error',
      ready: false,
      error: {
        code: 'internal',
        category: 'internal',
        retryable: false,
        message: '本地识别健康检查失败',
        at: Date.now(),
      },
    };
  }
}

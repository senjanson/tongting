/**
 * sub2api 语音识别客户端：POST {base}/v1/audio/transcriptions（OpenAI 兼容 multipart）。
 *
 * 【未经真实服务验证】sub2api 实例是否转发该端点、所选模型是否接受音频、是否返回分段时间戳，
 * 都必须在用户实例上实测后才能在能力矩阵中标为 verified。
 *
 * - whisper 系列模型请求 verbose_json + segment 时间戳；其他模型只请求 json（多数不支持 verbose_json），
 *   此时没有分段时间，调用方应把整段时间标为 endEstimated。
 * - 不跟随重定向；错误映射见 ./http.ts。
 * - 没有免费的健康检查端点：health() 不发起计费调用，返回 ready=false 与 code 'health-not-supported'，
 *   调用方应视为「未知」，而不是「失败」。
 */
import { z } from 'zod';
import { AppError } from '../../domain/errors';
import type { AsrProvider, AsrTranscription } from './types';
import { guardedRequest, httpError, joinApiPath, normalizeServiceBaseUrl, redactUrl } from './http';
import { asrLanguageParam } from './local-client';
import { wavDurationMs } from '../../audio/wav';

/** OpenAI 兼容接口的上传上限为 25 MB。 */
export const SUB2API_ASR_MAX_BYTES = 25 * 1024 * 1024;

const VerboseSegmentSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  text: z.string().max(4_000),
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
});

const ResponseSchema = z.object({
  text: z.string().max(16_000),
  language: z.string().max(40).optional(),
  duration: z.number().min(0).optional(),
  segments: z.array(VerboseSegmentSchema).max(1_000).optional(),
});

/** Whisper verbose_json 的 language 是英文全名（例如 "english"），转换常见值为代码，未知则丢弃。 */
const LANGUAGE_NAMES: Record<string, string> = {
  english: 'en',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
  spanish: 'es',
  french: 'fr',
  german: 'de',
  russian: 'ru',
  portuguese: 'pt',
  italian: 'it',
};

function normalizeLanguage(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(lower)) return lower;
  return LANGUAGE_NAMES[lower];
}

export function supportsVerboseJson(model: string): boolean {
  return /^whisper/i.test(model.trim());
}

export function createSub2apiAsrProvider(params: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
}): AsrProvider {
  const base = normalizeServiceBaseUrl(params.baseUrl);
  const origin = redactUrl(base);
  const fetchImpl = params.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  if (!params.apiKey)
    throw new AppError({
      code: 'auth-missing',
      category: 'config',
      retryable: false,
      message: '尚未设置 API Key',
    });
  if (!params.model.trim()) {
    throw new AppError({
      code: 'asr-model-missing',
      category: 'config',
      retryable: false,
      message: '尚未选择语音识别模型',
    });
  }

  return {
    kind: 'sub2api',
    async transcribe(wav, options): Promise<AsrTranscription> {
      if (wav.byteLength > SUB2API_ASR_MAX_BYTES) {
        throw new AppError({
          code: 'audio-too-large',
          category: 'format',
          retryable: false,
          message: '识别分段过大',
        });
      }
      const verbose = supportsVerboseJson(params.model);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
      form.append('model', params.model.trim());
      form.append('response_format', verbose ? 'verbose_json' : 'json');
      if (verbose) form.append('timestamp_granularities[]', 'segment');
      const lang = asrLanguageParam(options.language);
      if (lang !== 'auto') form.append('language', lang);

      const started = Date.now();
      const json = await guardedRequest(
        fetchImpl,
        joinApiPath(base, '/v1/audio/transcriptions'),
        { method: 'POST', headers: { Authorization: `Bearer ${params.apiKey}` }, body: form },
        { signal: options.signal, timeoutMs: options.timeoutMs, service: 'sub2api-asr', origin },
        async (response, body) => {
          if (!response.ok)
            throw await httpError(response, body, 'sub2api-asr', origin, Date.now());
          try {
            return await body.json(1024 * 1024);
          } catch (error) {
            if (error instanceof AppError) throw error;
            throw badResponse(origin, error);
          }
        },
      );
      const parsed = ResponseSchema.safeParse(json);
      if (!parsed.success) throw badResponse(origin);
      const r = parsed.data;
      const durationMs = r.duration !== undefined ? r.duration * 1000 : (wavDurationMs(wav) ?? 0);
      return {
        text: r.text,
        language: normalizeLanguage(r.language),
        durationMs,
        processingMs: Date.now() - started,
        segments: (r.segments ?? []).map((s) => ({
          startMs: Math.round(s.start * 1000),
          endMs: Math.round(Math.max(s.start, s.end) * 1000),
          text: s.text,
          avgLogprob: s.avg_logprob,
          noSpeechProb:
            s.no_speech_prob !== undefined ? Math.min(1, Math.max(0, s.no_speech_prob)) : undefined,
        })),
      };
    },
    async health() {
      return {
        status: 'error',
        ready: false,
        error: {
          code: 'health-not-supported',
          category: 'unsupported',
          retryable: false,
          message:
            'sub2api 语音识别没有免费的健康检查接口，需要在连接检查中显式进行一次（可能计费的）识别测试。',
          at: Date.now(),
        },
      };
    },
  };
}

function badResponse(origin: string, cause?: unknown): AppError {
  return new AppError(
    {
      code: 'sub2api-asr-bad-response',
      category: 'format',
      retryable: false,
      message: 'sub2api 语音识别返回的数据格式无法识别',
      detail: origin,
    },
    { cause },
  );
}

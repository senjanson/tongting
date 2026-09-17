/**
 * sub2api 云端语音合成 HTTP 调用：POST {base}/v1/audio/speech（OpenAI 兼容）。在 offscreen 中调用。
 *
 * 【未经真实服务验证】端点是否被 sub2api 实例转发、模型与 voice 是否可用、speed 是否被接受，均需实测。
 * - 只发送 OpenAI 文档中的字段；speed 仅在不为 1 时发送，voice 为空时不发送（由服务决定或报错）。
 * - 不跟随重定向；超时与取消覆盖到音频读取完毕；响应体流式读取、上限 20 MB；只接受音频类型或 octet-stream。
 */
import { AppError } from '../../domain/errors';
import {
  guardedRequest,
  httpError,
  joinApiPath,
  normalizeServiceBaseUrl,
  redactUrl,
} from '../asr/http';

export const SPEECH_MAX_BYTES = 20 * 1024 * 1024;

export interface SpeechRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
  text: string;
  speed: number;
  signal: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SpeechAudio {
  audio: ArrayBuffer;
  contentType: string;
  latencyMs: number;
}

export async function synthesizeSpeech(req: SpeechRequest): Promise<SpeechAudio> {
  const base = normalizeServiceBaseUrl(req.baseUrl);
  const origin = redactUrl(base);
  const fetchImpl = req.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const body: Record<string, unknown> = {
    model: req.model,
    input: req.text,
    response_format: 'mp3',
  };
  if (req.voice) body.voice = req.voice;
  if (Number.isFinite(req.speed) && Math.abs(req.speed - 1) > 1e-3)
    body.speed = Math.min(4, Math.max(0.25, req.speed));
  const started = Date.now();
  const { audio, contentType } = await guardedRequest(
    fetchImpl,
    joinApiPath(base, '/v1/audio/speech'),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    { signal: req.signal, timeoutMs: req.timeoutMs ?? 30_000, service: 'sub2api-tts', origin },
    async (response, reader) => {
      if (!response.ok) throw await httpError(response, reader, 'sub2api-tts', origin, Date.now());
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (type && !type.startsWith('audio/') && type !== 'application/octet-stream') {
        throw new AppError({
          code: 'sub2api-tts-bad-response',
          category: 'format',
          retryable: false,
          message: 'sub2api 语音合成没有返回音频数据',
          detail: `${origin} ${type.slice(0, 60)}`,
        });
      }
      const bytes = await reader.bytes(SPEECH_MAX_BYTES);
      return {
        audio: bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
        contentType: type,
      };
    },
  );
  if (audio.byteLength === 0) {
    throw new AppError({
      code: 'sub2api-tts-empty',
      category: 'format',
      retryable: false,
      message: 'sub2api 语音合成返回了空音频',
    });
  }
  return {
    audio,
    contentType: contentType || 'application/octet-stream',
    latencyMs: Date.now() - started,
  };
}

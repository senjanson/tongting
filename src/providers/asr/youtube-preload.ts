import { z } from 'zod';
import { AppError, type AppErrorInfo } from '../../domain/errors';
import { MAX_MEDIA_TIME_MS } from '../../domain/cue';
import { asrLanguageParam, TranscriptionSchema } from './local-client';
import {
  guardedRequest,
  httpError,
  joinApiPath,
  normalizeLoopbackBaseUrl,
  redactUrl,
} from './http';
import { t } from '../../i18n';

const ResultSchema = TranscriptionSchema.extend({
  startMs: z.number().int().min(0).max(MAX_MEDIA_TIME_MS),
  durationMs: z.number().positive().max(30_000),
});

export type YoutubePreloadResult = z.infer<typeof ResultSchema>;

/** 416 响应头：服务端可读取音频的实际结尾（毫秒）。旧版服务不提供。 */
export const MEDIA_END_HEADER = 'X-Tongting-Media-End-Ms';

/** 预读起点已超过服务端可读取的音频结尾（416）。mediaEndMs 为服务端报告的结尾，旧版服务为 undefined。 */
export class PreloadRangeError extends AppError {
  constructor(
    info: AppErrorInfo,
    readonly mediaEndMs: number | undefined,
  ) {
    super(info);
  }
}

function mediaEndMs(header: string | null): number | undefined {
  if (!header || !/^\d{1,10}$/.test(header.trim())) return undefined;
  const value = Number(header.trim());
  return value <= MAX_MEDIA_TIME_MS ? value : undefined;
}
export interface YoutubePreloadRequest {
  baseUrl: string;
  token: string;
  videoId: string;
  startMs: number;
  durationMs: number;
  language: string;
  signal: AbortSignal;
}

/** Worker-only: the page never receives the pairing token or media URLs. */
export async function preloadYoutubeAudio(
  request: YoutubePreloadRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<YoutubePreloadResult> {
  const base = normalizeLoopbackBaseUrl(request.baseUrl);
  const origin = redactUrl(base);
  if (!/^[A-Za-z0-9_-]{11}$/.test(request.videoId) || !request.token) {
    throw new AppError({
      code: 'preload-config',
      category: 'config',
      retryable: false,
      message: t('background.preload.needVideoAndPairing'),
    });
  }
  const json = await guardedRequest(
    fetchImpl,
    joinApiPath(base, '/v1/youtube/transcribe'),
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoId: request.videoId,
        startMs: request.startMs,
        durationMs: request.durationMs,
        language: asrLanguageParam(request.language),
      }),
    },
    { signal: request.signal, timeoutMs: 90_000, service: 'local-asr', origin },
    async (response, body) => {
      if (response.status === 404)
        throw new AppError({
          code: 'preload-upgrade-required',
          category: 'config',
          retryable: false,
          message: t('background.preload.needUpdate'),
        });
      if (!response.ok) {
        const error = await httpError(response, body, 'local-asr', origin, Date.now());
        if (error.info.code === 'preload-range-unavailable')
          throw new PreloadRangeError(
            error.info,
            mediaEndMs(response.headers.get(MEDIA_END_HEADER)),
          );
        throw error;
      }
      return body.json(1024 * 1024);
    },
  );
  const parsed = ResultSchema.safeParse(json);
  if (
    !parsed.success ||
    parsed.data.startMs !== request.startMs ||
    parsed.data.durationMs > request.durationMs + 100 ||
    parsed.data.segments.some((s) => s.endMs < s.startMs || s.endMs > parsed.data.durationMs + 100)
  ) {
    throw new AppError({
      code: 'preload-bad-response',
      category: 'format',
      retryable: false,
      message: t('background.preload.badRange'),
    });
  }
  return parsed.data;
}

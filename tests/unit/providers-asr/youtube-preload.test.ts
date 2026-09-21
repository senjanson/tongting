import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import { mapHttpStatus } from '@src/providers/asr/http';
import { errorNextStep } from '@src/ui/state/derive';
import {
  preloadYoutubeAudio,
  type YoutubePreloadRequest,
} from '@src/providers/asr/youtube-preload';

const request = (): YoutubePreloadRequest => ({
  baseUrl: 'http://127.0.0.1:8765',
  token: 'test-pairing-token',
  videoId: 'aaaaaaaaaaa',
  startMs: 30000,
  durationMs: 20000,
  language: 'en-US',
  signal: new AbortController().signal,
});
const result = {
  startMs: 30000,
  durationMs: 20000,
  text: 'Hello',
  language: 'en',
  segments: [{ startMs: 10, endMs: 4000, text: 'Hello' }],
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

describe('authenticated loopback YouTube preloader', () => {
  it('sends only the video ID and interval, with no cookies or redirect following', async () => {
    const fetcher = vi.fn(async () => response(result));
    await expect(preloadYoutubeAudio(request(), fetcher)).resolves.toMatchObject(result);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8765/v1/youtube/transcribe');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store' });
    expect(JSON.parse(init.body as string)).toEqual({
      videoId: 'aaaaaaaaaaa',
      startMs: 30000,
      durationMs: 20000,
      language: 'en',
    });
    expect(JSON.stringify(init.body)).not.toContain('test-pairing-token');
  });
  it('never sends pairing credentials to a non-loopback host', async () => {
    const fetcher = vi.fn();
    await expect(
      preloadYoutubeAudio({ ...request(), baseUrl: 'https://example.com' }, fetcher),
    ).rejects.toMatchObject({ info: { category: 'config' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    { ...result, startMs: 0 },
    { ...result, durationMs: 25000 },
    { ...result, segments: [{ startMs: 300, endMs: 100, text: 'bad' }] },
    { ...result, segments: [{ startMs: 0, endMs: 22000, text: 'bad' }] },
  ])('rejects incorrect media timestamps rather than filling the buffer', async (data) => {
    await expect(preloadYoutubeAudio(request(), async () => response(data))).rejects.toMatchObject({
      info: { code: 'preload-bad-response' },
    });
  });
  it('explains old service versions and requires an explicit upgrade', async () => {
    await expect(
      preloadYoutubeAudio(request(), async () => response({}, 404)),
    ).rejects.toMatchObject({ info: { code: 'preload-upgrade-required' } });
  });
  it.each([
    [
      503,
      'youtube_preload_unavailable',
      'preload-unavailable',
      'config',
      false,
      '--youtube-preload',
    ],
    [422, 'youtube_unsupported', 'preload-video-unsupported', 'unsupported', false, '受限视频'],
    [
      416,
      'youtube_range_unavailable',
      'preload-range-unavailable',
      'unsupported',
      false,
      '视频结尾',
    ],
    [502, 'youtube_audio_failed', 'preload-audio-failed', 'network', true, '网络或代理'],
    [504, 'youtube_preload_timeout', 'preload-timeout', 'timeout', true, '网络或代理'],
  ] as const)(
    'explains %i / %s without exposing the service body',
    async (status, serviceCode, code, category, retryable, hint) => {
      const error = await preloadYoutubeAudio(request(), async () =>
        response(
          {
            error: {
              code: serviceCode,
              message:
                'internal token=test-pairing-token https://example.com/audio?signature=private',
            },
          },
          status,
        ),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AppError);
      const info = (error as AppError).info;
      expect(info).toMatchObject({ code, category, retryable, httpStatus: status });
      expect(info.message).toContain(hint);
      expect(JSON.stringify(info)).not.toMatch(/test-pairing-token|signature=private/);
      if (status === 503) {
        expect(info.message).toContain('连续播放');
        expect(errorNextStep(info).action).toBe('open-settings');
      }
    },
  );
  it('keeps real model loading retryable and never guesses it from preload/download substrings', () => {
    expect(mapHttpStatus(503, 'model_loading', 5000, 'local-asr', '').info).toMatchObject({
      code: 'asr-local-model-loading',
      retryable: true,
      retryAfterMs: 5000,
    });
    expect(mapHttpStatus(503, 'model_unavailable', undefined, 'local-asr', '').info.code).toBe(
      'asr-local-model-unavailable',
    );
    expect(
      mapHttpStatus(503, 'youtube_download_pending', undefined, 'local-asr', '').info.code,
    ).toBe('asr-local-unavailable');
    expect(
      mapHttpStatus(503, 'youtube_preload_unavailable', undefined, 'sub2api-asr', '').info.code,
    ).toBe('sub2api-asr-server-error');
  });
  it('cancels a pending request without waiting for the service to finish', async () => {
    const abort = new AbortController();
    const pending = preloadYoutubeAudio(
      { ...request(), signal: abort.signal },
      () => new Promise(() => {}),
    );
    abort.abort();
    await expect(pending).rejects.toMatchObject({ info: { category: 'cancelled' } });
  });
});

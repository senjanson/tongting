/**
 * sub2api 云端配音引擎（worker 侧）：经 offscreen `tts/play` 合成并播放。
 *
 * 【未经真实服务验证】见 ./sub2api-speech.ts。
 *
 * - 每次 speak 生成唯一的远端 utteranceId（调用方 id + 令牌），迟到的 tts/event 不会串到新句子。
 * - stop() 立即使当前句失效并通知 offscreen 停止；之后旧 listener 不再收到任何事件。
 * - 路由（地址/Key/模型/声音）在每次 speak 时读取，修改配置后不会继续使用旧 Key。
 */
import { AppError, toAppErrorInfo, type AppErrorInfo } from '../../domain/errors';
import type { MediaOwner } from '../../messaging/offscreen-protocol';
import type { OffscreenClient } from '../../audio/types';
import type { TtsEngine, TtsEngineEvent, TtsVoice } from './types';

export interface Sub2apiTtsRoute {
  baseUrl: string;
  apiKey: string;
  model: string;
  voice: string;
}

function configError(code: string, message: string): AppErrorInfo {
  return new AppError({ code, category: 'config', retryable: false, message }).info;
}

function notConfigured(): AppErrorInfo {
  return configError(
    'tts-not-configured',
    '尚未配置云端配音服务（地址、Key、模型），配音不可用；字幕仍可正常使用。',
  );
}

export function createSub2apiTtsEngine(params: {
  offscreen: OffscreenClient;
  getRoute: () => Sub2apiTtsRoute | null;
  getOwner: () => MediaOwner | null;
}): TtsEngine {
  let token = 0;
  let current: {
    token: number;
    utteranceId: string;
    remoteId: string;
    listener: (e: TtsEngineEvent) => void;
  } | null = null;
  let unsubscribe: (() => void) | null = null;
  let disposed = false;

  const finish = (tok: number, build: (utteranceId: string) => TtsEngineEvent, final: boolean) => {
    if (!current || current.token !== tok) return;
    const target = current;
    if (final) current = null;
    try {
      target.listener(build(target.utteranceId));
    } catch {
      // ignore
    }
  };

  const ensureSubscribed = () => {
    if (unsubscribe) return;
    unsubscribe = params.offscreen.onEvent((event) => {
      if (event.kind !== 'tts/event' || !current || event.utteranceId !== current.remoteId) return;
      const tok = current.token;
      switch (event.event) {
        case 'start':
          finish(tok, (utteranceId) => ({ type: 'start', utteranceId }), false);
          break;
        case 'end':
          finish(tok, (utteranceId) => ({ type: 'end', utteranceId }), true);
          break;
        case 'interrupted':
          finish(tok, (utteranceId) => ({ type: 'interrupted', utteranceId }), true);
          break;
        case 'error':
          finish(
            tok,
            (utteranceId) => ({
              type: 'error',
              utteranceId,
              error: event.error ?? {
                code: 'sub2api-tts-failed',
                category: 'tts',
                retryable: false,
                message: '云端配音失败',
              },
            }),
            true,
          );
          break;
      }
    });
  };

  return {
    kind: 'sub2api',
    async getVoices(): Promise<TtsVoice[]> {
      const route = params.getRoute();
      if (!route) throw new AppError(notConfigured());
      // 云端声音由用户在设置中填写；为空时允许不带 voice 合成（由服务决定默认声音）。未经实测不代表一定可用。
      return [{ voiceName: route.voice, remote: true }];
    },
    voiceKey() {
      const route = params.getRoute();
      return route ? `${route.baseUrl}|${route.model}|${route.voice}` : 'not-configured';
    },
    dispose() {
      disposed = true;
      const target = current;
      token++;
      current = null;
      unsubscribe?.();
      unsubscribe = null;
      if (target)
        params.offscreen
          .request({ kind: 'tts/stop', utteranceId: target.remoteId }, 5_000)
          .catch(() => undefined);
    },
    speak(utterance, listener) {
      if (disposed) {
        const utteranceId = utterance.utteranceId;
        queueMicrotask(() =>
          listener({
            type: 'error',
            utteranceId,
            error: configError('tts-engine-disposed', '配音引擎已释放'),
          }),
        );
        return;
      }
      ensureSubscribed();
      const tok = ++token;
      const remoteId = `${utterance.utteranceId.slice(0, 100)}~${tok}`;
      current = { token: tok, utteranceId: utterance.utteranceId, remoteId, listener };
      const failLater = (error: AppErrorInfo) =>
        queueMicrotask(() =>
          finish(tok, (utteranceId) => ({ type: 'error', utteranceId, error }), true),
        );
      const route = params.getRoute();
      if (!route) return failLater(notConfigured());
      const owner = params.getOwner();
      if (!owner) return failLater(configError('tts-no-owner', '当前没有可以播放配音的会话'));
      params.offscreen
        .request(
          {
            kind: 'tts/play',
            utteranceId: remoteId,
            owner,
            baseUrl: route.baseUrl,
            apiKey: route.apiKey,
            model: route.model,
            // 始终使用当前路由中的声音（设置修改立即生效），不使用控制器缓存的声音名。
            voice: route.voice,
            text: utterance.text.slice(0, 4_000),
            speed: Math.min(
              4,
              Math.max(0.25, Number.isFinite(utterance.rate) ? utterance.rate : 1),
            ),
            volume: Math.min(
              1,
              Math.max(0, Number.isFinite(utterance.volume) ? utterance.volume : 1),
            ),
          },
          15_000,
        )
        .catch((error: unknown) =>
          finish(
            tok,
            (utteranceId) => ({
              type: 'error',
              utteranceId,
              error: toAppErrorInfo(error, {
                category: 'tts',
                code: 'sub2api-tts-request-failed',
                message: '云端配音请求失败',
              }),
            }),
            true,
          ),
        );
    },
    stop() {
      const target = current;
      token++;
      current = null;
      if (target) {
        params.offscreen
          .request({ kind: 'tts/stop', utteranceId: target.remoteId }, 5_000)
          .catch(() => undefined);
      }
    },
  };
}

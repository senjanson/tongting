/**
 * 系统语音引擎：service worker 中调用 chrome.tts。
 *
 * - speak 使用 enqueue:false，新句子会打断旧句子。
 * - chrome.tts 事件没有 utterance id；每次 speak 生成「朗读令牌」，事件回调捕获该令牌，
 *   只有令牌仍为当前值才转发。stop() 后令牌失效，迟到的 start/end/error/interrupted 全部屏蔽（T15）。
 * - stop() 之后不再向旧 listener 发送任何事件（包括 interrupted），调用方自行维护状态。
 * - 系统声音可能由操作系统或远端引擎提供，remote=true 的声音可能需要网络，不能宣称完全离线。
 */
import { browser } from 'wxt/browser';
import { redactSecrets, type AppErrorInfo } from '../../domain/errors';
import type { TtsEngine, TtsEngineEvent, TtsUtterance, TtsVoice } from './types';
import { t } from '../../i18n';

export interface ChromeTtsEventLike {
  type: string;
  errorMessage?: string;
}

export interface ChromeTtsOptionsLike {
  lang?: string;
  voiceName?: string;
  rate?: number;
  volume?: number;
  enqueue?: boolean;
  desiredEventTypes?: string[];
  onEvent?: (event: ChromeTtsEventLike) => void;
}

export interface ChromeTtsLike {
  speak(utterance: string, options: ChromeTtsOptionsLike): Promise<void> | void;
  stop(): void | Promise<void>;
  getVoices(): Promise<
    Array<{ voiceName?: string; lang?: string; remote?: boolean; extensionId?: string }>
  >;
}

function systemTtsError(detail?: string, code = 'tts-system-error'): AppErrorInfo {
  return {
    code,
    category: 'tts',
    retryable: false,
    message: t('background.systemTts.failed'),
    detail: detail ? redactSecrets(detail).slice(0, 200) : undefined,
    at: Date.now(),
  };
}

function clamp(v: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

export function createSystemTtsEngine(api?: ChromeTtsLike): TtsEngine {
  const tts: ChromeTtsLike = api ?? (browser.tts as unknown as ChromeTtsLike);
  let token = 0;
  let current: {
    token: number;
    utteranceId: string;
    listener: (e: TtsEngineEvent) => void;
    started: boolean;
  } | null = null;

  const deliver = (tok: number, build: (utteranceId: string) => TtsEngineEvent, final: boolean) => {
    if (!current || current.token !== tok) return;
    const target = current;
    if (final) current = null;
    try {
      target.listener(build(target.utteranceId));
    } catch {
      // listener 错误不影响引擎
    }
  };

  const onChromeEvent = (tok: number, event: ChromeTtsEventLike) => {
    if (!current || current.token !== tok) return;
    switch (event.type) {
      case 'start':
        if (current.started) return;
        current.started = true;
        deliver(tok, (utteranceId) => ({ type: 'start', utteranceId }), false);
        return;
      case 'end':
        deliver(tok, (utteranceId) => ({ type: 'end', utteranceId }), true);
        return;
      case 'interrupted':
      case 'cancelled':
        deliver(tok, (utteranceId) => ({ type: 'interrupted', utteranceId }), true);
        return;
      case 'error':
        deliver(
          tok,
          (utteranceId) => ({
            type: 'error',
            utteranceId,
            error: systemTtsError(event.errorMessage),
          }),
          true,
        );
        return;
      default:
        return;
    }
  };

  return {
    kind: 'system',
    async getVoices(): Promise<TtsVoice[]> {
      const voices = await tts.getVoices();
      return voices
        .filter((v) => typeof v.voiceName === 'string' && v.voiceName.length > 0)
        .map((v) => ({
          voiceName: v.voiceName!,
          lang: v.lang,
          remote: v.remote,
          extensionId: v.extensionId,
        }));
    },
    speak(utterance: TtsUtterance, listener) {
      const tok = ++token;
      current = { token: tok, utteranceId: utterance.utteranceId, listener, started: false };
      const options: ChromeTtsOptionsLike = {
        lang: utterance.lang,
        rate: clamp(utterance.rate, 0.1, 10, 1),
        volume: clamp(utterance.volume, 0, 1, 1),
        enqueue: false,
        desiredEventTypes: ['start', 'end', 'interrupted', 'cancelled', 'error'],
        onEvent: (event) => onChromeEvent(tok, event),
      };
      if (utterance.voiceName) options.voiceName = utterance.voiceName;
      const fail = (error: unknown) => {
        // 异步报告，保证调用方在 speak 返回后才收到事件。
        queueMicrotask(() =>
          deliver(
            tok,
            (utteranceId) => ({
              type: 'error',
              utteranceId,
              error: systemTtsError(
                error instanceof Error ? error.message : String(error),
                'tts-system-speak-failed',
              ),
            }),
            true,
          ),
        );
      };
      try {
        const result = tts.speak(utterance.text, options);
        if (result && typeof (result as Promise<void>).then === 'function')
          (result as Promise<void>).catch(fail);
      } catch (error) {
        fail(error);
      }
    },
    dispose() {
      // 系统语音引擎在 worker 中共享（会话配音与设置页试听）：没有订阅需要释放，不停止其他使用者的朗读。
    },
    stop() {
      token++;
      current = null;
      try {
        const r = tts.stop();
        if (r && typeof (r as Promise<void>).then === 'function')
          (r as Promise<void>).catch(() => undefined);
      } catch {
        // 已无朗读或 API 不可用
      }
    },
  };
}

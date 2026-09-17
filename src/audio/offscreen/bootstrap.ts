/**
 * offscreen 文档装配：把真实浏览器 API 注入 host / capture session / TTS player。
 * entrypoints/offscreen/main.ts 只负责传入 worklet 地址并调用本函数。
 */
import { browser } from 'wxt/browser';
import { epochNowMs } from '../../domain/clock';
import { randomId } from '../../messaging/ports';
import { createAsrProviderFromRoute } from '../../providers/asr/route';
import { synthesizeSpeech } from '../../providers/tts/sub2api-speech';
import { CaptureSession } from './capture-session';
import { createOffscreenHost, type OffscreenHost, type PortLike } from './host';
import { TtsPlayer } from './tts-player';

export function bootstrapOffscreen(options: { workletUrl: string }): OffscreenHost {
  const epochNow = () => epochNowMs();
  const host = createOffscreenHost({
    connect: (name) => browser.runtime.connect({ name }) as unknown as PortLike,
    onRuntimeMessage: (listener) => {
      const wrapped = (
        message: unknown,
        sender: { id?: string; url?: string; tab?: unknown },
        sendResponse: (r: unknown) => void,
      ) => listener(message, sender, sendResponse);
      browser.runtime.onMessage.addListener(wrapped);
      return () => browser.runtime.onMessage.removeListener(wrapped);
    },
    runtimeId: browser.runtime.id,
    extensionOrigin: browser.runtime.getURL('/').replace(/\/$/, ''),
    createCaptureSession: (req, hooks) =>
      new CaptureSession(req, {
        getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        createAudioContext: () => new AudioContext({ latencyHint: 'interactive' }),
        createWorkletNode: (ctx, name, nodeOptions) => new AudioWorkletNode(ctx, name, nodeOptions),
        workletUrl: options.workletUrl,
        createAsrProvider: (route) => createAsrProviderFromRoute(route),
        emit: hooks.emit,
        onEnded: hooks.onEnded,
        now: epochNow,
        randomId: (prefix) => randomId(prefix),
        logger: console,
      }),
    createTtsPlayer: (emit) =>
      new TtsPlayer({
        createAudioContext: () => new AudioContext({ latencyHint: 'playback' }),
        synthesize: (req) => synthesizeSpeech(req),
        emit,
      }),
    now: epochNow,
    randomId,
    logger: console,
  });
  host.start();
  return host;
}

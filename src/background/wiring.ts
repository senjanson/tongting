/**
 * 真实依赖装配（仅 service worker）。监听器必须在 worker 启动时同步注册。
 */
import { CONTENT_WAKE_MESSAGE_TYPE } from '../messaging/wake';
import { createSecureLocalArea } from '../storage/secure-area';
import { encodeWavPcm16 } from '../audio/wav';
import { createSub2apiAsrProvider } from '../providers/asr/sub2api-client';
import { synthesizeSpeech } from '../providers/tts/sub2api-speech';
import { browser } from 'wxt/browser';
import { createOffscreenClient } from '../audio/offscreen-client';
import { createAsrCueAssembler } from '../captions/asr-assembler';
import { buildCueUnits } from '../captions/build-units';
import { createIncrementalCaptionAssembler } from '../captions/incremental';
import { randomId } from '../messaging/ports';
import { checkLocalAsrHealth } from '../providers/asr/local-client';
import { preloadYoutubeAudio } from '../providers/asr/youtube-preload';
import { normalizeBaseUrl } from '../providers/text/base-url';
import { runTextConnectionCheck } from '../providers/text/connection-check';
import { createTextProvider } from '../providers/text/factory';
import { discoverModels } from '../providers/text/models';
import { generateSearchKeywords } from '../providers/text/search-keywords';
import { searchHistory } from '../storage/search-history';
import { createDubbingController } from '../providers/tts/dubbing-controller';
import { createSub2apiTtsEngine } from '../providers/tts/sub2api-engine';
import { createSystemTtsEngine } from '../providers/tts/system-engine';
import { createIdbTranslationCache } from '../storage/translation-cache';
import { createTranscriptWriter, getTranscript, putTranscript } from '../storage/transcripts';
import { createTranslationScheduler } from '../translation/scheduler';
import { Coordinator } from './coordinator';
import type { CoordinatorDeps, KeyValueArea } from './deps';

function area(storageArea: typeof browser.storage.local): KeyValueArea {
  return {
    get: (keys) => storageArea.get(keys) as Promise<Record<string, unknown>>,
    set: (items) => storageArea.set(items),
    remove: (keys) => storageArea.remove(keys),
  };
}

export function startBackground(): Coordinator {
  // 凭证所在区域仅允许可信扩展上下文访问（内容脚本不可读）。
  void browser.storage.session
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => undefined);
  void browser.storage.local
    .setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' })
    .catch(() => undefined);

  const offscreen = createOffscreenClient();
  const deps: CoordinatorDeps = {
    generateSearchKeywords,
    searchHistory,
    now: () => Date.now(),
    randomId,
    storage: {
      local: area(browser.storage.local),
      session: area(browser.storage.session),
      secureLocal: createSecureLocalArea(),
    },
    runtimeId: browser.runtime.id,
    extensionOrigin: `chrome-extension://${browser.runtime.id}`,
    permissions: {
      contains: (originPattern) => browser.permissions.contains({ origins: [originPattern] }),
    },
    tabCapture: {
      getMediaStreamId: (targetTabId) =>
        new Promise<string>((resolve, reject) => {
          try {
            browser.tabCapture.getMediaStreamId({ targetTabId }, (streamId) => {
              const err = browser.runtime.lastError;
              if (err || !streamId) reject(new Error(err?.message ?? 'no stream id'));
              else resolve(streamId);
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error('tabCapture unavailable'));
          }
        }),
    },
    tabs: {
      exists: async (tabId) => {
        try {
          await browser.tabs.get(tabId);
          return true;
        } catch {
          return false;
        }
      },
      getActiveTabId: async () => {
        const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        return tab?.id;
      },
      wake: async (tabId) => {
        await browser.tabs
          .sendMessage(tabId, { type: CONTENT_WAKE_MESSAGE_TYPE })
          .catch(() => undefined);
      },
    },
    normalizeBaseUrl,
    createTextProvider: (config, transport) => createTextProvider(config, transport),
    discoverModels: (params) => discoverModels(params),
    runTextConnectionCheck: (params) => runTextConnectionCheck(params),
    probeSub2apiSpeech: async (params) => {
      const result = await synthesizeSpeech({ ...params, speed: 1, timeoutMs: 30_000 });
      return {
        bytes: result.audio.byteLength,
        contentType: result.contentType,
        latencyMs: result.latencyMs,
      };
    },
    probeSub2apiTranscription: async ({ signal, ...route }) => {
      const provider = createSub2apiAsrProvider(route);
      const sampleRate = 16_000;
      const samples = new Float32Array(sampleRate);
      for (let i = 0; i < samples.length; i++)
        samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sampleRate);
      const started = Date.now();
      const result = await provider.transcribe(encodeWavPcm16(samples, sampleRate), {
        language: 'auto',
        signal,
        timeoutMs: 30_000,
      });
      return { text: result.text, latencyMs: Date.now() - started };
    },
    createTranslationScheduler,
    preloadYoutubeAudio,
    translationCache: createIdbTranslationCache(),
    buildCueUnits,
    createIncrementalCaptionAssembler,
    createAsrCueAssembler,
    offscreen,
    systemTts: createSystemTtsEngine(),
    createSub2apiTtsEngine,
    createDubbingController,
    checkLocalAsrHealth: (baseUrl, signal) => checkLocalAsrHealth(baseUrl, signal),
    transcripts: { putTranscript, getTranscript, createWriter: createTranscriptWriter },
    logger: console,
  };

  const coordinator = new Coordinator(deps);

  browser.runtime.onConnect.addListener((port) => coordinator.handleConnect(port));
  browser.tabs.onRemoved.addListener((tabId) => coordinator.onTabRemoved(tabId));
  browser.commands.onCommand.addListener((command) => {
    if (command === 'toggle-translation') void coordinator.toggleActiveTab();
    else if (command === 'toggle-captions') void coordinator.toggleCaptions();
  });
  browser.permissions.onAdded.addListener(() => {
    void coordinator.handleCommand({ kind: 'permissions/changed' }).catch(() => undefined);
  });
  browser.permissions.onRemoved.addListener(() => {
    void coordinator.handleCommand({ kind: 'permissions/changed' }).catch(() => undefined);
  });
  browser.runtime.onInstalled.addListener(() => {
    // 工具栏图标打开弹窗；侧栏从弹窗按钮打开（保持用户手势）。
    void browser.sidePanel
      ?.setPanelBehavior?.({ openPanelOnActionClick: false })
      .catch(() => undefined);
  });
  return coordinator;
}

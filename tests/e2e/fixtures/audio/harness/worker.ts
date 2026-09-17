/**
 * P0 实验用 worker（仅测试构建使用，不进入产品包；由 build.ts 生成的临时入口引用）。
 * 使用产品的 createOffscreenClient / createSystemTtsEngine，并把少量操作暴露到 globalThis.__p0，
 * 供 Playwright 的 serviceWorker.evaluate 调用。
 */
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';
import { createOffscreenClient } from '@src/audio/offscreen-client';
import { PORT_OFFSCREEN } from '@src/messaging/ports';
import type { OffscreenEvent, OffscreenRequest } from '@src/messaging/offscreen-protocol';
import { createSystemTtsEngine } from '@src/providers/tts/system-engine';
import type { TtsEngineEvent } from '@src/providers/tts/types';

export default defineBackground({
  type: 'module',
  main() {
    const client = createOffscreenClient();
    const events: Array<{ at: number; event: OffscreenEvent }> = [];
    const hellos: unknown[] = [];
    client.onEvent((event) => events.push({ at: Date.now(), event }));
    client.onHello((status) => hellos.push(status));
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === PORT_OFFSCREEN) client.handlePort(port);
    });
    const tts = createSystemTtsEngine();
    const ttsEvents: Array<{ at: number; event: TtsEngineEvent }> = [];
    const errorText = (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e));

    (globalThis as unknown as { __p0: unknown }).__p0 = {
      events,
      hellos,
      ttsEvents,
      workerInstanceId: client.workerInstanceId,
      ensure: () => client.ensure(),
      queryStatus: () => client.queryStatus(),
      request: (r: OffscreenRequest, timeoutMs?: number) => client.request(r, timeoutMs),
      closeIfIdle: () => client.closeIfIdle(),
      contexts: async () =>
        (
          await (
            browser.runtime as unknown as { getContexts(f: unknown): Promise<unknown[]> }
          ).getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })
        ).length,
      rawCreateTwice: async () => {
        const out: string[] = [];
        for (let i = 0; i < 2; i++) {
          try {
            await browser.offscreen.createDocument({
              url: '/offscreen.html',
              reasons: ['USER_MEDIA'] as never,
              justification: 'p0',
            });
            out.push('ok');
          } catch (e) {
            out.push(`error: ${errorText(e)}`);
          }
        }
        return out;
      },
      activeTabId: async () =>
        (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id,
      getMediaStreamId: async (targetTabId: number) => {
        try {
          const id = await (
            browser.tabCapture as unknown as { getMediaStreamId(o: unknown): Promise<string> }
          ).getMediaStreamId({ targetTabId });
          return { ok: true as const, streamId: id };
        } catch (e) {
          return { ok: false as const, error: errorText(e) };
        }
      },
      voices: () => tts.getVoices(),
      speak: (text: string, lang: string, voiceName?: string) =>
        tts.speak(
          { utteranceId: `p0-${Date.now()}`, text, lang, voiceName, rate: 1, volume: 0.2 },
          (event) => ttsEvents.push({ at: Date.now(), event }),
        ),
      stopSpeak: () => tts.stop(),
    };
  },
});

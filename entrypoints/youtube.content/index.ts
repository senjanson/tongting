/**
 * YouTube 主内容脚本（ISOLATED world）。实现集中在 src/youtube/controller.ts。
 */
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { PORT_CONTENT, randomId } from '@src/messaging/ports';
import type { PortLike } from '@src/youtube/port-client';
import { startYoutubeContent } from '@src/youtube/controller';
import { guardInvalidation, isTrustedWake } from '@src/youtube/lifecycle';

function uiLanguage(): string | undefined {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return navigator.language;
  }
}

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  runAt: 'document_idle',
  // 不向页面广播 WXT 的启动 postMessage（与 MAIN world 桥的消息通道分开）。
  noScriptStartedPostMessage: true,
  main(ctx) {
    // 只看 runtime.id：ctx.isInvalid 可被页面伪造的 WXT 启动事件置为 true。
    const isRuntimeAlive = () => {
      try {
        return !!browser.runtime?.id;
      } catch {
        return false;
      }
    };
    startYoutubeContent({
      win: window,
      doc: document,
      connect: () => browser.runtime.connect({ name: PORT_CONTENT }) as unknown as PortLike,
      isContextValid: isRuntimeAlive,
      readLastError: () => {
        void browser.runtime.lastError;
      },
      onInvalidated: (cb) => guardInvalidation((fn) => ctx.onInvalidated(fn), isRuntimeAlive, cb),
      onWakeMessage: (cb) => {
        const listener = (message: unknown, sender: { id?: string; tab?: unknown }) => {
          if (isTrustedWake(message, sender, isRuntimeAlive() ? browser.runtime.id : undefined))
            cb();
          return undefined;
        };
        browser.runtime.onMessage.addListener(listener);
        return () => {
          try {
            browser.runtime.onMessage.removeListener(listener);
          } catch {
            /* 上下文可能已失效 */
          }
        };
      },
      pageInstanceId: randomId('pg-'),
      uiLanguage: uiLanguage(),
    });
  },
});

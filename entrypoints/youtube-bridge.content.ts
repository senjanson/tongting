/**
 * YouTube MAIN world 桥（document_start）。只读取必要的播放器元数据并被动观察 timedtext 响应，
 * 通过 window.postMessage 交给 ISOLATED 内容脚本校验。实现见 src/youtube/bridge/main-world.ts。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';

export default defineContentScript({
  matches: ['https://www.youtube.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installMainWorldBridge(window);
  },
});

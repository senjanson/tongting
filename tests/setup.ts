import 'fake-indexeddb/auto';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  fakeBrowser.reset();
  // fake-browser 尚未实现此 Chrome 事件；声音测试会覆盖为可触发的监听器。
  vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'addListener').mockImplementation(() => undefined);
  vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'removeListener').mockImplementation(() => undefined);
});

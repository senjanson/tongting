import 'fake-indexeddb/auto';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { beforeEach, vi } from 'vitest';
import { setLocale } from '@src/i18n';

beforeEach(() => {
  fakeBrowser.reset();
  // 非 React 代码的文案语言是模块级状态：每个用例从默认的简体中文开始，避免切换语言的用例互相影响。
  setLocale('zh-CN');
  // fake-browser 尚未实现此 Chrome 事件；声音测试会覆盖为可触发的监听器。
  vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'addListener').mockImplementation(() => undefined);
  vi.spyOn(fakeBrowser.tts.onVoicesChanged, 'removeListener').mockImplementation(() => undefined);
});

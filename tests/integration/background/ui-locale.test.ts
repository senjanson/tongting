import { describe, expect, it } from 'vitest';
import { getLocale } from '@src/i18n';
import { configure, createHarness, FakeScheduler, wait, type Harness } from './harness';

async function startCaptionSession(h: Harness) {
  const ui = await configure(h);
  const content = h.content(1, { documentId: 'doc-1' });
  content.hello();
  content.navigate('aaaaaaaaaaa');
  await wait(20);
  const res = await ui.command({ kind: 'session/start', tabId: 1 });
  expect(res.ok).toBe(true);
  await wait(30);
  content.trackData();
  await h.coordinator.idle();
  await wait(150);
  return { ui, content };
}

describe('worker 界面语言（settings.uiLocale）', () => {
  it('跟随浏览器界面语言：英文浏览器下 worker 提示与内容脚本语言为英文', async () => {
    const h = createHarness({ uiLanguage: 'en-US' });
    const ui = await configure(h);
    expect(getLocale()).toBe('en');
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    await wait(20);
    expect(content.messages('welcome').at(-1)?.locale).toBe('en');
    expect(content.messages('display/settings').at(-1)?.locale).toBe('en');
    const res = await ui.command({ kind: 'player/seek', tabId: 7, timeMs: 0 });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error.message).toBe(
      'The source video tab is unavailable, so it cannot jump there.',
    );
  });

  it('中文浏览器（含繁体）默认中文，手动选择优先', async () => {
    const h = createHarness({ uiLanguage: 'zh-TW' });
    const ui = await configure(h);
    expect(getLocale()).toBe('zh-CN');
    await ui.command({ kind: 'settings/update', patch: { uiLocale: 'en' } });
    expect(getLocale()).toBe('en');
    expect(h.coordinator.settings().uiLocale).toBe('en');
    await ui.command({ kind: 'settings/update', patch: { uiLocale: 'auto' } });
    expect(getLocale()).toBe('zh-CN');
  });

  it('切换界面语言不重启翻译会话，只按新语言重发覆盖层设置与状态文字', async () => {
    const h = createHarness({ uiLanguage: 'zh-CN' });
    const { ui, content } = await startCaptionSession(h);
    const before = ui.lastSnapshot()!;
    const session = before.sessions[0]!;
    const schedulers = FakeScheduler.all.length;
    expect(content.messages('session/state').at(-1)?.session?.statusText).toBe('翻译中');

    const res = await ui.command({ kind: 'settings/update', patch: { uiLocale: 'en' } });
    expect(res.ok).toBe(true);
    await h.coordinator.idle();
    await wait(80);

    const after = ui.lastSnapshot()!;
    expect(after.settings.uiLocale).toBe('en');
    expect(after.configRevision).toBe(before.configRevision);
    expect(after.sessions[0]?.identity).toEqual(session.identity);
    expect(after.sessions[0]?.phase).toBe('running');
    expect(FakeScheduler.all).toHaveLength(schedulers);
    expect(content.messages('display/settings').at(-1)?.locale).toBe('en');
    expect(content.messages('session/state').at(-1)?.session?.statusText).toBe('Translating');

    await ui.command({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  });

  it('重启后按已保存的 uiLocale 恢复语言', async () => {
    const h = createHarness({ uiLanguage: 'en-US' });
    const ui = await configure(h);
    await ui.command({ kind: 'settings/update', patch: { uiLocale: 'zh-CN' } });
    expect(getLocale()).toBe('zh-CN');
    const next = createHarness({ local: h.local, uiLanguage: 'en-US' });
    // 构造时先按浏览器语言，读取设置后改为已保存的选择。
    await next.coordinator.idle();
    await wait(20);
    expect(next.coordinator.settings().uiLocale).toBe('zh-CN');
    expect(getLocale()).toBe('zh-CN');
  });
});

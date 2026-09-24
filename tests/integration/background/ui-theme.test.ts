import { describe, expect, it } from 'vitest';
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

describe('worker 外观主题（settings.uiTheme）', () => {
  it('连接时的覆盖层设置带上当前主题，默认 auto', async () => {
    const h = createHarness({ uiLanguage: 'zh-CN' });
    await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    await wait(20);
    expect(h.coordinator.settings().uiTheme).toBe('auto');
    expect(content.messages('display/settings').at(-1)?.uiTheme).toBe('auto');
  });

  it('切换主题只向所有页面重发覆盖层设置，不重启会话、不递增配置版本', async () => {
    const h = createHarness({ uiLanguage: 'zh-CN' });
    const { ui, content } = await startCaptionSession(h);
    const other = h.content(2, { documentId: 'doc-2' });
    other.hello();
    await wait(20);
    const before = ui.lastSnapshot()!;
    const session = before.sessions[0]!;
    const schedulers = FakeScheduler.all.length;
    const sent = content.messages('display/settings').length;
    const sentOther = other.messages('display/settings').length;
    const captions = h.coordinator.settings().captions;

    const res = await ui.command({ kind: 'settings/update', patch: { uiTheme: 'ink' } });
    expect(res.ok).toBe(true);
    await h.coordinator.idle();
    await wait(50);

    expect(h.coordinator.settings().uiTheme).toBe('ink');
    expect(h.local.data.get('settings')).toMatchObject({ uiTheme: 'ink' });
    for (const [page, count] of [
      [content, sent],
      [other, sentOther],
    ] as const) {
      const messages = page.messages('display/settings');
      expect(messages).toHaveLength(count + 1);
      expect(messages.at(-1)).toEqual({
        type: 'display/settings',
        captions,
        targetLanguage: h.coordinator.settings().targetLanguage,
        locale: 'zh-CN',
        uiTheme: 'ink',
      });
    }
    const after = ui.lastSnapshot()!;
    expect(after.settings.uiTheme).toBe('ink');
    expect(after.configRevision).toBe(before.configRevision);
    expect(after.sessions[0]?.identity).toEqual(session.identity);
    expect(after.sessions[0]?.phase).toBe('running');
    expect(FakeScheduler.all).toHaveLength(schedulers);

    // 同一主题再次保存不重复下发；其他外观设置变化时仍带上当前主题。
    await ui.command({ kind: 'settings/update', patch: { uiTheme: 'ink' } });
    await h.coordinator.idle();
    expect(content.messages('display/settings')).toHaveLength(sent + 1);
    await ui.command({ kind: 'settings/update', patch: { captions: { fontSizePx: 30 } } });
    await h.coordinator.idle();
    expect(content.messages('display/settings').at(-1)).toMatchObject({
      captions: { fontSizePx: 30 },
      uiTheme: 'ink',
    });

    // 恢复默认把主题改回 auto，同样重发。
    await ui.command({ kind: 'settings/reset' });
    await h.coordinator.idle();
    expect(content.messages('display/settings').at(-1)?.uiTheme).toBe('auto');

    await ui.command({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
  });

  it('重连与 worker 重启后按已保存的主题下发', async () => {
    const h = createHarness({ uiLanguage: 'zh-CN' });
    const ui = await configure(h);
    await ui.command({ kind: 'settings/update', patch: { uiTheme: 'wave' } });
    await h.coordinator.idle();
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    await wait(20);
    expect(content.messages('display/settings').at(-1)?.uiTheme).toBe('wave');

    const next = createHarness({ local: h.local, uiLanguage: 'zh-CN' });
    await next.coordinator.idle();
    const restarted = next.content(1, { documentId: 'doc-1' });
    restarted.hello();
    await wait(20);
    expect(next.coordinator.settings().uiTheme).toBe('wave');
    expect(restarted.messages('display/settings').at(-1)?.uiTheme).toBe('wave');
  });
});

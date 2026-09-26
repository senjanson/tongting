/**
 * 诊断日志（worker 端）：会话创建与状态变化、页面上报的记录、导出内容与脱敏、清空。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setDiagSink } from '@src/diagnostics/log';
import { createDiagnosticsStore, DIAG_STORAGE_KEY } from '@src/diagnostics/store';
import { API_KEY, configure, createHarness, FakeScheduler, MemoryArea, wait } from './harness';

afterEach(() => setDiagSink(undefined));

function withDiagnostics() {
  const area = new MemoryArea();
  const store = createDiagnosticsStore({ area, saveDelayMs: 10 });
  setDiagSink((record) => store.add({ ...record, src: 'bg' }));
  const h = createHarness({ uiLanguage: 'zh-CN', diagnostics: store });
  return { h, store, area };
}

async function exportText(ui: ReturnType<ReturnType<typeof createHarness>['ui']>) {
  const res = await ui.command({ kind: 'diagnostics/export' });
  expect(res.ok).toBe(true);
  return (res as { data: { text: string; entries: number } }).data;
}

describe('诊断日志', () => {
  it('记录会话创建、状态变化与页面上报；导出含当前状态，不含 Key、令牌与签名参数', async () => {
    const { h, area } = withDiagnostics();
    const ui = await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    content.send({
      type: 'diag/log',
      entries: [
        {
          t: Date.now(),
          src: 'bridge',
          level: 'warn',
          event: 'timedtext.response',
          data: {
            status: 200,
            bodyLength: 0,
            url: 'https://www.youtube.com/api/timedtext?v=aaaaaaaaaaa&pot=SECRETPOT',
            apiKey: 'sk-leaked-1234567890',
          },
        },
      ],
    });
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);

    const { text, entries } = await exportText(ui);
    expect(entries).toBeGreaterThan(0);
    expect(text).toContain('Vocasub diagnostics 9.9.9-test');
    expect(text).toContain('browser: HarnessBrowser/1.0');
    expect(text).toContain('credential: configured');
    expect(text).toContain('"baseUrl":"https://api.example.com"');
    expect(text).toMatch(/session\.create .*"video":"aaaaaaaaaaa"/);
    expect(text).toMatch(/session\.(new|state) .*"phase":"running"/);
    expect(text).toMatch(/session\.(new|state) .*"source":"full-track"/);
    expect(text).toMatch(/page\.state .*"captions":"available"/);
    expect(text).toMatch(/bridge#1 +WARN +timedtext\.response .*"bodyLength":0/);
    expect(text).toContain('https://www.youtube.com/api/timedtext?{v,pot}');
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain('SECRETPOT');
    expect(text).not.toContain('sk-leaked');
    expect(text).not.toContain('/v1');

    // 日志写入扩展本地存储。
    await wait(30);
    const saved = area.data.get(DIAG_STORAGE_KEY) as { entries: unknown[] };
    expect(saved.entries.length).toBe(entries);
  });

  it('翻译失败记录错误码、HTTP 状态与服务错误类型；同类失败只在变化时和每 20 次记录', async () => {
    const { h, store } = withDiagnostics();
    const ui = await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(100);
    const scheduler = FakeScheduler.all.at(-1)!;
    const cues = scheduler.cues;
    expect(cues.length).toBeGreaterThan(1);
    const fail = (cue: (typeof cues)[number], httpStatus: number, detail: string) => ({
      cueId: cue.id,
      cueRevision: cue.revision,
      state: 'failed' as const,
      error: {
        code: httpStatus === 429 ? 'rate-limited' : 'server-error',
        category: 'network' as const,
        retryable: true,
        message: `HTTP ${httpStatus} https://api.example.com/v1/responses?key=SECRET`,
        httpStatus,
        detail,
      },
    });
    for (let i = 0; i < 21; i++) scheduler.emit([fail(cues[0]!, 500, 'server_error')]);
    scheduler.emit([fail(cues[1]!, 429, 'rate_limit')]);
    await wait(50);
    const failures = store.entries().filter((e) => e.event === 'translate.failed');
    expect(
      failures.map((e) => (e.data as { httpStatus: number; count: number }).httpStatus),
    ).toEqual([500, 500, 429]);
    expect(failures.map((e) => (e.data as { count: number }).count)).toEqual([1, 20, 1]);
    expect(failures[0]).toMatchObject({
      level: 'warn',
      data: { code: 'server-error', detail: 'server_error', model: 'gpt-5.6-terra' },
    });
    expect(JSON.stringify(failures)).not.toContain('SECRET');
  });

  it('记录检查连接结果与界面操作失败（只记命令种类，不记参数）', async () => {
    const { h, store } = withDiagnostics();
    const ui = await configure(h);
    const check = await ui.command({ kind: 'connection/check', scope: 'text' } as never);
    expect(check.ok).toBe(true);
    const logged = store.entries().find((e) => e.event === 'connection.check');
    // 测试替身的文本检查不返回检查项，只返回检测到的协议。
    expect(logged?.data).toMatchObject({
      baseUrl: 'https://api.example.com',
      model: 'gpt-5.6-terra',
      detectedProtocol: 'responses',
      items: [],
    });

    await ui.command({ kind: 'credentials/clear' });
    const discover = await ui.command({ kind: 'models/discover' });
    expect(discover.ok).toBe(false);
    const failed = store.entries().filter((e) => e.event === 'ui.command-failed');
    expect(failed.at(-1)).toMatchObject({
      level: 'warn',
      data: { command: 'models/discover', code: 'missing-api-key', category: 'config' },
    });
    expect(JSON.stringify(store.entries())).not.toContain(API_KEY);
  });

  it('页面上报的非法记录被丢弃，且不会触发快照', async () => {
    const { h, store } = withDiagnostics();
    const ui = await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    await wait(50);
    const snapshots = ui.port.sent.filter((m) => (m as { type: string }).type === 'snapshot');
    const before = store.entries().length;
    content.send({
      type: 'diag/log',
      entries: [{ t: Date.now(), src: 'page', level: 'info', event: 'page.ok', data: { n: 1 } }],
    });
    // 事件名不合法：整条消息被协议校验拒收。
    content.send({
      type: 'diag/log',
      entries: [{ t: Date.now(), src: 'page', level: 'info', event: 'bad event!' }],
    } as never);
    await wait(80);
    expect(
      store
        .entries()
        .slice(before)
        .map((e) => e.event),
    ).toEqual(['page.ok']);
    expect(store.entries().at(-1)).toMatchObject({ src: 'page', tab: 1, data: { n: 1 } });
    expect(ui.port.sent.filter((m) => (m as { type: string }).type === 'snapshot')).toHaveLength(
      snapshots.length,
    );
  });

  it('清空后只剩清空记录', async () => {
    const { h } = withDiagnostics();
    const ui = await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(100);
    expect((await exportText(ui)).text).toContain('session.create');
    const res = await ui.command({ kind: 'diagnostics/clear' });
    expect(res.ok).toBe(true);
    const after = await exportText(ui);
    expect(after.text).not.toContain('session.create');
    expect(after.entries).toBeLessThanOrEqual(2);
  });

  it('没有日志存储时导出只有当前状态', async () => {
    const h = createHarness({ uiLanguage: 'zh-CN' });
    const ui = await configure(h);
    const { text, entries } = await exportText(ui);
    expect(entries).toBe(0);
    expect(text).toContain('Vocasub diagnostics unknown');
    expect(text).not.toContain(API_KEY);
  });
});

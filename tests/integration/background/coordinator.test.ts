import { beforeEach, describe, expect, it } from 'vitest';
import {
  API_KEY,
  EXT_ORIGIN,
  FakeDubbing,
  FakePort,
  FakeScheduler,
  RUNTIME_ID,
  configure,
  createHarness,
  idleStatus,
  wait,
  type Harness,
} from './harness';

async function startCaptionSession(h: Harness, tabId = 1, videoId = 'aaaaaaaaaaa') {
  const ui = await configure(h);
  const content = h.content(tabId, { documentId: `doc-${tabId}` });
  content.hello();
  content.navigate(videoId);
  await wait(20);
  const res = await ui.command({ kind: 'session/start', tabId });
  expect(res.ok).toBe(true);
  await wait(30);
  content.trackData();
  await h.coordinator.idle();
  await wait(150);
  return { ui, content };
}

describe('Coordinator – 字幕模式会话', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it('starts, loads the track, pushes cues and never exposes the API key in snapshots', async () => {
    const { ui, content } = await startCaptionSession(h);
    expect(content.requestKinds()).toContain('captions/load-track');
    const snap = ui.lastSnapshot();
    expect(snap?.sessions[0]?.phase).toBe('running');
    expect(snap?.sessions[0]?.sourceMode).toBe('full-track');
    // UI 用快照中的 recordId 关联收藏与字幕记录，必须与 worker 写入 IndexedDB 的一致。
    expect(snap?.sessions[0]?.recordId).toBe('aaaaaaaaaaa|zh-CN|track:en');
    expect(snap?.credential).toMatchObject({ configured: true, storage: 'session' });
    expect(JSON.stringify(ui.port.sent)).not.toContain(API_KEY);
    expect(JSON.stringify(content.port.sent)).not.toContain(API_KEY);
    const full = content.messages('session/cues').filter((m) => m.full);
    expect(full.at(-1)?.cues).toHaveLength(2);
    // 字幕原文保持为纯文本（HTML 不被解析，由渲染层用 textContent 处理）。
    expect(full.at(-1)?.cues[1]?.sourceText).toBe('This is <b>not</b> a test.');
    const scheduler = FakeScheduler.all.at(-1)!;
    expect(scheduler.cues).toHaveLength(2);
    expect(scheduler.provider.config.apiKey).toBe(API_KEY);
    expect(h.session.data.get('secret.apiKey')).toBe(API_KEY);
    expect(h.local.data.has('secret.apiKey')).toBe(false);
  });

  it('applies translation results only for matching cue revisions and forwards them to overlay and dubbing', async () => {
    const { ui, content } = await startCaptionSession(h);
    await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
    await wait(50);
    const scheduler = FakeScheduler.all.at(-1)!;
    const [c0, c1] = scheduler.cues;
    scheduler.emit([
      {
        cueId: c0!.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好，世界。',
        translationKey: 'k1',
      },
      {
        cueId: c1!.id,
        cueRevision: 5,
        state: 'done',
        translatedText: '过期修订',
        translationKey: 'k1',
      },
    ]);
    await wait(150);
    const patches = content.messages('session/cues').filter((m) => !m.full);
    const all = patches.flatMap((p) => p.cues);
    expect(all.find((c) => c.id === c0!.id)?.translatedText).toBe('你好，世界。');
    expect(all.find((c) => c.id === c1!.id)).toBeUndefined();
    expect(FakeDubbing.all.at(-1)?.upserted.map((c) => c.id)).toEqual([c0!.id]);
    await wait(2_100);
    const record = [...h.transcripts.values()][0] as {
      recordId: string;
      cues: { translatedText?: string }[];
    };
    expect(record.recordId).toBe(ui.lastSnapshot()!.sessions[0]!.recordId);
    expect(record.cues[0]?.translatedText).toBe('你好，世界。');
  });

  it('fails clearly without credentials and does not request captions or capture', async () => {
    const ui = h.ui();
    await ui.command({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api.example.com', protocol: 'responses' } },
    });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('missing-api-key');
    expect(s.desiredState).toBe('stopped');
    expect(content.requestKinds()).not.toContain('captions/load-track');
    expect(h.offscreen.requests).toHaveLength(0);
  });

  it('T10: stop then start during an in-flight start keeps the last intent with a single live session', async () => {
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    let release!: () => void;
    h.permissionGranted.delay = new Promise((r) => (release = r));
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(10);
    await ui.command({ kind: 'session/stop', tabId: 1 });
    await ui.command({ kind: 'session/start', tabId: 1 });
    h.permissionGranted.delay = undefined;
    release();
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(100);
    const live = FakeScheduler.all.filter((s) => !s.disposed);
    expect(live).toHaveLength(1);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(1);
    expect(ui.lastSnapshot()!.sessions[0]!.phase).toBe('running');
  });

  it('keeps a retry issued while a failing start is still in flight', async () => {
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    // 第一次权限检查在用户再次点击后才返回「未授权」；之后用户已授予权限。
    h.deps.permissions.contains = async () => {
      calls++;
      if (calls === 1) {
        await gate;
        return false;
      }
      return true;
    };
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(10);
    await ui.command({ kind: 'session/start', tabId: 1 });
    release();
    await wait(40);
    content.trackData();
    await h.coordinator.idle();
    await wait(120);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('running');
    expect(FakeScheduler.all.filter((x) => !x.disposed)).toHaveLength(1);
  });

  it('T12: A→B→A creates distinct sessions and ignores late track data from the old navigation', async () => {
    const { ui, content } = await startCaptionSession(h, 1, 'aaaaaaaaaaa');
    const firstSession = ui.lastSnapshot()!.sessions[0]!.identity.sessionId;
    const firstNav = content.navigationId;
    content.navigate('bbbbbbbbbbb');
    await wait(40);
    content.trackData();
    await h.coordinator.idle();
    await wait(60);
    content.navigate('aaaaaaaaaaa');
    await wait(40);
    // 旧 A（第一次导航）的迟到字幕数据
    content.trackData([{ startMs: 0, endMs: 1000, text: 'stale A' }], firstNav, 'aaaaaaaaaaa');
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);
    const snap = ui.lastSnapshot()!;
    expect(snap.sessions).toHaveLength(1);
    const third = snap.sessions[0]!;
    expect(third.identity.videoId).toBe('aaaaaaaaaaa');
    expect(third.identity.sessionId).not.toBe(firstSession);
    expect(FakeScheduler.all.filter((s) => !s.disposed)).toHaveLength(1);
    const current = FakeScheduler.all.find((s) => !s.disposed)!;
    expect(current.cues.map((c) => c.sourceText)).not.toContain('stale A');
    expect(FakeScheduler.all[0]!.disposed).toBe(true);
  });

  it('T13: changing target language bumps config revision, clears old translations and invalidates dubbing', async () => {
    const { ui, content } = await startCaptionSession(h);
    await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit([
      {
        cueId: scheduler.cues[0]!.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好',
        translationKey: 'k',
      },
    ]);
    await wait(120);
    const revBefore = ui.lastSnapshot()!.configRevision;
    await ui.command({ kind: 'settings/update', patch: { targetLanguage: 'ja' } });
    await wait(120);
    const snap = ui.lastSnapshot()!;
    expect(snap.configRevision).toBe(revBefore + 1);
    expect(scheduler.configRevisions.at(-1)).toBe(revBefore + 1);
    expect(scheduler.config.targetLanguage).toBe('ja');
    const lastFull = content
      .messages('session/cues')
      .filter((m) => m.full)
      .at(-1)!;
    expect(lastFull.cues.every((c) => c.translatedText === undefined)).toBe(true);
    expect(FakeDubbing.all.at(-1)!.invalidations.length).toBeGreaterThan(0);
    // 显示设置同步到页面
    expect(content.messages('display/settings').at(-1)?.targetLanguage).toBe('ja');
  });

  it('T24: starting on another tab releases the first session before the second starts', async () => {
    const { ui } = await startCaptionSession(h, 1, 'aaaaaaaaaaa');
    const content2 = h.content(2, { documentId: 'doc-2' });
    content2.hello();
    content2.navigate('ccccccccccc');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 2 });
    await wait(40);
    content2.trackData();
    await h.coordinator.idle();
    await wait(100);
    const snap = ui.lastSnapshot()!;
    const active = snap.sessions.filter((x) => x.phase !== 'idle' && x.phase !== 'error');
    expect(active).toHaveLength(1);
    expect(active[0]!.identity.tabId).toBe(2);
    expect(snap.audioOwner?.tabId).toBe(2);
    expect(FakeScheduler.all[0]!.disposed).toBe(true);
    // L5：被切走的标签页保留说明，而不是静默消失。
    const moved = snap.sessions.find((x) => x.identity.tabId === 1);
    expect(moved?.phase).toBe('idle');
    expect(moved?.desiredState).toBe('stopped');
    expect(moved?.notice?.code).toBe('moved-to-other-tab');
  });

  it('T28: clearing the key while running stops the session with an actionable error', async () => {
    const { ui } = await startCaptionSession(h);
    await ui.command({ kind: 'credentials/clear' });
    await h.coordinator.idle();
    await wait(100);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('config-invalid-while-running');
    expect(FakeScheduler.all.every((x) => x.disposed)).toBe(true);
    expect(h.session.data.has('secret.apiKey')).toBe(false);
  });

  it('T28: changing the key keeps finished translations and hands the scheduler a provider with the new key', async () => {
    const { ui, content } = await startCaptionSession(h);
    const scheduler = FakeScheduler.all.at(-1)!;
    scheduler.emit([
      {
        cueId: scheduler.cues[0]!.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好',
        translationKey: 'k',
      },
    ]);
    await wait(120);
    const rev = ui.lastSnapshot()!.configRevision;
    await ui.command({
      kind: 'credentials/set',
      apiKey: 'sk-test-NEW-key-987654',
      remember: false,
    });
    await wait(120);
    expect(scheduler.disposed).toBe(false);
    expect(scheduler.provider.config.apiKey).toBe('sk-test-NEW-key-987654');
    expect(scheduler.configRevisions.at(-1)).toBe(rev);
    expect(ui.lastSnapshot()!.configRevision).toBe(rev);
    const fulls = content.messages('session/cues').filter((m) => m.full);
    expect(
      fulls.at(-1)!.cues.some((c) => c.translatedText === '你好') ||
        content
          .messages('session/cues')
          .some((m) => m.cues.some((c) => c.translatedText === '你好')),
    ).toBe(true);
    expect(JSON.stringify(ui.port.sent)).not.toContain('sk-test-NEW-key-987654');
  });

  it('surfaces repeated translation failures as a session notice and overlay status until a translation succeeds', async () => {
    const { ui, content } = await startCaptionSession(h);
    const scheduler = FakeScheduler.all.at(-1)!;
    const [c0, c1] = scheduler.cues;
    scheduler.emit([
      {
        cueId: c0!.id,
        cueRevision: 0,
        state: 'failed',
        error: {
          code: 'stream-interrupted',
          category: 'network',
          retryable: true,
          message: '流式响应中断',
        },
      },
    ]);
    await wait(80);
    expect(ui.lastSnapshot()!.sessions[0]!.notice?.code).toBe('translation-failing');
    expect(content.messages('session/state').at(-1)?.session?.statusText).toBe(
      '部分字幕翻译失败，正在重试',
    );
    scheduler.emit([
      {
        cueId: c1!.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '好的。',
        translationKey: 'k1',
      },
    ]);
    await wait(80);
    expect(ui.lastSnapshot()!.sessions[0]!.notice).toBeUndefined();
    expect(content.messages('session/state').at(-1)?.session?.statusText).toBe('翻译中');
  });

  it('resets cues left running after a pause so the UI does not show stale progress', async () => {
    const { ui } = await startCaptionSession(h);
    const scheduler = FakeScheduler.all.at(-1)!;
    const cueId = scheduler.cues[0]!.id;
    const cuesPort = ui.port;
    cuesPort.deliver({
      type: 'cues/subscribe',
      sessionId: ui.lastSnapshot()!.sessions[0]!.identity.sessionId,
    });
    scheduler.emit([{ cueId, cueRevision: 0, state: 'running' }]);
    await wait(50);
    await ui.command({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    const cueMsgs = cuesPort.sent.filter((m) => (m as { type: string }).type === 'cues') as {
      cues: { id: string; translationState: string }[];
    }[];
    const last = cueMsgs
      .flatMap((m) => m.cues)
      .filter((c) => c.id === cueId)
      .at(-1);
    expect(last?.translationState).toBe('pending');
    expect(scheduler.paused).toBe(true);
    expect(ui.lastSnapshot()!.sessions[0]!.phase).toBe('paused');
  });

  it('T23: content port disconnect releases the session', async () => {
    const { ui, content } = await startCaptionSession(h);
    content.port.remoteDisconnect();
    await h.coordinator.idle();
    await wait(100);
    expect(FakeScheduler.all.every((x) => x.disposed)).toBe(true);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(0);
    expect(ui.lastSnapshot()!.pages).toHaveLength(0);
  });

  it('enables full-track backfill only for complete caption tracks and reflects it in the snapshot', async () => {
    const { ui } = await startCaptionSession(h);
    const sessionId = ui.lastSnapshot()!.sessions[0]!.identity.sessionId;
    const res = await ui.command({ kind: 'session/backfill', tabId: 1, sessionId, enabled: true });
    expect(res.ok).toBe(true);
    await wait(60);
    expect(FakeScheduler.all.at(-1)!.backfill.at(-1)).toBe(true);
    expect(ui.lastSnapshot()!.sessions[0]!.backfill).toBe(true);
    await ui.command({ kind: 'session/backfill', tabId: 1, sessionId, enabled: false });
    await wait(60);
    expect(ui.lastSnapshot()!.sessions[0]!.backfill).toBeUndefined();
  });

  it('keeps waiting for caption tracks while the page still reports availability unknown', async () => {
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.send({
      type: 'page/video',
      navigationId: 1,
      videoId: 'aaaaaaaaaaa',
      isLive: false,
      isShorts: false,
    });
    content.navigationId = 1;
    content.videoId = 'aaaaaaaaaaa';
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(20);
    // 播放器尚未就绪：空轨道 + unknown，以及一次元数据错误，都不应结束等待。
    content.send({
      type: 'captions/tracks',
      navigationId: 1,
      videoId: 'aaaaaaaaaaa',
      availability: 'unknown',
      tracks: [],
    });
    content.send({
      type: 'captions/error',
      navigationId: 1,
      videoId: 'aaaaaaaaaaa',
      error: {
        code: 'player-not-ready',
        category: 'youtube',
        retryable: true,
        message: '播放器未就绪',
      },
    });
    await wait(150);
    let s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('starting');
    expect(s.error).toBeUndefined();
    content.send({
      type: 'captions/tracks',
      navigationId: 1,
      videoId: 'aaaaaaaaaaa',
      availability: 'available',
      tracks: [{ trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' }],
    });
    await wait(40);
    content.trackData();
    await h.coordinator.idle();
    await wait(120);
    s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('running');
    expect(s.sourceMode).toBe('full-track');
    expect(h.offscreen.kinds()).not.toContain('capture/start');
  });

  it('T11: a seek bumps the epoch for scheduler and dubbing', async () => {
    const { content } = await startCaptionSession(h);
    const scheduler = FakeScheduler.all.at(-1)!;
    const epochsBefore = scheduler.epochs.length;
    content.player({ currentTimeMs: 1000 }, 'tick');
    content.player({ currentTimeMs: 300_000 }, 'seeked');
    await wait(20);
    expect(scheduler.epochs.length).toBeGreaterThan(epochsBefore);
    expect(scheduler.playheads.at(-1)).toBe(300_000);
  });

  it('re-feeds finished cues to dubbing after seek, resume and replay, but not while paused', async () => {
    const { ui, content } = await startCaptionSession(h);
    await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
    await wait(50);
    const scheduler = FakeScheduler.all.at(-1)!;
    const c0 = scheduler.cues[0]!;
    scheduler.emit([
      {
        cueId: c0.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好。',
        translationKey: 'k1',
      },
    ]);
    await wait(50);
    const dub = FakeDubbing.all.at(-1)!;
    const ids = () => dub.upserted.map((c) => c.id);

    content.player({ currentTimeMs: 1000 }, 'tick');
    await wait(10);
    dub.upserted = [];
    const invalidationsBefore = dub.invalidations.length;
    content.player({ currentTimeMs: 0 }, 'seeked');
    await wait(20);
    expect(dub.invalidations.length).toBeGreaterThan(invalidationsBefore);
    expect(ids()).toContain(c0.id);

    dub.upserted = [];
    await ui.command({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    await wait(50);
    scheduler.emit([
      {
        cueId: c0.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好。',
        translationKey: 'k1',
      },
    ]);
    await wait(20);
    expect(dub.upserted).toHaveLength(0);
    await ui.command({ kind: 'session/resume', tabId: 1 });
    await h.coordinator.idle();
    await wait(50);
    expect(ids()).toContain(c0.id);

    content.player({ currentTimeMs: 5_000, ended: true, paused: true }, 'ended');
    await wait(20);
    dub.upserted = [];
    content.player({ currentTimeMs: 0, ended: false }, 'seeked');
    await wait(20);
    expect(ids()).toContain(c0.id);
  });

  it('T27: settings persistence failure is reported as not persisted but applied in memory', async () => {
    const ui = h.ui();
    h.local.failWrites = true;
    const res = await ui.command({
      kind: 'settings/update',
      patch: { captions: { fontSizePx: 30 } },
    });
    expect(res.ok && res.data).toEqual({ persisted: false });
    await wait(80);
    const snap = ui.lastSnapshot()!;
    expect(snap.settingsPersisted).toBe(false);
    expect(snap.settings.captions.fontSizePx).toBe(30);
  });
});

describe('Coordinator – 发送方与命令校验（T29）', () => {
  it('rejects content ports from non-YouTube origins and UI ports from web pages', () => {
    const h = createHarness();
    const evil = new FakePort('tongting:content', {
      id: RUNTIME_ID,
      url: 'https://evil.example/',
      tab: { id: 3 } as never,
      frameId: 0,
    });
    h.coordinator.handleConnect(evil);
    expect(evil.disconnected).toBe(true);
    const fakeUi = new FakePort('tongting:ui', {
      id: RUNTIME_ID,
      url: 'https://www.youtube.com/watch',
      tab: { id: 3 } as never,
      frameId: 0,
    });
    h.coordinator.handleConnect(fakeUi);
    expect(fakeUi.disconnected).toBe(true);
    const otherExt = new FakePort('tongting:ui', {
      id: 'otherextensionidotherextensionid',
      url: `${EXT_ORIGIN}/sidepanel.html`,
    });
    h.coordinator.handleConnect(otherExt);
    expect(otherExt.disconnected).toBe(true);
  });

  it('answers malformed UI commands with an explicit rejection', async () => {
    const h = createHarness();
    const ui = h.ui();
    ui.port.deliver({
      type: 'command',
      requestId: 'bad1',
      command: { kind: 'credentials/set', apiKey: 42 },
    });
    await wait(20);
    const res = ui.port.sent.find((m) => (m as { requestId?: string }).requestId === 'bad1') as {
      ok: boolean;
    };
    expect(res?.ok).toBe(false);
  });

  it('ignores content messages that fail schema validation', async () => {
    const h = createHarness();
    const content = h.content(1);
    content.hello();
    content.send({
      type: 'page/video',
      navigationId: 1,
      videoId: '<script>',
      isLive: false,
      isShorts: false,
    } as never);
    await wait(80);
    const ui = h.ui();
    await wait(80);
    expect(ui.lastSnapshot()!.pages[0]?.videoId ?? null).toBeNull();
  });
});

describe('Coordinator – 语音识别模式', () => {
  it('uses tab capture when no captions exist and stops a capture whose start is still in flight (T14)', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    let release!: () => void;
    h.offscreen.captureStartDelay = new Promise((r) => (release = r));
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(60);
    expect(h.offscreen.kinds()).toContain('capture/start');
    await ui.command({ kind: 'session/stop', tabId: 1 });
    release();
    await h.coordinator.idle();
    await wait(60);
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
      asr: { token?: string };
    };
    const stop = h.offscreen.requests.find((r) => r.kind === 'capture/stop') as
      { leaseId: string } | undefined;
    expect(stop?.leaseId).toBe(start.leaseId);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(0);
    // 本地识别令牌只进入 offscreen 请求，不出现在 UI 快照
    expect(start.asr.token).toBe('local-token-123456');
    expect(JSON.stringify(ui.port.sent)).not.toContain('local-token-123456');
  });

  it('pausing translation releases tab capture; resuming re-acquires it or stays paused with a next step', async () => {
    const h = createHarness();
    h.deps.timings = { leaseRenewMs: 60, leaseRetryMs: 30 };
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const first = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
    };
    const renewsFor = (leaseId: string) =>
      h.offscreen.requests.filter(
        (r) => r.kind === 'lease/renew' && (r as { leaseId: string }).leaseId === leaseId,
      ).length;
    await wait(200);
    expect(renewsFor(first.leaseId)).toBeGreaterThan(0);
    const owner = (
      h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
        owner: { sessionId: string; tabId: number; epoch: number };
      }
    ).owner;
    h.offscreen.emitEvent({
      kind: 'asr/status',
      leaseId: first.leaseId,
      owner,
      state: 'running',
      backlogMs: 500,
      activeTracks: 1,
    });
    await wait(100);
    expect(ui.lastSnapshot()!.sessions[0]!.resources.activeTracks).toBe(1);
    await ui.command({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    expect(h.offscreen.requests).toContainEqual(
      expect.objectContaining({ kind: 'capture/stop', leaseId: first.leaseId }),
    );
    const paused = ui.lastSnapshot()!.sessions[0]!;
    expect(paused.phase).toBe('paused');
    // 捕获释放后不再有心跳：资源字段按释放结果复位。
    expect(paused.resources).toMatchObject({ capture: 'none', asr: 'idle', activeTracks: 0 });
    expect(paused.resources.asrBacklogMs).toBeUndefined();
    // 续租定时器已停止：之后不再有旧租约的续租请求。
    const before = renewsFor(first.leaseId);
    await wait(200);
    expect(renewsFor(first.leaseId)).toBe(before);

    // 恢复时没有用户调用扩展：保持暂停并说明原因。
    h.captureResult.value = 'error';
    await ui.command({ kind: 'session/resume', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    let snap = ui.lastSnapshot()!.sessions[0]!;
    expect(snap.phase).toBe('paused');
    expect(snap.desiredState).toBe('paused');
    expect(snap.error?.code).toBe('capture-not-allowed');

    // 用户点击图标后再次继续：重新获取捕获。
    h.captureResult.value = 'ok';
    await ui.command({ kind: 'session/resume', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    snap = ui.lastSnapshot()!.sessions[0]!;
    expect(snap.phase).toBe('running');
    expect(snap.error).toBeUndefined();
    const starts = h.offscreen.requests.filter((r) => r.kind === 'capture/start') as {
      leaseId: string;
    }[];
    expect(starts).toHaveLength(2);
    expect(starts[1]!.leaseId).not.toBe(first.leaseId);
    await wait(200);
    expect(renewsFor(first.leaseId)).toBe(before);
    expect(renewsFor(starts[1]!.leaseId)).toBeGreaterThan(0);
  });

  it('reports a clear next step when captions are missing and ASR is not configured (T04)', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.error?.code).toBe('asr-not-configured');
    expect(h.offscreen.requests).toHaveLength(0);
  });

  it('reports captions-not-ready instead of "no captions" when availability stays unknown after the wait', async () => {
    const h = createHarness();
    h.deps.timings = { tracksWaitMs: 60 };
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.send({
      type: 'page/video',
      navigationId: 1,
      videoId: 'aaaaaaaaaaa',
      isLive: false,
      isShorts: false,
    });
    content.navigationId = 1;
    content.videoId = 'aaaaaaaaaaa';
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(150);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.error?.code).toBe('captions-not-ready');
    expect(s.error?.message).not.toContain('没有可读取的字幕');
    expect(h.offscreen.requests).toHaveLength(0);
  });

  it('asks for a user gesture when tab capture is not allowed', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    h.captureResult.value = 'error';
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    expect(ui.lastSnapshot()!.sessions[0]!.error?.code).toBe('capture-not-allowed');
    expect(h.offscreen.kinds()).not.toContain('capture/start');
  });

  it('drops ASR results from an old epoch and accepts current ones', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(60);
    const snap = ui.lastSnapshot()!.sessions[0]!;
    expect(snap.phase).toBe('running');
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
    };
    const owner = { sessionId: snap.identity.sessionId, tabId: 1, epoch: snap.identity.epoch };
    const base = {
      kind: 'asr/result' as const,
      leaseId: start.leaseId,
      startMs: 0,
      endMs: 1000,
      endEstimated: false,
      final: true,
      revision: 0,
    };
    h.offscreen.emitEvent({
      ...base,
      owner: { ...owner, epoch: owner.epoch + 99 },
      segmentId: 'old',
      text: 'old epoch',
    });
    h.offscreen.emitEvent({ ...base, owner, segmentId: 'cur', text: 'current epoch' });
    await wait(120);
    const scheduler = FakeScheduler.all.at(-1)!;
    expect(scheduler.cues.map((c) => c.sourceText)).toEqual(['current epoch']);
  });

  it('T25: capture ended unexpectedly moves the session to an error state and releases resources', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
      owner: { sessionId: string; tabId: number; epoch: number };
    };
    h.offscreen.emitEvent({
      kind: 'capture/ended',
      leaseId: start.leaseId,
      owner: start.owner,
      reason: 'track-ended',
    });
    await h.coordinator.idle();
    await wait(100);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('capture-track-ended');
    expect(FakeScheduler.all.every((x) => x.disposed)).toBe(true);
  });

  it('restarts a start in progress with the new configuration when translation settings change', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1, { documentId: 'doc-1' });
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(30);
    const firstId = ui.lastSnapshot()!.sessions[0]!.identity.sessionId;
    await ui.command({ kind: 'settings/update', patch: { style: 'faithful' } });
    await wait(80);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.identity.sessionId).not.toBe(firstId);
    expect(s.phase).toBe('running');
    expect(FakeScheduler.all[0]!.disposed).toBe(true);
    expect(FakeScheduler.all.at(-1)!.disposed).toBe(false);
  });

  it('discards a connection check that was in flight when the API key changed', async () => {
    const h = createHarness();
    const ui = await configure(h);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    h.deps.runTextConnectionCheck = async () => {
      await gate;
      return {
        items: [{ key: 'auth', status: 'verified', message: 'ok' }],
        detectedProtocol: 'responses',
      };
    };
    const pending = ui.command({
      kind: 'connection/check',
      scope: 'text',
      allowBilledAudioProbe: false,
    });
    await wait(20);
    await ui.command({
      kind: 'credentials/set',
      apiKey: 'sk-test-second-key-000000',
      remember: false,
    });
    release();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(ui.lastSnapshot()!.capabilities.auth).toBeUndefined();
  });

  it('probes sub2api speech only when billed calls are explicitly allowed', async () => {
    const h = createHarness();
    const ui = await configure(h);
    await ui.command({
      kind: 'settings/update',
      patch: { tts: { backend: 'sub2api', sub2apiModel: 'tts-test' } },
    });
    let calls = 0;
    h.deps.probeSub2apiSpeech = async () => {
      calls++;
      return { bytes: 2048, contentType: 'audio/mpeg', latencyMs: 20 };
    };
    const noProbe = await ui.command({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: false,
    });
    expect(calls).toBe(0);
    const items1 = (
      noProbe as { data: { items: { key: string; status: string; reasonCode?: string }[] } }
    ).data.items;
    expect(items1.find((i) => i.key === 'tts')).toMatchObject({
      status: 'unknown',
      reasonCode: 'not-probed',
    });
    const probed = await ui.command({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: true,
    });
    expect(calls).toBe(1);
    const items2 = (probed as { data: { items: { key: string; status: string }[] } }).data.items;
    expect(items2.find((i) => i.key === 'tts')?.status).toBe('verified');
    h.deps.probeSub2apiSpeech = async () => {
      throw Object.assign(new Error('x'), { info: undefined });
    };
    const failed = await ui.command({
      kind: 'connection/check',
      scope: 'tts',
      allowBilledAudioProbe: true,
    });
    const items3 = (failed as { data: { items: { key: string; status: string }[] } }).data.items;
    expect(items3.find((i) => i.key === 'tts')?.status).toBe('failed');
  });

  it('refreshes tab capture only when the credential used by the recognition route changes', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const starts = () => h.offscreen.requests.filter((r) => r.kind === 'capture/start').length;
    expect(starts()).toBe(1);
    await ui.command({
      kind: 'credentials/set',
      apiKey: 'sk-test-second-key-000000',
      remember: false,
    });
    await h.coordinator.idle();
    await wait(60);
    expect(starts()).toBe(1);
    expect(h.offscreen.kinds()).not.toContain('capture/stop');
    await ui.command({ kind: 'asr/set-token', token: 'local-token-rotated-99' });
    await h.coordinator.idle();
    await wait(100);
    expect(h.offscreen.kinds()).toContain('capture/stop');
    expect(starts()).toBe(2);
    const last = h.offscreen.requests.filter((r) => r.kind === 'capture/start').at(-1) as {
      asr: { token?: string };
    };
    expect(last.asr.token).toBe('local-token-rotated-99');
    expect(ui.lastSnapshot()!.sessions[0]!.phase).toBe('running');
  });

  it('wakes an unregistered page on start and starts once its content script reconnects', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1);
    let wakes = 0;
    h.deps.tabs.wake = async () => {
      wakes++;
      setTimeout(() => {
        content.hello();
        content.navigate('aaaaaaaaaaa');
      }, 100);
    };
    const res = await ui.command({ kind: 'session/start', tabId: 1 });
    expect(res.ok).toBe(true);
    expect(wakes).toBe(1);
    await wait(40);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);
    expect(ui.lastSnapshot()!.sessions[0]?.phase).toBe('running');
  });

  it('keeps a paused session when the same document reconnects on a new port', async () => {
    const h = createHarness();
    const { ui, content } = await startCaptionSession(h);
    await ui.command({ kind: 'session/pause', tabId: 1 });
    await h.coordinator.idle();
    await wait(60);
    const sessionId = ui.lastSnapshot()!.sessions[0]!.identity.sessionId;
    const again = h.content(1, { documentId: 'doc-1' });
    again.hello();
    again.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await h.coordinator.idle();
    await wait(80);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.identity.sessionId).toBe(sessionId);
    expect(s.phase).toBe('paused');
    expect(again.messages('session/state').at(-1)?.session?.sessionId).toBe(sessionId);
  });

  it('rejects content ports that do not carry a documentId', async () => {
    const h = createHarness();
    await h.coordinator.ready;
    const port = new FakePort('tongting:content', {
      id: RUNTIME_ID,
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      tab: { id: 7 } as never,
      frameId: 0,
    });
    h.coordinator.handleConnect(port);
    expect(port.disconnected).toBe(true);
  });

  it('L3: changing the base URL under auto protocol restarts the session to re-detect instead of failing', async () => {
    const h = createHarness();
    const ui = await configure(h);
    await ui.command({
      kind: 'settings/update',
      patch: { provider: { protocol: 'auto', detectedProtocol: 'responses' } },
    });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(30);
    content.trackData();
    await h.coordinator.idle();
    await wait(120);
    const firstId = ui.lastSnapshot()!.sessions[0]!.identity.sessionId;
    await ui.command({
      kind: 'settings/update',
      patch: { provider: { baseUrl: 'https://api2.example.com/v1' } },
    });
    await wait(60);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.error?.code).not.toBe('config-invalid-while-running');
    expect(s.identity.sessionId).not.toBe(firstId);
  });

  it('the Alt+T shortcut wakes a page whose content script has not reconnected and starts translation', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1);
    h.deps.tabs.wake = async () => {
      setTimeout(() => {
        content.hello();
        content.navigate('aaaaaaaaaaa');
      }, 80);
    };
    await h.coordinator.toggleActiveTab();
    await wait(40);
    content.trackData();
    await h.coordinator.idle();
    await wait(150);
    expect(ui.lastSnapshot()!.sessions[0]?.phase).toBe('running');
  });

  it('rejects pause without a session and never starts translation implicitly', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    const res = await ui.command({ kind: 'session/pause', tabId: 1 });
    expect(res.ok).toBe(false);
    await h.coordinator.idle();
    await wait(40);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(0);
    expect(content.requestKinds()).not.toContain('captions/load-track');
    expect(FakeScheduler.all).toHaveLength(0);
  });

  it('L4: rejects session commands that carry a stale sessionId', async () => {
    const h = createHarness();
    const { ui } = await startCaptionSession(h);
    const res = await ui.command({
      kind: 'session/stop',
      tabId: 1,
      sessionId: 'sess-stale-000000',
    });
    expect(res.ok).toBe(false);
    expect((res as { error?: { code: string } }).error?.code).toBe('stale-session');
    await wait(40);
    expect(ui.lastSnapshot()!.sessions[0]!.phase).toBe('running');
  });

  it('R12: a page that keeps cancelling track loads does not cause silent restart loops', async () => {
    const h = createHarness();
    const ui = await configure(h);
    const content = h.content(1);
    content.autoReply = false;
    const orig = content.port.onPost!;
    content.port.onPost = (m) => {
      orig(m);
      const msg = m as { type: string; requestId: string; request: { kind: string } };
      if (msg.type !== 'request') return;
      queueMicrotask(() =>
        content.port.deliver(
          msg.request.kind === 'captions/load-track'
            ? {
                type: 'reply',
                requestId: msg.requestId,
                ok: false,
                error: {
                  code: 'navigation-changed',
                  category: 'cancelled',
                  retryable: false,
                  message: '页面已切换到其他视频，操作已取消。',
                },
              }
            : { type: 'reply', requestId: msg.requestId, ok: true },
        ),
      );
    };
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    await wait(150);
    expect(
      content.requestKinds().filter((k) => k === 'captions/load-track').length,
    ).toBeLessThanOrEqual(2);
    const snap = ui.lastSnapshot()!;
    expect(FakeScheduler.all.length).toBeLessThanOrEqual(2);
    expect(snap.sessions).toHaveLength(1);
    // 轨道加载失败后退回「当前显示字幕」增量来源（带提示），或明确报错；不得反复静默重启。
    const s = snap.sessions[0]!;
    if (s.phase === 'running') {
      expect(s.sourceMode).toBe('incremental-captions');
      expect(s.notice).toBeDefined();
    } else {
      expect(s.phase).toBe('error');
      expect(s.error).toBeDefined();
    }
  });

  it('T23: closing the tab releases capture, disposes the scheduler and forgets the page', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
    };
    h.coordinator.onTabRemoved(1);
    await wait(20);
    await h.coordinator.idle();
    await wait(80);
    expect(h.offscreen.requests).toContainEqual(
      expect.objectContaining({ kind: 'capture/stop', leaseId: start.leaseId }),
    );
    expect(FakeScheduler.all.every((x) => x.disposed)).toBe(true);
    const snap = ui.lastSnapshot()!;
    expect(snap.pages).toHaveLength(0);
    expect(snap.sessions).toHaveLength(0);
    expect(snap.audioOwner).toBeNull();
  });

  it('stops ASR capture when the video ends, with a visible reason', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
    };
    content.player({ currentTimeMs: 600_000, ended: true, paused: true }, 'ended');
    await h.coordinator.idle();
    await wait(100);
    expect(h.offscreen.requests).toContainEqual(
      expect.objectContaining({ kind: 'capture/stop', leaseId: start.leaseId }),
    );
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('video-ended');
  });

  it('T26: a throwing cleanup step does not prevent the remaining resources from being released', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    await ui.command({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const dub = FakeDubbing.all.at(-1)!;
    dub.dispose = () => {
      throw new Error('dispose failed');
    };
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
    };
    await ui.command({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    expect(h.offscreen.requests).toContainEqual(
      expect.objectContaining({ kind: 'capture/stop', leaseId: start.leaseId }),
    );
    expect(FakeScheduler.all.every((x) => x.disposed)).toBe(true);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(0);
  });

  it('rejects full-track backfill for ASR sources', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const res = await ui.command({ kind: 'session/backfill', tabId: 1, enabled: true });
    expect(res.ok).toBe(false);
    expect((res as { error?: { code: string } }).error?.code).toBe('backfill-unsupported');
  });

  it('T21: an orphaned offscreen lease without a recovery record is stopped', async () => {
    const h = createHarness();
    await h.coordinator.ready;
    h.offscreen.emitHello({
      ...idleStatus(),
      lease: {
        leaseId: 'lease-orphan-000001',
        owner: { sessionId: 'sess-gone-0001', tabId: 9, epoch: 0 },
        expiresAtEpochMs: Date.now() + 20_000,
      },
    });
    await wait(40);
    expect(h.offscreen.requests).toContainEqual(
      expect.objectContaining({ kind: 'capture/stop', leaseId: 'lease-orphan-000001' }),
    );
  });

  it('advances the capture timeline discontinuity only for media changes, not volume or fullscreen', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const ids = () =>
      h.offscreen.requests
        .filter((r) => r.kind === 'timeline/anchor')
        .map((r) => (r as { anchor: { discontinuityId: number } }).anchor.discontinuityId);
    content.player({ currentTimeMs: 1_000 }, 'tick');
    await wait(10);
    const base = ids().at(-1)!;
    content.player({ currentTimeMs: 1_050, volume: 0.3 }, 'volumechange');
    content.player({ currentTimeMs: 1_100, volume: 0.3, fullscreen: true }, 'fullscreen');
    content.player({ currentTimeMs: 1_150, volume: 0.3, fullscreen: true }, 'playing');
    await wait(10);
    expect(ids().at(-1)).toBe(base);
    content.player({ currentTimeMs: 1_200, volume: 0.3, fullscreen: true, paused: true }, 'pause');
    await wait(10);
    expect(ids().at(-1)).toBe(base + 1);
  });

  it('T22: losing the offscreen connection fails the ASR session immediately; a quiet-input warning is only a notice', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
      owner: { sessionId: string; tabId: number; epoch: number };
    };
    h.offscreen.emitEvent({
      kind: 'asr/error',
      leaseId: start.leaseId,
      owner: start.owner,
      error: { code: 'asr-input-quiet', category: 'asr', retryable: true, message: '输入音量过低' },
    } as never);
    await wait(40);
    let s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('running');
    expect(s.error).toBeUndefined();
    expect(s.notice?.code).toBe('asr-input-quiet');
    // offscreen 心跳中的实际音轨数同步到快照。
    h.offscreen.emitEvent({
      kind: 'asr/status',
      leaseId: start.leaseId,
      owner: start.owner,
      state: 'running',
      backlogMs: 0,
      activeTracks: 1,
    });
    await wait(100);
    s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.resources.activeTracks).toBe(1);
    expect(s.resources.asr).toBe('running');
    h.offscreen.emitConnectionLost('port-disconnected');
    await h.coordinator.idle();
    await wait(100);
    s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('offscreen-lost');
    // 停止完成后错误快照不再显示捕获/识别仍在进行。
    expect(s.resources.capture).not.toBe('active');
    expect(s.resources.asr).toBe('idle');
    expect(s.resources.activeTracks).toBe(0);
  });

  it('T22: a recreated offscreen document fails the ASR session immediately instead of waiting for lease renewal', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await h.coordinator.idle();
    const start = h.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
      owner: { sessionId: string; tabId: number; epoch: number };
    };
    h.offscreen.emitHello({
      ...idleStatus(),
      offscreenInstanceId: 'off-first',
      lease: { leaseId: start.leaseId, owner: start.owner, expiresAtEpochMs: Date.now() + 30_000 },
    });
    await wait(40);
    expect(ui.lastSnapshot()!.sessions[0]!.phase).toBe('running');
    h.offscreen.emitHello({ ...idleStatus(), offscreenInstanceId: 'off-second', lease: null });
    await h.coordinator.idle();
    await wait(100);
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('error');
    expect(s.error?.code).toBe('offscreen-lost');
  });
});

describe('Coordinator – worker 重启恢复', () => {
  it('restores a caption session only for the same document, navigation and video', async () => {
    const h1 = createHarness();
    const { content } = await startCaptionSession(h1);
    const sessionId = h1.coordinator.buildSnapshot(0).sessions[0]!.identity.sessionId;
    await wait(120);
    // 模拟 worker 被终止：内存状态丢失，storage.session 与 storage.local 保留。
    const h2 = createHarness({ local: h1.local, session: h1.session });
    const ui2 = h2.ui();
    const content2 = h2.content(1, { documentId: 'doc-1' });
    content2.hello();
    content2.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await wait(40);
    content2.trackData();
    await h2.coordinator.idle();
    await wait(120);
    const snap = ui2.lastSnapshot()!;
    expect(snap.sessions[0]?.identity.sessionId).toBe(sessionId);
    expect(snap.sessions[0]?.phase).toBe('running');
  });

  it('does not auto-resume a paused session after a worker restart and explains why', async () => {
    const h1 = createHarness();
    const { ui, content } = await startCaptionSession(h1);
    await ui.command({ kind: 'session/pause', tabId: 1 });
    await h1.coordinator.idle();
    await wait(150);
    const sessionId = h1.coordinator.buildSnapshot(0).sessions[0]!.identity.sessionId;
    const h2 = createHarness({ local: h1.local, session: h1.session });
    const ui2 = h2.ui();
    const content2 = h2.content(1, { documentId: 'doc-1' });
    content2.hello();
    content2.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await h2.coordinator.idle();
    await wait(120);
    const snap = ui2.lastSnapshot()!.sessions[0];
    expect(snap?.identity.sessionId).toBe(sessionId);
    expect(snap?.phase).toBe('error');
    expect(snap?.desiredState).toBe('stopped');
    expect(snap?.error?.code).toBe('worker-restarted-paused');
    expect(content2.requestKinds()).not.toContain('captions/load-track');
    expect(FakeScheduler.all).toHaveLength(0);
  });

  it('does not restore when the page document changed', async () => {
    const h1 = createHarness();
    const { content } = await startCaptionSession(h1);
    await wait(120);
    const h2 = createHarness({ local: h1.local, session: h1.session });
    const ui2 = h2.ui();
    const content2 = h2.content(1, { documentId: 'doc-reloaded' });
    content2.hello();
    content2.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await h2.coordinator.idle();
    await wait(120);
    expect(ui2.lastSnapshot()!.sessions).toHaveLength(0);
    expect(content2.requestKinds()).not.toContain('captions/load-track');
  });

  it('T21: renews a recoverable lease at offscreen handshake and adopts it without waiting for caption tracks', async () => {
    const h1 = createHarness();
    const ui1 = await configure(h1, { asr: true });
    const content = h1.content(1, { documentId: 'doc-1' });
    content.hello();
    content.navigate('aaaaaaaaaaa', { tracks: false });
    await wait(20);
    await ui1.command({ kind: 'session/start', tabId: 1 });
    await h1.coordinator.idle();
    await wait(120);
    const start = h1.offscreen.requests.find((r) => r.kind === 'capture/start') as {
      leaseId: string;
      owner: { sessionId: string; tabId: number; epoch: number };
    };
    const leaseStatus = {
      ...idleStatus(),
      lease: { leaseId: start.leaseId, owner: start.owner, expiresAtEpochMs: Date.now() + 10_000 },
    };

    const h2 = createHarness({ local: h1.local, session: h1.session });
    await h2.coordinator.ready;
    h2.offscreen.status = leaseStatus;
    h2.offscreen.emitHello(leaseStatus);
    await wait(40);
    const renew = h2.offscreen.requests.find((r) => r.kind === 'lease/renew') as
      { leaseId: string; ttlMs: number } | undefined;
    expect(renew?.leaseId).toBe(start.leaseId);
    expect(renew!.ttlMs).toBeGreaterThanOrEqual(45_000);

    const ui2 = h2.ui();
    const content2 = h2.content(1, { documentId: 'doc-1' });
    content2.hello();
    // 页面此时报告有字幕轨道：恢复的识别会话仍应直接接管租约，而不是等待字幕轨道。
    content2.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await h2.coordinator.idle();
    await wait(120);
    const snap = ui2.lastSnapshot()!.sessions[0];
    expect(snap?.identity.sessionId).toBe(start.owner.sessionId);
    expect(snap?.phase).toBe('running');
    expect(snap?.sourceMode).toBe('asr');
    expect(content2.requestKinds()).not.toContain('captions/load-track');
    expect(h2.offscreen.kinds()).not.toContain('capture/start');
  });
});

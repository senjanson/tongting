/* 协调器审查（bg-reviewer）复现场景的回归测试：断言修复后的正确行为。 */
import { describe, expect, it } from 'vitest';
import { BackgroundToUiSchema } from '@src/messaging/ui-protocol';
import { FakeScheduler, configure, createHarness, wait, type Harness } from './harness';

async function startCaptionSession(h: Harness, tabId = 1, videoId = 'aaaaaaaaaaa') {
  const ui = await configure(h);
  const content = h.content(tabId, { documentId: `doc-${tabId}` });
  content.hello();
  content.navigate(videoId);
  await wait(20);
  await ui.command({ kind: 'session/start', tabId });
  await wait(30);
  content.trackData();
  await h.coordinator.idle();
  await wait(150);
  return { ui, content };
}

async function startAsrSession(h: Harness, ui: Awaited<ReturnType<typeof configure>>) {
  const content = h.content(1);
  content.hello();
  content.navigate('aaaaaaaaaaa', { tracks: false });
  await wait(20);
  await ui.command({ kind: 'session/start', tabId: 1 });
  await h.coordinator.idle();
  await wait(60);
  return content;
}

describe('coordinator review regressions', () => {
  it('R3: recovery matches page identity, not a 2-minute window since the last record write', async () => {
    const h1 = createHarness();
    const { content } = await startCaptionSession(h1);
    await wait(120);
    const rec = (
      h1.session.data.get('sessionRecords') as { savedAt: number; sessionId: string }[]
    )[0]!;
    h1.session.data.set('sessionRecords', [{ ...rec, savedAt: rec.savedAt - 10 * 60_000 }]);
    const h2 = createHarness({ local: h1.local, session: h1.session, secureLocal: h1.secureLocal });
    const ui2 = h2.ui();
    const c2 = h2.content(1, { documentId: 'doc-1' });
    c2.hello();
    c2.navigate('aaaaaaaaaaa', { navigationId: content.navigationId });
    await wait(40);
    c2.trackData();
    await h2.coordinator.idle();
    await wait(120);
    const s = ui2.lastSnapshot()!.sessions[0];
    expect(s?.identity.sessionId).toBe(rec.sessionId);
    expect(s?.phase).toBe('running');
    // 恢复前不先下发「无会话」，避免覆盖层闪烁
    expect(c2.messages('session/state').some((m) => m.session === null)).toBe(false);
  });

  it('R6: a hanging transcript read does not block stop or a start on another tab', async () => {
    const h = createHarness();
    h.deps.timings = { stopStepTimeoutMs: 150, transcriptSaveDebounceMs: 20 };
    const { ui } = await startCaptionSession(h);
    h.deps.transcripts.getTranscript = () => new Promise(() => undefined);
    const sched = FakeScheduler.all.at(-1)!;
    sched.emit([
      {
        cueId: sched.cues[0]!.id,
        cueRevision: 0,
        state: 'done',
        translatedText: '你好',
        translationKey: 'k',
      },
    ]);
    await wait(50);
    await ui.command({ kind: 'session/stop', tabId: 1 });
    const c2 = h.content(2, { documentId: 'doc-2' });
    c2.hello();
    c2.navigate('ccccccccccc');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 2 });
    await wait(600);
    c2.trackData();
    await wait(200);
    expect(c2.requestKinds()).toContain('captions/load-track');
    const state = await Promise.race([
      h.coordinator.idle().then(() => 'idle'),
      wait(1_500).then(() => 'stuck'),
    ]);
    expect(state).toBe('idle');
    const live = ui.lastSnapshot()!.sessions.filter((s) => s.phase === 'running');
    expect(live.map((s) => s.identity.tabId)).toEqual([2]);
  });

  it('R7: stopping during auto protocol detection aborts the probe and ends the session promptly', async () => {
    const h = createHarness();
    const ui = await configure(h);
    await ui.command({ kind: 'settings/update', patch: { provider: { protocol: 'auto' } } });
    let signal: AbortSignal | undefined;
    h.deps.runTextConnectionCheck = async (p) => {
      signal = p.signal;
      await new Promise(() => undefined);
      return { items: [] };
    };
    const content = h.content(1);
    content.hello();
    content.navigate('aaaaaaaaaaa');
    await wait(20);
    await ui.command({ kind: 'session/start', tabId: 1 });
    await wait(30);
    await ui.command({ kind: 'session/stop', tabId: 1 });
    await h.coordinator.idle();
    await wait(80);
    expect(signal?.aborted).toBe(true);
    expect(ui.lastSnapshot()!.sessions).toHaveLength(0);
  });

  it('R8: an over-long duration keeps the running session visible and every snapshot stays schema-valid', async () => {
    const h = createHarness();
    const ui = await configure(h, { asr: true });
    const content = await startAsrSession(h, ui);
    content.send({
      type: 'page/video',
      navigationId: content.navigationId,
      videoId: 'aaaaaaaaaaa',
      durationMs: 5000 * 3_600_000,
      isLive: false,
      isShorts: false,
    });
    await wait(100);
    let snap = ui.lastSnapshot()!;
    expect(snap.audioOwner?.tabId).toBe(1);
    expect(snap.sessions).toHaveLength(1);
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
    const snapshots = ui.port.sent.filter((m) => (m as { type: string }).type === 'snapshot');
    expect(snapshots.every((m) => BackgroundToUiSchema.safeParse(m).success)).toBe(true);
    snap = ui.lastSnapshot()!;
    expect(snap.sessions[0]?.error?.code).toBe('capture-track-ended');
  });

  it('R10: a single lease renewal failure within the TTL is retried instead of ending the session', async () => {
    const h = createHarness();
    h.deps.timings = { leaseRenewMs: 80, leaseRetryMs: 40 };
    const ui = await configure(h, { asr: true });
    await startAsrSession(h, ui);
    const orig = h.offscreen.request.bind(h.offscreen);
    let n = 0;
    h.offscreen.request = async (req) => {
      if (req.kind === 'lease/renew' && n++ === 0) throw new Error('offscreen-timeout');
      return orig(req);
    };
    await wait(500);
    await h.coordinator.idle();
    const s = ui.lastSnapshot()!.sessions[0]!;
    expect(s.phase).toBe('running');
    expect(s.error).toBeUndefined();
    expect(n).toBeGreaterThan(2);
    expect(h.offscreen.kinds()).not.toContain('capture/stop');
  });
});

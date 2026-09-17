/**
 * 全链路 E2E（故障）：真实扩展 + 模拟 sub2api 注入故障。
 * - T05 Key 无效（401）：连接检查不显示成功；会话显示认证错误、不无限重试；更换正确 Key 后恢复。
 * - T07 429 + Retry-After：请求次数与并发有界、间隔遵守 Retry-After；故障解除后恢复。
 * - T30 跨 origin 302：明确失败，Authorization 未发往重定向目标。
 * - T08 SSE 半截断开：半截译文不作为最终结果；有限重试。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 */
import { expect, test, type Page } from '@playwright/test';
import {
  configureProvider,
  connectionCheck,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { E2E_API_KEY, mockTranslation, startRecorder } from './fixtures/full-chain/mock-sub2api';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import {
  makeCaptionLines,
  type CaptionLine,
  type FixtureVideo,
} from './fixtures/full-chain/youtube';

test.describe.configure({ timeout: 180_000 });

const VIDEO_A = 'AAAAAAAAAAA';
let videos: FixtureVideo[];
let lines: CaptionLine[];
let fc: FullChain | undefined;
const evidence: Record<string, unknown> = {};

test.beforeAll(async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成长视频夹具');
  lines = makeCaptionLines('Alpha', 45);
  videos = [
    {
      videoId: VIDEO_A,
      title: 'Full Chain Alpha',
      lengthSeconds: 150,
      captions: lines,
      media: await silentVideo(150),
    },
  ];
});

test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

test.afterAll(() => {
  if (Object.keys(evidence).length)
    console.log('[full-chain-faults evidence]', JSON.stringify(evidence, null, 2));
});

async function startSession(page: Page, tabId: number) {
  expect(await video(page).play()).toBe(true);
  await fc!.ui.ok({ kind: 'session/start', tabId });
  return fc!.ui.waitSession(tabId, (s) => s.phase === 'running' && s.sourceMode === 'full-track', {
    timeout: 30_000,
    message: '会话 running',
  });
}

function intervals(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - times[i]!);
}

test('T05 Key 无效（401）：不显示连接成功、不无限重试，更换 Key 后恢复', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc, {}, 'wrong-key-e2e-0000');
  const report = await connectionCheck(fc);
  const byKey = Object.fromEntries(report.items.map((i) => [i.key, i]));
  expect(byKey.auth!.status).toBe('failed');
  expect(report.items.some((i) => i.key === 'translation' && i.status === 'verified')).toBe(false);
  const snapAfterCheck = await ui.waitSnapshot((s) => s.capabilities.auth?.status === 'failed', {
    message: '快照能力矩阵 auth=failed',
  });
  expect(JSON.stringify(snapAfterCheck)).not.toContain('wrong-key-e2e-0000');

  const { page, tabId } = await openWatch(fc, VIDEO_A);
  const beforeStart = mock.requests.length;
  await startSession(page, tabId);
  const errored = await ui.waitSession(tabId, (s) => s.error?.category === 'auth', {
    timeout: 20_000,
    message: '会话显示认证错误',
  });
  const firstErrorCount = mock.requests.length - beforeStart;
  // 视频继续播放并跳转到新区间：阻塞错误期间不应继续发送请求。
  await ui.ok({ kind: 'player/seek', tabId, timeMs: 90_000 });
  await sleep(8_000);
  const totalAfterWait = mock.requests.length - beforeStart;
  const badge = (await waitOverlay(page, () => true)).badge;
  expect(totalAfterWait).toBeLessThanOrEqual(3);
  expect(mock.requests.slice(beforeStart).every((r) => r.status === 401)).toBe(true);
  expect(errored.translation.done).toBe(0);

  // 更换为正确 Key：同一会话恢复翻译。
  await ui.ok({ kind: 'credentials/set', apiKey: E2E_API_KEY, remember: false });
  const recovered = await ui.waitSession(tabId, (s) => s.translation.done > 0 && !s.error, {
    timeout: 20_000,
    message: '换 Key 后恢复翻译且错误清除',
  });
  expect(recovered.identity.sessionId).toBe(errored.identity.sessionId);
  evidence.t05 = {
    check: report.items.map((i) => ({ key: i.key, status: i.status, reasonCode: i.reasonCode })),
    sessionError: {
      code: errored.error?.code,
      category: errored.error?.category,
      message: errored.error?.message,
    },
    requestsUntilError: firstErrorCount,
    requestsAfter8s: totalAfterWait,
    overlayBadge: badge,
    recoveredDone: recovered.translation.done,
  };
});

test('T07 429 + Retry-After：有界退避、无重试风暴，解除后恢复', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  mock.setDefault('responses', {
    kind: 'status',
    status: 429,
    headers: { 'retry-after': '2' },
    body: {
      error: {
        message: 'Rate limit reached',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded',
      },
    },
  });
  const t0 = Date.now();
  const beforeStart = mock.requests.length;
  await startSession(page, tabId);
  await sleep(15_000);
  const during = mock.requests.slice(beforeStart);
  const snap = (await ui.session(tabId))!;
  const gaps = intervals(during.map((r) => r.receivedAt));
  // 15 秒、Retry-After 2 秒：请求数有界（无风暴），并发不超过 2。
  expect(during.length).toBeGreaterThan(0);
  expect(during.length).toBeLessThanOrEqual(12);
  expect(mock.maxInflight()).toBeLessThanOrEqual(2);
  const burstAfterFirst = during.filter((r) => r.receivedAt - during[0]!.receivedAt < 1_500).length;
  expect(burstAfterFirst).toBeLessThanOrEqual(2);

  mock.setDefault('responses', null);
  const recovered = await ui.waitSession(tabId, (s) => s.translation.done > 0, {
    timeout: 40_000,
    message: '限流解除后恢复翻译',
  });
  await video(page).pause();
  const at = (await video(page).state()).currentTimeMs;
  const line = lines.find((l) => l.startMs <= at && at < l.startMs + l.durationMs);
  if (line) {
    await ui.ok({ kind: 'session/retry-failed', tabId });
    await waitOverlay(
      page,
      (s) => s.main === mockTranslation('zh-CN', line.text),
      30_000,
      '恢复后当前位置译文',
    );
  }
  evidence.t07 = {
    windowMs: 15_000,
    requests: during.length,
    statuses: during.map((r) => r.status),
    intervalsMs: gaps,
    maxInflight: mock.maxInflight(),
    burstWithin1500ms: burstAfterFirst,
    snapshotDuring: {
      translation: snap.translation,
      error: snap.error && {
        code: snap.error.code,
        category: snap.error.category,
        retryAfterMs: snap.error.retryAfterMs,
      },
    },
    recoveredAfterMs: Date.now() - t0,
    recoveredDone: recovered.translation.done,
  };
});

test('T30 跨 origin 302：明确失败，Authorization 未发往重定向目标', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  const target = await startRecorder();
  try {
    await configureProvider(fc);
    mock.setDefault('responses', {
      kind: 'redirect',
      status: 302,
      location: `${target.baseUrl}/v1/responses`,
    });
    mock.setDefault('models', {
      kind: 'redirect',
      status: 302,
      location: `${target.baseUrl}/v1/models`,
    });
    const report = await connectionCheck(fc);
    expect(
      report.items.some(
        (i) => i.status === 'verified' && (i.key === 'translation' || i.key === 'modelList'),
      ),
    ).toBe(false);

    const { page, tabId } = await openWatch(fc, VIDEO_A);
    await startSession(page, tabId);
    const running = await ui.waitSession(tabId, (s) => s.translation.failed > 0, {
      timeout: 20_000,
      message: '重定向导致翻译失败计数',
    });
    await ui.subscribeCues(running.identity.sessionId);
    await sleep(5_000);
    expect(target.requests).toHaveLength(0);
    const sessionRequests = mock.translationRequests();
    expect(sessionRequests.length).toBeLessThanOrEqual(4);
    const cues = await ui.cues(running.identity.sessionId);
    expect(cues.some((c) => c.translationState === 'done')).toBe(false);
    const failed = cues.filter((c) => c.translationState === 'failed');
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((c) => c.translationError?.code === 'redirect-blocked')).toBe(true);
    const snap = (await ui.session(tabId))!;
    const overlay = await waitOverlay(page, () => true);
    evidence.t30 = {
      check: report.items.map((i) => ({
        key: i.key,
        status: i.status,
        reasonCode: i.reasonCode,
        message: i.message,
      })),
      cueError: failed[0]?.translationError && {
        code: failed[0].translationError.code,
        category: failed[0].translationError.category,
        message: failed[0].translationError.message,
      },
      sessionError: snap.error ?? null,
      sessionNotice: snap.notice ?? null,
      translation: snap.translation,
      overlay: { main: overlay.main, pending: overlay.pending, badge: overlay.badge },
      redirectTargetRequests: target.requests.length,
      mockRequests: mock.requests.map((r) => ({
        endpoint: r.endpoint,
        status: r.status,
        auth: r.authorization ? 'present' : 'absent',
      })),
    };
  } finally {
    await target.close();
  }
});

test('T08 SSE 半截断开：半截译文不作为最终结果，有限重试后成功', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc, { provider: { streaming: true } });
  const truncated = {
    kind: 'sse-truncated' as const,
    chunks: [
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{"translations":[{"id":"' })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x","text":"半截' })}\n\n`,
    ],
  };
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  await video(page).pause();
  await video(page).seek(4.0);
  mock.enqueue('responses', truncated, truncated);
  const beforeStart = mock.requests.length;
  await ui.ok({ kind: 'session/start', tabId });
  const running = await ui.waitSession(tabId, (s) => s.phase === 'running', {
    timeout: 30_000,
    message: 'running',
  });
  await ui.subscribeCues(running.identity.sessionId);
  const line = lines.find((l) => l.startMs <= 4_000 && 4_000 < l.startMs + l.durationMs)!;
  await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', line.text),
    30_000,
    '重试后的完整译文',
  );
  const cues = await ui.cues(running.identity.sessionId);
  expect(cues.some((c) => (c.translatedText ?? '').includes('半截'))).toBe(false);
  const events = await ui.cueEvents();
  expect(events.some((e) => e.cues.some((c) => (c.translatedText ?? '').includes('半截')))).toBe(
    false,
  );
  const reqs = mock.requests.slice(beforeStart).filter((r) => r.endpoint === 'responses');
  expect(reqs.every((r) => r.stream)).toBe(true);

  // 持续半截：有限重试后标记失败，不无限请求。
  mock.setDefault('responses', truncated);
  await ui.ok({ kind: 'cache/clear' });
  const before2 = mock.requests.length;
  await ui.ok({ kind: 'player/seek', tabId, timeMs: 100_000 });
  await sleep(15_000);
  const persistent = mock.requests.slice(before2);
  const snap = (await ui.session(tabId))!;
  expect(persistent.length).toBeGreaterThan(0);
  expect(persistent.length).toBeLessThanOrEqual(12);
  evidence.t08 = {
    firstRoundRequests: reqs.map((r) => ({
      stream: r.stream,
      status: r.status,
      aborted: r.aborted,
    })),
    persistentRequests15s: persistent.length,
    persistentIntervalsMs: intervals(persistent.map((r) => r.receivedAt)),
    snapshot: {
      translation: snap.translation,
      error: snap.error && { code: snap.error.code, category: snap.error.category },
    },
  };
});

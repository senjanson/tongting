/**
 * 全链路 E2E（T21 字幕部分）：运行中强制停止扩展 service worker，验证新 worker 从 storage.session 的会话记录与
 * 内容脚本重新握手后恢复真实会话（同一 sessionId、不重复会话），UI 重连后看到新的 workerInstanceId。
 *
 * 停止方式：在扩展页面的 CDP 会话中调用 ServiceWorker.stopAllWorkers（与 chrome://serviceworker-internals 的 Stop 等价，
 * 实测会终止扩展 worker，下一次事件时由浏览器重新启动 worker 脚本，全局变量丢失）。
 * 这是自动化替代；浏览器因空闲自然挂起 worker 的时机与本测试不同。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 */
import { expect, test } from '@playwright/test';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { UiDriver } from './helpers/ui-driver';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
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

test('T21（字幕模式）：强制停止 service worker 后，会话按记录恢复且不重复', async () => {
  fc = await setupFullChain({ videos });
  const { mock } = fc;
  let ui = fc.ui;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  expect(await video(page).play()).toBe(true);
  await ui.ok({ kind: 'session/start', tabId });
  const before = await ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.translation.done > 0,
    {
      timeout: 30_000,
      message: '会话 running 且有译文',
    },
  );
  const snapBefore = (await ui.snapshot())!;

  await fc.ext.serviceWorker.evaluate(() => {
    (globalThis as { __e2eMarker?: string }).__e2eMarker = 'before-stop';
  });
  const cdp = await fc.ext.context.newCDPSession(ui.page);
  await cdp.send('ServiceWorker.enable');
  const stoppedAt = Date.now();
  await cdp.send('ServiceWorker.stopAllWorkers');
  await cdp.detach();

  // 旧 UI 端口随 worker 终止而断开。
  await expect.poll(async () => (await ui.stats()).disconnected, { timeout: 10_000 }).toBe(true);
  await expect
    .poll(
      () =>
        fc!.ext.serviceWorker
          .evaluate(() => (globalThis as { __e2eMarker?: string }).__e2eMarker ?? 'gone')
          .catch(() => 'gone'),
      { timeout: 10_000 },
    )
    .toBe('gone');
  const oldGlobalsGone = await fc.ext.serviceWorker
    .evaluate(() => typeof (globalThis as { __e2eMarker?: string }).__e2eMarker)
    .catch((e: Error) => `evaluate-failed: ${e.message.slice(0, 80)}`);

  // 重新打开 UI（新 worker 实例）。
  await ui.close();
  ui = await UiDriver.open(fc.ext.context, fc.ext.extensionId);
  fc.ui = ui;
  const restarted = await ui.waitSnapshot(
    (s) => s.workerInstanceId !== snapBefore.workerInstanceId,
    {
      timeout: 15_000,
      message: '新 worker 实例',
    },
  );
  expect(restarted.credential.configured).toBe(true);

  // 播放中的内容脚本在下一次事件时重连；新 worker 按会话记录恢复同一会话。
  const recovered = await ui.waitSession(tabId, (s) => s.phase === 'running', {
    timeout: 30_000,
    message: 'worker 重启后会话恢复 running',
  });
  const recoveredAt = Date.now();
  const snap = (await ui.snapshot())!;
  expect(snap.sessions).toHaveLength(1);
  expect(recovered.identity.sessionId).toBe(before.identity.sessionId);
  expect(recovered.identity.videoId).toBe(VIDEO_A);
  expect(snap.audioOwner).toEqual({ tabId, sessionId: before.identity.sessionId });

  // 覆盖层继续显示当前位置的译文。
  await video(page).pause();
  await video(page).seek(20.0);
  const line = lines.find((l) => l.startMs <= 20_000 && 20_000 < l.startMs + l.durationMs)!;
  const ov = await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', line.text),
    20_000,
    '恢复后的译文',
  );
  expect(ov.hosts).toBe(1);
  await sleep(1_000);
  expect((await ui.snapshot())!.sessions).toHaveLength(1);

  test.info().annotations.push({
    type: 'evidence',
    description: JSON.stringify({
      workerBefore: snapBefore.workerInstanceId,
      workerAfter: restarted.workerInstanceId,
      oldGlobalsGone,
      recoverMs: recoveredAt - stoppedAt,
      sessionId: recovered.identity.sessionId,
      epochBefore: before.identity.epoch,
      epochAfter: recovered.identity.epoch,
      requests: mock.requests.length,
    }),
  });
  console.log('[T21 evidence]', test.info().annotations.at(-1)!.description);
});

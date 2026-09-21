/** Real extension/player volume; deterministic translation and silent TTS boundary. */
import { expect, test } from '@playwright/test';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  video,
  type FullChain,
} from './helpers/full-chain';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';

const VIDEO = 'MUTESPEECH1';
let fc: FullChain | undefined;
test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

test('interpretation keeps original silent across speech/gaps/seeks and restores the latest user volume after pause, mode change and stop', async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成视频夹具');
  fc = await setupFullChain({
    videos: [
      {
        videoId: VIDEO,
        title: 'Continuous original silence',
        lengthSeconds: 35,
        media: await silentVideo(35),
        captions: [
          { startMs: 1500, durationMs: 1800, text: 'First sentence.' },
          { startMs: 7500, durationMs: 1800, text: 'Second sentence.' },
          { startMs: 16000, durationMs: 1800, text: 'Third sentence.' },
        ],
      },
    ],
  });
  await fc.ext.serviceWorker.evaluate(() => {
    type Options = { onEvent?(event: { type: string }): void };
    const g = globalThis as unknown as {
      chrome: {
        tts: {
          getVoices(): Promise<unknown[]>;
          speak(text: string, options: Options): Promise<void>;
          stop(): Promise<void>;
        };
      };
      __muteSpeech: string[];
    };
    g.__muteSpeech = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let token = 0;
    g.chrome.tts.getVoices = async () => [
      { voiceName: 'Silent test voice', lang: 'zh-CN', remote: false },
    ];
    g.chrome.tts.speak = async (_text, options) => {
      const own = ++token;
      queueMicrotask(() => {
        if (own === token) {
          g.__muteSpeech.push('start');
          options.onEvent?.({ type: 'start' });
        }
      });
      timer = setTimeout(() => {
        if (own === token) {
          g.__muteSpeech.push('end');
          options.onEvent?.({ type: 'end' });
        }
      }, 400);
    };
    g.chrome.tts.stop = async () => {
      token++;
      clearTimeout(timer);
    };
  });
  await configureProvider(fc, { outputMode: 'subtitle-voice', sourceStrategy: 'captions-only' });
  expect((await fc.ui.snapshot())?.settings.audio.originalMode).toBe('mute');
  const { page, tabId } = await openWatch(fc, VIDEO);
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('video')!.volume = 0.8;
  });
  await fc.ui.ok({ kind: 'session/start', tabId });
  await fc.ui.waitSession(tabId, (s) => s.phase === 'running');
  const volume = () => expect.poll(async () => (await video(page).state()).volume);
  await volume().toBe(0); // 未开始中文也应静音
  await page.evaluate(() => {
    const g = window as unknown as { __originalVolumes: number[] };
    g.__originalVolumes = [];
    const v = document.querySelector<HTMLVideoElement>('video')!;
    v.addEventListener('volumechange', () => g.__originalVolumes.push(v.volume));
  });
  await video(page).play();
  await expect
    .poll(
      () =>
        fc!.ext.serviceWorker.evaluate(
          () =>
            (globalThis as unknown as { __muteSpeech: string[] }).__muteSpeech.filter(
              (e) => e === 'end',
            ).length,
        ),
      { timeout: 20000 },
    )
    .toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await fc!.ui.session(tabId))?.resources.tts).toBe('idle');
  await volume().toBe(0);
  await video(page).seek(14000 / 1000);
  await expect
    .poll(async () => (await video(page).state()).currentTimeMs)
    .toBeGreaterThanOrEqual(14000);
  await volume().toBe(0);
  const values = await page.evaluate(
    () => (window as unknown as { __originalVolumes: number[] }).__originalVolumes,
  );
  expect(
    values.every((v) => v === 0),
    JSON.stringify(values),
  ).toBe(true);

  const sessionId = (await fc.ui.session(tabId))!.identity.sessionId;
  await fc.ui.ok({ kind: 'session/pause', tabId, sessionId });
  await volume().toBeCloseTo(0.8);
  await fc.ui.ok({ kind: 'session/resume', tabId, sessionId });
  await volume().toBe(0);
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('video')!.volume = 0.6;
  });
  await volume().toBe(0); // 用户修改的音量保存为退出同传后的值
  await fc.ui.ok({ kind: 'settings/update', patch: { outputMode: 'subtitle' } });
  await volume().toBeCloseTo(0.6);
  await fc.ui.ok({ kind: 'settings/update', patch: { outputMode: 'subtitle-voice' } });
  await volume().toBe(0);
  await fc.ui.ok({
    kind: 'settings/update',
    patch: { audio: { originalMode: 'mix', duckOriginal: false } },
  });
  await volume().toBeCloseTo(0.6);
  await fc.ui.ok({ kind: 'settings/update', patch: { audio: { originalMode: 'mute' } } });
  await volume().toBe(0);
  await fc.ui.page.setViewportSize({ width: 320, height: 900 });
  await fc.ui.page.getByText('AUDIO / 声音', { exact: true }).scrollIntoViewIfNeeded();
  await expect(fc.ui.page.getByRole('button', { name: '全程静音', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(await fc.ui.page.evaluate(() => document.documentElement.scrollWidth <= 321)).toBe(true);
  await fc.ui.page.screenshot({
    path: test.info().outputPath('continuous-silence-320.png'),
    animations: 'disabled',
  });
  await fc.ui.ok({ kind: 'session/stop', tabId, sessionId });
  await volume().toBeCloseTo(0.6);
});

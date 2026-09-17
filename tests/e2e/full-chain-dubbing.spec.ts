/**
 * 全链路 E2E（P5 配音）：字幕轨道来源 + mock sub2api 翻译 + 真实系统语音（worker 中的 chrome.tts，Playwright Chromium on macOS）。
 *
 * 观察方式：在真实 worker 中给 chrome.tts.speak / stop 包一层只记录的透传（调用原实现、转发原 onEvent），
 * 记录朗读文本与 start/end/interrupted/cancelled 事件；原声 ducking 通过页面 video.volume 采样验证。
 * T31 的「目标语言没有声音」在本机无法真实出现（8 个目标语言都有 macOS 系统声音），
 * 因此该用例把 chrome.tts.getVoices 的结果过滤掉日语声音（平台 API 替身，属于 mock），其余链路真实。
 *
 * 会从扬声器朗读（音量 0.2）。需显式设置 TONGTING_E2E_TTS=1。
 * 前置：TONGTING_E2E=1 pnpm exec wxt build；ffmpeg 可用。
 */
import { expect, test, type Page, type Worker } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import type { CaptionLine, FixtureVideo } from './fixtures/full-chain/youtube';
import type { SettingsPatch } from '../../src/domain/settings';

test.describe.configure({ timeout: 240_000 });

const VIDEO_A = 'AAAAAAAAAAA';
const EVIDENCE_FILE = resolve(
  import.meta.dirname,
  '../../test-results/full-chain-dubbing-evidence.json',
);
const evidence: Record<string, unknown> = {};
const WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];
const LINES: CaptionLine[] = Array.from({ length: 30 }, (_, i) => ({
  startMs: 1_000 + i * 4_000,
  durationMs: 3_200,
  // 文本必须唯一：朗读文本按原文反查句子（曾因「Line one.」重复把第 21 句误归为第 1 句）。
  text: `Line ${i + 1} ${WORDS[i % 20]}.`,
}));
let videos: FixtureVideo[];
let fc: FullChain | undefined;

test.beforeAll(async () => {
  test.skip(!process.env.TONGTING_E2E_TTS, '配音用例会通过系统语音发声，需设置 TONGTING_E2E_TTS=1');
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成视频夹具');
  videos = [
    {
      videoId: VIDEO_A,
      title: 'Dubbing',
      lengthSeconds: 130,
      captions: LINES,
      media: await silentVideo(130),
    },
  ];
});

test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
  // 每个用例结束即合并写入证据（失败后 Playwright 会重启 worker 进程，模块级变量不保留）。
  await mkdir(dirname(EVIDENCE_FILE), { recursive: true });
  const prev = await readFile(EVIDENCE_FILE, 'utf8').then(
    (t) => JSON.parse(t) as Record<string, unknown>,
    () => ({}),
  );
  await writeFile(EVIDENCE_FILE, JSON.stringify({ ...prev, ...evidence }, null, 2));
});

interface TtsSpy {
  calls: Array<{
    at: number;
    text: string;
    lang?: string;
    voiceName?: string;
    rate?: number;
    volume?: number;
  }>;
  events: Array<{ at: number; idx: number; type: string }>;
  stops: number[];
  wrapped: boolean;
}

async function installTtsSpy(sw: Worker, hideLangPrefix?: string): Promise<void> {
  const wrapped = await sw.evaluate((hide) => {
    type Opts = {
      lang?: string;
      voiceName?: string;
      rate?: number;
      volume?: number;
      onEvent?: (e: { type: string }) => void;
    };
    type Voice = { lang?: string; voiceName?: string };
    const g = globalThis as unknown as {
      chrome: {
        tts: { speak(t: string, o: Opts): unknown; stop(): unknown; getVoices(): Promise<Voice[]> };
      };
      __e2eTts?: TtsSpy;
    };
    const tts = g.chrome.tts;
    const spy: TtsSpy = { calls: [], events: [], stops: [], wrapped: false };
    g.__e2eTts = spy;
    const speak = tts.speak.bind(tts);
    const stop = tts.stop.bind(tts);
    const getVoices = tts.getVoices.bind(tts);
    tts.speak = (text: string, options: Opts) => {
      const idx = spy.calls.length;
      spy.calls.push({
        at: Date.now(),
        text,
        lang: options?.lang,
        voiceName: options?.voiceName,
        rate: options?.rate,
        volume: options?.volume,
      });
      const onEvent = options?.onEvent;
      return speak(text, {
        ...options,
        onEvent: (e: { type: string }) => {
          spy.events.push({ at: Date.now(), idx, type: e.type });
          onEvent?.(e);
        },
      });
    };
    tts.stop = () => {
      spy.stops.push(Date.now());
      return stop();
    };
    if (hide) {
      tts.getVoices = () =>
        getVoices().then((list) =>
          list.filter((v) => !(v.lang ?? '').toLowerCase().startsWith(hide)),
        );
    }
    spy.wrapped = tts.speak !== speak;
    return spy.wrapped;
  }, hideLangPrefix ?? '');
  expect(wrapped, 'chrome.tts.speak 可被透传包装').toBe(true);
}

const spyState = (sw: Worker) =>
  sw.evaluate(() => (globalThis as unknown as { __e2eTts: TtsSpy }).__e2eTts);

async function setup(
  patch: SettingsPatch = {},
  hideLang?: string,
): Promise<{ f: FullChain; page: Page; tabId: number }> {
  const f = await setupFullChain({ videos });
  fc = f;
  await configureProvider(f, {
    outputMode: 'subtitle-voice',
    targetLanguage: 'zh-CN',
    pauseDubWithVideo: true,
    tts: { backend: 'system' },
    audio: { dubVolume: 0.2, duckOriginal: true, duckLevel: 0.3, rate: 1 },
    ...patch,
  });
  await installTtsSpy(f.ext.serviceWorker, hideLang);
  const { page, tabId } = await openWatch(f, VIDEO_A);
  return { f, page, tabId };
}

const lineAt = (mediaMs: number) =>
  LINES.findIndex((l) => l.startMs <= mediaMs && mediaMs < l.startMs + l.durationMs);
const lineOfText = (text: string, lang = 'zh-CN') => {
  const hits = LINES.flatMap((l, i) => (mockTranslation(lang, l.text) === text ? [i] : []));
  if (hits.length > 1) throw new Error(`朗读文本对应多句字幕，无法归因：${text}`);
  return hits[0] ?? -1;
};

/** 后台采样页面音量与播放位置。 */
function sampler(page: Page) {
  const samples: Array<{ at: number; mediaMs: number; volume: number; paused: boolean }> = [];
  let running = true;
  const done = (async () => {
    while (running) {
      const s = await video(page)
        .state()
        .catch(() => null);
      if (s)
        samples.push({
          at: Date.now(),
          mediaMs: s.currentTimeMs,
          volume: s.volume,
          paused: s.paused,
        });
      await sleep(100);
    }
  })();
  return {
    samples,
    async stop() {
      running = false;
      await done;
    },
    mediaAt(at: number) {
      const before = samples.filter((s) => s.at <= at).at(-1);
      return before ? before.mediaMs + (before.paused ? 0 : at - before.at) : null;
    },
  };
}

async function waitEvents(
  sw: Worker,
  predicate: (s: TtsSpy) => boolean,
  timeout: number,
  message: string,
) {
  await expect.poll(async () => predicate(await spyState(sw)), { timeout, message }).toBe(true);
  return spyState(sw);
}

test('P5 系统语音配音：朗读事件、与字幕时间同步、每句只读一次；T17 ducking 中用户调音量后不恢复旧音量', async () => {
  const { f, page, tabId } = await setup();
  const sw = f.ext.serviceWorker;
  type V = { voiceName: string; lang?: string; remote?: boolean };
  const voicesReply = await f.ui.ok<V[] | { voices: V[] }>({ kind: 'tts/voices' });
  const voices = Array.isArray(voicesReply) ? voicesReply : voicesReply.voices;
  const byLang = (p: string) =>
    voices.filter((v) => (v.lang ?? '').toLowerCase().startsWith(p)).length;
  evidence.voices = {
    total: voices.length,
    remote: voices.filter((v) => v.remote).length,
    perTargetLanguage: Object.fromEntries(
      ['zh-cn', 'zh-tw', 'en', 'ja', 'ko', 'es', 'fr', 'de'].map((l) => [l, byLang(l)]),
    ),
  };

  const smp = sampler(page);
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  await f.ui.waitSession(tabId, (s) => s.phase === 'running' && s.sourceMode === 'full-track', {
    timeout: 30_000,
  });
  // 至少 2 句完整朗读（start + end）。
  let spy = await waitEvents(
    sw,
    (s) => s.events.filter((e) => e.type === 'end').length >= 2,
    40_000,
    '两句朗读结束',
  );
  const speakingSeen = await f.ui
    .waitSession(tabId, (s) => s.resources.tts === 'speaking', { timeout: 15_000 })
    .then(
      () => true,
      () => false,
    );

  // T17：朗读中（已 duck 到 0.3）用户把音量改为 0.6。之后 ducking 结束（句间宽限结束或会话停止）不得恢复旧的 1.0。
  const startsBefore = spy.events.filter((e) => e.type === 'start').length;
  await waitEvents(
    sw,
    (s) => s.events.filter((e) => e.type === 'start').length > startsBefore,
    20_000,
    '下一句开始朗读',
  );
  await expect
    .poll(async () => (await video(page).state()).volume, {
      timeout: 3_000,
      message: '朗读中原声被 duck 到 0.3',
    })
    .toBeCloseTo(0.3, 2);
  const userChangeAt = Date.now();
  await page.evaluate(() => {
    document.querySelector<HTMLVideoElement>('#movie_player video')!.volume = 0.6;
  });
  await sleep(300);
  const volumeRightAfterUser = (await video(page).state()).volume;
  // 再朗读两句，观察之后的 duck 基准。
  const startsAfterUser = (await spyState(sw)).events.filter((e) => e.type === 'start').length;
  spy = await waitEvents(
    sw,
    (s) => s.events.filter((e) => e.type === 'start').length >= startsAfterUser + 2,
    20_000,
    '用户调音量后再读两句',
  );
  const sessionId = (await f.ui.session(tabId))!.identity.sessionId;
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId });
  await f.ui.waitSnapshot((x) => !x.sessions.some((y) => y.identity.tabId === tabId));
  await sleep(1_500);
  const volumeAfterStop = (await video(page).state()).volume;
  const afterUser = smp.samples.filter((x) => x.at > userChangeAt + 300);
  const volumesAfterUser = [...new Set(afterUser.map((x) => Math.round(x.volume * 1000) / 1000))];
  await smp.stop();
  const cues = spy.calls.map((c) => ({
    ...c,
    line: lineOfText(c.text),
    mediaAtCall: smp.mediaAt(c.at),
  }));
  const syncOffsets = cues
    .filter((c) => c.line >= 0 && c.mediaAtCall !== null)
    .map((c) => c.mediaAtCall! - LINES[c.line]!.startMs);
  evidence.p5 = {
    speakingSeen,
    calls: cues,
    events: spy.events,
    syncOffsetsMs: syncOffsets,
    t17: { volumeRightAfterUser, volumesAfterUser, volumeAfterStop },
    volumeTimeline: smp.samples
      .filter((s, i, a) => i === 0 || s.volume !== a[i - 1]!.volume)
      .map((s) => ({ mediaMs: s.mediaMs, volume: s.volume })),
  };
  console.log(
    '[P5]',
    JSON.stringify({
      calls: cues.map((c) => [c.line, c.voiceName, c.lang, c.mediaAtCall]),
      syncOffsets,
      t17: evidence.p5 && (evidence.p5 as { t17: unknown }).t17,
    }),
  );

  expect(cues.every((c) => c.line >= 0)).toBe(true);
  const lines = cues.map((c) => c.line);
  expect(new Set(lines).size).toBe(lines.length);
  expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  expect(spy.events.some((e) => e.type === 'start')).toBe(true);
  expect(spy.events.some((e) => e.type === 'end')).toBe(true);
  expect(syncOffsets.every((o) => o > -1_000 && o < 2_500)).toBe(true);
  expect(volumeRightAfterUser).toBeCloseTo(0.6, 2);
  // 之后只可能出现用户音量 0.6 或以其为基准的 duck 值 0.18，不得回到旧基准 1.0 / 0.3。
  expect(
    volumesAfterUser.every((v) => Math.abs(v - 0.6) < 0.005 || Math.abs(v - 0.18) < 0.005),
  ).toBe(true);
  expect(volumeAfterStop).toBeCloseTo(0.6, 2);
});

test('T15/T16 暂停、跳转、停止后不再朗读旧句，恢复后与当前位置同步', async () => {
  const { f, page, tabId } = await setup();
  const sw = f.ext.serviceWorker;
  const smp = sampler(page);
  expect(await video(page).play()).toBe(true);
  const s0 = await f.ui
    .ok<unknown>({ kind: 'session/start', tabId })
    .then(() => f.ui.waitSession(tabId, (s) => s.phase === 'running', { timeout: 30_000 }));
  const steps: Record<string, unknown> = {};

  // 视频暂停：朗读中立即停播，暂停期间不朗读。
  let spy = await waitEvents(
    sw,
    (s) => s.events.some((e) => e.type === 'start'),
    30_000,
    '开始朗读',
  );
  const pausedAt = Date.now();
  await video(page).pause();
  spy = await waitEvents(
    sw,
    (s) =>
      s.stops.some((t) => t >= pausedAt) ||
      s.events.some(
        (e) => e.at >= pausedAt && ['interrupted', 'cancelled', 'end'].includes(e.type),
      ),
    3_000,
    '暂停后停播',
  );
  const stopLatency = Math.min(
    ...spy.stops.filter((t) => t >= pausedAt).map((t) => t - pausedAt),
    Infinity,
  );
  const callsAtPause = spy.calls.length;
  await sleep(4_000);
  spy = await spyState(sw);
  steps.pause = {
    stopLatencyMs: stopLatency,
    newCallsWhilePaused: spy.calls.length - callsAtPause,
    isSpeaking: await sw.evaluate(() =>
      (
        globalThis as unknown as { chrome: { tts: { isSpeaking(): Promise<boolean> } } }
      ).chrome.tts.isSpeaking(),
    ),
  };
  expect(spy.calls.length).toBe(callsAtPause);

  // 恢复：只朗读当前位置（或之后）的句子，不连播旧积压。
  const resumeMedia = (await video(page).state()).currentTimeMs;
  const callsBeforeResume = spy.calls.length;
  expect(await video(page).play()).toBe(true);
  spy = await waitEvents(sw, (s) => s.calls.length > callsBeforeResume, 15_000, '恢复后朗读');
  const afterResume = spy.calls.slice(callsBeforeResume).map((c) => lineOfText(c.text));
  steps.resume = { resumeMedia, afterResumeLines: afterResume, currentLine: lineAt(resumeMedia) };
  expect(
    afterResume.every((i) => i >= 0 && LINES[i]!.startMs + LINES[i]!.durationMs > resumeMedia),
  ).toBe(true);

  // 跳转到远处：旧句不再朗读，之后只读新位置附近的句子。
  spy = await waitEvents(
    sw,
    (s) => s.events.some((e) => e.type === 'start' && e.idx >= callsBeforeResume),
    10_000,
    '恢复后的朗读已开始发声',
  );
  const seekTo = 80_000;
  const seekAt = Date.now();
  const callsBeforeSeek = spy.calls.length;
  await video(page).seek(seekTo / 1000);
  spy = await waitEvents(sw, (s) => s.calls.length > callsBeforeSeek, 20_000, '跳转后朗读');
  const afterSeek = spy.calls.slice(callsBeforeSeek).map((c) => ({
    line: lineOfText(c.text),
    dtMs: c.at - seekAt,
    mediaAtCall: smp.mediaAt(c.at),
  }));
  steps.seek = {
    seekTo,
    afterSeek,
    stopsAfterSeek: spy.stops.filter((t) => t >= seekAt).length,
    eventsAroundSeek: spy.events
      .filter((e) => e.at > seekAt - 1_500)
      .map((e) => ({ ...e, dt: e.at - seekAt, line: lineOfText(spy.calls[e.idx]!.text) })),
  };
  evidence.t15t16 = steps;
  expect(
    afterSeek.every(
      (c) => c.line >= 0 && LINES[c.line]!.startMs + LINES[c.line]!.durationMs > seekTo,
    ),
  ).toBe(true);

  // 停止：立即停播，之后不再朗读。
  spy = await waitEvents(
    sw,
    (s) => s.events.some((e) => e.at > seekAt && e.type === 'start'),
    15_000,
    '跳转后开始朗读',
  );
  const stopAt = Date.now();
  const callsBeforeStop = spy.calls.length;
  await f.ui.ok({ kind: 'session/stop', tabId, sessionId: s0.identity.sessionId });
  spy = await waitEvents(
    sw,
    (s) =>
      s.stops.some((t) => t >= stopAt) ||
      s.events.some((e) => e.at >= stopAt && ['interrupted', 'cancelled'].includes(e.type)),
    3_000,
    '停止后停播',
  );
  await sleep(5_000);
  spy = await spyState(sw);
  const volumeAfterStop = (await video(page).state()).volume;
  steps.stop = {
    stopLatencyMs: Math.min(
      ...spy.stops.filter((t) => t >= stopAt).map((t) => t - stopAt),
      Infinity,
    ),
    callsAfterStop: spy.calls.length - callsBeforeStop,
    volumeAfterStop,
    isSpeaking: await sw.evaluate(() =>
      (
        globalThis as unknown as { chrome: { tts: { isSpeaking(): Promise<boolean> } } }
      ).chrome.tts.isSpeaking(),
    ),
  };
  await smp.stop();
  evidence.t15t16 = steps;
  console.log('[T15/T16]', JSON.stringify(steps));
  expect(spy.calls.length).toBe(callsBeforeStop);
  expect(volumeAfterStop).toBeCloseTo(1, 2);
  expect((steps.stop as { isSpeaking: boolean }).isSpeaking).toBe(false);
});

test('T31 目标语言没有可用声音（getVoices 过滤掉日语声音的替身）：仅字幕降级并说明原因', async () => {
  const { f, page, tabId } = await setup({ targetLanguage: 'ja' }, 'ja');
  const sw = f.ext.serviceWorker;
  expect(await video(page).play()).toBe(true);
  await f.ui.ok({ kind: 'session/start', tabId });
  const s = await f.ui.waitSession(
    tabId,
    (x) =>
      x.phase === 'running' &&
      (x.resources.tts === 'unavailable' || x.notice?.code === 'tts-unavailable'),
    {
      timeout: 30_000,
      message: '配音不可用降级',
    },
  );
  await sleep(1_000);
  const line = LINES[lineAt((await video(page).state()).currentTimeMs + 2_000)] ?? LINES[1]!;
  const ov = await waitOverlay(
    page,
    (o) => !!o.main?.startsWith('译[ja] '),
    20_000,
    '日语译文字幕仍显示',
  );
  await sleep(4_000);
  const spy = await spyState(sw);
  const snap = (await f.ui.session(tabId))!;
  evidence.t31 = {
    notice: snap.notice,
    tts: snap.resources.tts,
    calls: spy.calls.length,
    overlay: ov.main,
    badge: ov.badge,
    line: line.text,
    translation: snap.translation,
  };
  console.log('[T31]', JSON.stringify(evidence.t31));
  expect(s.phase).toBe('running');
  expect(snap.notice?.code).toBe('tts-unavailable');
  expect(snap.notice?.message).toMatch(/日/);
  expect(snap.resources.tts).toBe('unavailable');
  expect(spy.calls).toHaveLength(0);
  expect(snap.translation.done).toBeGreaterThan(0);
});

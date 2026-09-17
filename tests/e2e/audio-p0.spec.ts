/**
 * P0 音频能力实验（真实 Chromium，Playwright 自带版本）。结果记录在 docs/validation/p0-audio.md。
 *
 * 运行：TONGTING_P0_AUDIO=1 pnpm exec playwright test tests/e2e/audio-p0.spec.ts
 * 依赖：macOS `say`、/opt/homebrew/bin/ffmpeg 与 ffprobe（缺失时跳过）。
 * 会短暂发声（系统语音朗读一句、测试页低音量播放），因此默认跳过，需显式设置 TONGTING_P0_AUDIO=1。
 *
 * 说明：
 * - 使用独立构建的实验扩展：产品的 offscreen 入口（同一 worklet/bootstrap）+ 调用产品 createOffscreenClient 的实验 worker。
 * - 页面、识别服务、语音合成均为 127.0.0.1 上的本地替身；不访问 YouTube，不调用任何真实/付费服务。
 * - tabCapture 的「用户手势」在自动化中用 --allowlisted-extension-id 替代，这不是对真实手势链路的验收。
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type {
  OffscreenEvent,
  OffscreenRequest,
  OffscreenStatus,
} from '../../src/messaging/offscreen-protocol';
import type { TtsEngineEvent, TtsVoice } from '../../src/providers/tts/types';
import { decodeWavPcm16 } from '../../src/audio/wav';
import { buildAudioHarness } from './fixtures/audio/harness/build';
import { ASR_TOKEN, startMockServers, TTS_KEY, type MockServers } from './fixtures/audio/servers';
import {
  ffprobeStream,
  generateSpeech,
  toolsAvailable,
  type SpeechFixture,
} from './fixtures/audio/speech';

test.describe.configure({ mode: 'serial', timeout: 240_000 });

const HARNESS_WORK_DIR = join(tmpdir(), 'tongting-audio-p0-harness');
const HEADLESS = process.env.P0_HEADFUL ? false : true;

interface P0Api {
  events: Array<{ at: number; event: OffscreenEvent }>;
  hellos: OffscreenStatus[];
  ttsEvents: Array<{ at: number; event: TtsEngineEvent }>;
  ensure(): Promise<OffscreenStatus>;
  queryStatus(): Promise<OffscreenStatus | null>;
  request(r: OffscreenRequest, timeoutMs?: number): Promise<unknown>;
  closeIfIdle(): Promise<boolean>;
  contexts(): Promise<number>;
  rawCreateTwice(): Promise<string[]>;
  activeTabId(): Promise<number | undefined>;
  getMediaStreamId(
    tabId: number,
  ): Promise<{ ok: true; streamId: string } | { ok: false; error: string }>;
  voices(): Promise<TtsVoice[]>;
  speak(text: string, lang: string, voiceName?: string): void;
  stopSpeak(): void;
}

type P0Global = typeof globalThis & { __p0: P0Api };

/** 段内第一个 20 ms 帧 RMS 高于 -40 dBFS 的位置（ms）。 */
function speechOnsetMs(file: string): number {
  const buf = readFileSync(file);
  const wav = decodeWavPcm16(new Uint8Array(buf).buffer);
  const frame = Math.round(wav.sampleRate * 0.02);
  for (let i = 0; i + frame <= wav.samples.length; i += frame) {
    let sum = 0;
    for (let j = i; j < i + frame; j++) sum += wav.samples[j]! * wav.samples[j]!;
    if (20 * Math.log10(Math.sqrt(sum / frame) || 1e-9) > -40) return (i / wav.sampleRate) * 1000;
  }
  return -1;
}

let extensionDir = '';
let speech: SpeechFixture;
let workDir = '';
const evidence: Record<string, unknown> = {};

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function launch(
  extraArgs: string[] = [],
  options: { unmute?: boolean } = {},
): Promise<{ context: BrowserContext; sw: Worker; extensionId: string; userDataDir: string }> {
  const userDataDir = await mkdtemp(join(tmpdir(), 'tongting-p0-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: HEADLESS,
    // Playwright 在 headless 下默认加 --mute-audio，实测会让 tabCapture 得到全零 PCM（见 p0-audio.md）。
    ignoreDefaultArgs: options.unmute ? ['--mute-audio'] : [],
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, sw, extensionId: new URL(sw.url()).host, userDataDir };
}

function p0<T>(
  sw: Worker,
  fn: (api: P0Api, arg: unknown) => T | Promise<T>,
  arg?: unknown,
): Promise<T> {
  return sw.evaluate(
    ([source, a]) => {
      const f = new Function('api', 'arg', `return (${source})(api, arg);`) as (
        api: unknown,
        arg: unknown,
      ) => unknown;
      return f((globalThis as P0Global).__p0, a);
    },
    [fn.toString(), arg] as const,
  ) as Promise<T>;
}

async function openPlayingPage(context: BrowserContext, url: string, volume = 1): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  const r = await page.evaluate(
    (v) => (window as unknown as { __play(v: number): Promise<string> }).__play(v),
    volume,
  );
  expect(r).toBe('playing');
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __media(): { mediaTimeMs: number } }).__media().mediaTimeMs,
      ),
    )
    .toBeGreaterThan(200);
  return page;
}

async function offscreenViaCdp(port: number): Promise<unknown> {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    url: string;
    type: string;
    webSocketDebuggerUrl?: string;
  }>;
  const target = list.find((t) => t.url.endsWith('/offscreen.html') && t.webSocketDebuggerUrl);
  if (!target)
    return {
      error: 'offscreen target not found',
      targets: list.map((t) => ({ type: t.type, url: t.url })),
    };
  const ws = new WebSocket(target.webSocketDebuggerUrl!);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  const result = await new Promise<unknown>((resolve) => {
    ws.onmessage = (m) => {
      const data = JSON.parse(String(m.data)) as {
        id?: number;
        result?: { result?: { value?: string } };
      };
      if (data.id === 1) resolve(JSON.parse(data.result?.result?.value ?? 'null'));
    };
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: {
          expression: `JSON.stringify({ targetType: ${JSON.stringify(target.type)}, status: globalThis.__tongtingOffscreen?.status(), diagnostics: globalThis.__tongtingOffscreen?.diagnostics(), sampleRateProbe: typeof AudioContext })`,
          returnByValue: true,
        },
      }),
    );
  });
  ws.close();
  return result;
}

test.beforeAll(async () => {
  test.skip(
    !process.env.TONGTING_P0_AUDIO,
    '音频 P0 实验会发声，需设置 TONGTING_P0_AUDIO=1 显式运行',
  );
  test.skip(!(await toolsAvailable()), '需要 macOS say 与 ffmpeg/ffprobe');
  workDir = await mkdtemp(join(tmpdir(), 'tongting-p0-run-'));
  extensionDir = await buildAudioHarness(HARNESS_WORK_DIR);
  speech = await generateSpeech(workDir);
  evidence.speech = { durationMs: speech.durationMs, gaps: speech.gaps };
});

const EVIDENCE_FILE =
  process.env.P0_EVIDENCE_FILE ??
  resolve(import.meta.dirname, '../../test-results/audio-p0-evidence.json');

async function saveEvidence() {
  await mkdir(dirname(EVIDENCE_FILE), { recursive: true });
  await writeFile(EVIDENCE_FILE, JSON.stringify(evidence, null, 2));
}

test.afterAll(async () => {
  if (Object.keys(evidence).length === 0) return;
  await saveEvidence();
  console.log(`[p0] evidence written to ${EVIDENCE_FILE}`);
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test('P0-a/b/e: offscreen 创建去重与关闭、无手势 tabCapture 报错、chrome.tts 声音与事件', async () => {
  const servers = await startMockServers({ speechWav: speech.path, outDir: workDir });
  const { context, sw, extensionId, userDataDir } = await launch();
  try {
    evidence.extensionId = extensionId;
    const uaPage = await context.newPage();
    evidence.userAgent = await uaPage.evaluate(() => navigator.userAgent);
    evidence.chromiumVersion =
      context.browser()?.version() ?? /Chrome\/([\d.]+)/.exec(String(evidence.userAgent))?.[1];
    evidence.headless = HEADLESS;
    await uaPage.close();

    // ---- (a) offscreen 文档 ----
    const a: Record<string, unknown> = {};
    a.contextsBefore = await p0(sw, (api) => api.contexts());
    const statuses = await p0(sw, (api) => Promise.all([api.ensure(), api.ensure(), api.ensure()]));
    a.concurrentEnsureInstanceIds = statuses.map((s) => s.offscreenInstanceId);
    a.contextsAfterEnsure = await p0(sw, (api) => api.contexts());
    a.hellosAfterEnsure = await p0(sw, (api) => api.hellos.length);
    a.rawCreateWhileExists = await p0(sw, (api) => api.rawCreateTwice());
    a.closeIfIdle = await p0(sw, (api) => api.closeIfIdle());
    a.contextsAfterClose = await p0(sw, (api) => api.contexts());
    const again = await p0(sw, (api) => api.ensure());
    a.recreatedInstanceId = again.offscreenInstanceId;
    a.closeIfIdleAgain = await p0(sw, (api) => api.closeIfIdle());
    evidence.a = a;
    expect(a.contextsBefore).toBe(0);
    expect(new Set(a.concurrentEnsureInstanceIds as string[]).size).toBe(1);
    expect(a.contextsAfterEnsure).toBe(1);
    expect(a.closeIfIdle).toBe(true);
    expect(a.contextsAfterClose).toBe(0);
    expect(a.recreatedInstanceId).not.toBe((a.concurrentEnsureInstanceIds as string[])[0]);

    // ---- (b) 无用户手势 / 无 allowlist 时 getMediaStreamId ----
    const page = await openPlayingPage(context, servers.pageUrl, 0.2);
    const tabId = await p0(sw, (api) => api.activeTabId());
    const noGesture = await p0(sw, (api, id) => api.getMediaStreamId(id as number), tabId);
    evidence.bWithoutGesture = { tabId, result: noGesture };
    expect(noGesture.ok).toBe(false);
    await page.evaluate(() => (document.getElementById('a') as HTMLAudioElement).pause());

    // ---- (e) chrome.tts ----
    const voices = await p0(sw, (api) => api.voices());
    const zh = voices.filter((v) => /^zh|^cmn|^yue/i.test(v.lang ?? ''));
    const e: Record<string, unknown> = {
      totalVoices: voices.length,
      zhVoices: zh,
      remoteVoices: voices.filter((v) => v.remote).length,
      sampleOtherVoices: voices.slice(0, 8),
    };
    const zhCn =
      zh.find((v) => /tingting/i.test(v.voiceName)) ??
      zh.find((v) => /zh[-_]CN/i.test(v.lang ?? ''));
    if (zhCn) {
      const t0 = Date.now();
      await p0(
        sw,
        (api, v) => api.speak('同听配音测试，一二三。', 'zh-CN', v as string),
        zhCn.voiceName,
      );
      await expect
        .poll(() => p0(sw, (api) => api.ttsEvents.map((x) => x.event.type)), { timeout: 15_000 })
        .toContain('end');
      const evs = await p0(sw, (api) => api.ttsEvents.splice(0));
      e.speak = {
        voice: zhCn,
        events: evs.map((x) => ({ type: x.event.type, afterMs: x.at - t0 })),
      };
      // T15 实机：speak 后立即 stop，迟到事件应被令牌屏蔽
      await p0(
        sw,
        (api, v) => {
          api.speak('这句话会被立即停止。', 'zh-CN', v as string);
          api.stopSpeak();
        },
        zhCn.voiceName,
      );
      await page.waitForTimeout(3_000);
      e.speakThenStopEvents = await p0(sw, (api) => api.ttsEvents.map((x) => x.event.type));
    }
    evidence.e = e;
    await page.close();
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await servers.close();
  }
  test.info().annotations.push({ type: 'extensionId', description: String(evidence.extensionId) });
});

test('P0-b/c/d/f: allowlist 替代手势 → offscreen 捕获 → 16k WAV 分段 → 本地识别替身 → 时间映射 → 停止释放', async () => {
  const servers: MockServers = await startMockServers({ speechWav: speech.path, outDir: workDir });
  const cdpPort = await freePort();
  // 扩展 ID 由解包目录路径决定：构建目录固定，因此与上一个用例相同。
  const first = await launch();
  const extensionId = first.extensionId;
  await first.context.close();
  await rm(first.userDataDir, { recursive: true, force: true });
  const { context, sw, userDataDir } = await launch(
    [`--allowlisted-extension-id=${extensionId}`, `--remote-debugging-port=${cdpPort}`],
    {
      unmute: true,
    },
  );
  const stopLoops: Array<() => void> = [];
  try {
    const page = await openPlayingPage(context, servers.pageUrl, 0.6);
    const tabId = (await p0(sw, (api) => api.activeTabId()))!;
    const sid = await p0(sw, (api, id) => api.getMediaStreamId(id as number), tabId);
    evidence.bAllowlisted = { ok: sid.ok, error: sid.ok ? undefined : sid.error };
    expect(sid.ok).toBe(true);
    if (!sid.ok) return;

    const media = () =>
      page.evaluate(() =>
        (
          window as unknown as {
            __media(): {
              epochMs: number;
              mediaTimeMs: number;
              paused: boolean;
              ended: boolean;
              rate: number;
            };
          }
        ).__media(),
      );
    // 本实验未跳转/暂停，断点编号保持不变。
    const discontinuityId = 1;
    const anchorOf = (m: Awaited<ReturnType<typeof media>>) => ({
      epochMs: m.epochMs,
      mediaTimeMs: m.mediaTimeMs,
      playbackRate: m.rate,
      paused: m.paused || m.ended,
      seeking: false,
      buffering: false,
      ad: false,
      discontinuityId,
    });
    const leaseId = 'lease-p0-main-0001';
    const owner = { sessionId: 'session-p0-0001', tabId, epoch: 0 };
    const startedAt = Date.now();
    const startReply = await p0(sw, (api, r) => api.request(r as OffscreenRequest, 20_000), {
      kind: 'capture/start',
      leaseId,
      owner,
      leaseTtlMs: 30_000,
      streamId: sid.streamId,
      asr: { backend: 'local', baseUrl: servers.asrBaseUrl, token: ASR_TOKEN },
      language: 'en',
      segmentMs: 3_000,
      // 自动化中不向扬声器回放原声（识别分支在原声增益之前，不受影响）。
      originalVolume: 0,
      anchor: anchorOf(await media()),
    } satisfies OffscreenRequest);
    const c: Record<string, unknown> = { startReply, startLatencyMs: Date.now() - startedAt };
    c.originalGainReply = await p0(sw, (api, r) => api.request(r as OffscreenRequest), {
      kind: 'audio/original-gain',
      leaseId,
      gain: 0,
      rampMs: 200,
    });

    // 模拟协调器：每 500 ms 转发一次播放器锚点，每 10 s 续租。
    let stopAnchors = false;
    stopLoops.push(() => (stopAnchors = true));
    const anchorLoop = (async () => {
      let lastRenew = Date.now();
      while (!stopAnchors) {
        const m = await media().catch(() => null);
        if (!m) break;
        await p0(sw, (api, r) => api.request(r as OffscreenRequest), {
          kind: 'timeline/anchor',
          leaseId,
          anchor: anchorOf(m),
        }).catch(() => undefined);
        if (Date.now() - lastRenew > 10_000) {
          await p0(sw, (api, r) => api.request(r as OffscreenRequest), {
            kind: 'lease/renew',
            leaseId,
            ttlMs: 30_000,
          });
          lastRenew = Date.now();
        }
        await page.waitForTimeout(500);
      }
    })();

    const waitStart = Date.now();
    while (servers.segments.length < 4 && Date.now() - waitStart < 45_000)
      await page.waitForTimeout(1_000);
    await page.waitForTimeout(1_500);
    c.waitedMs = Date.now() - waitStart;
    c.segmentsReceived = servers.segments.length;
    c.mediaNow = await media();
    c.statusWhileRunning = await p0(sw, (api) => api.queryStatus());
    c.offscreenCdp = await offscreenViaCdp(cdpPort);
    const events = await p0(sw, (api) => api.events.map((x) => ({ at: x.at, event: x.event })));
    const results = events
      .filter((x) => x.event.kind === 'asr/result')
      .map((x) => x.event as Extract<OffscreenEvent, { kind: 'asr/result' }>);
    const asrStatuses = events.filter((x) => x.event.kind === 'asr/status').map((x) => x.event);
    c.startedEvent = events.find((x) => x.event.kind === 'capture/started')?.event;
    c.asrStatusLast = asrStatuses.at(-1);
    c.asrErrors = events.filter((x) => x.event.kind === 'asr/error').map((x) => x.event);
    c.eventKinds = events.map((x) => x.event.kind);
    evidence.c = c;
    await saveEvidence();

    // ---- (d) WAV 独立可解码 ----
    const d = [];
    for (const seg of servers.segments) d.push({ ...seg, ffprobe: await ffprobeStream(seg.file) });
    evidence.d = d;

    // 时间映射核对：静音切分的分段起点应落在已知静音区间内
    const mapping = results.map((r) => {
      const gap = speech.gaps.find(
        (g) => r.startMs >= g.startMs - 400 && r.startMs <= g.endMs + 400,
      );
      const dist = gap
        ? r.startMs < gap.startMs
          ? r.startMs - gap.startMs
          : r.startMs > gap.endMs
            ? r.startMs - gap.endMs
            : 0
        : null;
      return {
        segmentId: r.segmentId,
        startMs: r.startMs,
        endMs: r.endMs,
        endEstimated: r.endEstimated,
        nearestGap: gap,
        outsideGapByMs: dist,
      };
    });
    evidence.mapping = mapping;
    // 更精确的映射误差：分段在静音中切开时，段内第一个有声帧对应该静音区间的结束（下一句起点）。
    // 预测起点 = 映射后的 startMs + 段内起音偏移；实际起点 = gap.endMs。识别队列串行，结果顺序与上传顺序一致。
    evidence.mappingError = results.map((r, i) => {
      const seg = servers.segments[i];
      const gap = speech.gaps.find((g) => r.startMs >= g.startMs - 400 && r.startMs <= g.endMs);
      if (!seg || !gap)
        return {
          segmentId: r.segmentId,
          skipped: seg ? 'segment does not start in a known gap' : 'no upload',
        };
      const onsetMs = speechOnsetMs(seg.file);
      return {
        segmentId: r.segmentId,
        mappedStartMs: r.startMs,
        onsetInWavMs: onsetMs,
        predictedOnsetMediaMs: r.startMs + onsetMs,
        actualOnsetMediaMs: gap.endMs,
        errorMs: r.startMs + onsetMs - gap.endMs,
      };
    });
    evidence.requestsSeen = servers.requests.slice(0, 5);

    expect((c.statusWhileRunning as OffscreenStatus).resources).toMatchObject({
      capture: 'active',
      activeTracks: 1,
    });
    expect((c.statusWhileRunning as OffscreenStatus).audioContextState).toBe('running');
    for (const seg of d) {
      expect(seg.ffprobe).toMatchObject({ codec: 'pcm_s16le', sampleRate: 16000, channels: 1 });
      expect(seg.rmsDbfs).toBeGreaterThan(-45);
    }
    expect(results.length).toBeGreaterThanOrEqual(2);

    // ---- (f) 停止与释放 ----
    stopAnchors = true;
    await anchorLoop;
    const inFlightAtStop = servers.inFlight();
    const stopReply = await p0(sw, (api, r) => api.request(r as OffscreenRequest, 10_000), {
      kind: 'capture/stop',
      leaseId,
      reason: 'p0',
    });
    const segmentsAtStop = servers.segments.length;
    const statusAfterStop = await p0(sw, (api) => api.queryStatus());
    const cdpAfterStop = await offscreenViaCdp(cdpPort);
    await page.waitForTimeout(6_000);
    const f = {
      inFlightAtStop,
      stopReply,
      statusAfterStop,
      cdpAfterStop,
      segmentsAtStop,
      segmentsSixSecondsLater: servers.segments.length,
      inFlightSixSecondsLater: servers.inFlight(),
      endedEvent: (await p0(sw, (api) => api.events.map((x) => x.event))).find(
        (ev) => ev.kind === 'capture/ended',
      ),
      pageAfterStop: await media(),
    };
    await page.evaluate(() => (document.getElementById('a') as HTMLAudioElement).pause());
    evidence.f = f;
    expect(stopReply).toMatchObject({ stopped: true, activeTracks: 0 });
    // activeTracks 是汇总数字，不能单独作为释放证据：同时经 CDP 读取 offscreen 中保留的真实 track.readyState。
    const lastEnded = (
      cdpAfterStop as {
        diagnostics?: { lastEnded?: { capture?: { trackReadyStates?: string[] } } };
      }
    ).diagnostics?.lastEnded;
    expect(lastEnded?.capture?.trackReadyStates?.length ?? 0).toBeGreaterThan(0);
    expect(lastEnded?.capture?.trackReadyStates?.every((st) => st === 'ended')).toBe(true);
    expect(statusAfterStop).toMatchObject({
      lease: null,
      resources: { capture: 'none', activeTracks: 0, pendingRequests: 0 },
    });
    expect(f.segmentsSixSecondsLater).toBe(segmentsAtStop);
    expect(f.inFlightSixSecondsLater).toBe(0);

    // ---- 追加：租约不续期时自行停止（T21 实机） ----
    const sid2 = await p0(sw, (api, id) => api.getMediaStreamId(id as number), tabId);
    if (sid2.ok) {
      const t0 = Date.now();
      await p0(sw, (api, r) => api.request(r as OffscreenRequest, 20_000), {
        kind: 'capture/start',
        leaseId: 'lease-p0-expire-0001',
        owner: { ...owner, epoch: 1 },
        leaseTtlMs: 5_000,
        streamId: sid2.streamId,
        asr: { backend: 'local', baseUrl: servers.asrBaseUrl, token: ASR_TOKEN },
        language: 'en',
        segmentMs: 3_000,
        originalVolume: 1,
        anchor: anchorOf(await media()),
      } satisfies OffscreenRequest);
      await expect
        .poll(
          () =>
            p0(sw, (api) =>
              api.events.filter((x) => x.event.kind === 'capture/ended').map((x) => x.event),
            ),
          { timeout: 15_000 },
        )
        .toEqual(
          expect.arrayContaining([
            expect.objectContaining({ leaseId: 'lease-p0-expire-0001', reason: 'lease-expired' }),
          ]),
        );
      evidence.leaseExpiry = {
        endedAfterMs: Date.now() - t0,
        status: await p0(sw, (api) => api.queryStatus()),
        cdp: await offscreenViaCdp(cdpPort),
      };
    } else {
      evidence.leaseExpiry = { skipped: sid2.error };
    }

    // ---- 追加：云端配音播放路径（本地替身，经 offscreen 合成→解码→播放） ----
    const ttsOwner = { ...owner, epoch: 2 };
    const ttsBase = {
      kind: 'tts/play',
      owner: ttsOwner,
      baseUrl: servers.ttsBaseUrl,
      apiKey: TTS_KEY,
      model: 'mock-tts',
      voice: 'mock',
      text: '你好',
      speed: 1,
      volume: 0.2,
    } as const;
    await p0(sw, (api, r) => api.request(r as OffscreenRequest), {
      ...ttsBase,
      utteranceId: 'p0-tts-1',
    });
    await expect
      .poll(
        () =>
          p0(sw, (api) =>
            api.events
              .filter((x) => x.event.kind === 'tts/event')
              .map(
                (x) =>
                  `${(x.event as { utteranceId: string }).utteranceId}:${(x.event as { event: string }).event}`,
              ),
          ),
        { timeout: 15_000 },
      )
      .toContain('p0-tts-1:end');
    // tts/play 的回复在合成音频取回并开始播放后才返回（替身延迟 500 ms），因此不能等回复后再 stop：
    // 在同一 worker 调用中发出 play 后立即 stop，验证「合成结果迟到于 stop」时不发声（T15）。
    const playThenStop = await p0(
      sw,
      async (api, r) => {
        const play = api.request(r as OffscreenRequest).then(
          (v) => ({ ok: true, v }),
          (e: Error) => ({ ok: false, e: e.message }),
        );
        const stopAt = Date.now();
        const stop = await api.request({ kind: 'tts/stop', utteranceId: 'p0-tts-2' });
        return { stopAt, stop, play: await play };
      },
      { ...ttsBase, utteranceId: 'p0-tts-2' },
    );
    evidence.cloudTtsPlayThenStop = playThenStop;
    await page.waitForTimeout(2_000);
    const ttsEvents = await p0(sw, (api) =>
      api.events
        .filter((x) => x.event.kind === 'tts/event')
        .map((x) => ({ at: x.at, event: x.event })),
    );
    evidence.cloudTts = ttsEvents;
    expect(
      ttsEvents.map(
        (x) =>
          `${(x.event as { utteranceId: string }).utteranceId}:${(x.event as { event: string }).event}`,
      ),
    ).toEqual(['p0-tts-1:start', 'p0-tts-1:end', 'p0-tts-2:interrupted']);

    evidence.closeIfIdleAtEnd = await p0(sw, (api) => api.closeIfIdle());
    evidence.contextsAtEnd = await p0(sw, (api) => api.contexts());
    await page.close();
  } finally {
    stopLoops.forEach((f) => f());
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
    await servers.close();
  }
});

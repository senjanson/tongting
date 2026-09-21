/**
 * Opt-in paid integration: synthetic local video + REAL sub2api + local Whisper + system TTS.
 * This file does not test the real YouTube site. Its youtube.com page/media are fixture routes.
 * Run only with TONGTING_LIVE_SUB2API=1, SUB2API_BASE_URL, SUB2API_API_KEY_FILE and optionally
 * SUB2API_MODELS (first comma/whitespace-separated model; default gpt-5.6-luna).
 *
 * Uses a private copy of the production build and a disposable browser profile. Only that copy
 * receives the service/loopback host permissions. No connection probes or cloud audio calls.
 * tabCapture's invocation gesture is substituted by Chromium's extension allowlist. Audio is
 * audible. Traces, screenshots, videos, request bodies and authorization headers are never saved.
 * The input key file belongs to the caller; cleanup deletes only this test's profile/key storage.
 */
import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Cue } from '../../src/domain/cue';
import type { SettingsPatch } from '../../src/domain/settings';
import type { UiCommand } from '../../src/messaging/ui-protocol';
import {
  ASR_BASE_URL,
  localAsrAvailable,
  portOpen,
  startLocalAsr,
  type LocalAsr,
} from './fixtures/full-chain/asr-local';
import {
  ffmpegAvailable,
  sayAvailable,
  silentVideo,
  speechVideo,
} from './fixtures/full-chain/media';
import {
  routeFullChainYoutube,
  type CaptionLine,
  type FixtureVideo,
} from './fixtures/full-chain/youtube';
import { cdpEvaluator, freePort, isOffscreen } from './helpers/cdp';
import { EXTENSION_DIR, unpackedExtensionId } from './helpers/extension';
import { sleep, video, waitOverlay } from './helpers/full-chain';
import { UiDriver } from './helpers/ui-driver';

test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ timeout: 240_000, retries: 0 });
test.skip(process.env.TONGTING_LIVE_SUB2API !== '1', 'Requires explicit paid-service/audio opt-in');

const EVIDENCE_FILE = resolve(import.meta.dirname, '../../test-results/live-sub2api-evidence.json');
const HAN = /\p{Script=Han}/u;
const CAPTION_ID = 'LLLLLLLLLLL';
const ASR_ID = 'SSSSSSSSSSS';
const LINES: CaptionLine[] = [
  {
    startMs: 1_000,
    durationMs: 12_000,
    text: 'The meeting starts at nine, and we do not need to buy more apples.',
  },
  {
    startMs: 16_000,
    durationMs: 12_000,
    text: 'Forty two people joined the meeting, so please keep the original timestamps.',
  },
];

interface LiveConfig {
  baseUrl: string;
  origin: string;
  model: string;
  keyFile: string;
}
interface Observations {
  requests: Array<{ at: number; status?: number; elapsedMs?: number; failed?: boolean }>;
  budgetExceeded: number;
  calls: Array<{ at: number; text: string; lang?: string }>;
  events: Array<{ at: number; index: number; type: string }>;
  stops: number[];
}
interface SafeOffscreen {
  missing?: boolean;
  activeTracks?: number;
  pendingRequests?: number;
  trackReadyStates?: string[];
  segmentsQueued?: number;
  resultsEmitted?: number;
  lastEndedTracks?: string[];
}

function config(): LiveConfig {
  const raw = process.env.SUB2API_BASE_URL;
  const keyFile = process.env.SUB2API_API_KEY_FILE;
  if (!raw || !keyFile) throw new Error('Set SUB2API_BASE_URL and SUB2API_API_KEY_FILE');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('SUB2API_BASE_URL must be an HTTP(S) URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Service URL must not contain credentials, query parameters or a fragment');
  return {
    baseUrl: url.href.replace(/\/$/, ''),
    origin: url.origin,
    keyFile,
    model: process.env.SUB2API_MODELS?.trim().split(/[\s,]+/)[0] || 'gpt-5.6-luna',
  };
}

/** Deliberately do not attach provider errors or snapshots: they may contain service-supplied text. */
async function command(ui: UiDriver, value: UiCommand): Promise<void> {
  const result = await ui.command(value, 60_000);
  if (!result.ok) throw new Error(`Live test command failed: ${value.kind}`);
}

class LiveRun {
  rootDir?: string;
  context?: BrowserContext;
  worker!: Worker;
  ui!: UiDriver;
  page!: Page;
  tabId = -1;
  extensionId = '';
  cdpPort = 0;
  asr?: LocalAsr;
  readonly evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    youtubeSource: 'Local synthetic fixture; real YouTube networking/player not exercised',
    translation: 'Real sub2api Responses API',
    speech: 'Real local Whisper small and/or real system TTS; no cloud audio service',
    tabCaptureGesture: 'Chromium --allowlisted-extension-id automation substitute',
    build: 'Isolated temporary copy of .output/chrome-mv3 (production build)',
    captureArtifacts: { trace: false, screenshot: false, video: false },
  };

  async setup(fixture: FixtureVideo, asr: boolean, requestBudget: number): Promise<void> {
    const cfg = config();
    this.evidence.model = cfg.model;
    this.evidence.requestBudget = requestBudget;
    this.rootDir = await mkdtemp(join(tmpdir(), 'tongting-live-sub2api-'));
    const extensionDir = join(this.rootDir, 'extension');
    await cp(EXTENSION_DIR, extensionDir, { recursive: true });
    const manifestFile = join(extensionDir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as {
      host_permissions?: string[];
    };
    const service = new URL(cfg.baseUrl);
    manifest.host_permissions = [
      ...new Set([
        ...(manifest.host_permissions ?? []),
        `${service.protocol}//${service.hostname}/*`,
        'http://127.0.0.1/*',
      ]),
    ];
    await writeFile(manifestFile, JSON.stringify(manifest));
    this.extensionId = unpackedExtensionId(extensionDir);
    if (asr) {
      const unavailable = await localAsrAvailable();
      if (unavailable) throw new Error(unavailable);
      this.asr = await startLocalAsr({ extensionId: this.extensionId, logName: 'live-sub2api' });
    }
    this.cdpPort = await freePort();
    this.context = await chromium.launchPersistentContext(join(this.rootDir, 'profile'), {
      channel: 'chromium',
      headless: true,
      ignoreDefaultArgs: ['--mute-audio'],
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        `--allowlisted-extension-id=${this.extensionId}`,
        `--remote-debugging-port=${this.cdpPort}`,
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    this.worker =
      this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent('serviceworker'));
    expect(new URL(this.worker.url()).host).toBe(this.extensionId);
    await routeFullChainYoutube(this.context, [fixture]);
    await this.installObservers(cfg.origin, requestBudget);
    this.ui = await UiDriver.open(this.context, this.extensionId);
    const patch: SettingsPatch = {
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      sourceStrategy: asr ? 'asr-only' : 'captions-only',
      outputMode: 'subtitle-voice',
      prefetch: false,
      rememberCredentials: false,
      pauseDubWithVideo: true,
      provider: {
        baseUrl: cfg.baseUrl,
        protocol: 'responses',
        model: cfg.model,
        reasoningEffort: 'omit',
        streaming: false,
        timeoutMs: 45_000,
      },
      tts: { backend: 'system' },
      audio: { dubVolume: 0.2, originalVolume: 0.3, rate: 1 },
      asr: { backend: asr ? 'local' : 'none', localUrl: ASR_BASE_URL, segmentMs: 5_000 },
    };
    await command(this.ui, { kind: 'settings/update', patch });
    // Never log this string, pass it to an assertion, include it in evidence or persist it locally.
    {
      const key = await readFile(cfg.keyFile, 'utf8').then((value) => value.trim());
      if (!key) throw new Error('The configured key file is empty');
      await command(this.ui, { kind: 'credentials/set', apiKey: key, remember: false });
    }
    if (this.asr) await command(this.ui, { kind: 'asr/set-token', token: this.asr.token });
    await command(this.ui, { kind: 'permissions/changed' });
    await expect
      .poll(
        async () => {
          const s = await this.ui.snapshot();
          return s?.credential.configured === true && s.hostPermission.granted;
        },
        { timeout: 10_000, message: 'Temporary credential and permission ready' },
      )
      .toBe(true);
    this.page = await this.context.newPage();
    await this.page.goto(`https://www.youtube.com/watch?v=${fixture.videoId}`);
    await this.page.bringToFront();
    await expect
      .poll(
        async () => {
          const info = (await this.ui.snapshot())?.pages.find((p) => p.videoId === fixture.videoId);
          if (!info || info.captionsAvailability === 'unknown') return false;
          this.tabId = info.tabId;
          return true;
        },
        { timeout: 20_000, message: 'Fixture page registered in production extension' },
      )
      .toBe(true);
  }

  private async installObservers(origin: string, budget: number): Promise<void> {
    await this.worker.evaluate(
      ({ origin, budget }) => {
        type Options = { lang?: string; onEvent?: (event: { type: string }) => void };
        const g = globalThis as unknown as {
          __liveSub2api: Observations;
          chrome: { tts: { speak(text: string, options: Options): unknown; stop(): unknown } };
        };
        const observed: Observations = {
          requests: [],
          budgetExceeded: 0,
          calls: [],
          events: [],
          stops: [],
        };
        g.__liveSub2api = observed;
        const fetchReal = globalThis.fetch.bind(globalThis);
        globalThis.fetch = async (input, init) => {
          const url = new URL(
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
          );
          if (url.origin !== origin || !/\/(?:responses|chat\/completions)$/.test(url.pathname))
            return fetchReal(input, init);
          if (observed.requests.length >= budget) {
            observed.budgetExceeded++;
            throw new Error('Live test request budget exhausted');
          }
          const entry: Observations['requests'][number] = { at: Date.now() };
          observed.requests.push(entry);
          try {
            const response = await fetchReal(input, init);
            entry.status = response.status;
            return response;
          } catch {
            entry.failed = true;
            throw new Error('Live service request failed');
          } finally {
            entry.elapsedMs = Date.now() - entry.at;
          }
        };
        const speakReal = g.chrome.tts.speak.bind(g.chrome.tts);
        const stopReal = g.chrome.tts.stop.bind(g.chrome.tts);
        g.chrome.tts.speak = (text, options) => {
          const index = observed.calls.length;
          observed.calls.push({ at: Date.now(), text, lang: options.lang });
          return speakReal(text, {
            ...options,
            onEvent: (event) => {
              observed.events.push({ at: Date.now(), index, type: event.type });
              options.onEvent?.(event);
            },
          });
        };
        g.chrome.tts.stop = () => {
          observed.stops.push(Date.now());
          return stopReal();
        };
      },
      { origin, budget },
    );
  }

  observations(): Promise<Observations> {
    return this.worker.evaluate(
      () => (globalThis as unknown as { __liveSub2api: Observations }).__liveSub2api,
    );
  }

  speaking(): Promise<boolean> {
    return this.worker.evaluate(
      () =>
        new Promise<boolean>((done) => {
          (
            globalThis as unknown as {
              chrome: { tts: { isSpeaking(cb: (value: boolean) => void): void } };
            }
          ).chrome.tts.isSpeaking(done);
        }),
    );
  }

  activeCaptures(): Promise<number> {
    return this.worker.evaluate(async () => {
      const list = await (
        globalThis as unknown as {
          chrome: { tabCapture: { getCapturedTabs(): Promise<Array<{ status: string }>> } };
        }
      ).chrome.tabCapture.getCapturedTabs();
      return list.filter((entry) => entry.status === 'active' || entry.status === 'pending').length;
    });
  }

  async offscreen(): Promise<SafeOffscreen> {
    const result = (await cdpEvaluator(
      this.cdpPort,
      isOffscreen(this.extensionId),
    )(() => {
      const api = (
        globalThis as unknown as {
          __tongtingOffscreen?: {
            status(): { resources: { activeTracks: number; pendingRequests: number } };
            diagnostics(): {
              capture?: {
                trackReadyStates: string[];
                segmentsQueued: number;
                resultsEmitted: number;
              };
              lastEnded?: { capture?: { trackReadyStates: string[] } };
            };
          };
        }
      ).__tongtingOffscreen;
      if (!api) return { missing: true };
      const status = api.status();
      const diagnostics = api.diagnostics();
      return {
        activeTracks: status.resources.activeTracks,
        pendingRequests: status.resources.pendingRequests,
        trackReadyStates: diagnostics.capture?.trackReadyStates,
        segmentsQueued: diagnostics.capture?.segmentsQueued,
        resultsEmitted: diagnostics.capture?.resultsEmitted,
        lastEndedTracks: diagnostics.lastEnded?.capture?.trackReadyStates,
      };
    })) as SafeOffscreen & { __noTarget?: boolean };
    return result.__noTarget ? { missing: true } : result;
  }

  async start(): Promise<string> {
    await command(this.ui, { kind: 'session/start', tabId: this.tabId });
    await expect
      .poll(async () => (await this.ui.session(this.tabId))?.phase, { timeout: 30_000 })
      .toBe('running');
    const id = (await this.ui.session(this.tabId))!.identity.sessionId;
    await this.ui.subscribeCues(id);
    return id;
  }

  async waitChinese(id: string, afterMs = -1): Promise<Cue[]> {
    await expect
      .poll(
        async () =>
          (await this.ui.cues(id)).some(
            (cue) =>
              cue.startMs > afterMs &&
              cue.translationState === 'done' &&
              HAN.test(cue.translatedText ?? ''),
          ),
        { timeout: 60_000, message: 'Real sub2api returned Chinese cues' },
      )
      .toBe(true);
    return (await this.ui.cues(id)).filter(
      (cue) => cue.translationState === 'done' && HAN.test(cue.translatedText ?? ''),
    );
  }

  async waitVoice(previousStarts = 0): Promise<void> {
    await expect
      .poll(
        async () =>
          (await this.observations()).events.filter((event) => event.type === 'start').length,
        { timeout: 45_000, message: 'Actual chrome.tts start event' },
      )
      .toBeGreaterThan(previousStarts);
  }

  async pause(id: string): Promise<void> {
    await video(this.page).pause();
    await command(this.ui, { kind: 'session/pause', tabId: this.tabId, sessionId: id });
    await expect.poll(async () => (await this.ui.session(this.tabId))?.phase).toBe('paused');
    await expect.poll(() => this.speaking()).toBe(false);
    await expect.poll(() => this.activeCaptures()).toBe(0);
    const count = (await this.observations()).calls.length;
    await sleep(500);
    expect((await this.observations()).calls.length, 'No new speech while paused').toBe(count);
  }

  async stop(id: string): Promise<void> {
    await video(this.page).pause();
    await command(this.ui, { kind: 'session/stop', tabId: this.tabId, sessionId: id });
    await expect.poll(async () => !!(await this.ui.session(this.tabId))).toBe(false);
    await expect.poll(() => this.activeCaptures()).toBe(0);
    await expect.poll(() => this.speaking()).toBe(false);
    await expect
      .poll(
        async () => {
          const off = await this.offscreen();
          return !!off.missing || (off.activeTracks === 0 && off.pendingRequests === 0);
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const count = (await this.observations()).calls.length;
    await sleep(700);
    expect((await this.observations()).calls.length, 'No late speech after stop').toBe(count);
    this.evidence.stopped = {
      activeCaptures: await this.activeCaptures(),
      speaking: await this.speaking(),
      offscreen: await this.offscreen(),
    };
  }

  async cleanup(): Promise<void> {
    const result = {
      credentialsCleared: false,
      storageCleared: false,
      contextClosed: false,
      temporaryDirectoryRemoved: false,
      asrClosed: !this.asr,
    };
    this.evidence.cleanup = result;
    if (this.worker)
      this.evidence.observations = await this.observations().catch(() => ({ unavailable: true }));
    if (this.ui) {
      if (this.tabId >= 0)
        await this.ui
          .command({ kind: 'session/stop', tabId: this.tabId }, 5_000)
          .catch(() => undefined);
      const key = await this.ui.command({ kind: 'credentials/clear' }, 5_000).catch(() => null);
      const token = await this.ui.command({ kind: 'asr/clear-token' }, 5_000).catch(() => null);
      result.credentialsCleared = key?.ok === true && token?.ok === true;
    }
    if (this.worker) {
      result.storageCleared = await this.worker
        .evaluate(async () => {
          const api = (
            globalThis as unknown as {
              chrome: {
                tts: { stop(): void };
                storage: {
                  session: { clear(): Promise<void> };
                  local: { clear(): Promise<void> };
                };
              };
            }
          ).chrome;
          api.tts.stop();
          await Promise.all([api.storage.session.clear(), api.storage.local.clear()]);
          return true;
        })
        .catch(() => false);
    }
    if (this.context)
      result.contextClosed = await this.context.close().then(
        () => true,
        () => false,
      );
    if (this.asr) {
      result.asrClosed = await this.asr.close().then(
        async () => !(await portOpen(8765)),
        () => false,
      );
      this.asr.token = '';
    }
    if (this.rootDir)
      result.temporaryDirectoryRemoved = await rm(this.rootDir, {
        recursive: true,
        force: true,
      }).then(
        () => true,
        () => false,
      );
    if (
      (this.context && !result.contextClosed) ||
      !result.asrClosed ||
      (this.rootDir && !result.temporaryDirectoryRemoved)
    )
      throw new Error('Live test resource cleanup incomplete; see non-sensitive evidence');
  }
}

async function runLive(name: string, task: (run: LiveRun) => Promise<void>): Promise<void> {
  const run = new LiveRun();
  let passed = false;
  try {
    if (!(await ffmpegAvailable()) || !(await sayAvailable()))
      throw new Error('Live fixture tests require ffmpeg and macOS say');
    await task(run);
    const observations = await run.observations();
    expect(observations.requests.some((request) => request.status === 200)).toBe(true);
    expect(observations.budgetExceeded).toBe(0);
    passed = true;
  } finally {
    try {
      await run.cleanup();
    } finally {
      run.evidence.assertionsPassed = passed;
      run.evidence.finishedAt = new Date().toISOString();
      await mkdir(dirname(EVIDENCE_FILE), { recursive: true });
      const previous = await readFile(EVIDENCE_FILE, 'utf8').then(
        (value) => JSON.parse(value) as Record<string, unknown>,
        () => ({}),
      );
      await writeFile(
        EVIDENCE_FILE,
        JSON.stringify({ ...previous, [name]: run.evidence }, null, 2),
      );
    }
  }
}

test('live sub2api: fixture captions → Chinese overlay → real TTS; pause/resume/seek/stop', async () => {
  await runLive('captions', async (run) => {
    await run.setup(
      {
        videoId: CAPTION_ID,
        title: 'LOCAL SYNTHETIC CAPTION FIXTURE',
        lengthSeconds: 40,
        captions: LINES,
        media: await silentVideo(40),
      },
      false,
      4,
    );
    const id = await run.start();
    const initial = await run.waitChinese(id);
    const first = initial.find((cue) => cue.startMs === LINES[0]!.startMs)!;
    expect(first).toBeTruthy();
    expect(first.endMs).toBe(LINES[0]!.startMs + LINES[0]!.durationMs);
    await video(run.page).seek(first.startMs / 1000);
    expect(await video(run.page).play()).toBe(true);
    await run.waitVoice();
    const overlay = await waitOverlay(
      run.page,
      (value) => value.hidden === false && value.mainHidden === false && HAN.test(value.main ?? ''),
    );
    run.evidence.overlay = { chinese: overlay.main, source: overlay.secondary };
    await run.pause(id);
    const starts = (await run.observations()).events.filter(
      (event) => event.type === 'start',
    ).length;
    await command(run.ui, { kind: 'session/resume', tabId: run.tabId, sessionId: id });
    await expect.poll(async () => (await run.ui.session(run.tabId))?.phase).toBe('running');
    const epoch = (await run.ui.session(run.tabId))!.identity.epoch;
    await video(run.page).seek(LINES[1]!.startMs / 1000);
    await expect
      .poll(async () => (await run.ui.session(run.tabId))!.identity.epoch)
      .toBeGreaterThan(epoch);
    // Full-track speech intentionally skips cues arriving >1.5 s after their start. With
    // prefetch disabled to bound paid calls, keep the video paused until this seek's real
    // translation is ready; network latency must not masquerade as a resume/seek failure.
    await run.waitChinese(id, LINES[0]!.startMs);
    expect((await video(run.page).state()).paused).toBe(true);
    expect(await video(run.page).play()).toBe(true);
    await run.waitVoice(starts);
    const cues = await run.ui.cues(id);
    for (const line of LINES) {
      const cue = cues.find((item) => item.startMs === line.startMs);
      expect(cue?.endMs).toBe(line.startMs + line.durationMs);
    }
    run.evidence.cues = cues.map(({ startMs, endMs, sourceText, translatedText }) => ({
      startMs,
      endMs,
      sourceText,
      translatedText,
    }));
    run.evidence.pauseResumeSeekPassed = true;
    run.evidence.seekPlaybackWaitedForTranslation = true;
    await run.stop(id);
  });
});

test('live sub2api: real tabCapture/local ASR → Chinese → real TTS; resume and seek cleanup', async () => {
  await runLive('asr', async (run) => {
    const speech = await speechVideo(2_000);
    await run.setup(
      {
        videoId: ASR_ID,
        title: 'LOCAL SYNTHETIC SPEECH FIXTURE, NO CAPTIONS',
        lengthSeconds: Math.ceil(speech.durationMs / 1000),
        media: speech.bytes,
      },
      true,
      8,
    );
    expect(await video(run.page).play()).toBe(true);
    const anchor = await run.page.evaluate(() => ({
      at: Date.now(),
      mediaMs: document.querySelector<HTMLVideoElement>('video')!.currentTime * 1000,
    }));
    const id = await run.start();
    await expect.poll(() => run.activeCaptures(), { timeout: 10_000 }).toBe(1);
    const capture = await run.offscreen();
    expect(capture.trackReadyStates).toEqual(['live']);
    await run.waitChinese(id);
    await run.waitVoice();
    const observations = await run.observations();
    const start = observations.events.find((event) => event.type === 'start')!;
    const spoken = observations.calls[start.index]!;
    const cues = await run.ui.cues(id);
    const matching = cues.find((cue) => cue.translatedText === spoken.text)!;
    expect(matching).toBeTruthy();
    expect(matching.source).toBe('asr');
    expect(matching.endMs).toBeGreaterThan(matching.startMs);
    expect(matching.endMs).toBeLessThanOrEqual(speech.durationMs);
    const expectedPhrase = speech.phrases.find(
      (phrase) =>
        matching.startMs < phrase.endMs + 2_000 && matching.endMs > phrase.startMs - 2_000,
    );
    expect(expectedPhrase, 'ASR timestamp overlaps a known spoken phrase').toBeTruthy();
    expect(matching.sourceText.toLowerCase()).toMatch(
      /quick|brown|fox|translat|time|timestamp|audio|captur|segment|video|paus|seek|number|sentence/,
    );
    run.evidence.firstSpokenCue = {
      startMs: matching.startMs,
      endMs: matching.endMs,
      sourceText: matching.sourceText,
      translatedText: matching.translatedText,
      actualTtsStartMediaMs: anchor.mediaMs + start.at - anchor.at,
    };
    run.evidence.capture = capture;
    await run.pause(id);
    const paused = await run.offscreen();
    expect(paused.activeTracks ?? 0).toBe(0);
    const previousCount = (await run.observations()).events.filter(
      (event) => event.type === 'start',
    ).length;
    await command(run.ui, { kind: 'session/resume', tabId: run.tabId, sessionId: id });
    await expect.poll(() => run.activeCaptures(), { timeout: 15_000 }).toBe(1);
    const epoch = (await run.ui.session(run.tabId))!.identity.epoch;
    // Seek to a known phrase: exercise a discontinuity without waiting for a full video.
    const seekMs = speech.phrases[2]!.startMs;
    await video(run.page).seek(seekMs / 1000);
    await expect
      .poll(async () => (await run.ui.session(run.tabId))!.identity.epoch)
      .toBeGreaterThan(epoch);
    await expect.poll(() => run.speaking()).toBe(false);
    expect(await video(run.page).play()).toBe(true);
    await expect
      .poll(async () => (await run.offscreen()).resultsEmitted ?? 0, {
        timeout: 45_000,
        message: 'Resumed real capture emitted a new recognition result',
      })
      .toBeGreaterThan(0);
    const resumedCues = await run.waitChinese(id, seekMs - 2_000);
    await run.waitVoice(previousCount);
    run.evidence.resumedCues = resumedCues.map(
      ({ startMs, endMs, sourceText, translatedText }) => ({
        startMs,
        endMs,
        sourceText,
        translatedText,
      }),
    );
    run.evidence.pauseResumeSeekPassed = true;
    await run.stop(id);
  });
});

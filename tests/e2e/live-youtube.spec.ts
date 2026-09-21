/**
 * Explicitly gated real YouTube + real sub2api long-running test. No page/network fixtures.
 * Uses a disposable extension copy/profile; credentials never enter traces or artifacts.
 * TONGTING_LIVE_YOUTUBE=1, SUB2API_BASE_URL, SUB2API_API_KEY_FILE are required.
 * TONGTING_LIVE_PROXY is an optional existing proxy; only this browser process uses it.
 */
import { expect, test, type Page, type Request, type Worker } from '@playwright/test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  launchExtension,
  EXTENSION_DIR,
  unpackedExtensionId,
  type LaunchedExtension,
} from './helpers/extension';
import { startLocalAsr, ASR_BASE_URL, type LocalAsr } from './fixtures/full-chain/asr-local';
import { UiDriver } from './helpers/ui-driver';
import { overlayState } from './helpers/full-chain';
import type { ConnectionReport } from '../../src/messaging/ui-protocol';
import type { Cue } from '../../src/domain/cue';
import type { SessionSnapshot } from '../../src/domain/session';

const enabled = process.env.TONGTING_LIVE_YOUTUBE === '1';
const useAsr = process.env.TONGTING_LIVE_YOUTUBE_ASR === '1';
const smokeOnly = process.env.TONGTING_LIVE_SMOKE_ONLY === '1';
const requestedListenSeconds = Number(process.env.TONGTING_LIVE_LISTEN_SECONDS ?? 8);
const listenMs =
  (Number.isFinite(requestedListenSeconds)
    ? Math.min(20, Math.max(8, requestedListenSeconds))
    : 8) * 1_000;
const watchUrl =
  process.env.TONGTING_LIVE_YOUTUBE_URL ?? 'https://www.youtube.com/watch?v=ZA-tUyM_y7s';
const requestedMinutes = Number(process.env.TONGTING_LIVE_MINUTES ?? 20);
const minutes = Number.isFinite(requestedMinutes)
  ? Math.min(60, Math.max(1, requestedMinutes))
  : 20;
const evidenceFile = resolve('test-results/live-youtube-evidence.json');
const segmentMs = 5_000;
const pauseObservationMs = segmentMs * 2 + 1_000;
const chinese = /[\u3400-\u9fff]/;
test.use({ trace: 'off', screenshot: 'off', video: 'off' });
test.describe.configure({ timeout: (minutes + 12) * 60_000, retries: 0 });

interface SpeechObservations {
  calls: Array<{ at: number; chinese: boolean; characters: number; lang?: string }>;
  events: Array<{ at: number; index: number; type: string }>;
}

interface RequestEvidence {
  kind: 'translation' | 'asr';
  startedAt: number;
  finishedAt?: number;
  status?: number;
  failed?: boolean;
}

interface AsrObservations {
  documents: string[];
  requests: Record<string, RequestEvidence>;
}

type AsrObserverMessage = {
  marker: 'tongting-live-asr-observer';
  document: string;
  id?: string;
  request?: RequestEvidence;
};

/** Runs only in the disposable offscreen document, before its production module loads. */
function offscreenFetchObserver(origin: string) {
  const api = (
    globalThis as unknown as {
      chrome: { runtime: { sendMessage(message: AsrObserverMessage): Promise<unknown> } };
    }
  ).chrome.runtime;
  const document = crypto.randomUUID();
  let sequence = 0;
  const emit = (id?: string, request?: RequestEvidence) => {
    // Metadata only. Observation failure cannot alter the real fetch or its original error.
    void api
      .sendMessage({ marker: 'tongting-live-asr-observer', document, id, request })
      .catch(() => undefined);
  };
  emit();
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
      location.href,
    );
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (
      url.origin !== origin ||
      url.pathname !== '/v1/transcribe' ||
      method.toUpperCase() !== 'POST'
    )
      return realFetch(input, init);
    const id = `${document}:${++sequence}`;
    const request: RequestEvidence = { kind: 'asr', startedAt: Date.now() };
    emit(id, request);
    try {
      const response = await realFetch(input, init);
      request.status = response.status;
      return response;
    } catch (error) {
      request.failed = true;
      throw error;
    } finally {
      // This is fetch settlement (headers/error), not a claim to have inspected the body.
      request.finishedAt = Date.now();
      emit(id, request);
    }
  };
}

async function installAsrObserver(worker: Worker, extensionId: string) {
  await worker.evaluate((id) => {
    const global = globalThis as unknown as { __liveYoutubeAsr?: AsrObservations };
    if (global.__liveYoutubeAsr) throw new Error('ASR observer already installed');
    const observations: AsrObservations = { documents: [], requests: {} };
    global.__liveYoutubeAsr = observations;
    const api = (
      globalThis as unknown as {
        chrome: {
          runtime: {
            onMessage: {
              addListener(
                listener: (
                  message: AsrObserverMessage,
                  sender: { id?: string; url?: string },
                ) => void,
              ): void;
            };
          };
        };
      }
    ).chrome.runtime;
    api.onMessage.addListener((message, sender) => {
      if (
        sender.id !== id ||
        sender.url !== `chrome-extension://${id}/offscreen.html` ||
        message?.marker !== 'tongting-live-asr-observer'
      )
        return;
      if (!observations.documents.includes(message.document))
        observations.documents.push(message.document);
      if (message.id && message.request)
        observations.requests[message.id] = {
          ...observations.requests[message.id],
          ...message.request,
        };
    });
  }, extensionId);
}

type SpeechGlobal = typeof globalThis & {
  __liveYoutubeSpeech?: SpeechObservations;
};

async function observeSpeech(worker: Worker) {
  await worker.evaluate(() => {
    const global = globalThis as SpeechGlobal;
    if (global.__liveYoutubeSpeech) throw new Error('Speech observer already installed');
    const observations: SpeechObservations = { calls: [], events: [] };
    global.__liveYoutubeSpeech = observations;
    type Options = { lang?: string; onEvent?: (event: { type: string }) => void };
    const api = (
      globalThis as unknown as {
        chrome: { tts: { speak(text: string, options: Options): unknown } };
      }
    ).chrome.tts;
    const speak = api.speak.bind(api);
    api.speak = (text, options) => {
      const index = observations.calls.length;
      observations.calls.push({
        at: Date.now(),
        chinese: /[\u3400-\u9fff]/.test(text),
        characters: text.length,
        lang: options.lang,
      });
      return speak(text, {
        ...options,
        onEvent: (event) => {
          // Character callbacks are noisy; only lifecycle events are evidence.
          if (['start', 'end', 'interrupted', 'cancelled', 'error'].includes(event.type))
            observations.events.push({ at: Date.now(), index, type: event.type });
          options.onEvent?.(event);
        },
      });
    };
  });
}

async function speechObservations(worker: Worker): Promise<SpeechObservations> {
  return worker.evaluate(() => {
    const result = (globalThis as SpeechGlobal).__liveYoutubeSpeech;
    if (!result) throw new Error('Speech observer lost; cannot certify continuity');
    return result;
  });
}

function chineseStarts(observations: SpeechObservations, after: number, before = Infinity) {
  return observations.events.filter(
    (event) =>
      event.type === 'start' &&
      event.at >= after &&
      event.at < before &&
      observations.calls[event.index]?.chinese === true &&
      observations.calls[event.index]!.at >= after,
  ).length;
}

async function physicalAudio(worker: Worker) {
  return worker.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          runtime: { lastError?: { message?: string } };
          tts: { isSpeaking(callback: (speaking: boolean) => void): void };
          tabCapture: {
            getCapturedTabs(
              callback: (tabs: Array<{ tabId: number; status: string }>) => void,
            ): void;
          };
        };
      }
    ).chrome;
    const [speaking, captures] = await Promise.all([
      new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('isSpeaking timeout')), 5_000);
        api.tts.isSpeaking((value) => {
          clearTimeout(timer);
          if (api.runtime.lastError) reject(new Error('isSpeaking failed'));
          else resolve(value);
        });
      }),
      new Promise<Array<{ tabId: number; status: string }>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('getCapturedTabs timeout')), 5_000);
        api.tabCapture.getCapturedTabs((tabs) => {
          clearTimeout(timer);
          if (api.runtime.lastError) reject(new Error('getCapturedTabs failed'));
          else resolve(tabs.filter((tab) => ['active', 'pending'].includes(tab.status)));
        });
      }),
    ]);
    return { speaking, captures };
  });
}

async function playback(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!element) throw new Error('YouTube video element is missing');
    return {
      currentTimeMs: element.currentTime * 1_000,
      paused: element.paused,
      ended: element.ended,
      readyState: element.readyState,
      rate: element.playbackRate,
      errorCode: element.error?.code ?? null,
      errorScreen: !!document.querySelector('.ytp-error .ytp-error-content-wrap'),
      ad: document.querySelector('#movie_player')?.classList.contains('ad-showing') ?? false,
    };
  });
}

function summarizeSession(state: SessionSnapshot | undefined) {
  return {
    phase: state?.phase,
    source: state?.sourceMode,
    epoch: state?.identity.epoch,
    translation: state?.translation && {
      done: state.translation.done,
      pending: state.translation.pending,
      running: state.translation.running,
      failed: state.translation.failed,
      blockedCode: state.translation.blockedError?.code,
    },
    resources: state?.resources,
    noticeCode: state?.notice?.code,
    errorCode: state?.error?.code,
  };
}

function assertRunning(state: SessionSnapshot | undefined, sessionId: string) {
  expect(state?.identity.sessionId, 'Original session identity').toBe(sessionId);
  expect(state?.phase).toBe('running');
  expect(state?.sourceMode).toMatch(useAsr ? /^asr$/ : /^(full-track|incremental-captions)$/);
  expect(state?.outputMode).toBe('subtitle-voice');
  expect(state?.translation.blockedError).toBeUndefined();
  expect(state?.error).toBeUndefined();
  expect(state?.resources.tts).not.toMatch(/^(error|unavailable)$/);
  if (useAsr) {
    expect(state?.resources.capture).toBe('active');
    expect(state?.resources.activeTracks).toBeGreaterThan(0);
    expect(state?.resources.asr).toMatch(/^(running|backlogged)$/);
  }
}

function isChineseCue(cue: Cue) {
  return (
    cue.translationState === 'done' &&
    chinese.test(cue.translatedText ?? '') &&
    (useAsr ? cue.source === 'asr' : cue.source !== 'asr')
  );
}

async function visibleTranslation(page: Page, cues: Cue[], currentTimeMs: number) {
  const overlay = await overlayState(page);
  if (
    !overlay.hosts ||
    overlay.hidden ||
    overlay.mainHidden ||
    overlay.pending ||
    !chinese.test(overlay.main ?? '')
  )
    return undefined;
  // Match the actual visible text and bounded media range. Hidden stale text and unrelated
  // future cached subtitles must never certify current translation. Late ASR holds are valid.
  return cues.find(
    (cue) =>
      isChineseCue(cue) &&
      cue.translatedText?.trim() === overlay.main?.trim() &&
      cue.startMs <= currentTimeMs + 500 &&
      cue.endMs >= currentTimeMs - 8_000,
  );
}

async function asrHealth() {
  const response = await fetch(`${ASR_BASE_URL}/health`, { signal: AbortSignal.timeout(5_000) });
  const body = (await response.json()) as { status?: string; ready?: boolean; model?: string };
  expect(response.ok, 'Local ASR health HTTP status').toBe(true);
  expect(body.status).toBe('ok');
  expect(body.ready).toBe(true);
  return { status: body.status, ready: body.ready, model: body.model };
}

async function play(page: Page) {
  return page.evaluate(async () => {
    const element = document.querySelector<HTMLVideoElement>('#movie_player video');
    if (!element) throw new Error('YouTube video element is missing');
    await element.play();
    return { duration: element.duration, currentTime: element.currentTime, paused: element.paused };
  });
}

test('真实 YouTube 长视频：连续翻译、暂停恢复、跨段跳转、停止清理', async () => {
  test.skip(!enabled, 'Requires explicit real-service opt-in; uses billable subtitle requests');
  const baseUrl = process.env.SUB2API_BASE_URL;
  const keyFile = process.env.SUB2API_API_KEY_FILE;
  if (!baseUrl || !keyFile) throw new Error('Missing live-service URL or credential file path');
  const target = new URL(watchUrl);
  if (target.origin !== 'https://www.youtube.com' || target.pathname !== '/watch') {
    throw new Error('Use a public https://www.youtube.com/watch URL');
  }
  const videoId = target.searchParams.get('v');
  if (!videoId) throw new Error('Missing video ID');
  const apiOrigin = new URL(baseUrl).origin;
  const apiKey = (await readFile(keyFile, 'utf8')).trim();
  if (!apiKey) throw new Error('Empty credential file');
  const model = process.env.SUB2API_MODELS?.split(',')[0]?.trim() || 'gpt-5.6-luna';
  const temp = await mkdtemp(join(tmpdir(), 'tongting-real-youtube-'));
  const dir = join(temp, 'extension');
  let ext: LaunchedExtension | undefined;
  let asr: LocalAsr | undefined;
  let ui: UiDriver | undefined;
  let tabId: number | undefined;
  let failure: Error | undefined;
  const events: Array<Record<string, unknown>> = [];
  const requests: RequestEvidence[] = [];
  const requestEntries = new WeakMap<Request, RequestEvidence>();
  const asrRequestEntries = new Map<string, RequestEvidence>();
  const captionResponses: Array<Record<string, unknown>> = [];
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    videoUrl: watchUrl,
    model,
    subtitleSource: useAsr ? 'real tabCapture and local Whisper small' : 'YouTube captions',
    source: 'real YouTube website and media; no fixtures or route interception',
    scope: smokeOnly
      ? 'short probe only: fresh Chinese subtitle, visible overlay, real Chinese TTS start, stop cleanup; no duration/pause/resume/seek certification'
      : 'continuous playback, translation and real Chinese dubbing; pause/resume, seeks, stop cleanup',
    sourceSelection: 'initial ASR-only or captions-only gate; does not test changing sources',
    captureAuthorization: 'disposable Playwright Chromium profile; automation extension allowlist',
    outputMode: 'subtitle-voice',
    durationRequestedMinutes: smokeOnly ? null : minutes,
    events,
    requests,
    captionResponses,
    outcome: 'incomplete',
  };
  const redact = (error: unknown) =>
    [apiKey, asr?.token]
      .filter((secret): secret is string => !!secret)
      .reduce((message, secret) => message.split(secret).join('[REDACTED]'), String(error))
      .slice(0, 2_000);
  const checkpoint = async () => {
    await mkdir(resolve('test-results'), { recursive: true });
    const json = JSON.stringify(evidence, null, 2);
    if ([apiKey, asr?.token].some((secret) => secret && json.includes(secret)))
      throw new Error('Refusing to write evidence containing credential');
    await writeFile(evidenceFile, json);
  };
  const syncAsrRequests = async () => {
    if (!useAsr || !ext) return 0;
    const observations = await ext.serviceWorker.evaluate(
      () => (globalThis as unknown as { __liveYoutubeAsr?: AsrObservations }).__liveYoutubeAsr,
    );
    if (!observations)
      throw new Error('Live ASR observation missing: worker collector unavailable');
    for (const [id, value] of Object.entries(observations.requests)) {
      const existing = asrRequestEntries.get(id);
      if (existing) Object.assign(existing, value);
      else {
        const entry = { ...value };
        asrRequestEntries.set(id, entry);
        requests.push(entry);
      }
    }
    evidence.asrObserver = {
      method: 'offscreen fetch passthrough, starts and settlement metadata only',
      documentsObserved: observations.documents.length,
      requestsObserved: asrRequestEntries.size,
    };
    return observations.documents.length;
  };
  try {
    await cp(EXTENSION_DIR, dir, { recursive: true });
    if (useAsr) {
      // Instrument only this disposable copy. Loading before the production module also
      // covers the first segment and each recreated offscreen document after resume.
      const offscreenPath = join(dir, 'offscreen.html');
      const offscreenHtml = await readFile(offscreenPath, 'utf8');
      if (!offscreenHtml.includes('<head>'))
        throw new Error('Cannot install offscreen ASR observer');
      await writeFile(
        join(dir, 'live-asr-observer.js'),
        `;(${offscreenFetchObserver.toString()})(${JSON.stringify(new URL(ASR_BASE_URL).origin)});`,
      );
      await writeFile(
        offscreenPath,
        offscreenHtml.replace('<head>', '<head><script src="/live-asr-observer.js"></script>'),
      );
    }
    const manifestPath = join(dir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.host_permissions = [apiOrigin + '/*', ...(useAsr ? ['http://127.0.0.1/*'] : [])];
    await writeFile(manifestPath, JSON.stringify(manifest));
    const proxy = process.env.TONGTING_LIVE_PROXY;
    ext = await launchExtension({
      extensionDir: dir,
      unmute: true,
      extraArgs: [
        `--allowlisted-extension-id=${unpackedExtensionId(dir)}`,
        ...(proxy
          ? [
              `--proxy-server=${proxy}`,
              `--proxy-bypass-list=127.0.0.1;localhost;${new URL(baseUrl).hostname}`,
            ]
          : []),
      ],
    });
    if (useAsr)
      asr = await startLocalAsr({ extensionId: ext.extensionId, logName: 'live-youtube' });
    await observeSpeech(ext.serviceWorker);
    if (useAsr) await installAsrObserver(ext.serviceWorker, ext.extensionId);
    // Playwright observes translation requests; offscreen ASR uses its own passthrough.
    // Retain only kind/time/status: no URLs, authorization headers, request/response bodies.
    ext.context.on('request', (request) => {
      if (request.method() !== 'POST') return;
      const url = new URL(request.url());
      if (url.origin !== apiOrigin || !/\/(responses|chat\/completions)$/.test(url.pathname))
        return;
      const entry: RequestEvidence = { kind: 'translation', startedAt: Date.now() };
      requests.push(entry);
      requestEntries.set(request, entry);
    });
    ext.context.on('requestfinished', (request) => {
      const entry = requestEntries.get(request);
      if (entry) entry.finishedAt = Date.now();
    });
    ext.context.on('requestfailed', (request) => {
      const entry = requestEntries.get(request);
      if (entry) {
        entry.finishedAt = Date.now();
        entry.failed = true;
      }
    });
    ext.context.on('response', (response) => {
      const entry = requestEntries.get(response.request());
      if (entry) entry.status = response.status();
      const url = new URL(response.url());
      if (url.hostname.endsWith('youtube.com') && url.pathname === '/api/timedtext') {
        const item = {
          status: response.status(),
          lang: url.searchParams.get('lang'),
          kind: url.searchParams.get('kind'),
          name: url.searchParams.get('name'),
          format: url.searchParams.get('fmt'),
          bytes: -1,
        };
        captionResponses.push(item);
        void response.body().then(
          (body) => {
            item.bytes = body.byteLength;
          },
          () => undefined,
        );
      }
    });
    ui = await UiDriver.open(ext.context, ext.extensionId);
    await ui.ok({
      kind: 'settings/update',
      patch: {
        provider: { baseUrl, model, protocol: 'responses', streaming: false, timeoutMs: 30_000 },
        sourceStrategy: useAsr ? 'asr-only' : 'captions-only',
        ...(useAsr
          ? {
              asr: { backend: 'local', localUrl: ASR_BASE_URL, segmentMs },
            }
          : {}),
        sourceLanguage: 'en',
        targetLanguage: 'zh-CN',
        outputMode: 'subtitle-voice',
        audio: { originalVolume: 0.05, dubVolume: 0.8, duckOriginal: true },
        tts: { backend: 'system' },
        prefetch: true,
      },
    });
    await ui.ok({ kind: 'credentials/set', apiKey, remember: false });
    if (asr) await ui.ok({ kind: 'asr/set-token', token: asr.token });
    const report = await ui.ok<ConnectionReport>(
      { kind: 'connection/check', scope: 'text', allowBilledAudioProbe: false },
      120_000,
    );
    evidence.connection = report.items.map((item) => ({ key: item.key, status: item.status }));
    await checkpoint();
    expect(report.items.find((item) => item.key === 'translation')?.status).toBe('verified');
    await ui.page.setViewportSize({ width: 320, height: 900 });
    await ui.page.getByRole('tab', { name: '设置', exact: true }).click();
    await ui.page.getByRole('button', { name: '获取模型列表', exact: true }).click();
    const modelSelect = ui.page.getByLabel('翻译模型', { exact: true });
    await expect(modelSelect).toBeEnabled();
    evidence.modelChoices = await modelSelect.locator('option').allTextContents();
    await expect(modelSelect).toHaveValue(model);
    await ui.page.screenshot({
      path: resolve('test-results/live-model-selector.png'),
      animations: 'disabled',
    });

    const page = await ext.context.newPage();
    await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.bringToFront();
    await page.waitForFunction(
      (minimumDuration) => {
        const v = document.querySelector<HTMLVideoElement>('#movie_player video');
        return !!v && v.readyState >= 2 && v.duration > minimumDuration;
      },
      smokeOnly ? 30 : 30 * 60,
      { timeout: 90_000 },
    );
    const initial = await play(page);
    const cc = page.locator('.ytp-subtitles-button');
    if (!useAsr && (await cc.count()) && (await cc.getAttribute('aria-pressed')) !== 'true')
      await cc.click();
    evidence.captionUi = await page.evaluate(() => {
      const player = document.querySelector('#movie_player') as HTMLElement & {
        getOption?(module: string, option: string): unknown;
      };
      const pick = (track: unknown) => {
        if (!track || typeof track !== 'object') return track;
        const item = track as Record<string, unknown>;
        return {
          languageCode: item.languageCode,
          kind: item.kind,
          vss_id: item.vss_id,
          vssId: item.vssId,
          name: item.name,
        };
      };
      const list = player.getOption?.('captions', 'tracklist');
      return {
        cc: document.querySelector('.ytp-subtitles-button')?.getAttribute('aria-pressed'),
        current: pick(player.getOption?.('captions', 'track')),
        tracks: Array.isArray(list) ? list.map(pick) : [],
        segments: document.querySelectorAll('.ytp-caption-segment').length,
      };
    });
    evidence.video = { title: await page.title(), durationSeconds: initial.duration };
    const info = await ui.waitPage(
      videoId,
      useAsr ? undefined : (p) => p.captionsAvailability === 'available',
      45_000,
    );
    tabId = info.tabId;
    evidence.tracks = info.tracks;
    console.log(
      '[live-youtube] Video ready',
      JSON.stringify({
        durationSeconds: Math.round(initial.duration),
        mode: smokeOnly ? 'short-probe' : 'long-run',
        source: useAsr ? 'asr' : 'captions',
      }),
    );
    const startedAt = Date.now();
    await ui.ok({ kind: 'session/start', tabId });
    const session = await ui.waitSession(tabId, (s) => s.phase === 'running', { timeout: 60_000 });
    const sessionId = session.identity.sessionId;
    evidence.initialSession = summarizeSession(session);
    console.log('[live-youtube] Session', JSON.stringify(evidence.initialSession));
    await ui.subscribeCues(sessionId);

    const sample = async () => {
      if (useAsr && (await syncAsrRequests()) === 0)
        throw new Error('Live ASR observation missing: offscreen script has not registered');
      const [state, player, cues, speech, audio] = await Promise.all([
        ui!.session(tabId!),
        playback(page),
        ui!.cues(sessionId),
        speechObservations(ext!.serviceWorker),
        physicalAudio(ext!.serviceWorker),
      ]);
      assertRunning(state, sessionId);
      expect(player.errorCode, 'YouTube media error').toBeNull();
      expect(player.errorScreen, 'YouTube player error screen').toBe(false);
      expect(player.paused, 'YouTube continues playing').toBe(false);
      expect(player.ended, 'Video must not end during observation').toBe(false);
      expect(player.ad, 'Observe the selected video, not an advertisement').toBe(false);
      expect(player.rate, 'Measure continuous playback at normal speed').toBe(1);
      const visible = await visibleTranslation(page, cues, player.currentTimeMs);
      if (useAsr)
        expect(
          audio.captures.some((capture) => capture.tabId === tabId && capture.status === 'active'),
          'Actual tabCapture is active for this video',
        ).toBe(true);
      return { at: Date.now(), state: state!, player, cues, speech, audio, visible };
    };
    const waitForTranslation = async (options: {
      label: string;
      after: number;
      baselineIds: Set<string>;
      minimumEpoch: number;
      targetTimeMs: number;
      allowCached: boolean;
    }) => {
      let accepted: Record<string, unknown> | undefined;
      let lastDiagnosticAt = 0;
      await expect
        .poll(
          async () => {
            const current = await sample();
            const cue = current.visible;
            const fresh = !!cue && !options.baselineIds.has(cue.id);
            const currentRange =
              !!cue &&
              cue.endMs >= options.targetTimeMs - 2_000 &&
              cue.startMs <= options.targetTimeMs + (current.at - options.after) + 4_000;
            const starts = chineseStarts(current.speech, options.after);
            if (current.at - lastDiagnosticAt >= 5_000) {
              lastDiagnosticAt = current.at;
              const diagnostic = {
                stage: options.label,
                ...summarizeSession(current.state),
                mediaSeconds: Math.round(current.player.currentTimeMs / 1_000),
                cueCount: current.cues.length,
                visibleChinese: !!cue,
                freshVisibleCue: fresh,
                chineseSpeechStarts: starts,
              };
              evidence.latestDiagnostic = diagnostic;
              console.log('[live-youtube] Translation', JSON.stringify(diagnostic));
              await checkpoint();
            }
            if (
              current.state.identity.epoch < options.minimumEpoch ||
              !cue ||
              !currentRange ||
              (!fresh && !options.allowCached) ||
              starts === 0
            )
              return false;
            accepted = {
              stage: options.label,
              epoch: current.state.identity.epoch,
              after: options.after,
              observedAt: current.at,
              mediaTimeMs: current.player.currentTimeMs,
              cue: { id: cue.id, source: cue.source, startMs: cue.startMs, endMs: cue.endMs },
              freshCue: fresh,
              reusedVisibleCache: !fresh,
              visibleChinese: true,
              chineseSpeechStarts: starts,
              captures: current.audio.captures,
              ...(useAsr ? { asrHealth: await asrHealth() } : {}),
            };
            return true;
          },
          {
            timeout: 60_000,
            intervals: [500],
            message: `${options.label}: current visible Chinese translation and actual Chinese TTS start`,
          },
        )
        .toBe(true);
      events.push(accepted!);
      await checkpoint();
    };

    await waitForTranslation({
      label: 'initial',
      after: startedAt,
      baselineIds: new Set(),
      minimumEpoch: session.identity.epoch,
      targetTimeMs: initial.currentTime * 1_000,
      allowCached: false,
    });
    // Let the user hear the real speech. A start callback alone is not an audible probe:
    // retain playback for at least 8 seconds (configurable for a user listening test),
    // allowing another 7 seconds for a normal end.
    // If the utterance is longer, certify only observed uninterrupted speech duration.
    if (smokeOnly) {
      const audibleObservationStart = Date.now();
      let normalChineseEnds = 0;
      let sustainedChineseMs = 0;
      while (Date.now() - audibleObservationStart < listenMs + 7_000) {
        const current = await sample();
        const starts = current.speech.events.filter(
          (event) =>
            event.type === 'start' &&
            event.at >= startedAt &&
            current.speech.calls[event.index]?.chinese === true,
        );
        normalChineseEnds = starts.filter((start) =>
          current.speech.events.some(
            (event) => event.index === start.index && event.type === 'end' && event.at >= start.at,
          ),
        ).length;
        for (const start of starts) {
          const terminal = current.speech.events.find(
            (event) =>
              event.index === start.index &&
              event.at >= start.at &&
              ['end', 'interrupted', 'cancelled', 'error'].includes(event.type),
          );
          if (!terminal && current.audio.speaking)
            sustainedChineseMs = Math.max(sustainedChineseMs, current.at - start.at);
        }
        if (Date.now() - audibleObservationStart >= listenMs && normalChineseEnds > 0) break;
        await page.waitForTimeout(500);
      }
      evidence.shortProbeAudio = {
        observationMs: Date.now() - audibleObservationStart,
        normalChineseEnds,
        sustainedChineseMs,
        evidence:
          normalChineseEnds > 0
            ? 'normal-chinese-utterance-end'
            : 'sustained-chinese-speech-at-least-3s; complete-utterance-not-confirmed',
      };
      expect(
        normalChineseEnds > 0 || sustainedChineseMs >= 3_000,
        'Audible Chinese speech must finish normally or remain speaking for at least 3 seconds',
      ).toBe(true);
      await checkpoint();
    } else {
      const first = await sample();
      const continuousStart = first.at;
      let mediaWindowStart = first;
      let minuteStart = first;
      const windows: Array<Record<string, unknown>> = [];
      const visibleIds = new Set<string>();
      const completedIds = new Set(first.cues.filter(isChineseCue).map((cue) => cue.id));
      let newCompleted = 0;
      let visibleSamples = 0;
      let samples = 0;
      let latest = first;
      const finishWindow = async () => {
        const elapsedMs = latest.at - minuteStart.at;
        const starts = chineseStarts(latest.speech, minuteStart.at, latest.at + 1);
        const window = {
          startSeconds: Math.round((minuteStart.at - continuousStart) / 1_000),
          elapsedSeconds: Math.round(elapsedMs / 1_000),
          mediaAdvanceSeconds: Math.round(
            (latest.player.currentTimeMs - minuteStart.player.currentTimeMs) / 1_000,
          ),
          samples,
          visibleSamples,
          distinctVisibleChineseCues: visibleIds.size,
          newCompletedChineseCues: newCompleted,
          chineseSpeechStarts: starts,
          translationRequests: requests.filter(
            (request) =>
              request.kind === 'translation' &&
              request.startedAt >= minuteStart.at &&
              request.startedAt <= latest.at,
          ).length,
          asrRequests: requests.filter(
            (request) =>
              request.kind === 'asr' &&
              request.startedAt >= minuteStart.at &&
              request.startedAt <= latest.at,
          ).length,
          ...(useAsr ? { asrHealth: await asrHealth() } : {}),
        };
        windows.push(window);
        evidence.continuousPlayback = {
          wallSeconds: Math.round((latest.at - continuousStart) / 1_000),
          windows,
        };
        console.log('[live-youtube] Minute', JSON.stringify(window));
        await checkpoint();
        expect(
          window.mediaAdvanceSeconds,
          'Sustained video progress in each window',
        ).toBeGreaterThanOrEqual((elapsedMs / 1_000) * 0.75);
        expect(
          visibleIds.size,
          'Distinct current Chinese subtitles in each minute',
        ).toBeGreaterThanOrEqual(2);
        expect(
          visibleSamples / samples,
          'Chinese subtitles visibly cover at least 20% of samples',
        ).toBeGreaterThanOrEqual(0.2);
        expect(starts, 'New real Chinese speech starts in every minute').toBeGreaterThan(0);
        if (useAsr) {
          expect(newCompleted, 'New ASR translations in every minute').toBeGreaterThan(0);
          expect(
            window.asrRequests,
            'Real local ASR request initiation in every minute',
          ).toBeGreaterThan(0);
        }
        minuteStart = latest;
        visibleIds.clear();
        newCompleted = 0;
        visibleSamples = 0;
        samples = 0;
      };
      while (Date.now() - continuousStart < minutes * 60_000) {
        await page.waitForTimeout(
          Math.min(2_000, Math.max(1, minutes * 60_000 - (Date.now() - continuousStart))),
        );
        latest = await sample();
        samples++;
        if (latest.visible) {
          visibleSamples++;
          visibleIds.add(latest.visible.id);
        }
        for (const cue of latest.cues.filter(isChineseCue)) {
          if (!completedIds.has(cue.id)) {
            completedIds.add(cue.id);
            newCompleted++;
          }
        }
        const mediaWindowMs = latest.at - mediaWindowStart.at;
        if (mediaWindowMs >= 30_000) {
          const advance = latest.player.currentTimeMs - mediaWindowStart.player.currentTimeMs;
          events.push({
            stage: 'progress',
            elapsedSeconds: Math.round((latest.at - continuousStart) / 1_000),
            mediaTimeMs: latest.player.currentTimeMs,
            mediaAdvanceMs: advance,
            wallMs: mediaWindowMs,
            ...summarizeSession(latest.state),
            visibleChinese: !!latest.visible,
            actualCaptures: latest.audio.captures.length,
          });
          await checkpoint();
          expect(
            advance,
            'At least 75% real media progress every 30 seconds',
          ).toBeGreaterThanOrEqual(mediaWindowMs * 0.75);
          expect(advance, 'No unnoticed media jump').toBeLessThanOrEqual(
            mediaWindowMs * 1.25 + 1_000,
          );
          mediaWindowStart = latest;
        }
        if (latest.at - minuteStart.at >= 60_000) await finishWindow();
      }
      // A short timer remainder belongs to the previous complete minute; meaningful
      // partial windows (for fractional minute opt-ins) receive the same checks.
      if (latest.at - minuteStart.at >= 15_000) await finishWindow();
      expect(windows.length, 'At least one sustained evidence window').toBeGreaterThan(0);

      const beforePause = await sample();
      await ui.ok({ kind: 'session/pause', tabId, sessionId });
      const paused = await ui.waitSession(
        tabId,
        (state) => state.phase === 'paused' && state.translation.running === 0,
      );
      expect(paused.identity.epoch, 'Pause invalidates old work').toBeGreaterThan(
        beforePause.state.identity.epoch,
      );
      expect(paused.resources.activeTracks).toBe(0);
      await expect
        .poll(
          async () => {
            const audio = await physicalAudio(ext!.serviceWorker);
            return !audio.speaking && audio.captures.length === 0;
          },
          { timeout: 10_000, message: 'Pause releases actual capture and speech' },
        )
        .toBe(true);
      // Drain already-started requests. Only starts after settled pause constitute new work;
      // responses from before pause are neither counted as new work nor silently ignored.
      await expect
        .poll(
          async () => {
            await syncAsrRequests();
            return requests.filter((request) => !request.finishedAt).length;
          },
          {
            timeout: 10_000,
            message: 'Pre-pause network requests finish or abort',
          },
        )
        .toBe(0);
      const pauseSettledAt = Date.now();
      const pausedRequestCount = requests.length;
      const pausedSpeechCount = (await speechObservations(ext.serviceWorker)).calls.length;
      const pauseEnd = pauseSettledAt + pauseObservationMs;
      while (Date.now() < pauseEnd) {
        await page.waitForTimeout(Math.min(1_000, pauseEnd - Date.now()));
        const audio = await physicalAudio(ext.serviceWorker);
        await syncAsrRequests();
        expect(audio.captures).toHaveLength(0);
        expect(audio.speaking).toBe(false);
        expect(requests.length, 'No new translation or ASR requests while paused').toBe(
          pausedRequestCount,
        );
        expect(
          (await speechObservations(ext.serviceWorker)).calls.length,
          'No late speech calls while paused',
        ).toBe(pausedSpeechCount);
        expect((await ui.session(tabId))?.phase).toBe('paused');
      }
      evidence.pause = {
        observationMs: Date.now() - pauseSettledAt,
        noNewRequestStarts: true,
        noLateSpeechCalls: true,
        activeCaptures: 0,
        speaking: false,
        drainedEarlierRequests: true,
        epoch: paused.identity.epoch,
      };
      const resumeAt = Date.now();
      const resumePosition = (await playback(page)).currentTimeMs;
      const beforeResumeIds = new Set((await ui.cues(sessionId)).map((cue) => cue.id));
      await ui.ok({ kind: 'session/resume', tabId, sessionId });
      await ui.waitSession(tabId, (state) => state.phase === 'running');
      await waitForTranslation({
        label: 'resume',
        after: resumeAt,
        baselineIds: beforeResumeIds,
        minimumEpoch: paused.identity.epoch,
        targetTimeMs: resumePosition,
        allowCached: !useAsr,
      });
      for (const seconds of [
        Math.floor(initial.duration / 2),
        Math.max(0, initial.duration - 90),
      ]) {
        const before = await ui.session(tabId);
        const beforeIds = new Set((await ui.cues(sessionId)).map((cue) => cue.id));
        const seekAt = Date.now();
        await ui.ok({ kind: 'player/seek', tabId, timeMs: seconds * 1_000 });
        await play(page);
        await ui.waitSession(
          tabId,
          (state) => state.phase === 'running' && state.identity.epoch > before!.identity.epoch,
        );
        await expect
          .poll(async () => Math.abs((await playback(page)).currentTimeMs - seconds * 1_000), {
            timeout: 5_000,
            message: 'Player reaches requested seek position',
          })
          .toBeLessThan(6_000);
        await waitForTranslation({
          label: `seek-${seconds}`,
          after: seekAt,
          baselineIds: beforeIds,
          minimumEpoch: before!.identity.epoch + 1,
          targetTimeMs: seconds * 1_000,
          allowCached: !useAsr,
        });
      }
    }
    const finalSession = await ui.session(tabId);
    const cues = await ui.cues(sessionId);
    evidence.final = {
      ...summarizeSession(finalSession),
      cueCount: cues.length,
      chineseCueCount: cues.filter(isChineseCue).length,
    };
    evidence.speech = await speechObservations(ext.serviceWorker);
    await syncAsrRequests();
    // Ensure the network observers really saw production traffic before using their
    // absence as pause/stop evidence. A lost observer must fail, never look quiet.
    expect(
      requests.some((request) => request.kind === 'translation' && request.status === 200),
    ).toBe(true);
    if (useAsr) {
      if (!requests.some((request) => request.kind === 'asr'))
        throw new Error('Live ASR observation missing: no real ASR fetch was observed');
      expect(
        requests.some((request) => request.kind === 'asr' && request.status === 200),
        'At least one actual offscreen ASR fetch succeeds',
      ).toBe(true);
    }
    await ui.ok({ kind: 'session/stop', tabId, sessionId });
    await ui.waitSnapshot(
      (snapshot) => !snapshot.sessions.some((state) => state.identity.tabId === tabId),
    );
    await expect
      .poll(async () => {
        const overlay = await overlayState(page);
        return overlay.hidden || !overlay.hosts;
      })
      .toBe(true);
    await expect
      .poll(
        async () => {
          const audio = await physicalAudio(ext!.serviceWorker);
          return !audio.speaking && audio.captures.length === 0;
        },
        { timeout: 10_000 },
      )
      .toBe(true);
    const stoppedSpeechCount = (await speechObservations(ext.serviceWorker)).calls.length;
    await page.waitForTimeout(1_000);
    expect((await speechObservations(ext.serviceWorker)).calls.length).toBe(stoppedSpeechCount);
    evidence.stop = {
      sessionRemoved: true,
      overlayHidden: true,
      ...(await physicalAudio(ext.serviceWorker)),
      noLateSpeechCalls: true,
    };
    evidence.outcome = smokeOnly ? 'short-probe-passed' : 'passed';
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = redact(error);
    evidence.failureCategory = String(error).includes('Live ASR observation missing')
      ? 'test-observation-incomplete'
      : 'test-assertion-or-runtime-error';
    // Raw browser errors may contain credentials; never attach the unsanitized error.
    failure = new Error(String(evidence.error));
  } finally {
    const cleanup: Record<string, { ok: boolean; error?: string }> = {};
    evidence.cleanup = cleanup;
    const attempt = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action();
        cleanup[label] = { ok: true };
      } catch (error) {
        cleanup[label] = { ok: false, error: redact(error) };
      }
    };
    if (ui) {
      if (tabId !== undefined)
        await attempt('sessionStopped', () =>
          ui!.ok({ kind: 'session/stop', tabId: tabId! }, 5_000),
        );
      await attempt('credentialCleared', () => ui!.ok({ kind: 'credentials/clear' }, 5_000));
      if (asr) await attempt('asrTokenCleared', () => ui!.ok({ kind: 'asr/clear-token' }, 5_000));
    }
    if (ext) {
      if (useAsr) await attempt('asrObservationCollected', () => syncAsrRequests());
      // Disposable profile only: even a failed command must not leave speech or secrets.
      await attempt('speechAndStorageCleared', () =>
        ext!.serviceWorker.evaluate(async () => {
          const api = (
            globalThis as unknown as {
              chrome: {
                tts: { stop(): void };
                storage: { session: { clear(): Promise<void> }; local: { clear(): Promise<void> } };
              };
            }
          ).chrome;
          api.tts.stop();
          const results = await Promise.allSettled([
            api.storage.session.clear(),
            api.storage.local.clear(),
          ]);
          if (results.some((result) => result.status === 'rejected'))
            throw new Error('Temporary extension storage cleanup failed');
        }),
      );
      await attempt('extensionClosed', () => ext!.close());
    }
    if (asr) await attempt('localAsrClosed', () => asr!.close());
    await attempt('temporaryDirectoryRemoved', () => rm(temp, { recursive: true, force: true }));
    evidence.finishedAt = new Date().toISOString();
    const cleanupFailures = Object.entries(cleanup)
      .filter(([, result]) => !result.ok)
      .map(([label]) => label);
    const hadFailed = evidence.outcome === 'failed';
    if (cleanupFailures.length) {
      evidence.outcome = 'failed';
      evidence.cleanupFailures = cleanupFailures;
    }
    // Final evidence is attempted even when any release failed. Never replace the original
    // redacted test failure with a raw cleanup or filesystem exception.
    let checkpointFailed = false;
    try {
      await checkpoint();
    } catch {
      checkpointFailed = true;
      console.error('[live-youtube] Final evidence could not be written');
    }
    if (!hadFailed && (cleanupFailures.length || checkpointFailed))
      failure = new Error(
        `Live test cleanup/evidence failed: ${[...cleanupFailures, ...(checkpointFailed ? ['checkpoint'] : [])].join(', ')}`,
      );
  }
  if (failure) throw failure;
});

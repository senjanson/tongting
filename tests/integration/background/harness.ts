/**
 * 协调器集成测试夹具：用假端口与假依赖驱动真实 Coordinator / TranslationSession，
 * 记录副作用（请求、释放、发送的消息），而不只检查状态文本。
 */
import type { Cue, RawCaptionCue } from '@src/domain/cue';
import type { PlayerState } from '@src/domain/session';
import { Coordinator } from '@src/background/coordinator';
import type { CoordinatorDeps, KeyValueArea } from '@src/background/deps';
import type { PortLike } from '@src/background/connections';
import type { BackgroundToContent, ContentToBackground } from '@src/messaging/content-protocol';
import type {
  OffscreenEvent,
  OffscreenRequest,
  OffscreenStatus,
} from '@src/messaging/offscreen-protocol';
import type { BackgroundToUi, UiCommand } from '@src/messaging/ui-protocol';
import type { TextProviderConfig } from '@src/providers/text/types';
import type { DubbingConfig, TtsEngine } from '@src/providers/tts/types';
import type {
  CueTranslationUpdate,
  SchedulerIdentity,
  TranslationConfig,
} from '@src/translation/types';

export const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXT_ORIGIN = `chrome-extension://${RUNTIME_ID}`;
export const API_KEY = 'sk-test-SECRET-abcdef123456';

export const wait = (ms = 150) => new Promise((r) => setTimeout(r, ms));

export class MemoryArea implements KeyValueArea {
  data = new Map<string, unknown>();
  failWrites = false;
  async get(keys: string[]) {
    const out: Record<string, unknown> = {};
    for (const k of keys) if (this.data.has(k)) out[k] = structuredClone(this.data.get(k));
    return out;
  }
  async set(items: Record<string, unknown>) {
    if (this.failWrites) throw new Error('quota');
    for (const [k, v] of Object.entries(items)) this.data.set(k, structuredClone(v));
  }
  async remove(keys: string[]) {
    for (const k of keys) this.data.delete(k);
  }
}

export class FakePort implements PortLike {
  sent: unknown[] = [];
  disconnected = false;
  private msgListeners: ((m: unknown) => void)[] = [];
  private discListeners: (() => void)[] = [];
  onPost?: (m: unknown) => void;
  constructor(
    public name: string,
    public sender: PortLike['sender'],
  ) {}
  postMessage(message: unknown) {
    if (this.disconnected) throw new Error('disconnected');
    this.sent.push(structuredClone(message));
    this.onPost?.(message);
  }
  disconnect() {
    this.disconnected = true;
  }
  onMessage = { addListener: (l: (m: unknown) => void) => void this.msgListeners.push(l) };
  onDisconnect = { addListener: (l: () => void) => void this.discListeners.push(l) };
  deliver(message: unknown) {
    for (const l of this.msgListeners) l(message);
  }
  remoteDisconnect() {
    this.disconnected = true;
    for (const l of this.discListeners) l();
  }
}

export class FakeScheduler {
  static all: FakeScheduler[] = [];
  cues: Cue[] = [];
  identity: SchedulerIdentity;
  config: TranslationConfig;
  configRevisions: number[] = [];
  epochs: number[] = [];
  paused = false;
  disposed = false;
  playheads: number[] = [];
  private listeners: ((u: CueTranslationUpdate[]) => void)[] = [];
  constructor(
    public provider: { config: TextProviderConfig },
    config: TranslationConfig,
    identity: SchedulerIdentity,
  ) {
    this.config = config;
    this.identity = identity;
    FakeScheduler.all.push(this);
  }
  setCues(cues: readonly Cue[], identity: SchedulerIdentity) {
    this.cues = [...cues];
    this.identity = identity;
  }
  upsertCues(cues: readonly Cue[]) {
    for (const c of cues) {
      const i = this.cues.findIndex((x) => x.id === c.id);
      if (i >= 0) this.cues[i] = c;
      else this.cues.push(c);
    }
  }
  removeCues(ids: readonly string[]) {
    this.cues = this.cues.filter((c) => !ids.includes(c.id));
  }
  setPlayhead(p: { mediaTimeMs: number }) {
    this.playheads.push(p.mediaTimeMs);
  }
  setEpoch(epoch: number) {
    this.epochs.push(epoch);
  }
  setConfig(config: TranslationConfig, rev: number, provider: { config: TextProviderConfig }) {
    this.config = config;
    this.configRevisions.push(rev);
    this.provider = provider;
  }
  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }
  retryFailed() {
    return 0;
  }
  backfill: boolean[] = [];
  setBackfill(enabled: boolean) {
    this.backfill.push(enabled);
  }
  onUpdate(l: (u: CueTranslationUpdate[]) => void) {
    this.listeners.push(l);
    return () => {
      this.listeners = this.listeners.filter((x) => x !== l);
    };
  }
  emit(updates: CueTranslationUpdate[]) {
    if (this.disposed) return;
    for (const l of this.listeners) l(updates);
  }
  stats() {
    return { total: this.cues.length, done: 0, pending: this.cues.length, running: 0, failed: 0 };
  }
  dispose() {
    this.disposed = true;
    this.listeners = [];
  }
}

export class FakeOffscreen {
  requests: OffscreenRequest[] = [];
  status: OffscreenStatus | null = null;
  captureStartDelay?: Promise<void>;
  private eventListeners: ((e: OffscreenEvent) => void)[] = [];
  private helloListeners: ((s: OffscreenStatus) => void)[] = [];
  handledPorts: PortLike[] = [];
  async ensure() {
    return this.status ?? idleStatus();
  }
  async queryStatus() {
    return this.status;
  }
  async request(req: OffscreenRequest) {
    this.requests.push(structuredClone(req));
    if (req.kind === 'capture/start' && this.captureStartDelay) await this.captureStartDelay;
    return { ok: true };
  }
  onEvent(l: (e: OffscreenEvent) => void) {
    this.eventListeners.push(l);
    return () => undefined;
  }
  onHello(l: (s: OffscreenStatus) => void) {
    this.helloListeners.push(l);
    return () => undefined;
  }
  async closeIfIdle() {
    return true;
  }
  handlePort(port: PortLike) {
    this.handledPorts.push(port);
  }
  emitEvent(e: OffscreenEvent) {
    for (const l of this.eventListeners) l(e);
  }
  emitHello(s: OffscreenStatus) {
    for (const l of this.helloListeners) l(s);
  }
  private lostListeners: ((info: {
    reason: 'port-disconnected' | 'document-missing' | 'instance-changed';
  }) => void)[] = [];
  onConnectionLost(
    l: (info: { reason: 'port-disconnected' | 'document-missing' | 'instance-changed' }) => void,
  ) {
    this.lostListeners.push(l);
    return () => undefined;
  }
  emitConnectionLost(
    reason: 'port-disconnected' | 'document-missing' | 'instance-changed' = 'port-disconnected',
  ) {
    for (const l of this.lostListeners) l({ reason });
  }
  kinds() {
    return this.requests.map((r) => r.kind);
  }
}

export function idleStatus(): OffscreenStatus {
  return {
    offscreenInstanceId: 'off1',
    lease: null,
    resources: { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 },
    audioContextState: 'none',
    ttsPlaying: false,
  };
}

export class FakeDubbing {
  static all: FakeDubbing[] = [];
  configs: DubbingConfig[] = [];
  invalidations: number[] = [];
  upserted: Cue[] = [];
  disposed = false;
  constructor() {
    FakeDubbing.all.push(this);
  }
  setConfig(c: DubbingConfig) {
    this.configs.push(c);
  }
  upsertCues(c: readonly Cue[]) {
    this.upserted.push(...c);
  }
  onPlayer() {}
  invalidate(epoch: number) {
    this.invalidations.push(epoch);
  }
  onEvent() {
    return () => undefined;
  }
  stats() {
    return { state: 'idle' as const, backlog: 0, skipped: 0 };
  }
  dispose() {
    this.disposed = true;
  }
}

export interface Harness {
  coordinator: Coordinator;
  deps: CoordinatorDeps;
  local: MemoryArea;
  session: MemoryArea;
  secureLocal: MemoryArea;
  offscreen: FakeOffscreen;
  permissionGranted: { value: boolean; delay?: Promise<void> };
  captureResult: { value: 'ok' | 'error' };
  transcripts: Map<string, unknown>;
  ui(): UiClient;
  content(tabId: number, opts?: { documentId?: string; url?: string }): ContentClient;
}

export function createHarness(
  options: { local?: MemoryArea; session?: MemoryArea; secureLocal?: MemoryArea } = {},
): Harness {
  FakeScheduler.all = [];
  FakeDubbing.all = [];
  const local = options.local ?? new MemoryArea();
  const session = options.session ?? new MemoryArea();
  const secureLocal = options.secureLocal ?? new MemoryArea();
  const offscreen = new FakeOffscreen();
  const permissionGranted: Harness['permissionGranted'] = { value: true };
  const captureResult: Harness['captureResult'] = { value: 'ok' };
  const transcripts = new Map<string, unknown>();
  let idCounter = 0;
  const systemTts: TtsEngine = {
    kind: 'mock',
    getVoices: async () => [{ voiceName: 'Tingting', lang: 'zh-CN' }],
    speak: (u, l) => {
      l({ type: 'start', utteranceId: u.utteranceId });
      l({ type: 'end', utteranceId: u.utteranceId });
    },
    stop: () => undefined,
  };
  const deps: CoordinatorDeps = {
    now: () => Date.now(),
    randomId: (prefix = '') => `${prefix}${(++idCounter).toString().padStart(8, '0')}`,
    storage: { local, session, secureLocal },
    runtimeId: RUNTIME_ID,
    extensionOrigin: EXT_ORIGIN,
    permissions: {
      contains: async () => {
        if (permissionGranted.delay) await permissionGranted.delay;
        return permissionGranted.value;
      },
    },
    tabCapture: {
      getMediaStreamId: async () => {
        if (captureResult.value === 'error')
          throw new Error('Extension has not been invoked for the current page');
        return 'stream-1';
      },
    },
    tabs: { exists: async () => true, getActiveTabId: async () => 1, wake: async () => undefined },
    normalizeBaseUrl: (input) => {
      try {
        const u = new URL(input);
        const root = `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`;
        return {
          ok: true,
          baseUrl: root,
          origin: u.origin,
          originPattern: `${u.protocol}//${u.hostname}/*`,
        };
      } catch {
        return {
          ok: false,
          error: { code: 'invalid-url', category: 'config', retryable: false, message: '地址无效' },
        };
      }
    },
    createTextProvider: (config) =>
      ({
        config,
        profileKey: `${config.baseUrl}|${config.model}`,
        promptVersion: 'p1',
        translateBatch: async () => {
          throw new Error('not used');
        },
      }) as never,
    discoverModels: async () => ['gpt-5.6-terra'],
    runTextConnectionCheck: async () => ({ items: [], detectedProtocol: 'responses' }),
    probeSub2apiSpeech: async () => ({ bytes: 1024, contentType: 'audio/mpeg', latencyMs: 12 }),
    probeSub2apiTranscription: async () => ({ text: '', latencyMs: 15 }),
    createTranslationScheduler: (d, config, identity) =>
      new FakeScheduler(d.provider as never, config, identity) as never,
    translationCache: {
      get: async () => undefined,
      set: async () => undefined,
      clear: async () => undefined,
    },
    buildCueUnits: (raw: readonly RawCaptionCue[], o) =>
      raw.map((r, i) => ({
        id: `${o.idPrefix}:${i}`,
        revision: 0,
        startMs: r.startMs,
        endMs: r.endMs,
        sourceText: r.text,
        sourceLanguage: o.sourceLanguage,
        targetLanguage: o.targetLanguage,
        source: 'caption-track',
        stability: 'final',
        translationState: 'pending',
      })),
    createIncrementalCaptionAssembler: () => ({
      push: () => ({ upserts: [], removedIds: [] }),
      flush: () => ({ upserts: [], removedIds: [] }),
      reset: () => undefined,
    }),
    createAsrCueAssembler: (o) => {
      let n = 0;
      return {
        push: (r) => ({
          upserts: [
            {
              id: `${o.idPrefix}:${r.segmentId}`,
              revision: r.revision,
              startMs: r.startMs,
              endMs: r.endMs,
              sourceText: r.text,
              sourceLanguage: r.language ?? 'und',
              targetLanguage: o.targetLanguage,
              source: 'asr' as const,
              stability: r.final ? ('final' as const) : ('interim' as const),
              translationState: 'pending' as const,
            },
          ],
          removedIds: [],
        }),
        reset: () => {
          n++;
          void n;
        },
      };
    },
    offscreen: offscreen as never,
    systemTts,
    createSub2apiTtsEngine: () => systemTts,
    createDubbingController: () => new FakeDubbing() as never,
    checkLocalAsrHealth: async () => ({ status: 'ok', ready: true, model: 'small', device: 'cpu' }),
    transcripts: {
      putTranscript: async (r) => void transcripts.set(r.recordId, structuredClone(r)),
      getTranscript: async (id) => transcripts.get(id) as never,
    },
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
  const coordinator = new Coordinator(deps);
  const h: Harness = {
    coordinator,
    deps,
    local,
    session,
    secureLocal,
    offscreen,
    permissionGranted,
    captureResult,
    transcripts,
    ui: () => new UiClient(coordinator),
    content: (tabId, opts) => new ContentClient(coordinator, tabId, opts),
  };
  return h;
}

export class UiClient {
  port: FakePort;
  private n = 0;
  constructor(
    private readonly coordinator: Coordinator,
    path = '/sidepanel.html',
  ) {
    this.port = new FakePort('tongting:ui', { id: RUNTIME_ID, url: `${EXT_ORIGIN}${path}` });
    coordinator.handleConnect(this.port);
    this.port.deliver({ type: 'subscribe', protocolVersion: 1, surface: 'sidepanel' });
  }
  async command(command: UiCommand): Promise<Extract<BackgroundToUi, { type: 'result' }>> {
    const requestId = `req${++this.n}`;
    this.port.deliver({ type: 'command', requestId, command });
    for (let i = 0; i < 100; i++) {
      const res = this.port.sent.find(
        (m): m is Extract<BackgroundToUi, { type: 'result' }> =>
          (m as { type: string }).type === 'result' &&
          (m as { requestId: string }).requestId === requestId,
      );
      if (res) return res;
      await wait(10);
    }
    throw new Error(`no result for ${command.kind}`);
  }
  lastSnapshot() {
    const snaps = this.port.sent.filter(
      (m) => (m as { type: string }).type === 'snapshot',
    ) as Extract<BackgroundToUi, { type: 'snapshot' }>[];
    return snaps[snaps.length - 1]?.snapshot;
  }
}

export class ContentClient {
  port: FakePort;
  navigationId = 0;
  videoId: string | null = null;
  autoReply = true;
  requests: Extract<BackgroundToContent, { type: 'request' }>[] = [];
  constructor(
    coordinator: Coordinator,
    readonly tabId: number,
    opts: { documentId?: string; url?: string } = {},
  ) {
    this.port = new FakePort('tongting:content', {
      id: RUNTIME_ID,
      url: opts.url ?? 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      tab: { id: tabId } as never,
      frameId: 0,
      documentId: opts.documentId ?? `doc-${tabId}`,
    });
    this.port.onPost = (m) => {
      const msg = m as BackgroundToContent;
      if (msg.type === 'request') {
        this.requests.push(msg);
        if (this.autoReply) {
          queueMicrotask(() =>
            this.port.deliver({ type: 'reply', requestId: msg.requestId, ok: true }),
          );
        }
      }
    };
    coordinator.handleConnect(this.port);
  }
  send(message: ContentToBackground) {
    this.port.deliver(message);
  }
  hello(pageInstanceId = 'page-instance-0001') {
    this.send({
      type: 'hello',
      protocolVersion: 1,
      pageInstanceId,
      url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    });
  }
  navigate(videoId: string | null, opts: { tracks?: boolean; navigationId?: number } = {}) {
    this.navigationId = opts.navigationId ?? this.navigationId + 1;
    this.videoId = videoId;
    this.send({
      type: 'page/video',
      navigationId: this.navigationId,
      videoId,
      title: `Video ${videoId}`,
      isLive: false,
      isShorts: false,
      durationMs: 600_000,
    });
    if (videoId) {
      this.send({
        type: 'captions/tracks',
        navigationId: this.navigationId,
        videoId,
        availability: opts.tracks === false ? 'unavailable' : 'available',
        tracks:
          opts.tracks === false
            ? []
            : [{ trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' }],
      });
    }
  }
  trackData(
    cues: RawCaptionCue[] = sampleRaw(),
    navigationId = this.navigationId,
    videoId = this.videoId!,
  ) {
    this.send({
      type: 'captions/track-data',
      navigationId,
      videoId,
      track: { trackKey: 'en', languageCode: 'en', label: 'English', kind: 'manual' },
      format: 'json3',
      cues,
      complete: true,
      rejectedCount: 0,
    });
  }
  player(
    partial: Partial<PlayerState> = {},
    reason: Extract<ContentToBackground, { type: 'player/state' }>['reason'] = 'tick',
  ) {
    this.send({
      type: 'player/state',
      navigationId: this.navigationId,
      reason,
      state: {
        videoId: this.videoId,
        currentTimeMs: 0,
        paused: false,
        buffering: false,
        seeking: false,
        ended: false,
        playbackRate: 1,
        ad: false,
        volume: 1,
        muted: false,
        isLive: false,
        isShorts: false,
        fullscreen: false,
        sampledAtEpochMs: Date.now(),
        ...partial,
      },
    });
  }
  messages<T extends BackgroundToContent['type']>(type: T) {
    return this.port.sent.filter((m) => (m as { type: string }).type === type) as Extract<
      BackgroundToContent,
      { type: T }
    >[];
  }
  requestKinds() {
    return this.requests.map((r) => r.request.kind);
  }
}

export function sampleRaw(): RawCaptionCue[] {
  return [
    { startMs: 0, endMs: 2000, text: 'Hello world.' },
    { startMs: 2000, endMs: 4000, text: 'This is <b>not</b> a test.' },
  ];
}

export async function configure(h: Harness, overrides: { asr?: boolean } = {}) {
  const ui = h.ui();
  await ui.command({
    kind: 'settings/update',
    patch: {
      provider: {
        baseUrl: 'https://api.example.com/v1',
        protocol: 'responses',
        model: 'gpt-5.6-terra',
      },
    },
  });
  await ui.command({ kind: 'credentials/set', apiKey: API_KEY, remember: false });
  if (overrides.asr) {
    await ui.command({
      kind: 'settings/update',
      patch: { asr: { backend: 'local', localUrl: 'http://127.0.0.1:8765' } },
    });
    await ui.command({ kind: 'asr/set-token', token: 'local-token-123456' });
  }
  return ui;
}

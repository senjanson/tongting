/**
 * service worker 会话协调器：会话决策与状态版本的权威来源。
 *
 * - 每个标签页一个 slot：用户意图 desired 与实际会话分离；reconcile 循环在每次 await 后重新读取意图，
 *   新意图不会被「正在忙」丢弃（T10）。
 * - 第一版全局只允许一个活跃会话（音频 owner 唯一）；在另一标签页开始时先释放旧会话（T24）。
 * - UI 只拿快照与命令结果；快照不含明文凭证。
 * - worker 重启后从 storage.session 中的会话记录与 offscreen 实际状态核对再恢复（T21）。
 */
import type { Cue } from '../domain/cue';
import {
  AppError,
  cancelledError,
  redactUrl,
  toAppErrorInfo,
  type AppErrorInfo,
} from '../domain/errors';
import type { CapabilityKey, CapabilityMatrix, ProviderCapability } from '../domain/capability';
import {
  PageInfoSchema,
  SessionSnapshotSchema,
  type DesiredState,
  type SessionSnapshot,
} from '../domain/session';
import { MAX_MEDIA_TIME_MS } from '../domain/cue';
import {
  applySettingsPatch,
  defaultSettings,
  translationFingerprint,
  type Settings,
  type SettingsPatch,
} from '../domain/settings';
import type { ContentToBackground } from '../messaging/content-protocol';
import { CONTENT_PROTOCOL_VERSION } from '../messaging/content-protocol';
import type { OffscreenEvent, OffscreenStatus } from '../messaging/offscreen-protocol';
import {
  PORT_CONTENT,
  PORT_OFFSCREEN,
  PORT_UI,
  verifySender,
  type VerifiedContentSender,
  type VerifiedExtensionSender,
} from '../messaging/ports';
import {
  AppSnapshotSchema,
  ConnectionReportSchema,
  UI_PROTOCOL_VERSION,
  type AppSnapshot,
  type ConnectionCheckItem,
  type ConnectionReport,
  type UiCommand,
  type UiCommandResultMap,
} from '../messaging/ui-protocol';
import { ContentConnection, UiConnection, type PortLike } from './connections';
import type { TextProvider, TextProviderConfig } from '../providers/text/types';
import type { TtsVoice } from '../providers/tts/types';
import { voiceLanguageRank } from '../providers/tts/voices';
import type { CoordinatorDeps } from './deps';
import { toPageInfo, type PageState } from './pages';
import { SearchController } from './search-controller';
import {
  generateSearchKeywords,
  type SearchGenerationParams,
} from '../providers/text/search-keywords';
import { searchHistory } from '../storage/search-history';
import { TranslationSession, type SessionHost } from './session';
import {
  beginSecretRevocation,
  type SecretRevocation,
  clearSecret,
  loadSecret,
  loadSettings,
  maskSecret,
  saveSecret,
  saveSettings,
  type SecretState,
} from './settings-store';

const RECORDS_KEY = 'sessionRecords';
const CONFIG_REVISION_KEY = 'configRevision';
const CAPABILITIES_KEY = 'capabilities';
/**
 * 恢复记录按页面身份（documentId + navigationId + videoId）匹配，时间窗口只用于清理过旧的记录。
 * storage.session 随浏览器会话清空；documentId 在文档生命周期内唯一。
 */
const RECOVERY_WINDOW_MS = 6 * 3600_000;
const ORPHAN_LEASE_GRACE_MS = 45_000;
const SNAPSHOT_DEBOUNCE_MS = 40;

/** 持久化到 storage.session 的会话记录，用于 worker 重启后核对恢复。 */
export interface SessionRecord {
  tabId: number;
  documentId: string;
  navigationId: number;
  videoId: string;
  sessionId: string;
  desired: DesiredState;
  sourceMode: string;
  leaseId?: string;
  configRevision: number;
  savedAt: number;
}

interface TabSlot {
  tabId: number;
  desired: DesiredState;
  session?: TranslationSession;
  /** 启动失败或运行中致命错误后保留的错误快照，直到下一次命令或导航。 */
  errorSnapshot?: SessionSnapshot;
  loop?: Promise<void>;
  dirty: boolean;
  recovery?: SessionRecord;
  /** 每次用户命令递增；启动失败时只有意图未变才回退为 stopped，避免吞掉期间的新操作。 */
  intentSeq: number;
  /** 当前会话启动时的配置指纹；启动期间配置或凭证变化则中止并以新配置重启。 */
  startFingerprint?: string;
  /** 恢复/路由替换期间也必须隔离每次异步捕获配置。 */
  captureOperationKey?: string;
}

type CommandHandlerResult<K extends UiCommand['kind']> = UiCommandResultMap[K];

const TEXT_CAPABILITY_KEYS: CapabilityKey[] = [
  'reachability',
  'auth',
  'modelList',
  'model',
  'translation',
  'streaming',
  'hostPermission',
  'asr',
  'tts',
];

export class Coordinator implements SessionHost {
  private readonly search: SearchController;
  readonly workerInstanceId: string;
  readonly ready: Promise<void>;

  private settingsValue: Settings = defaultSettings();
  private settingsPersisted = true;
  private configRevisionValue = 0;
  private apiKeyState: SecretState = { value: undefined, storage: 'none' };
  private asrTokenState: SecretState = { value: undefined, storage: 'none' };
  private hostPermission: { origin?: string; granted: boolean } = { granted: false };
  private capabilities: CapabilityMatrix = {};
  private lastConnectionReport?: ConnectionReport;

  private readonly pages = new Map<number, PageState>();
  private readonly slots = new Map<number, TabSlot>();
  private readonly uiConnections = new Set<UiConnection>();
  private recoveryRecords = new Map<number, SessionRecord>();
  private snapshotVersion = 0;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private recordsWrite: Promise<void> = Promise.resolve();
  private recordsTimer?: ReturnType<typeof setTimeout>;
  private orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastOffscreenInstanceId?: string;
  private connectionCheckAbort?: AbortController;
  private modelDiscoveryAbort?: AbortController;
  private sessionProvider?: { key: string; apiKey: string; provider: TextProvider };
  /** 凭证代数：更换/删除 API Key 或本地识别令牌时递增（Key 本身不参与 configRevision）。 */
  private credentialGeneration = 0;
  /** 分别记录 API Key 与本地识别令牌的变化，识别路由只受其实际使用的凭证影响。 */
  private apiKeyGeneration = 0;
  private asrTokenGeneration = 0;
  /** 配置写入共享同一队列，保证磁盘与配置副作用保持命令顺序。 */
  private mutationTail: Promise<void> = Promise.resolve();
  private apiKeyIntent = 0;
  private asrTokenIntent = 0;
  private permissionCheckGeneration = 0;
  private permissionsChangeGeneration = 0;
  private preview?: {
    id: string;
    timer?: ReturnType<typeof setTimeout>;
    cancel(): void;
  };

  constructor(readonly deps: CoordinatorDeps) {
    this.search = new SearchController({
      route: (signal) => this.searchRoute(signal),
      generate: (params) => (deps.generateSearchKeywords ?? generateSearchKeywords)(params),
      history: {
        list: () => (deps.searchHistory ?? searchHistory).list(),
        save: (record, signal) => (deps.searchHistory ?? searchHistory).save(record, signal),
        clear: () => (deps.searchHistory ?? searchHistory).clear(),
      },
      now: deps.now,
      randomId: deps.randomId,
      detected: (protocol) => {
        if (this.settingsValue.provider.protocol === 'auto') this.saveDetectedProtocol(protocol);
      },
    });
    this.workerInstanceId = deps.randomId('w');
    this.ready = this.init();
    deps.offscreen.onEvent((event) => this.onOffscreenEvent(event));
    deps.offscreen.onConnectionLost(() => {
      void this.ready.then(() => this.onOffscreenLost());
    });
    deps.offscreen.onHello((status) => {
      void this.ready.then(() => this.onOffscreenHello(status));
    });
  }

  // ---------------------------------------------------------------------------
  // 初始化与持久化
  // ---------------------------------------------------------------------------

  private async init(): Promise<void> {
    const { deps } = this;
    const loaded = await loadSettings(deps.storage.local, deps.logger);
    this.settingsValue = loaded.settings;
    const [apiKey, asrToken] = await Promise.all([
      loadSecret(deps.storage, 'apiKey'),
      loadSecret(deps.storage, 'asrToken'),
    ]);
    this.apiKeyState = apiKey;
    this.asrTokenState = asrToken;
    // 在发布首个快照前迁移仍可读取的临时凭证。只移动权威读取结果，不能复活已删除的旧副本。
    // 若上次写入失败而临时副本仍存在，下次启动会重试；已经被 Chrome 清空的值无法恢复。
    if (
      this.settingsValue.rememberCredentials &&
      [apiKey, asrToken].some((secret) => secret.value && secret.storage !== 'local')
    )
      this.settingsPersisted = await this.moveSecrets(true);
    if (loaded.needsPersistence) {
      const persisted = await saveSettings(deps.storage.local, this.settingsValue);
      this.settingsPersisted = persisted && this.settingsPersisted;
    }
    try {
      const stored = await deps.storage.session.get([
        CONFIG_REVISION_KEY,
        RECORDS_KEY,
        CAPABILITIES_KEY,
      ]);
      const rev = stored[CONFIG_REVISION_KEY];
      if (typeof rev === 'number' && Number.isInteger(rev) && rev >= 0)
        this.configRevisionValue = rev;
      const records = stored[RECORDS_KEY];
      if (Array.isArray(records)) {
        const now = deps.now();
        for (const r of records as SessionRecord[]) {
          if (
            r &&
            typeof r.tabId === 'number' &&
            typeof r.sessionId === 'string' &&
            now - r.savedAt < RECOVERY_WINDOW_MS
          ) {
            this.recoveryRecords.set(r.tabId, r);
          }
        }
      }
      const caps = stored[CAPABILITIES_KEY];
      if (caps && typeof caps === 'object') this.capabilities = caps as CapabilityMatrix;
    } catch {
      // session 区域不可用时从零开始
    }
    await this.refreshHostPermission();
    this.publish();
  }

  settings(): Settings {
    return this.settingsValue;
  }

  apiKey(): string | undefined {
    return this.apiKeyState.value;
  }

  asrToken(): string | undefined {
    return this.asrTokenState.value;
  }

  configRevision(): number {
    return this.configRevisionValue;
  }

  asrRouteKey(): string {
    const s = this.settingsValue;
    return JSON.stringify([
      s.asr.backend,
      s.sourceLanguage,
      s.asr.segmentMs,
      s.asr.backend === 'local' ? s.asr.localUrl : '',
      s.asr.backend === 'sub2api' ? [s.provider.baseUrl, s.asr.sub2apiModel] : '',
      s.asr.backend === 'local'
        ? this.asrTokenGeneration
        : s.asr.backend === 'sub2api'
          ? this.apiKeyGeneration
          : 0,
    ]);
  }

  /** 影响会话启动结果的配置指纹：不含字幕外观、音量类设置、协议探测结果与凭证存储位置，含凭证代数。 */
  private startFingerprint(): string {
    const s = this.settingsValue;
    return JSON.stringify([
      {
        ...s,
        captions: undefined,
        audio: undefined,
        rememberCredentials: undefined,
        pauseDubWithVideo: undefined,
        layout: undefined,
        provider: { ...s.provider, detectedProtocol: undefined },
      },
      this.credentialGeneration,
    ]);
  }

  /** 凭证变化：递增代数，作废在途连接检查与模型发现（结果不得归到新凭证名下）。 */
  private invalidateCredentials(which: 'apiKey' | 'asrToken'): void {
    if (which === 'apiKey') this.search.cancelAll();
    if (which === 'apiKey') this.apiKeyGeneration++;
    else this.asrTokenGeneration++;
    this.credentialGeneration++;
    this.connectionCheckAbort?.abort();
    this.modelDiscoveryAbort?.abort();
    if (which === 'asrToken') {
      delete this.capabilities.localAsr;
      this.lastConnectionReport = undefined;
      this.persistCapabilities();
    }
  }

  /**
   * 设置或凭证变化后：启动中的会话若配置指纹已变则中止当前等待，由收敛循环以新配置重启；
   * 运行中的识别会话若识别路由（后端、地址、模型、凭证）变化则标记重新获取捕获。
   */
  private afterConfigChange(): void {
    const fingerprint = this.startFingerprint();
    const routeKey = this.asrRouteKey();
    for (const slot of this.slots.values()) {
      const session = slot.session;
      if (!session || session.isStopping) continue;
      if (slot.startFingerprint !== undefined && slot.startFingerprint !== fingerprint) {
        session.abortPending('config-changed');
        void this.reconcile(slot);
        continue;
      }
      if (slot.captureOperationKey !== undefined && slot.captureOperationKey !== routeKey) {
        session.needsCaptureRefresh = true;
        session.abortPending('asr-route-changed');
        void this.reconcile(slot);
        continue;
      }
      if (
        session.sourceMode === 'asr-preload' &&
        session.captureRouteKey !== undefined &&
        session.captureRouteKey !== routeKey
      ) {
        session.restartRequested = true;
        // A paused preloader already owns no request. Keep its paused intent and
        // transcript visible; the next explicit resume rebuilds the new route.
        if (slot.desired === 'running') {
          void session.stop('preload-route-changed');
          void this.reconcile(slot);
        }
        continue;
      }
      if (
        session.sourceMode === 'asr' &&
        session.captureRouteKey !== undefined &&
        session.captureRouteKey !== routeKey
      ) {
        session.needsCaptureRefresh = true;
        void this.reconcile(slot);
      }
    }
  }

  page(tabId: number): PageState | undefined {
    return this.pages.get(tabId);
  }

  persistRecords(): void {
    if (this.recordsTimer) return;
    this.recordsTimer = setTimeout(() => {
      this.recordsTimer = undefined;
      const records: SessionRecord[] = [];
      for (const slot of this.slots.values()) {
        const s = slot.session;
        if (!s || s.isStopping || slot.desired === 'stopped') continue;
        records.push({
          tabId: slot.tabId,
          documentId: s.identity.documentId,
          navigationId: s.navigationId,
          videoId: s.identity.videoId,
          sessionId: s.identity.sessionId,
          desired: slot.desired,
          sourceMode: s.sourceMode,
          leaseId: s.capture?.leaseId,
          configRevision: s.identity.configRevision,
          savedAt: this.deps.now(),
        });
      }
      // 尚未被接管的恢复记录继续保留到恢复窗口结束。
      for (const r of this.recoveryRecords.values()) {
        if (!records.some((x) => x.tabId === r.tabId)) records.push(r);
      }
      this.recordsWrite = this.recordsWrite
        .then(() => this.deps.storage.session.set({ [RECORDS_KEY]: records }))
        .catch(() => undefined);
    }, 50);
  }

  private async bumpConfigRevision(): Promise<void> {
    this.configRevisionValue++;
    try {
      await this.deps.storage.session.set({ [CONFIG_REVISION_KEY]: this.configRevisionValue });
    } catch {
      // 仅影响重启后的恢复判断：版本不一致时不会恢复旧会话。
    }
  }

  private async refreshHostPermission(): Promise<void> {
    const generation = ++this.permissionCheckGeneration;
    const normalized = this.settingsValue.provider.baseUrl
      ? this.deps.normalizeBaseUrl(this.settingsValue.provider.baseUrl)
      : undefined;
    if (!normalized?.ok) {
      this.hostPermission = { granted: false, origin: undefined };
      return;
    }
    let granted: boolean;
    try {
      granted = await this.deps.permissions.contains(normalized.originPattern);
    } catch {
      granted = false;
    }
    if (generation === this.permissionCheckGeneration)
      this.hostPermission = { origin: normalized.origin, granted };
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** 权限变化按当前实际路由核验。浏览器网络失败不能代替释放采集与播音资源。 */
  private async onPermissionsChanged(): Promise<{ granted: boolean }> {
    this.search.cancelAll();
    const generation = ++this.permissionsChangeGeneration;
    const settings = this.settingsValue;
    const previous = this.hostPermission.granted;
    await this.refreshHostPermission();
    const local =
      settings.asr.backend === 'local'
        ? this.deps.normalizeBaseUrl(settings.asr.localUrl)
        : undefined;
    const localGranted = local?.ok
      ? await this.deps.permissions.contains(local.originPattern).catch(() => false)
      : true;
    if (generation !== this.permissionsChangeGeneration)
      return { granted: this.hostPermission.granted };
    if (settings !== this.settingsValue) return this.onPermissionsChanged();
    const providerMissing = !!settings.provider.baseUrl && !this.hostPermission.granted;
    if (previous !== this.hostPermission.granted || providerMissing || !localGranted) {
      this.connectionCheckAbort?.abort();
      this.modelDiscoveryAbort?.abort();
      this.lastConnectionReport = undefined;
      if (providerMissing || previous !== this.hostPermission.granted)
        this.resetProviderCapabilities();
      if (!localGranted) delete this.capabilities.localAsr;
      this.persistCapabilities();
    }
    for (const slot of this.slots.values()) {
      const session = slot.session;
      if (!session || session.isStopping) continue;
      if (!localGranted && session.sourceMode === 'none' && slot.startFingerprint !== undefined) {
        // 首次 ASR 权限查询尚未结束：中止旧查询，重建时会按当前权限重新选择来源。
        session.abortPending('permission-changed');
        void this.reconcile(slot);
      }
      if (
        !providerMissing &&
        !(['asr', 'asr-preload'].includes(session.sourceMode) && !localGranted)
      )
        continue;
      this.onFatal(session, {
        code: 'host-permission-revoked',
        category: 'permission',
        retryable: true,
        message:
          '服务访问权限已被撤回，翻译、捕获与配音已停止。请在设置页重新授权后点击「开始翻译」。',
      });
    }
    this.publish();
    return { granted: this.hostPermission.granted };
  }

  // ---------------------------------------------------------------------------
  // 端口接入
  // ---------------------------------------------------------------------------

  handleConnect(port: PortLike): void {
    const { deps } = this;
    if (port.name === PORT_CONTENT) {
      const sender = verifySender(port.sender, 'content', deps.runtimeId, deps.extensionOrigin);
      // 页面身份依赖 documentId（Chrome 106+ 提供）；缺失时无法区分页面重载，拒绝连接。
      if (!sender || sender.kind !== 'content' || !sender.documentId) return safeDisconnect(port);
      this.attachContent(port, sender);
      return;
    }
    if (port.name === PORT_UI) {
      const sender = verifySender(port.sender, 'ui', deps.runtimeId, deps.extensionOrigin);
      if (!sender || sender.kind !== 'ui') return safeDisconnect(port);
      this.attachUi(port, sender);
      return;
    }
    if (port.name === PORT_OFFSCREEN) {
      const sender = verifySender(port.sender, 'offscreen', deps.runtimeId, deps.extensionOrigin);
      if (!sender) return safeDisconnect(port);
      deps.offscreen.handlePort(port);
      return;
    }
    safeDisconnect(port);
  }

  private attachContent(port: PortLike, sender: VerifiedContentSender): void {
    const conn = new ContentConnection(port, sender, this.deps.randomId);
    let pageInstanceId: string | undefined;
    conn.onMessage((msg) => {
      void this.ready.then(() => {
        if (msg.type === 'hello') {
          pageInstanceId = msg.pageInstanceId;
          this.onContentHello(conn, msg);
          return;
        }
        const page = this.pages.get(conn.tabId);
        if (!pageInstanceId || !page || page.conn !== conn) return;
        this.onContentMessage(page, msg);
      });
    });
    conn.onDisconnect(() => {
      void this.ready.then(() => this.onContentDisconnect(conn));
    });
  }

  private onContentHello(
    conn: ContentConnection,
    msg: Extract<ContentToBackground, { type: 'hello' }>,
  ): void {
    const tabId = conn.tabId;
    const documentId = conn.documentId ?? `page:${msg.pageInstanceId}`;
    const existing = this.pages.get(tabId);
    if (existing && existing.conn !== conn) {
      // 同一标签页出现新的连接：旧连接失效。
      existing.conn.disconnect();
    }
    // 同一文档重新连接（例如端口重建）：保留导航身份，避免把同一视频当作新导航而结束暂停中的会话。
    const prev = existing && existing.documentId === documentId ? existing : undefined;
    const page: PageState = {
      tabId,
      documentId,
      pageInstanceId: msg.pageInstanceId,
      url: msg.url,
      conn,
      navigationId: prev?.navigationId ?? -1,
      videoId: prev?.videoId ?? null,
      title: prev?.title,
      channel: prev?.channel,
      durationMs: prev?.durationMs,
      player: prev?.player,
      isLive: prev?.isLive ?? false,
      isShorts: prev?.isShorts ?? false,
      tracks: prev?.tracks ?? [],
      captionsAvailability: prev?.captionsAvailability ?? 'unknown',
      connectedAt: this.deps.now(),
    };
    this.pages.set(tabId, page);
    conn.send({
      type: 'welcome',
      protocolVersion: CONTENT_PROTOCOL_VERSION,
      workerInstanceId: this.workerInstanceId,
    });
    conn.send({
      type: 'display/settings',
      captions: this.settingsValue.captions,
      targetLanguage: this.settingsValue.targetLanguage,
    });
    const slot = this.slots.get(tabId);
    if (slot?.session && slot.session.identity.documentId === documentId) {
      slot.session.pushSessionState();
      slot.session.pushFullCues();
    } else if (this.recoveryRecords.get(tabId)?.documentId !== documentId) {
      // 有待核对的恢复记录时不先下发「无会话」，避免恢复成功前覆盖层闪烁清空。
      conn.send({ type: 'session/state', session: null });
    }
    if (slot) void this.reconcile(slot);
    this.publish();
  }

  private onContentMessage(
    page: PageState,
    msg: Exclude<ContentToBackground, { type: 'hello' | 'reply' }>,
  ): void {
    const slot = this.slots.get(page.tabId);
    const session = slot?.session;
    switch (msg.type) {
      case 'page/video': {
        const changed = msg.navigationId !== page.navigationId;
        page.navigationId = msg.navigationId;
        page.videoId = msg.videoId;
        page.title = msg.title;
        page.channel = msg.channel;
        page.durationMs =
          msg.durationMs === undefined ? undefined : Math.min(msg.durationMs, MAX_MEDIA_TIME_MS);
        page.isLive = msg.isLive;
        page.isShorts = msg.isShorts;
        if (changed) {
          page.tracks = [];
          page.captionsAvailability = 'unknown';
          page.player = undefined;
          this.onNavigation(page);
        }
        break;
      }
      case 'player/state':
        if (msg.navigationId !== page.navigationId) return;
        page.player = msg.state;
        if (
          session &&
          session.navigationId === page.navigationId &&
          session.identity.documentId === page.documentId
        ) {
          session.onPlayerState(msg.state, msg.reason);
        }
        break;
      case 'captions/tracks':
        if (msg.navigationId !== page.navigationId || msg.videoId !== page.videoId) return;
        page.tracks = msg.tracks;
        page.captionsAvailability = msg.availability;
        session?.onTracksChanged();
        break;
      case 'captions/track-data':
        if (msg.navigationId !== page.navigationId || msg.videoId !== page.videoId) return;
        if (session && session.navigationId === page.navigationId) void session.onTrackData(msg);
        break;
      case 'captions/visible':
        if (session && session.navigationId === page.navigationId) session.onVisibleCaption(msg);
        break;
      case 'captions/error':
        if (msg.navigationId !== page.navigationId) return;
        session?.onCaptionError(msg.error);
        break;
    }
    this.publish();
  }

  private onNavigation(page: PageState): void {
    const slot = this.slots.get(page.tabId);
    if (slot) {
      slot.errorSnapshot = undefined;
      // 暂停中的会话不跨视频延续；运行中的会话在新视频上重新开始（新 sessionId）。
      if (slot.desired === 'paused') slot.desired = 'stopped';
      if (!page.videoId) slot.desired = 'stopped';
    }
    // worker 重启后的恢复：同一文档、同一导航序号、同一视频才恢复。
    const record = this.recoveryRecords.get(page.tabId);
    if (record) {
      this.recoveryRecords.delete(page.tabId);
      this.persistRecords();
      const samePage =
        this.deps.now() - record.savedAt < RECOVERY_WINDOW_MS &&
        record.documentId === page.documentId &&
        record.navigationId === page.navigationId &&
        record.videoId === page.videoId;
      const s = this.ensureSlot(page.tabId);
      let adoptLease = false;
      if (samePage && !s.session) {
        if (record.desired === 'running' && record.configRevision === this.configRevisionValue) {
          s.desired = 'running';
          s.recovery = record;
          adoptLease = true;
        } else if (record.desired === 'running') {
          // 后台重启期间设置已变化：不沿用旧会话，按新配置重新开始（识别来源可能需要重新点击扩展）。
          s.desired = 'running';
        } else {
          // 暂停中的会话不自动恢复（恢复识别捕获需要用户调用扩展）：给出明确提示。
          s.desired = 'stopped';
          s.errorSnapshot = this.syntheticSnapshot(
            {
              tabId: record.tabId,
              documentId: record.documentId,
              videoId: record.videoId,
              sessionId: record.sessionId,
              configRevision: record.configRevision,
              startedAt: record.savedAt,
            },
            {
              code: 'worker-restarted-paused',
              category: 'internal',
              retryable: true,
              message:
                '扩展后台已重启，暂停中的翻译无法自动恢复。请点击「开始翻译」重新开始，已保存的字幕记录不受影响。',
              at: this.deps.now(),
            },
          );
        }
      }
      if (record.leaseId && !adoptLease) {
        void this.deps.offscreen
          .request(
            { kind: 'capture/stop', leaseId: record.leaseId, reason: 'not-recovered' },
            5_000,
          )
          .catch(() => undefined);
      }
    }
    const target = this.slots.get(page.tabId);
    if (target) void this.reconcile(target);
  }

  private onContentDisconnect(conn: ContentConnection): void {
    const page = this.pages.get(conn.tabId);
    if (!page || page.conn !== conn) return;
    this.pages.delete(conn.tabId);
    const slot = this.slots.get(conn.tabId);
    if (slot) {
      // worker 存活期间内容脚本端口断开意味着页面卸载/重载/进入 bfcache：释放资源（T23）。
      slot.desired = 'stopped';
      void this.reconcile(slot);
    }
    this.publish();
  }

  onTabRemoved(tabId: number): void {
    void this.ready.then(() => {
      const page = this.pages.get(tabId);
      if (page) {
        this.pages.delete(tabId);
        page.conn.disconnect();
      }
      this.recoveryRecords.delete(tabId);
      const slot = this.slots.get(tabId);
      if (slot) {
        slot.desired = 'stopped';
        slot.errorSnapshot = undefined;
        void this.reconcile(slot).then(() => {
          if (!slot.session && !slot.loop) this.slots.delete(tabId);
          this.publish();
        });
      }
      this.persistRecords();
      this.publish();
    });
  }

  private attachUi(port: PortLike, sender: VerifiedExtensionSender): void {
    const conn = new UiConnection(port, sender);
    this.uiConnections.add(conn);
    conn.onMessage((msg) => {
      void this.ready.then(async () => {
        if (!conn.isConnected) return;
        switch (msg.type) {
          case 'subscribe':
            if (msg.protocolVersion !== UI_PROTOCOL_VERSION) return;
            conn.subscribed = true;
            // 递增版本：重连的 UI 可能已见过当前版本号，必须收到更大的版本才会接受。
            this.snapshotVersion++;
            conn.send({ type: 'snapshot', snapshot: this.buildSnapshot(this.snapshotVersion) });
            return;
          case 'cues/subscribe': {
            conn.cueSessionId = msg.sessionId;
            if (msg.sessionId) {
              const session = this.findSession(msg.sessionId);
              if (session) {
                conn.send({
                  type: 'cues',
                  sessionId: msg.sessionId,
                  cueVersion: session.cueVersion,
                  full: true,
                  cues: session.sortedCues(),
                });
              }
            }
            return;
          }
          case 'command': {
            try {
              const data = await this.handleCommand(msg.command, conn);
              conn.send({ type: 'result', requestId: msg.requestId, ok: true, data });
            } catch (error) {
              conn.send({
                type: 'result',
                requestId: msg.requestId,
                ok: false,
                error: toAppErrorInfo(error),
              });
            }
            return;
          }
        }
      });
    });
    conn.onDisconnect(() => {
      this.search.cancel(conn);
      this.uiConnections.delete(conn);
    });
  }

  // ---------------------------------------------------------------------------
  // 会话 reconcile
  // ---------------------------------------------------------------------------

  private ensureSlot(tabId: number): TabSlot {
    let slot = this.slots.get(tabId);
    if (!slot) {
      slot = { tabId, desired: 'stopped', dirty: false, intentSeq: 0 };
      this.slots.set(tabId, slot);
    }
    return slot;
  }

  private pageMatches(tabId: number, session: TranslationSession): boolean {
    const page = this.pages.get(tabId);
    return (
      !!page &&
      page.documentId === session.identity.documentId &&
      page.navigationId === session.navigationId &&
      page.videoId === session.identity.videoId
    );
  }

  /** 没有会话实例时用于展示错误或提示的快照（恢复失败、其他标签页占用等）。 */
  private syntheticSnapshot(
    base: {
      tabId: number;
      documentId: string;
      videoId: string;
      sessionId: string;
      configRevision: number;
      startedAt: number;
    },
    error: AppErrorInfo,
  ): SessionSnapshot {
    return {
      identity: {
        sessionId: base.sessionId,
        tabId: base.tabId,
        documentId: base.documentId,
        videoId: base.videoId,
        epoch: 0,
        configRevision: base.configRevision,
      },
      phase: 'error',
      desiredState: 'stopped',
      outputMode: this.settingsValue.outputMode,
      targetLanguage: this.settingsValue.targetLanguage,
      sourceMode: 'none',
      translation: { total: 0, done: 0, pending: 0, running: 0, failed: 0 },
      resources: { capture: 'none', asr: 'idle', tts: 'idle', activeTracks: 0, pendingRequests: 0 },
      error,
      cueVersion: 0,
      startedAt: base.startedAt,
      updatedAt: this.deps.now(),
    };
  }

  private findSession(sessionId: string): TranslationSession | undefined {
    for (const slot of this.slots.values()) {
      if (slot.session?.identity.sessionId === sessionId) return slot.session;
    }
    return undefined;
  }

  /** 请求收敛到最新意图。返回本轮循环结束的 promise。 */
  reconcile(slot: TabSlot): Promise<void> {
    slot.dirty = true;
    // 收敛循环可能正阻塞在启动/继续的等待上：不再需要时立即中止，而不是等到下一个检查点。
    const session = slot.session;
    if (
      session &&
      !session.isStopping &&
      (session.phase === 'starting' || session.phase === 'configuring')
    ) {
      const page = this.pages.get(slot.tabId);
      const pageMatches =
        page?.documentId === session.identity.documentId &&
        page?.navigationId === session.navigationId;
      const resuming = slot.startFingerprint === undefined;
      if (slot.desired === 'stopped' || !pageMatches || (resuming && slot.desired !== 'running')) {
        session.abortPending('superseded');
      }
    }
    if (!slot.loop) {
      slot.loop = (async () => {
        try {
          while (slot.dirty) {
            slot.dirty = false;
            await this.converge(slot);
          }
        } catch (error) {
          this.deps.logger.error(
            '[tongting] reconcile failed',
            error instanceof Error ? error.name : 'unknown',
          );
        } finally {
          slot.loop = undefined;
          this.publish();
          this.persistRecords();
        }
      })();
    }
    return slot.loop;
  }

  private async converge(slot: TabSlot): Promise<void> {
    let lastCreated: TranslationSession | undefined;
    for (let guard = 0; guard < 16; guard++) {
      const page = this.pages.get(slot.tabId);
      const session = slot.session;

      if (session) {
        const matchesPage =
          !!page &&
          page.documentId === session.identity.documentId &&
          page.navigationId === session.navigationId &&
          page.videoId === session.identity.videoId;
        if (!matchesPage || slot.desired === 'stopped' || session.isStopping) {
          await session.stop(matchesPage ? 'user-stop' : 'page-changed');
          if (slot.session === session) slot.session = undefined;
          if (page && page.documentId === session.identity.documentId) {
            page.conn.send({ type: 'session/state', session: null });
          }
          this.publish();
          continue;
        }
        if (slot.desired === 'running' && session.restartRequested) {
          await session.stop('source-config-changed');
          if (slot.session === session) slot.session = undefined;
          continue;
        }
        if (slot.desired === 'paused' && session.phase === 'running') {
          await session.pause();
          continue;
        }
        if (slot.desired === 'running' && session.phase === 'paused') {
          const intentAtResume = slot.intentSeq;
          const routeKey = this.asrRouteKey();
          slot.captureOperationKey = routeKey;
          try {
            await session.resume({
              stillWanted: () =>
                slot.session === session &&
                slot.desired === 'running' &&
                this.pageMatches(slot.tabId, session) &&
                this.asrRouteKey() === routeKey,
            });
          } catch (error) {
            const info = toAppErrorInfo(error);
            if (info.category !== 'cancelled') {
              // 保持暂停并说明下一步；期间若用户又有新操作，则按新意图继续收敛。
              session.error = info;
              if (slot.intentSeq === intentAtResume) slot.desired = 'paused';
            }
            this.publish();
          } finally {
            slot.captureOperationKey = undefined;
          }
          continue;
        }
        if (
          slot.desired === 'running' &&
          session.phase === 'running' &&
          session.needsCaptureRefresh
        ) {
          const intentAtRefresh = slot.intentSeq;
          const routeKey = this.asrRouteKey();
          slot.captureOperationKey = routeKey;
          try {
            await session.refreshCapture({
              stillWanted: () =>
                slot.session === session &&
                slot.desired === 'running' &&
                this.pageMatches(slot.tabId, session) &&
                this.asrRouteKey() === routeKey,
            });
          } catch (error) {
            const info = toAppErrorInfo(error);
            if (info.category !== 'cancelled') {
              session.error = info;
              if (slot.intentSeq === intentAtRefresh) slot.desired = 'paused';
            }
            this.publish();
          } finally {
            slot.captureOperationKey = undefined;
          }
          continue;
        }
        return;
      }

      if (slot.desired !== 'running') {
        // 会话创建前就收到暂停：没有可暂停的对象，意图归为停止。
        if (slot.desired === 'paused') slot.desired = 'stopped';
        return;
      }
      if (!page || !page.videoId || page.navigationId < 0) {
        // 没有可翻译的视频：等待页面上报；导航到非视频页时意图已被置为 stopped。
        return;
      }

      // 全局单会话：先释放其他标签页的会话。
      const others = [...this.slots.values()].filter(
        (s) => s !== slot && (s.session || s.desired !== 'stopped'),
      );
      if (others.length) {
        for (const other of others) {
          if (other.session && !other.session.isStopping) {
            // 被切走的标签页保留一条提示（T24/L5）。
            other.errorSnapshot = {
              ...other.session.snapshot(),
              phase: 'idle',
              desiredState: 'stopped',
              error: undefined,
              notice: {
                code: 'moved-to-other-tab',
                message: '翻译已切换到另一个标签页，本页已停止。',
                level: 'info',
              },
            };
          }
          other.desired = 'stopped';
          void this.reconcile(other);
        }
        await Promise.all(
          others.map((o) =>
            o.session
              ? withTimeout(o.session.whenStopped(), 15_000).catch(() => undefined)
              : Promise.resolve(),
          ),
        );
        if (others.some((o) => o.session)) {
          // 其他标签页的会话未能在时限内释放：不启动第二套资源，给出可见错误。
          slot.desired = 'stopped';
          slot.errorSnapshot = this.syntheticSnapshot(
            {
              tabId: slot.tabId,
              documentId: page.documentId,
              videoId: page.videoId,
              sessionId: this.deps.randomId('s'),
              configRevision: this.configRevisionValue,
              startedAt: this.deps.now(),
            },
            {
              code: 'other-session-stuck',
              category: 'internal',
              retryable: true,
              message:
                '另一个标签页的翻译未能及时停止，为避免重复占用音频与请求，本次未开始。请关闭或刷新另一个标签页后重试。',
              at: this.deps.now(),
            },
          );
          this.publish();
          return;
        }
        continue;
      }

      const recovery = slot.recovery;
      slot.recovery = undefined;
      const created = new TranslationSession(this, {
        sessionId: recovery?.sessionId ?? this.deps.randomId('s'),
        tabId: slot.tabId,
        documentId: page.documentId,
        videoId: page.videoId,
        navigationId: page.navigationId,
      });
      slot.session = created;
      slot.errorSnapshot = undefined;
      created.pushSessionState();
      this.publish();
      const intentAtStart = slot.intentSeq;
      const fingerprint = this.startFingerprint();
      slot.startFingerprint = fingerprint;
      try {
        await created.start({
          stillWanted: () =>
            slot.session === created &&
            slot.desired !== 'stopped' &&
            this.startFingerprint() === fingerprint &&
            this.pages.get(slot.tabId)?.documentId === created.identity.documentId &&
            this.pages.get(slot.tabId)?.navigationId === created.navigationId,
          recovery: recovery ? { leaseId: recovery.leaseId } : undefined,
        });
      } catch (error) {
        const info = toAppErrorInfo(error);
        if (info.category !== 'cancelled') {
          created.setError(info);
          slot.errorSnapshot = {
            ...created.snapshot(),
            phase: 'error',
            desiredState: 'stopped',
            error: info,
          };
          if (slot.intentSeq === intentAtStart) slot.desired = 'stopped';
        }
        await created.stop('start-failed');
        if (slot.session === created) slot.session = undefined;
        const p = this.pages.get(slot.tabId);
        if (p && p.documentId === created.identity.documentId)
          p.conn.send({ type: 'session/state', session: null });
        if (slot.errorSnapshot) slot.errorSnapshot = { ...slot.errorSnapshot, phase: 'error' };
        if (slot.startFingerprint === fingerprint) slot.startFingerprint = undefined;
        lastCreated = created;
        this.publish();
        continue;
      }
      if (slot.startFingerprint === fingerprint) slot.startFingerprint = undefined;
      this.persistRecords();
    }
    // 收敛轮次耗尽（反复启动失败/被取代）：停止并给出可见的错误，而不是静默保持「想要运行」。
    this.deps.logger.warn('[tongting] converge guard exhausted');
    if (slot.desired !== 'stopped') {
      slot.desired = 'stopped';
      const base = slot.session ?? lastCreated;
      const error: AppErrorInfo = {
        code: 'start-retry-exhausted',
        category: 'internal',
        retryable: true,
        message:
          '翻译多次启动未能完成，已停止。请刷新页面后重新开始；若反复出现，请在设置页检查服务配置。',
        at: this.deps.now(),
      };
      const lastPage = this.pages.get(slot.tabId);
      if (base) {
        slot.errorSnapshot = { ...base.snapshot(), phase: 'error', desiredState: 'stopped', error };
      } else if (lastPage?.videoId) {
        slot.errorSnapshot = this.syntheticSnapshot(
          {
            tabId: slot.tabId,
            documentId: lastPage.documentId,
            videoId: lastPage.videoId,
            sessionId: this.deps.randomId('s'),
            configRevision: this.configRevisionValue,
            startedAt: this.deps.now(),
          },
          error,
        );
      }
      if (slot.session) void this.reconcile(slot);
    }
  }

  onFatal(session: TranslationSession, error: AppErrorInfo): void {
    for (const slot of this.slots.values()) {
      if (slot.session !== session) continue;
      session.setError(error);
      slot.errorSnapshot = {
        ...session.snapshot(),
        phase: 'error',
        desiredState: 'stopped',
        error,
      };
      slot.desired = 'stopped';
      // 同步进入停止：调度器、配音与在途请求立即中止，不等收敛循环排队。
      // 错误快照取自出错时刻；停止完成后按真实释放结果更新资源字段，避免把已停止的捕获显示为进行中。
      void session.stop('fatal').then(
        () => {
          const snap = slot.errorSnapshot;
          if (!snap || snap.identity.sessionId !== session.identity.sessionId) return;
          slot.errorSnapshot = { ...snap, resources: session.snapshot().resources };
          this.publish();
        },
        () => undefined,
      );
      void this.reconcile(slot);
    }
    this.publish();
  }

  saveDetectedProtocol(protocol: 'responses' | 'chat'): void {
    const provider = this.settingsValue.provider;
    const revision = this.configRevisionValue;
    const generation = this.credentialGeneration;
    void this.mutate(async () => {
      if (revision !== this.configRevisionValue || generation !== this.credentialGeneration) return;
      const current = this.settingsValue.provider;
      if (
        current.protocol !== 'auto' ||
        current.baseUrl !== provider.baseUrl ||
        current.model !== provider.model
      )
        return;
      const previous = current.detectedProtocol;
      if (previous === protocol) return;
      this.settingsValue = applySettingsPatch(this.settingsValue, {
        provider: { detectedProtocol: protocol },
      });
      this.settingsPersisted = await saveSettings(this.deps.storage.local, this.settingsValue);
      if (previous !== undefined) {
        await this.bumpConfigRevision();
        this.applyTranslationConfigToSessions();
      }
      this.publish();
    });
  }

  // ---------------------------------------------------------------------------
  // offscreen
  // ---------------------------------------------------------------------------

  private onOffscreenEvent(event: OffscreenEvent): void {
    void this.ready.then(() => {
      if (event.kind === 'status') {
        this.onOffscreenHello(event.status);
        return;
      }
      for (const slot of this.slots.values()) slot.session?.onOffscreenEvent(event);
    });
  }

  /** offscreen 端口断开或文档消失：持有捕获的会话立即报错（T22），不等续租超时。 */
  private onOffscreenLost(): void {
    for (const slot of this.slots.values()) {
      const session = slot.session;
      if (!session?.capture || session.capture.state !== 'active' || session.isStopping) continue;
      this.onFatal(session, {
        code: 'offscreen-lost',
        category: 'audio',
        retryable: true,
        message: '音频处理组件意外中断，已停止语音识别。请重新开始翻译。',
        at: this.deps.now(),
      });
    }
  }

  /** offscreen 连接/状态：核对租约归属，孤立资源限期停止（T21）。 */
  private onOffscreenHello(status: OffscreenStatus): void {
    const lease = status.lease;
    const prevInstance = this.lastOffscreenInstanceId;
    this.lastOffscreenInstanceId = status.offscreenInstanceId;
    if (prevInstance !== undefined && prevInstance !== status.offscreenInstanceId) {
      // offscreen 文档已被重建：旧文档中的捕获必然已丢失，持有租约的会话立即报错（T22），不等续租超时。
      for (const slot of this.slots.values()) {
        const session = slot.session;
        if (!session?.capture || session.capture.state !== 'active' || session.isStopping) continue;
        if (lease?.leaseId === session.capture.leaseId) continue;
        this.onFatal(session, {
          code: 'offscreen-lost',
          category: 'audio',
          retryable: true,
          message: '音频处理组件意外中断，已停止语音识别。请重新开始翻译。',
          at: this.deps.now(),
        });
      }
    }
    if (!lease) return;
    for (const slot of this.slots.values()) {
      if (slot.session?.capture?.leaseId === lease.leaseId) return;
    }
    const record = [...this.recoveryRecords.values()].find(
      (r) => r.leaseId === lease.leaseId && r.sessionId === lease.owner.sessionId,
    );
    const stopOrphan = () => {
      this.orphanTimers.delete(lease.leaseId);
      for (const slot of this.slots.values()) {
        if (slot.session?.capture?.leaseId === lease.leaseId) return;
      }
      void this.deps.offscreen
        .request({ kind: 'capture/stop', leaseId: lease.leaseId, reason: 'orphaned' }, 5_000)
        .catch(() => undefined);
    };
    if (record && this.deps.now() - record.savedAt < RECOVERY_WINDOW_MS) {
      if (!this.orphanTimers.has(lease.leaseId)) {
        // offscreen 在新 worker 握手后只给很短的宽限；恢复会话接管前先把租约延长到孤立资源宽限期末尾。
        void this.deps.offscreen
          .request(
            { kind: 'lease/renew', leaseId: lease.leaseId, ttlMs: ORPHAN_LEASE_GRACE_MS + 5_000 },
            5_000,
          )
          .catch(() => undefined);
        this.orphanTimers.set(lease.leaseId, setTimeout(stopOrphan, ORPHAN_LEASE_GRACE_MS));
      }
      return;
    }
    stopOrphan();
  }

  // ---------------------------------------------------------------------------
  // 命令
  // ---------------------------------------------------------------------------

  async handleCommand(command: UiCommand, owner: object = this): Promise<unknown> {
    await this.ready;
    switch (command.kind) {
      case 'search/generate':
        if (owner instanceof UiConnection && !owner.isConnected) throw cancelledError();
        return this.search.generate(owner, command.operationId, command.query);
      case 'search/cancel':
        this.search.cancel(owner, command.operationId);
        return { cancelled: true };
      case 'search/history':
        return this.search.list();
      case 'search/clear-history':
        return this.search.clear();
      case 'session/start':
        return this.setDesired(command.tabId, 'running', true);
      case 'session/resume':
        return this.setDesired(command.tabId, 'running', false, command.sessionId);
      case 'session/pause':
        return this.setDesired(command.tabId, 'paused', false, command.sessionId);
      case 'session/stop':
        return this.setDesired(command.tabId, 'stopped', false, command.sessionId);
      case 'session/retry-failed': {
        this.assertCurrentSession(command.tabId, command.sessionId);
        const session = this.slots.get(command.tabId)?.session;
        return {
          retried: session?.retryFailed() ?? 0,
        } satisfies CommandHandlerResult<'session/retry-failed'>;
      }
      case 'session/backfill': {
        this.assertCurrentSession(command.tabId, command.sessionId);
        const session = this.slots.get(command.tabId)?.session;
        if (!session) {
          throw new AppError({
            code: 'no-session',
            category: 'cancelled',
            retryable: false,
            message: '当前标签页没有进行中的翻译。',
          });
        }
        session.setBackfill(command.enabled);
        return { enabled: command.enabled } satisfies CommandHandlerResult<'session/backfill'>;
      }
      case 'player/seek': {
        const page = this.pages.get(command.tabId);
        if (!page?.videoId) {
          throw new AppError({
            code: 'no-source-tab',
            category: 'youtube',
            retryable: false,
            message: '源视频标签页不可用，无法跳转。',
          });
        }
        await page.conn.request(
          { kind: 'player/seek', videoId: page.videoId, timeMs: command.timeMs },
          5_000,
          page.navigationId,
        );
        return { accepted: true };
      }
      case 'settings/update':
        return this.mutate(() => this.updateSettings(command.patch));
      case 'settings/reset':
        return this.mutate(() => this.replaceSettings(defaultSettings()));
      case 'credentials/set': {
        const intent = ++this.apiKeyIntent;
        return this.mutate(() => this.setApiKey(command.apiKey, command.remember, intent));
      }
      case 'credentials/clear': {
        const intent = ++this.apiKeyIntent;
        const revocation = beginSecretRevocation(this.deps.storage, 'apiKey');
        // 删除的物理取消不排在可能缓慢的存储操作后面。
        this.apiKeyState = { value: undefined, storage: 'none', cleanupPending: true };
        this.invalidateCredentials('apiKey');
        this.resetProviderCapabilities();
        this.applyTranslationConfigToSessions();
        this.afterConfigChange();
        this.publish();
        return this.mutate(() => this.clearApiKey(intent, revocation));
      }
      case 'asr/set-token': {
        const intent = ++this.asrTokenIntent;
        return this.mutate(() => this.setAsrToken(command.token, intent));
      }
      case 'asr/clear-token': {
        const intent = ++this.asrTokenIntent;
        const revocation = beginSecretRevocation(this.deps.storage, 'asrToken');
        this.invalidateCredentials('asrToken');
        this.asrTokenState = { value: undefined, storage: 'none', cleanupPending: true };
        this.afterConfigChange();
        this.publish();
        return this.mutate(async () => {
          const cleared = await clearSecret(this.deps.storage, 'asrToken', revocation);
          if (intent === this.asrTokenIntent) this.asrTokenState.cleanupPending = !cleared;
          this.publish();
          if (!cleared) throw secretCleanupError();
          return { cleared: true };
        });
      }
      case 'permissions/changed':
        return this.onPermissionsChanged();
      case 'connection/check':
        return this.runConnectionCheck(command.scope, command.allowBilledAudioProbe);
      case 'models/discover':
        return this.discoverModels();
      case 'tts/voices': {
        const voices = await this.deps.systemTts.getVoices();
        this.setCapability('systemTts', this.systemTtsCapability(voices));
        return { voices };
      }
      case 'tts/preview':
        return this.previewVoice(command.text, command.voiceName, command.rate);
      case 'tts/stop-preview':
        this.cancelVoicePreview();
        return { stopped: true };
      case 'cache/clear':
        await this.deps.translationCache.clear();
        return { cleared: true };
    }
  }

  /** 命令携带的 sessionId 与当前会话（或错误快照）不一致：界面状态已过期，拒绝执行。 */
  private assertCurrentSession(tabId: number, sessionId: string | undefined): void {
    if (sessionId === undefined) return;
    const slot = this.slots.get(tabId);
    const current = slot?.session?.identity.sessionId ?? slot?.errorSnapshot?.identity.sessionId;
    if (current !== sessionId) {
      throw new AppError({
        code: 'stale-session',
        category: 'cancelled',
        retryable: false,
        message: '翻译状态已变化，界面已刷新，请确认后重试。',
      });
    }
  }

  private async setDesired(
    tabId: number,
    desired: DesiredState,
    explicitStart: boolean,
    sessionId?: string,
  ): Promise<{ accepted: true }> {
    this.assertCurrentSession(tabId, sessionId);
    let page = this.pages.get(tabId);
    if (explicitStart && (!page || !page.videoId)) {
      // worker 被回收后内容脚本尚未重连：先唤醒页面，短暂等待其登记。
      page = await this.wakePage(tabId);
    }
    if (desired !== 'stopped' && (!page || !page.videoId)) {
      throw new AppError({
        code: 'no-video',
        category: 'youtube',
        retryable: false,
        message:
          '当前标签页不是可播放的 YouTube 视频页，或页面尚未连接。请打开视频页面后重试（必要时刷新页面）。',
      });
    }
    const slot = this.ensureSlot(tabId);
    if (!explicitStart && desired !== 'stopped' && !slot.session && slot.desired === 'stopped') {
      // 暂停/继续只作用于已有会话（或正在创建的会话）；不得借此隐式开始翻译。
      throw new AppError({
        code: 'no-session',
        category: 'cancelled',
        retryable: false,
        message: '当前标签页没有进行中的翻译，请点击「开始翻译」。',
      });
    }
    if (explicitStart || desired === 'stopped') slot.errorSnapshot = undefined;
    const current = slot.session;
    if (
      explicitStart &&
      current &&
      (current.phase === 'running' || current.phase === 'paused') &&
      !current.isStopping &&
      !current.restartRequested &&
      this.pageMatches(tabId, current) &&
      current.snapshot().playbackBuffer?.state === 'blocked'
    ) {
      // The error callout sends session/start for an explicit retry. A preloader
      // error keeps the session alive, so merely setting desired=running would
      // otherwise never dispatch another request.
      current.retryFailed();
    }
    slot.desired = desired;
    slot.intentSeq++;
    void this.reconcile(slot);
    this.publish();
    return { accepted: true };
  }

  private async wakePage(tabId: number, timeoutMs = 1_500): Promise<PageState | undefined> {
    await this.deps.tabs.wake(tabId).catch(() => undefined);
    const deadline = this.deps.now() + timeoutMs;
    for (;;) {
      const page = this.pages.get(tabId);
      if (page?.videoId && page.navigationId >= 0) return page;
      if (this.deps.now() >= deadline) return page;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  private async updateSettings(patch: SettingsPatch): Promise<{ persisted: boolean }> {
    let next: Settings;
    try {
      next = applySettingsPatch(this.settingsValue, patch);
    } catch {
      throw new AppError({
        code: 'invalid-settings',
        category: 'config',
        retryable: false,
        message: '设置值无效，未应用。',
      });
    }
    return this.replaceSettings(next);
  }

  private async replaceSettings(next: Settings): Promise<{ persisted: boolean }> {
    const prev = this.settingsValue;
    this.settingsValue = next;
    const translationChanged = translationFingerprint(prev) !== translationFingerprint(next);
    const schedulingChanged =
      prev.prefetch !== next.prefetch ||
      prev.cacheTranslations !== next.cacheTranslations ||
      prev.provider.timeoutMs !== next.provider.timeoutMs ||
      prev.provider.streaming !== next.provider.streaming;
    const providerChanged = JSON.stringify(prev.provider) !== JSON.stringify(next.provider);
    const asrChanged = JSON.stringify(prev.asr) !== JSON.stringify(next.asr);
    const ttsChanged = JSON.stringify(prev.tts) !== JSON.stringify(next.tts);
    if (providerChanged) {
      this.search.cancelAll();
      this.connectionCheckAbort?.abort();
      this.modelDiscoveryAbort?.abort();
      this.resetProviderCapabilities();
    }
    if (asrChanged || ttsChanged || prev.targetLanguage !== next.targetLanguage) {
      this.connectionCheckAbort?.abort();
      this.lastConnectionReport = undefined;
      if (asrChanged) {
        delete this.capabilities.asr;
        delete this.capabilities.localAsr;
      }
      if (ttsChanged || prev.targetLanguage !== next.targetLanguage) {
        delete this.capabilities.tts;
        delete this.capabilities.systemTts;
      }
      this.persistCapabilities();
    }
    // 来源变更不会继续原来的采集；暂停中的会话到恢复时才按新来源重建。
    if (
      prev.sourceStrategy !== next.sourceStrategy ||
      prev.sourceLanguage !== next.sourceLanguage ||
      prev.playbackMode !== next.playbackMode
    ) {
      for (const slot of this.slots.values()) {
        const session = slot.session;
        if (!session || session.isStopping) continue;
        if (
          prev.sourceStrategy !== next.sourceStrategy ||
          prev.playbackMode !== next.playbackMode ||
          session.sourceMode !== 'asr'
        ) {
          session.restartRequested = true;
          if (slot.desired === 'running') {
            void session.stop('source-config-changed');
            void this.reconcile(slot);
          }
        }
      }
    }
    this.afterConfigChange();
    for (const slot of this.slots.values())
      slot.session?.onNonTranslationSettingsChanged(prev, next);
    let persisted = await saveSettings(this.deps.storage.local, next);
    if (providerChanged) await this.refreshHostPermission();
    if (prev.rememberCredentials !== next.rememberCredentials) {
      persisted = (await this.moveSecrets(next.rememberCredentials)) && persisted;
    }
    this.settingsPersisted = persisted;
    if (translationChanged) {
      await this.bumpConfigRevision();
      this.applyTranslationConfigToSessions();
    } else if (schedulingChanged) {
      for (const slot of this.slots.values()) {
        const provider = this.providerForSessions();
        if (slot.session && provider) slot.session.onSchedulingSettingsChanged(next, provider);
      }
    }
    this.afterConfigChange();
    if (prev.targetLanguage !== next.targetLanguage && this.capabilities.systemTts) {
      // 系统语音能力按目标语言判定：语言变化后旧结论作废。
      delete this.capabilities.systemTts;
      this.persistCapabilities();
    }
    if (
      JSON.stringify(prev.captions) !== JSON.stringify(next.captions) ||
      prev.targetLanguage !== next.targetLanguage
    ) {
      for (const page of this.pages.values()) {
        page.conn.send({
          type: 'display/settings',
          captions: next.captions,
          targetLanguage: next.targetLanguage,
        });
      }
    }
    this.publish();
    return { persisted };
  }

  /**
   * 系统语音能力按当前目标语言判定，与配音控制器共用 voices.ts 的匹配规则
   * （例如普通话目标不计入粤语声音）；「有声音」不等于朗读效果已验证。
   */
  private systemTtsCapability(voices: readonly TtsVoice[]): ProviderCapability {
    const lang = this.settingsValue.targetLanguage;
    const matching = voices.filter((v) => voiceLanguageRank(v, lang, false) >= 0);
    return {
      status: matching.length ? 'verified' : 'unsupported',
      configRevision: this.configRevisionValue,
      checkedAt: new Date(this.deps.now()).toISOString(),
      reasonCode: matching.length ? undefined : 'no-voice-for-language',
      message: matching.length
        ? `系统语音中有 ${matching.length} 个可用于当前目标语言的声音（实际朗读效果请试听确认）。`
        : '系统语音中没有当前目标语言的声音，配音将不可用，仅显示字幕。',
    };
  }

  /** 其他配置齐全，只差自动协议探测结果。 */
  private needsProtocolDetection(): boolean {
    const s = this.settingsValue;
    return (
      s.provider.protocol === 'auto' &&
      !s.provider.detectedProtocol &&
      !!s.provider.model &&
      !!this.apiKeyState.value &&
      !!s.provider.baseUrl &&
      this.deps.normalizeBaseUrl(s.provider.baseUrl).ok
    );
  }

  private providerForSessions() {
    const s = this.settingsValue;
    const apiKey = this.apiKeyState.value;
    const normalized = s.provider.baseUrl
      ? this.deps.normalizeBaseUrl(s.provider.baseUrl)
      : undefined;
    const protocol =
      s.provider.protocol === 'auto' ? s.provider.detectedProtocol : s.provider.protocol;
    if (!normalized?.ok || !apiKey || !protocol || !s.provider.model) return undefined;
    return this.textProvider({
      baseUrl: normalized.baseUrl,
      apiKey,
      protocol,
      model: s.provider.model,
      reasoningEffort: s.provider.reasoningEffort,
      streaming: s.provider.streaming,
    });
  }

  /**
   * 配置与凭证未变时复用同一 provider 实例：调度器据此判断无需中止在途请求，避免重复计费。
   * 缓存只在 worker 内存中，Key 不持久化、不进入快照。
   */
  textProvider(config: TextProviderConfig): TextProvider {
    const { apiKey, ...rest } = config;
    const key = JSON.stringify(rest);
    const cached = this.sessionProvider;
    if (cached && cached.key === key && cached.apiKey === apiKey) return cached.provider;
    const provider = this.deps.createTextProvider(config);
    this.sessionProvider = { key, apiKey, provider };
    return provider;
  }

  /** 译文相关配置或凭证变化后：新 provider 生效；配置不可用则结束会话并说明原因（T28）。 */
  private applyTranslationConfigToSessions(): void {
    const provider = this.providerForSessions();
    for (const slot of this.slots.values()) {
      const session = slot.session;
      if (!session || session.isStopping) continue;
      if (!provider && this.hostPermission.granted && this.needsProtocolDetection()) {
        // 自动协议下修改了服务地址：探测结果已清除，按新地址重新启动会话（重新探测协议），而不是报错停止（L3）。
        void session.stop('config-changed');
        void this.reconcile(slot);
        continue;
      }
      if (!provider || !this.hostPermission.granted) {
        this.onFatal(session, {
          code: 'config-invalid-while-running',
          category: 'config',
          retryable: false,
          message:
            '服务配置已变化且当前不可用（地址、Key、协议、模型或访问权限缺失），已停止翻译。请完成设置后重新开始。',
          at: this.deps.now(),
        });
        continue;
      }
      session.onTranslationConfigChanged(this.settingsValue, this.configRevisionValue, provider);
    }
  }

  private async setApiKey(
    apiKey: string,
    remember: boolean,
    intent: number,
  ): Promise<UiCommandResultMap['credentials/set']> {
    if (intent !== this.apiKeyIntent) throw cancelledError('credential superseded');
    const trimmed = apiKey.trim();
    if (!trimmed)
      throw new AppError({
        code: 'empty-key',
        category: 'config',
        retryable: false,
        message: 'API Key 不能为空。',
      });
    const rememberChanged = remember !== this.settingsValue.rememberCredentials;
    if (rememberChanged) {
      this.settingsValue = applySettingsPatch(this.settingsValue, {
        rememberCredentials: remember,
      });
      this.settingsPersisted = await saveSettings(this.deps.storage.local, this.settingsValue);
    }
    if (intent !== this.apiKeyIntent) throw cancelledError('credential superseded');
    let persisted = await saveSecret(this.deps.storage, 'apiKey', trimmed, remember);
    if (rememberChanged) persisted &&= this.settingsPersisted;
    if (intent !== this.apiKeyIntent) throw cancelledError('credential superseded');
    // Key 与代数在同一个同步步骤生效；持久化期间仍保持旧值/旧代数一致。
    // 即使持久化失败，也在内存中生效，并如实告知未保存。
    this.apiKeyState = {
      value: trimmed,
      storage: persisted ? (remember ? 'local' : 'session') : 'none',
      cleanupPending: !persisted || undefined,
    };
    this.invalidateCredentials('apiKey');
    this.resetProviderCapabilities();
    // Key 不改变译文内容：保留已完成译文，用新凭证的 provider 替换，旧 provider 的在途请求由调度器立即中止（T28）。
    const provider = this.providerForSessions();
    for (const slot of this.slots.values()) {
      const session = slot.session;
      if (!session || session.isStopping) continue;
      if (!provider && this.hostPermission.granted && this.needsProtocolDetection()) {
        // 自动协议下修改了服务地址：探测结果已清除，按新地址重新启动会话（重新探测协议），而不是报错停止（L3）。
        void session.stop('config-changed');
        void this.reconcile(slot);
        continue;
      }
      if (!provider || !this.hostPermission.granted) {
        this.onFatal(session, {
          code: 'config-invalid-while-running',
          category: 'config',
          retryable: false,
          message:
            '服务配置已变化且当前不可用（地址、Key、协议、模型或访问权限缺失），已停止翻译。请完成设置后重新开始。',
          at: this.deps.now(),
        });
        continue;
      }
      session.onSchedulingSettingsChanged(this.settingsValue, provider);
    }
    this.afterConfigChange();
    this.publish();
    // 新凭证已更新 provider 并取消旧启动操作，再执行不改变凭证内容的存储位置迁移。
    if (rememberChanged && this.asrTokenState.value) {
      const tokenIntent = this.asrTokenIntent;
      const ok = await saveSecret(
        this.deps.storage,
        'asrToken',
        this.asrTokenState.value,
        remember,
      );
      persisted &&= ok;
      if (tokenIntent === this.asrTokenIntent)
        this.asrTokenState = {
          value: this.asrTokenState.value,
          storage: ok ? (remember ? 'local' : 'session') : 'none',
          cleanupPending: !ok || undefined,
        };
    }
    if (intent !== this.apiKeyIntent) throw cancelledError('credential superseded');
    this.publish();
    return { persisted, storage: remember ? 'local' : 'session' };
  }

  private async clearApiKey(
    intent: number,
    revocation: SecretRevocation,
  ): Promise<{ cleared: true }> {
    const cleared = await clearSecret(this.deps.storage, 'apiKey', revocation);
    if (intent === this.apiKeyIntent) this.apiKeyState.cleanupPending = !cleared;
    await this.bumpConfigRevision();
    this.publish();
    if (!cleared) throw secretCleanupError();
    return { cleared: true };
  }

  private async setAsrToken(token: string, intent: number): Promise<{ persisted: boolean }> {
    if (intent !== this.asrTokenIntent) throw cancelledError('credential superseded');
    this.invalidateCredentials('asrToken');
    const remember = this.settingsValue.rememberCredentials;
    const persisted = await saveSecret(this.deps.storage, 'asrToken', token, remember);
    if (intent !== this.asrTokenIntent) throw cancelledError('credential superseded');
    this.asrTokenState = {
      value: token,
      storage: persisted ? (remember ? 'local' : 'session') : 'none',
      cleanupPending: !persisted || undefined,
    };
    this.setCapability('localAsr', { status: 'unknown', configRevision: this.configRevisionValue });
    this.afterConfigChange();
    this.publish();
    return { persisted };
  }

  private async moveSecrets(remember: boolean): Promise<boolean> {
    let persisted = true;
    if (this.apiKeyState.value) {
      const intent = this.apiKeyIntent;
      const ok = await saveSecret(this.deps.storage, 'apiKey', this.apiKeyState.value, remember);
      persisted &&= ok;
      if (intent === this.apiKeyIntent)
        this.apiKeyState = {
          value: this.apiKeyState.value,
          storage: ok ? (remember ? 'local' : 'session') : 'none',
          cleanupPending: !ok || undefined,
        };
    }
    if (this.asrTokenState.value) {
      const intent = this.asrTokenIntent;
      const ok = await saveSecret(
        this.deps.storage,
        'asrToken',
        this.asrTokenState.value,
        remember,
      );
      persisted &&= ok;
      if (intent === this.asrTokenIntent)
        this.asrTokenState = {
          value: this.asrTokenState.value,
          storage: ok ? (remember ? 'local' : 'session') : 'none',
          cleanupPending: !ok || undefined,
        };
    }
    return persisted;
  }

  private resetProviderCapabilities(): void {
    for (const key of TEXT_CAPABILITY_KEYS) delete this.capabilities[key];
    this.lastConnectionReport = undefined;
    this.persistCapabilities();
  }

  private setCapability(key: CapabilityKey, value: ProviderCapability): void {
    this.capabilities[key] = value;
    this.persistCapabilities();
    this.publish();
  }

  private persistCapabilities(): void {
    void this.deps.storage.session
      .set({ [CAPABILITIES_KEY]: this.capabilities })
      .catch(() => undefined);
  }

  private async runConnectionCheck(
    scope: 'text' | 'asr' | 'tts' | 'all',
    allowBilledAudioProbe = false,
  ): Promise<ConnectionReport> {
    this.connectionCheckAbort?.abort();
    const controller = new AbortController();
    this.connectionCheckAbort = controller;
    const revision = this.configRevisionValue;
    const generation = this.credentialGeneration;
    const settingsAtCheck = JSON.stringify([
      this.settingsValue.provider,
      this.settingsValue.asr,
      this.settingsValue.tts,
      this.settingsValue.targetLanguage,
    ]);
    const checkedAt = this.deps.now();
    const items: ConnectionCheckItem[] = [];
    let detectedProtocol: 'responses' | 'chat' | undefined;
    let models: string[] | undefined;

    if (scope === 'text' || scope === 'all') {
      await this.refreshHostPermission();
      const result = await this.deps.runTextConnectionCheck({
        provider: this.settingsValue.provider,
        apiKey: this.apiKeyState.value,
        hasHostPermission: this.hostPermission.granted,
        signal: controller.signal,
        includeStreaming: this.settingsValue.provider.streaming,
      });
      items.push(...result.items);
      detectedProtocol = result.detectedProtocol;
      models = result.models;
    }
    if (scope === 'asr' || scope === 'all') {
      items.push(await this.checkAsr(controller.signal, allowBilledAudioProbe));
    }
    if (scope === 'tts' || scope === 'all') {
      const voices = await this.deps.systemTts.getVoices().catch(() => []);
      const capability = this.systemTtsCapability(voices);
      items.push({
        key: 'systemTts',
        status: capability.status,
        message: capability.message ?? '',
      });
      if (this.settingsValue.tts.backend === 'sub2api') {
        items.push(await this.checkSub2apiTts(controller.signal, allowBilledAudioProbe));
      }
    }

    if (
      controller.signal.aborted ||
      revision !== this.configRevisionValue ||
      generation !== this.credentialGeneration ||
      settingsAtCheck !==
        JSON.stringify([
          this.settingsValue.provider,
          this.settingsValue.asr,
          this.settingsValue.tts,
          this.settingsValue.targetLanguage,
        ])
    ) {
      throw new AppError({
        code: 'check-superseded',
        category: 'cancelled',
        retryable: true,
        message: '配置已变化，本次检查结果作废，请重新检查。',
      });
    }
    const iso = new Date(checkedAt).toISOString();
    for (const item of items) {
      this.capabilities[item.key] = {
        status: item.status,
        checkedAt: iso,
        configRevision: revision,
        reasonCode: item.reasonCode,
        message: item.message,
        latencyMs: item.latencyMs,
      };
    }
    if (detectedProtocol) this.saveDetectedProtocol(detectedProtocol);
    const report: ConnectionReport = {
      checkedAt,
      configRevision: revision,
      credentialGeneration: generation,
      items,
      detectedProtocol,
      models: models?.slice(0, 1_000),
    };
    this.lastConnectionReport = report;
    this.persistCapabilities();
    this.publish();
    return report;
  }

  /** sub2api 音频接口公共前置条件；不满足时返回失败项，满足时返回调用参数。 */
  private async sub2apiAudioRoute(
    key: 'asr' | 'tts',
    model: string,
  ): Promise<ConnectionCheckItem | { baseUrl: string; apiKey: string; model: string }> {
    const s = this.settingsValue;
    const normalized = s.provider.baseUrl
      ? this.deps.normalizeBaseUrl(s.provider.baseUrl)
      : undefined;
    if (!normalized?.ok)
      return {
        key,
        status: 'failed',
        message: '请先填写有效的 sub2api 服务地址。',
        reasonCode: 'invalid-url',
      };
    const apiKey = this.apiKeyState.value;
    if (!apiKey)
      return {
        key,
        status: 'failed',
        message: '请先填写 API Key。',
        reasonCode: 'missing-api-key',
      };
    if (!model.trim())
      return { key, status: 'failed', message: '请先填写模型 ID。', reasonCode: 'model-missing' };
    await this.refreshHostPermission();
    if (!this.hostPermission.granted) {
      return {
        key,
        status: 'failed',
        message: '尚未授予访问服务地址的权限。',
        reasonCode: 'host-permission-missing',
      };
    }
    return { baseUrl: normalized.baseUrl, apiKey, model };
  }

  private notProbed(key: 'asr' | 'tts', what: string): ConnectionCheckItem {
    return {
      key,
      status: 'unknown',
      message: `检查 sub2api ${what}需要一次实际调用（可能产生少量费用）；勾选「允许实际调用」后重新检查。`,
      reasonCode: 'not-probed',
    };
  }

  private async checkSub2apiAsr(
    signal: AbortSignal,
    allowBilled: boolean,
  ): Promise<ConnectionCheckItem> {
    if (!allowBilled) return this.notProbed('asr', '语音识别');
    const route = await this.sub2apiAudioRoute('asr', this.settingsValue.asr.sub2apiModel);
    if ('key' in route) return route;
    try {
      const result = await this.deps.probeSub2apiTranscription({ ...route, signal });
      return {
        key: 'asr',
        status: 'verified',
        message: `识别接口调用成功（测试音频为 1 秒合成音，只验证接口与认证，不代表识别准确度${result.text ? '' : '；返回文本为空属正常'}）。`,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      const info = toAppErrorInfo(error, { category: 'asr' });
      return { key: 'asr', status: 'failed', message: info.message, reasonCode: info.code };
    }
  }

  private async checkSub2apiTts(
    signal: AbortSignal,
    allowBilled: boolean,
  ): Promise<ConnectionCheckItem> {
    if (!allowBilled) return this.notProbed('tts', '语音合成');
    const s = this.settingsValue;
    const route = await this.sub2apiAudioRoute('tts', s.tts.sub2apiModel);
    if ('key' in route) return route;
    try {
      const result = await this.deps.probeSub2apiSpeech({
        ...route,
        voice: s.tts.sub2apiVoice,
        text: s.targetLanguage.startsWith('zh') ? '你好' : 'Hello',
        signal,
      });
      return {
        key: 'tts',
        status: 'verified',
        message: `合成接口返回了 ${Math.round(result.bytes / 1024)} KB 音频（${result.contentType || '未知格式'}）；声音效果请在视频中试听确认。`,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      const info = toAppErrorInfo(error, { category: 'tts' });
      return { key: 'tts', status: 'failed', message: info.message, reasonCode: info.code };
    }
  }

  private async checkAsr(
    signal: AbortSignal,
    allowBilledAudioProbe = false,
  ): Promise<ConnectionCheckItem> {
    const asr = this.settingsValue.asr;
    if (asr.backend === 'none') {
      return {
        key: 'localAsr',
        status: 'unknown',
        message: '未启用语音识别服务；无字幕视频将无法翻译。',
        reasonCode: 'not-configured',
      };
    }
    if (asr.backend === 'sub2api') return this.checkSub2apiAsr(signal, allowBilledAudioProbe);
    const normalized = this.deps.normalizeBaseUrl(asr.localUrl);
    if (!normalized.ok)
      return {
        key: 'localAsr',
        status: 'failed',
        message: '本地识别服务地址无效。',
        reasonCode: 'invalid-url',
      };
    const granted = await this.deps.permissions
      .contains(normalized.originPattern)
      .catch(() => false);
    if (!granted) {
      return {
        key: 'localAsr',
        status: 'failed',
        message: '尚未授予访问本地识别服务的权限。',
        reasonCode: 'host-permission-missing',
      };
    }
    const started = this.deps.now();
    const health = await this.deps.checkLocalAsrHealth(normalized.baseUrl, signal);
    const latencyMs = this.deps.now() - started;
    if (health.status === 'ok' && health.ready) {
      return {
        key: 'localAsr',
        status: this.asrTokenState.value ? 'verified' : 'failed',
        message: this.asrTokenState.value
          ? `本地识别服务可用（模型 ${health.model ?? '未知'}，${health.device ?? '未知设备'}）。配对令牌将在首次识别时验证。`
          : '本地识别服务在线，但尚未填写配对令牌。',
        latencyMs,
        reasonCode: this.asrTokenState.value ? undefined : 'token-missing',
      };
    }
    if (health.status === 'loading') {
      return {
        key: 'localAsr',
        status: 'failed',
        message: '本地识别服务正在加载模型，请稍后重试。',
        latencyMs,
        reasonCode: 'loading',
      };
    }
    return {
      key: 'localAsr',
      status: 'failed',
      message:
        health.error?.message ??
        `无法连接本地识别服务（${redactUrl(normalized.baseUrl)}），请确认已启动。`,
      latencyMs,
      reasonCode: health.status,
    };
  }

  private async searchRoute(
    signal: AbortSignal,
  ): Promise<Omit<SearchGenerationParams, 'query' | 'signal'>> {
    const provider = this.settingsValue.provider;
    const apiKey = this.apiKeyState.value;
    const generation = this.apiKeyGeneration;
    const intent = this.apiKeyIntent;
    const normalized = this.deps.normalizeBaseUrl(provider.baseUrl);
    if (!normalized.ok) throw new AppError(normalized.error);
    if (!apiKey || !provider.model.trim())
      throw new AppError({
        code: 'search-config-missing',
        category: 'config',
        retryable: false,
        message: '请先在设置中保存 API Key 和翻译模型。',
      });
    const granted = await this.deps.permissions
      .contains(normalized.originPattern)
      .catch(() => false);
    if (
      signal.aborted ||
      generation !== this.apiKeyGeneration ||
      intent !== this.apiKeyIntent ||
      provider !== this.settingsValue.provider
    )
      throw cancelledError();
    if (!granted)
      throw new AppError({
        code: 'host-permission-missing',
        category: 'permission',
        retryable: false,
        message: '请先在设置中授予访问服务地址的权限。',
      });
    return {
      baseUrl: normalized.baseUrl,
      apiKey,
      model: provider.model,
      protocol:
        provider.protocol === 'auto' ? (provider.detectedProtocol ?? 'auto') : provider.protocol,
      reasoningEffort: provider.reasoningEffort,
      timeoutMs: provider.timeoutMs,
    };
  }

  private async discoverModels(): Promise<{ models: string[] }> {
    const s = this.settingsValue.provider;
    const normalized = s.baseUrl ? this.deps.normalizeBaseUrl(s.baseUrl) : undefined;
    if (!normalized?.ok)
      throw new AppError({
        code: 'missing-base-url',
        category: 'config',
        retryable: false,
        message: '请先填写有效的服务地址。',
      });
    const apiKey = this.apiKeyState.value;
    if (!apiKey)
      throw new AppError({
        code: 'missing-api-key',
        category: 'config',
        retryable: false,
        message: '请先填写 API Key。',
      });
    const generation = this.credentialGeneration;
    await this.refreshHostPermission();
    if (generation !== this.credentialGeneration || this.settingsValue.provider !== s)
      throw cancelledError('discovery superseded');
    if (!this.hostPermission.granted) {
      throw new AppError({
        code: 'host-permission-missing',
        category: 'permission',
        retryable: false,
        message: '请先授予访问服务地址的权限。',
      });
    }
    this.modelDiscoveryAbort?.abort();
    const controller = new AbortController();
    this.modelDiscoveryAbort = controller;
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const models = await this.deps.discoverModels({
        baseUrl: normalized.baseUrl,
        apiKey,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        generation !== this.credentialGeneration ||
        this.settingsValue.provider !== s
      ) {
        throw new AppError({
          code: 'discovery-superseded',
          category: 'cancelled',
          retryable: true,
          message: '服务地址或 Key 已变化，本次模型列表作废，请重新获取。',
        });
      }
      return { models: models.slice(0, 1_000) };
    } finally {
      clearTimeout(timer);
      if (this.modelDiscoveryAbort === controller) this.modelDiscoveryAbort = undefined;
    }
  }

  private async previewVoice(
    text?: string,
    voiceName?: string,
    rate?: number,
  ): Promise<{ started: true }> {
    for (const slot of this.slots.values()) {
      if (
        slot.session &&
        slot.session.outputMode === 'subtitle-voice' &&
        slot.desired === 'running' &&
        !slot.session.isStopping
      ) {
        throw new AppError({
          code: 'dubbing-active',
          category: 'tts',
          retryable: false,
          message: '配音进行中，暂不能试听。请先暂停翻译。',
        });
      }
    }
    const s = this.settingsValue;
    const sample =
      text?.trim() ||
      (s.targetLanguage.startsWith('zh')
        ? '你好，这是同听的配音试听。'
        : 'Hello, this is a Tongting voice preview.');
    this.cancelVoicePreview();
    const utteranceId = this.deps.randomId('preview');
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const owner = {
        id: utteranceId,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
        cancel: () => {
          if (this.preview !== owner) return;
          release();
          this.deps.systemTts.stop();
          if (!settled) {
            settled = true;
            reject(cancelledError('preview cancelled'));
          }
        },
      };
      const release = () => {
        clearTimeout(owner.timer);
        if (this.preview === owner) this.preview = undefined;
      };
      this.preview = owner;
      owner.timer = setTimeout(() => {
        if (this.preview !== owner || settled) return;
        release();
        settled = true;
        this.deps.systemTts.stop();
        reject(
          new AppError({
            code: 'tts-start-timeout',
            category: 'tts',
            retryable: true,
            message: '系统语音没有开始朗读，请检查所选声音。',
          }),
        );
      }, 5_000);
      this.deps.systemTts.speak(
        {
          utteranceId,
          text: sample,
          lang: s.targetLanguage,
          voiceName: voiceName ?? (s.audio.voiceName || undefined),
          rate: rate ?? s.audio.rate,
          volume: s.audio.dubVolume,
        },
        (event) => {
          if (this.preview !== owner) return;
          if (event.type === 'start') {
            clearTimeout(owner.timer);
            if (!settled) {
              settled = true;
              resolve();
            }
          } else if (event.type === 'error') {
            release();
            if (!settled) {
              settled = true;
              reject(new AppError(event.error));
            }
          } else if (event.type === 'end' || event.type === 'interrupted') {
            release();
            if (!settled) {
              settled = true;
              resolve();
            }
          }
        },
      );
    });
    return { started: true };
  }

  /** 会话获得语音引擎之前撤销试听所有权；迟到回调和停止按钮不能再停止会话。 */
  cancelVoicePreview(): void {
    this.preview?.cancel();
  }

  /** 快捷键：切换当前活动标签页的翻译。 */
  async toggleActiveTab(): Promise<void> {
    await this.ready;
    const tabId = await this.deps.tabs.getActiveTabId();
    if (tabId === undefined) return;
    const slot = this.slots.get(tabId);
    let page = this.pages.get(tabId);
    // 快捷键是推荐的「调用扩展」方式：worker 刚重启、内容脚本尚未重连时先唤醒页面。
    if (!page?.videoId) page = await this.wakePage(tabId);
    if (!page?.videoId) return;
    const next: DesiredState =
      !slot || slot.desired === 'stopped'
        ? 'running'
        : slot.desired === 'running'
          ? 'paused'
          : 'running';
    await this.setDesired(tabId, next, !slot || slot.desired === 'stopped').catch(() => undefined);
  }

  async toggleCaptions(): Promise<void> {
    await this.ready;
    await this.mutate(() =>
      this.updateSettings({
        captions: { enabled: !this.settingsValue.captions.enabled },
      }),
    ).catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // 快照
  // ---------------------------------------------------------------------------

  publish(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      if (this.uiConnections.size === 0) return;
      this.snapshotVersion++;
      const snapshot = this.buildSnapshot(this.snapshotVersion);
      for (const conn of this.uiConnections) {
        if (conn.subscribed) conn.send({ type: 'snapshot', snapshot });
      }
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  emitUiCues(
    sessionId: string,
    patch: { cueVersion: number; full: boolean; cues: Cue[]; removedIds?: string[] },
  ): void {
    for (const conn of this.uiConnections) {
      if (conn.cueSessionId !== sessionId) continue;
      conn.send({
        type: 'cues',
        sessionId,
        cueVersion: patch.cueVersion,
        full: patch.full,
        cues: patch.cues,
        removedIds: patch.removedIds,
      });
    }
  }

  buildSnapshot(version: number): AppSnapshot {
    const sessions: SessionSnapshot[] = [];
    let audioOwner: AppSnapshot['audioOwner'] = null;
    for (const slot of this.slots.values()) {
      if (slot.session) {
        const snap = slot.session.snapshot();
        const phase = slot.session.isStopping ? 'stopping' : snap.phase;
        const parsed = SessionSnapshotSchema.safeParse({
          ...snap,
          phase,
          desiredState: slot.desired,
        });
        if (parsed.success) sessions.push(parsed.data);
        if (!slot.session.isStopping)
          audioOwner = { tabId: slot.tabId, sessionId: snap.identity.sessionId };
      } else if (slot.errorSnapshot) {
        const parsed = SessionSnapshotSchema.safeParse({
          ...slot.errorSnapshot,
          desiredState: slot.desired,
        });
        if (parsed.success) sessions.push(parsed.data);
        else this.deps.logger.warn('[tongting] dropped invalid error snapshot');
      }
    }
    const pages = [...this.pages.values()]
      .map(toPageInfo)
      .filter((p) => PageInfoSchema.safeParse(p).success);
    const report =
      this.lastConnectionReport &&
      ConnectionReportSchema.safeParse(this.lastConnectionReport).success
        ? this.lastConnectionReport
        : undefined;
    const snapshot: AppSnapshot = {
      snapshotVersion: version,
      workerInstanceId: this.workerInstanceId,
      settings: this.settingsValue,
      settingsPersisted: this.settingsPersisted,
      configRevision: this.configRevisionValue,
      credential: {
        configured: !!this.apiKeyState.value,
        generation: this.credentialGeneration,
        storage: this.apiKeyState.storage,
        cleanupPending: this.apiKeyState.cleanupPending,
        masked: maskSecret(this.apiKeyState.value),
      },
      asrToken: {
        configured: !!this.asrTokenState.value,
        generation: this.credentialGeneration,
        storage: this.asrTokenState.storage,
        cleanupPending: this.asrTokenState.cleanupPending,
        masked: maskSecret(this.asrTokenState.value),
      },
      hostPermission: { origin: this.hostPermission.origin, granted: this.hostPermission.granted },
      capabilities: this.capabilities as AppSnapshot['capabilities'],
      lastConnectionReport: report,
      pages,
      sessions,
      audioOwner,
    };
    // 整份快照发送前校验：UI 会拒收非法快照，发送非法数据会让界面停在旧状态。
    const parsed = AppSnapshotSchema.safeParse(snapshot);
    if (parsed.success) return parsed.data;
    this.deps.logger.warn(
      '[tongting] snapshot failed validation',
      parsed.error.issues.slice(0, 3).map((i) => i.path.join('.')),
    );
    return {
      ...snapshot,
      capabilities: {},
      lastConnectionReport: undefined,
      pages: [],
      sessions: [],
    };
  }

  /** 测试辅助：等待所有 reconcile 循环结束。 */
  async idle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const loops = [...this.slots.values()].map((s) => s.loop).filter(Boolean);
      if (loops.length === 0) return;
      await Promise.all(loops);
    }
  }
}

function secretCleanupError(): AppError {
  return new AppError({
    code: 'secret-cleanup-incomplete',
    category: 'storage',
    retryable: true,
    message:
      '凭证已停止使用，但本机存储副本尚未全部清除。请点击「重试清理」；清理完成前不要把它视为已彻底删除。',
  });
}

function safeDisconnect(port: PortLike): void {
  try {
    port.disconnect();
  } catch {
    // ignore
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error('rejected'));
      },
    );
  });
}

export type { AppErrorInfo };

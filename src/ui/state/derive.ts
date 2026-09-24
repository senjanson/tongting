/**
 * 从快照派生界面状态（纯函数，便于单测）。
 *
 * 原则：只展示快照里的真实状态；没有数据时显示「未知 / 未检测」，不预填示例数字。
 * 面向用户的文案由最后一个参数 locale 决定；省略时使用当前页面语言（getLocale）。
 */
import type { AppErrorInfo } from '../../domain/errors';
import type { PageInfo, PlayerState, SessionSnapshot } from '../../domain/session';
import type { Settings } from '../../domain/settings';
import type { AppSnapshot, TtsVoiceInfo } from '../../messaging/ui-protocol';
import { normalizeBaseUrl } from '../../providers/text/base-url';
import { voiceLanguageRank } from '../../providers/tts/voices';
import { getLocale, translate, type Locale } from '../../i18n';
import { languageLabel, sourceLanguageLabel } from '../format';
import type { ConnectionStatus } from './client';

export interface ActiveTabInfo {
  tabId: number;
  windowId: number;
  /** 没有 tabs 权限时通常为 undefined，不能依赖。 */
  url?: string;
  title?: string;
}

export type TabContext =
  | { kind: 'loading' }
  | { kind: 'no-tab' }
  /** 已向该标签页发送唤醒，短时间内等待内容脚本上报。 */
  | { kind: 'waking'; tab: ActiveTabInfo }
  /** 当前标签页未登记为 YouTube 页面。maybeYoutube：URL 看起来是 YouTube 但内容脚本未连接。 */
  | { kind: 'not-youtube'; tab: ActiveTabInfo; maybeYoutube: boolean }
  | { kind: 'youtube-no-video'; tab: ActiveTabInfo; page: PageInfo }
  | { kind: 'video'; tab: ActiveTabInfo; page: PageInfo; session: SessionSnapshot | undefined };

const YOUTUBE_URL = /^https:\/\/(www|m)\.youtube\.com\//i;

export function findPageByTab(snapshot: AppSnapshot | null, tabId: number): PageInfo | undefined {
  return snapshot?.pages.find((p) => p.tabId === tabId);
}

/** 找到某页面当前视频对应的会话：同标签页、同视频；优先同一文档，其次最近更新。 */
export function findSessionForPage(
  snapshot: AppSnapshot | null,
  page: PageInfo,
): SessionSnapshot | undefined {
  if (!snapshot || !page.videoId) return undefined;
  const candidates = snapshot.sessions.filter(
    (s) => s.identity.tabId === page.tabId && s.identity.videoId === page.videoId,
  );
  candidates.sort((a, b) => {
    const docA = a.identity.documentId === page.documentId ? 1 : 0;
    const docB = b.identity.documentId === page.documentId ? 1 : 0;
    return docB - docA || b.updatedAt - a.updatedAt;
  });
  return candidates[0];
}

export function deriveTabContext(
  snapshot: AppSnapshot | null,
  tab: ActiveTabInfo | null | undefined,
  tabLoading: boolean,
  waking = false,
): TabContext {
  if (!tab) return tabLoading ? { kind: 'loading' } : { kind: 'no-tab' };
  const page = findPageByTab(snapshot, tab.tabId);
  if (!page) {
    if (waking) return { kind: 'waking', tab };
    return { kind: 'not-youtube', tab, maybeYoutube: !!tab.url && YOUTUBE_URL.test(tab.url) };
  }
  if (!page.videoId) return { kind: 'youtube-no-video', tab, page };
  return { kind: 'video', tab, page, session: findSessionForPage(snapshot, page) };
}

export interface ServiceConfigState {
  ready: boolean;
  missingBaseUrl: boolean;
  /** 已填写但不符合规则的地址（与 worker 使用相同的 normalizeBaseUrl 判断）。 */
  invalidBaseUrl: boolean;
  missingKey: boolean;
  missingPermission: boolean;
  /** 面向用户的说明（ready 时为空）。 */
  message: string;
}

export function deriveServiceConfig(
  snapshot: AppSnapshot | null,
  locale: Locale = getLocale(),
): ServiceConfigState {
  if (!snapshot) {
    return {
      ready: false,
      missingBaseUrl: false,
      invalidBaseUrl: false,
      missingKey: false,
      missingPermission: false,
      message: '',
    };
  }
  const rawUrl = snapshot.settings.provider.baseUrl.trim();
  const missingBaseUrl = rawUrl === '';
  const normalized = missingBaseUrl ? undefined : normalizeBaseUrl(rawUrl);
  const invalidBaseUrl = !!normalized && !normalized.ok;
  const missingKey = !snapshot.credential.configured;
  const missingPermission = !missingBaseUrl && !invalidBaseUrl && !snapshot.hostPermission.granted;
  let message = '';
  if (invalidBaseUrl && normalized && !normalized.ok) {
    message = translate(locale, 'common.config.invalidUrl', { detail: normalized.error.message });
  } else if (missingBaseUrl && missingKey) {
    message = translate(locale, 'common.config.missingBoth');
  } else if (missingBaseUrl) {
    message = translate(locale, 'common.config.missingUrl');
  } else if (missingKey) {
    message = translate(locale, 'common.config.missingKey');
  } else if (missingPermission) {
    message = translate(locale, 'common.config.missingPermission');
  }
  return {
    ready: !missingBaseUrl && !invalidBaseUrl && !missingKey && !missingPermission,
    missingBaseUrl,
    invalidBaseUrl,
    missingKey,
    missingPermission,
    message,
  };
}

/** 会话已结束：启动失败或致命错误后 worker 以 phase=error + desiredState=stopped 表示。 */
export function isSessionEnded(session: SessionSnapshot | undefined): boolean {
  if (!session) return false;
  return (
    session.desiredState === 'stopped' && (session.phase === 'error' || session.phase === 'idle')
  );
}

export interface SessionProblem {
  error: AppErrorInfo;
  /** session：会话级错误；blocked：翻译调度器因不可恢复错误停止发送请求。 */
  source: 'session' | 'blocked';
}

/** 任意 phase 下的会话错误或翻译受阻原因。 */
export function sessionProblem(session: SessionSnapshot | undefined): SessionProblem | undefined {
  if (!session) return undefined;
  if (session.error) return { error: session.error, source: 'session' };
  if (session.translation.blockedError) {
    return { error: session.translation.blockedError, source: 'blocked' };
  }
  return undefined;
}

export type StatusTone = 'neutral' | 'accent' | 'warning' | 'danger' | 'busy' | 'demo';

export interface StatusInfo {
  label: string;
  tone: StatusTone;
}

export function sessionPhaseStatus(
  session: SessionSnapshot,
  locale: Locale = getLocale(),
): StatusInfo | undefined {
  const problem = sessionProblem(session);
  const label = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  switch (session.phase) {
    case 'error':
      return { label: label('common.status.error'), tone: 'danger' };
    case 'configuring':
    case 'starting':
      return problem
        ? { label: label('common.status.startBlocked'), tone: 'danger' }
        : { label: label('common.status.starting'), tone: 'busy' };
    case 'running':
      if (problem) return { label: label('common.status.translationBlocked'), tone: 'danger' };
      switch (session.playbackBuffer?.state) {
        case 'preparing':
          return { label: label('common.status.buffering'), tone: 'busy' };
        case 'blocked':
          return { label: label('common.status.bufferBlocked'), tone: 'warning' };
        case 'unavailable':
          return { label: label('common.status.preloadUnavailable'), tone: 'warning' };
        default:
          return { label: label('common.status.running'), tone: 'accent' };
      }
    case 'pausing':
      return { label: label('common.status.pausing'), tone: 'busy' };
    case 'paused':
      return problem
        ? { label: label('common.status.pausedWithError'), tone: 'danger' }
        : { label: label('common.status.paused'), tone: 'warning' };
    case 'stopping':
      return { label: label('common.status.stopping'), tone: 'busy' };
    case 'idle':
      return undefined;
  }
}

export function deriveStatus(args: {
  connection: ConnectionStatus;
  snapshot: AppSnapshot | null;
  tabContext: TabContext;
  config: ServiceConfigState;
  locale?: Locale;
}): StatusInfo {
  const { connection, snapshot, tabContext, config, locale = getLocale() } = args;
  const label = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  if (!snapshot) {
    return connection === 'reconnecting'
      ? { label: label('common.status.reconnecting'), tone: 'warning' }
      : { label: label('common.status.connecting'), tone: 'busy' };
  }
  if (tabContext.kind === 'video' && tabContext.session) {
    const phase = sessionPhaseStatus(tabContext.session, locale);
    if (phase) return phase;
  }
  if (!config.ready) {
    return config.invalidBaseUrl
      ? { label: label('common.status.invalidUrl'), tone: 'danger' }
      : { label: label('common.status.notConfigured'), tone: 'warning' };
  }
  switch (tabContext.kind) {
    case 'loading':
      return { label: label('common.status.readingTab'), tone: 'busy' };
    case 'waking':
      return { label: label('common.status.wakingPage'), tone: 'busy' };
    case 'video':
      return { label: label('common.status.ready'), tone: 'neutral' };
    default:
      return { label: label('common.status.notVideo'), tone: 'neutral' };
  }
}

export type PrimaryActionKind = 'start' | 'pause' | 'resume' | 'busy';

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
  /** 有值时按钮禁用，并显示原因。 */
  disabledReason?: string;
}

/**
 * 主按钮按「用户最后意图（desiredState）」决定，而不是只看 phase：
 * 启动过程中点暂停、暂停过程中点继续，都以最后一次意图为准，由 worker 负责落实。
 */
export function derivePrimaryAction(
  session: SessionSnapshot | undefined,
  config: ServiceConfigState,
  connection: ConnectionStatus,
  locale: Locale = getLocale(),
): PrimaryAction {
  const notConnected =
    connection !== 'connected' ? translate(locale, 'common.primary.notConnected') : undefined;
  if (
    !session ||
    session.phase === 'idle' ||
    (session.desiredState === 'stopped' && session.phase !== 'stopping')
  ) {
    const label = translate(
      locale,
      session?.phase === 'error' ? 'common.primary.restart' : 'common.primary.start',
    );
    return {
      kind: 'start',
      label,
      disabledReason: notConnected ?? (config.ready ? undefined : config.message),
    };
  }
  if (session.desiredState === 'stopped') {
    return {
      kind: 'busy',
      label: translate(locale, 'common.primary.stopping'),
      disabledReason: translate(locale, 'common.primary.stoppingReason'),
    };
  }
  if (session.phase === 'error') {
    return {
      kind: 'start',
      label: translate(locale, 'common.retry'),
      disabledReason: notConnected ?? (config.ready ? undefined : config.message),
    };
  }
  if (session.desiredState === 'paused') {
    return {
      kind: 'resume',
      label: translate(locale, 'common.primary.resume'),
      disabledReason: notConnected,
    };
  }
  return {
    kind: 'pause',
    label: translate(locale, 'common.primary.pause'),
    disabledReason: notConnected,
  };
}

/** 是否显示「停止并释放音频」。已结束的会话不再持有资源。 */
export function canStop(session: SessionSnapshot | undefined): boolean {
  if (!session || isSessionEnded(session)) return false;
  if (session.phase === 'idle') return false;
  return !(session.desiredState === 'stopped' && session.phase === 'stopping');
}

/** 是否显示「重试失败的 N 条」。 */
export function canRetryFailed(session: SessionSnapshot | undefined): boolean {
  return (
    !!session &&
    !isSessionEnded(session) &&
    session.phase !== 'stopping' &&
    session.translation.failed > 0
  );
}

export type NextStepAction = 'open-settings' | 'retry' | 'reload-tab' | 'none';

export interface NextStep {
  action: NextStepAction;
  label: string;
  /** 无法由按钮完成时的操作指引。 */
  hint?: string;
}

/** 中文版本的采集手势提示（兼容旧引用）；界面请用 errorNextStep 的 hint。 */
export const CAPTURE_GESTURE_HINT = translate('zh-CN', 'common.nextStep.captureGesture');

/** 错误 → 可执行的下一步。 */
export function errorNextStep(
  error: Pick<AppErrorInfo, 'category' | 'retryable'> & { code?: string },
  locale: Locale = getLocale(),
): NextStep {
  const label = (key: Parameters<typeof translate>[1]) => translate(locale, key);
  if (error.code === 'capture-not-allowed' || error.category === 'capture') {
    return { action: 'none', label: '', hint: label('common.nextStep.captureGesture') };
  }
  // 播放器数据尚未就绪（不是视频没有字幕）：稍后重试即可，不引导去配置识别。
  if (error.code === 'captions-not-ready') return { action: 'retry', label: label('common.retry') };
  switch (error.category) {
    case 'config':
    case 'auth':
    case 'permission':
    case 'quota':
      return { action: 'open-settings', label: label('common.nextStep.checkSettings') };
    case 'captions':
    case 'asr':
      return { action: 'open-settings', label: label('common.nextStep.configureAsr') };
    case 'tts':
      return { action: 'open-settings', label: label('common.nextStep.checkTts') };
    case 'youtube':
      return { action: 'reload-tab', label: label('common.nextStep.reloadYoutube') };
    case 'storage':
    case 'cancelled':
      return { action: 'none', label: '' };
    case 'rate-limit':
      return { action: 'retry', label: label('common.nextStep.retryLater') };
    default:
      return error.retryable
        ? { action: 'retry', label: label('common.retry') }
        : { action: 'open-settings', label: label('common.nextStep.checkSettings') };
  }
}

/** notice 按 code 决定是否提供「打开设置」。未知 code 不提供动作，避免误导。 */
const NOTICE_SETTINGS_CODES = new Set([
  'captions-unavailable',
  'tts-disabled',
  'tts-unavailable',
  'tts-error',
  'host-permission-missing',
  'asr-host-permission-missing',
]);

export function noticeHasSettingsAction(code: string): boolean {
  return NOTICE_SETTINGS_CODES.has(code);
}

export function playerStatusLabel(
  player: PlayerState | undefined,
  locale: Locale = getLocale(),
): string {
  if (!player) return translate(locale, 'common.player.none');
  if (player.ad) return translate(locale, 'common.player.ad');
  if (player.ended) return translate(locale, 'common.player.ended');
  if (player.seeking) return translate(locale, 'common.player.seeking');
  if (player.buffering) return translate(locale, 'common.player.buffering');
  if (player.paused) return translate(locale, 'common.player.paused');
  return translate(locale, 'common.player.playing');
}

/** 播放器快照在采样后的时间推算；最多外推 5 秒，避免快照停止更新时时间一直走。 */
export function estimatePlayerTimeMs(
  player: PlayerState | undefined,
  nowEpochMs: number,
): number | undefined {
  if (!player) return undefined;
  const base = player.currentTimeMs;
  if (player.paused || player.buffering || player.seeking || player.ended || player.ad) return base;
  const elapsed = Math.min(Math.max(nowEpochMs - player.sampledAtEpochMs, 0), 5_000);
  const estimate = base + elapsed * player.playbackRate;
  return player.durationMs ? Math.min(estimate, player.durationMs) : estimate;
}

export function sourceModeShortLabel(
  mode: SessionSnapshot['sourceMode'] | undefined,
  locale: Locale = getLocale(),
): string {
  switch (mode) {
    case 'full-track':
      return translate(locale, 'common.sourceMode.fullTrack');
    case 'incremental-captions':
      return translate(locale, 'common.sourceMode.incremental');
    case 'asr':
      return translate(locale, 'common.sourceMode.asr');
    case 'asr-preload':
      return translate(locale, 'common.sourceMode.asrPreload');
    case 'none':
      return translate(locale, 'common.sourceMode.none');
    default:
      return translate(locale, 'common.unknown');
  }
}

export interface SourceLanguageInfo {
  selected: string;
  actual: string;
}

/** 用户选择的源语言与实际检测/轨道语言分开描述。 */
export function describeSourceLanguage(
  settings: Settings,
  session: SessionSnapshot | undefined,
  locale: Locale = getLocale(),
): SourceLanguageInfo {
  const selected = sourceLanguageLabel(settings.sourceLanguage, locale);
  const parts: string[] = [];
  if (session?.sourceTrack) {
    parts.push(
      translate(locale, 'common.source.track', {
        label: session.sourceTrack.label,
        code: session.sourceTrack.languageCode,
      }),
    );
  }
  if (session?.detectedSourceLanguage && session.detectedSourceLanguage !== 'und') {
    parts.push(
      translate(locale, 'common.source.detected', {
        name: sourceLanguageLabel(session.detectedSourceLanguage, locale),
      }),
    );
  }
  return {
    selected,
    actual: parts.length ? parts.join(' · ') : translate(locale, 'common.source.notDetected'),
  };
}

/**
 * 会话对应的字幕记录（收藏按记录保存）：只使用 worker 在快照中下发的 recordId。
 * 缺失（尚未确定字幕来源）时返回 undefined，UI 应禁用收藏，不自行拼接。
 */
export function sessionRecordId(session: SessionSnapshot): string | undefined {
  return session.recordId;
}

/**
 * 按目标语言过滤实际声音，使用与 worker 选择声音相同的匹配函数（voiceLanguageRank），
 * 并按匹配优先级排序。
 */
export function filterVoicesForLanguage(
  voices: readonly TtsVoiceInfo[],
  targetLanguage: string,
): TtsVoiceInfo[] {
  return voices
    .map((voice, index) => ({
      voice,
      index,
      rank: voiceLanguageRank(voice, targetLanguage, false),
    }))
    .filter((v) => v.rank >= 0)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((v) => v.voice);
}

export type VoiceListState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; voices: TtsVoiceInfo[] }
  | { status: 'error'; message: string };

export interface VoiceAvailability {
  state: 'available' | 'unavailable' | 'unknown';
  /** 不可用或未知时的原因。 */
  reason?: string;
  voices: TtsVoiceInfo[];
}

export function deriveVoiceAvailability(
  snapshot: AppSnapshot,
  voiceList: VoiceListState,
  locale: Locale = getLocale(),
): VoiceAvailability {
  const { settings, capabilities } = snapshot;
  const language = languageLabel(settings.targetLanguage, locale);
  if (settings.tts.backend === 'none') {
    return { state: 'unavailable', reason: translate(locale, 'common.voice.ttsNone'), voices: [] };
  }
  if (settings.tts.backend === 'sub2api') {
    const cap = capabilities.tts;
    if (cap?.status === 'failed' || cap?.status === 'unsupported') {
      return {
        state: 'unavailable',
        reason: cap.message
          ? translate(locale, 'common.voice.sub2apiUnavailableDetail', { detail: cap.message })
          : translate(locale, 'common.voice.sub2apiUnavailable'),
        voices: [],
      };
    }
    if (!settings.tts.sub2apiModel) {
      return {
        state: 'unavailable',
        reason: translate(locale, 'common.voice.sub2apiNoModel'),
        voices: [],
      };
    }
    if (cap?.status !== 'verified') {
      return {
        state: 'unknown',
        reason: translate(locale, 'common.voice.sub2apiUnverified'),
        voices: [],
      };
    }
    return { state: 'available', voices: [] };
  }
  // 系统语音的可用性以 tts/voices 返回的实际声音列表为准。
  switch (voiceList.status) {
    case 'idle':
    case 'loading':
      return { state: 'unknown', reason: translate(locale, 'common.voice.loading'), voices: [] };
    case 'error':
      return {
        state: 'unknown',
        reason: translate(locale, 'common.voice.loadFailed', { detail: voiceList.message }),
        voices: [],
      };
    case 'ready': {
      const voices = filterVoicesForLanguage(voiceList.voices, settings.targetLanguage);
      if (voices.length === 0) {
        return {
          state: 'unavailable',
          reason: translate(locale, 'common.voice.noVoice', { language }),
          voices,
        };
      }
      return { state: 'available', voices };
    }
  }
}

/**
 * 会话协调器依赖。真实实现由 src/background/wiring.ts 注入；测试注入假实现。
 * 这些签名与各模块负责人约定的导出一致。
 */
import type { AppErrorInfo } from '../domain/errors';
import type { TranscriptRecord } from '../storage/db';
import type { ProviderSettings } from '../domain/settings';
import type { OffscreenClient } from '../audio/types';
import type { OffscreenConnectionLost } from '../audio/offscreen-client';
import type { SessionTimings } from './session';
import type { PortLike } from './connections';
import type {
  BuildCueUnits,
  IncrementalCaptionAssembler,
  AsrCueAssembler,
} from '../captions/types';
import type { AsrHealth } from '../providers/asr/types';
import type {
  ConnectionCheckResultItem,
  HttpTransport,
  TextProvider,
  TextProviderConfig,
} from '../providers/text/types';
import type { DubbingController, TtsEngine } from '../providers/tts/types';
import type { MediaOwner } from '../messaging/offscreen-protocol';
import type { CreateTranslationScheduler, TranslationCache } from '../translation/types';

export type NormalizeBaseUrlResult =
  | { ok: true; baseUrl: string; origin: string; originPattern: string }
  | { ok: false; error: AppErrorInfo };

export interface TextConnectionCheckResult {
  items: ConnectionCheckResultItem[];
  detectedProtocol?: 'responses' | 'chat';
  models?: string[];
}

export interface KeyValueArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export interface CoordinatorDeps {
  now(): number;
  randomId(prefix?: string): string;
  /** secureLocal：扩展 origin 的 IndexedDB，用于「记住在本机」的凭证。 */
  storage: { local: KeyValueArea; session: KeyValueArea; secureLocal: KeyValueArea };
  runtimeId: string;
  extensionOrigin: string;

  permissions: {
    contains(originPattern: string): Promise<boolean>;
  };
  tabCapture: {
    /** 必须在扩展被用户调用（activeTab）后才能成功。 */
    getMediaStreamId(targetTabId: number): Promise<string>;
  };
  tabs: {
    exists(tabId: number): Promise<boolean>;
    getActiveTabId(): Promise<number | undefined>;
    /** 向标签页内容脚本发送唤醒消息，使其重新连接 worker；标签页不存在或无内容脚本时静默失败。 */
    wake(tabId: number): Promise<void>;
  };

  normalizeBaseUrl(input: string): NormalizeBaseUrlResult;
  createTextProvider(config: TextProviderConfig, transport?: HttpTransport): TextProvider;
  discoverModels(params: {
    baseUrl: string;
    apiKey: string;
    signal: AbortSignal;
  }): Promise<string[]>;
  runTextConnectionCheck(params: {
    provider: ProviderSettings;
    apiKey: string | undefined;
    hasHostPermission: boolean;
    signal: AbortSignal;
    includeStreaming?: boolean;
  }): Promise<TextConnectionCheckResult>;
  /**
   * sub2api 语音合成/识别的实测探测（会产生计费调用，只在用户明确允许时调用）。
   * 合成：朗读一小段文本；识别：上传 1 秒合成测试音，只验证接口与认证，不验证识别准确度。
   */
  probeSub2apiSpeech(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    text: string;
    signal: AbortSignal;
  }): Promise<{ bytes: number; contentType: string; latencyMs: number }>;
  probeSub2apiTranscription(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    signal: AbortSignal;
  }): Promise<{ text: string; latencyMs: number }>;
  createTranslationScheduler: CreateTranslationScheduler;
  translationCache: TranslationCache;

  buildCueUnits: BuildCueUnits;
  createIncrementalCaptionAssembler(opts: {
    idPrefix: string;
    sourceLanguage: string;
    targetLanguage: string;
  }): IncrementalCaptionAssembler;
  createAsrCueAssembler(opts: { idPrefix: string; targetLanguage: string }): AsrCueAssembler;

  /** worker 统一接收 PORT_OFFSCREEN 连接后交给 offscreen 客户端处理。 */
  offscreen: OffscreenClient & {
    handlePort(port: PortLike): void;
    /** 端口断开、文档消失或实例变化（非主动关闭）时通知。 */
    onConnectionLost(listener: (info: OffscreenConnectionLost) => void): () => void;
  };
  systemTts: TtsEngine;
  createSub2apiTtsEngine(params: {
    offscreen: OffscreenClient;
    getRoute: () => { baseUrl: string; apiKey: string; model: string; voice: string } | null;
    getOwner: () => MediaOwner | null;
  }): TtsEngine;
  createDubbingController(deps: { engine: TtsEngine; now?: () => number }): DubbingController;
  checkLocalAsrHealth(baseUrl: string, signal: AbortSignal): Promise<AsrHealth>;

  transcripts: {
    putTranscript(record: TranscriptRecord): Promise<void>;
    getTranscript(recordId: string): Promise<TranscriptRecord | undefined>;
  };

  logger: Pick<Console, 'info' | 'warn' | 'error'>;
  /** 测试用：覆盖会话计时参数。 */
  timings?: Partial<SessionTimings>;
}

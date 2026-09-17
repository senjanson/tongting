/**
 * 翻译调度器契约（运行在 service worker，由会话协调器持有，每个会话一个实例）。
 *
 * 不变量：
 * - 只有与当前 (sessionId, epoch, configRevision) 匹配的结果会通过 onUpdate 发出。
 * - 失败或校验未通过的结果不进入最终缓存；partial 结果不发出为 done。
 * - dispose 后中止所有在途请求，不再发出任何回调。
 */
import type { AppErrorInfo } from '../domain/errors';
import type { Cue } from '../domain/cue';
import type { GlossaryEntry, TranslationStyle } from '../domain/settings';
import type { TranslationStats } from '../domain/session';
import type { TextProvider } from '../providers/text/types';

export interface TranslationConfig {
  sourceLanguage: string;
  targetLanguage: string;
  style: TranslationStyle;
  glossary: GlossaryEntry[];
  /** 是否预取播放点之后的字幕。 */
  prefetch: boolean;
  /** 是否使用持久缓存。 */
  useCache: boolean;
  timeoutMs: number;
}

export interface SchedulerIdentity {
  sessionId: string;
  epoch: number;
  configRevision: number;
  /** 来源版本：视频 ID + 字幕轨道 key 或 ASR 会话，用于缓存键。 */
  sourceKey: string;
}

export interface Playhead {
  mediaTimeMs: number;
  playing: boolean;
  playbackRate: number;
}

/**
 * 调度器在请求被中止/退避且不再立即重发时发出 pending（可回滚），避免会话层停留在 running。
 * 暂停、epoch 变化、setCues、配置变化后协调器仍会在本地重置 running。
 */
export interface CueTranslationUpdate {
  cueId: string;
  /** 对应的 cue revision；revision 已变化的结果会被丢弃。 */
  cueRevision: number;
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped';
  translatedText?: string;
  translationKey?: string;
  error?: AppErrorInfo;
  /** 是否为可回滚的流式部分结果。 */
  partial?: boolean;
  fromCache?: boolean;
}

export interface TranslationCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface TranslationSchedulerDeps {
  provider: TextProvider;
  cache: TranslationCache;
  now?: () => number;
  random?: () => number;
}

export interface TranslationScheduler {
  /** 替换全部 cue（完整轨道或会话开始）。 */
  setCues(cues: readonly Cue[], identity: SchedulerIdentity): void;
  /** 增量加入或修订 cue（ASR / 增量字幕）。interim cue 不翻译或只做可回滚翻译。 */
  upsertCues(cues: readonly Cue[]): void;
  removeCues(ids: readonly string[]): void;
  setPlayhead(playhead: Playhead): void;
  /** epoch 变化（跳转等）：淘汰与新播放区间无关的任务，旧结果不再发出。 */
  setEpoch(epoch: number): void;
  /**
   * 新 configRevision（或译文指纹变化）：中止全部在途请求并清空译文后重翻。
   * 相同 revision 且指纹不变（预取/缓存/超时/流式/换 Key）：保留已完成译文；传入新 provider 实例时立即中止旧实例的在途请求。
   */
  setConfig(config: TranslationConfig, configRevision: number, provider: TextProvider): void;
  /** 暂停翻译：中止在途请求并清空待办；保留已完成结果。 */
  pause(): void;
  resume(): void;
  retryFailed(): number;
  /**
   * 全片补译（导出用）：播放窗口与预取没有待办时，以并发 1 按顺序翻译完整字幕轨道其余部分。
   * 遵守暂停、限流、熔断与预取开关；只作用于 caption-track 来源的 cue。
   */
  setBackfill(enabled: boolean): void;
  onUpdate(listener: (updates: CueTranslationUpdate[]) => void): () => void;
  stats(): TranslationStats;
  dispose(): void;
}

export type CreateTranslationScheduler = (
  deps: TranslationSchedulerDeps,
  config: TranslationConfig,
  identity: SchedulerIdentity,
) => TranslationScheduler;

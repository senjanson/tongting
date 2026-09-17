/**
 * 配音契约。系统语音（chrome.tts）在 service worker 调用；云端合成在 offscreen 播放。
 * DubbingController 负责同步政策（见 EXECUTION_PLAN §8.6），与具体引擎解耦。
 */
import type { AppErrorInfo } from '../../domain/errors';
import type { Cue } from '../../domain/cue';
import type { PlayerState } from '../../domain/session';

export interface TtsVoice {
  voiceName: string;
  lang?: string;
  remote?: boolean;
  extensionId?: string;
}

export interface TtsUtterance {
  utteranceId: string;
  text: string;
  lang: string;
  voiceName?: string;
  rate: number;
  volume: number;
}

export type TtsEngineEvent =
  | { type: 'start'; utteranceId: string }
  | { type: 'end'; utteranceId: string }
  | { type: 'interrupted'; utteranceId: string }
  | { type: 'error'; utteranceId: string; error: AppErrorInfo };

export interface TtsEngine {
  readonly kind: 'system' | 'sub2api' | 'mock';
  getVoices(): Promise<TtsVoice[]>;
  /** 开始朗读；事件通过 listener 回传。同一时刻只允许一个 utterance。 */
  speak(utterance: TtsUtterance, listener: (event: TtsEngineEvent) => void): void;
  /** 立即停止当前朗读；不得等待 finish 回调才视为停止。 */
  stop(): void;
  /**
   * 释放本引擎实例持有的订阅与在途朗读（可重复调用）。共享引擎（系统语音）实现为不影响其他使用者的空操作。
   * dispose 之后 speak 会以 error 事件报告 tts-engine-disposed。
   */
  dispose?(): void;
  /** 声音可用性相关配置的版本键（例如云端路由的地址/模型/声音），用于控制器判断声音检测缓存是否过期。 */
  voiceKey?(): string;
}

export interface DubbingConfig {
  enabled: boolean;
  lang: string;
  voiceName?: string;
  rate: number;
  volume: number;
  pauseWithVideo: boolean;
}

export type DubbingEvent =
  | { type: 'speaking'; cueId: string }
  | { type: 'idle' }
  | { type: 'skipped'; cueId: string; reason: 'stale' | 'too-late' | 'backlog' | 'seek' }
  | { type: 'error'; cueId?: string; error: AppErrorInfo };

export interface DubbingStats {
  state: 'idle' | 'speaking' | 'paused' | 'disabled' | 'error' | 'unavailable';
  backlog: number;
  skipped: number;
  lastError?: AppErrorInfo;
}

export interface DubbingController {
  setConfig(config: DubbingConfig): void;
  /** 只接受 final 且翻译 done 的 cue；同一 cue id+revision 只朗读一次。 */
  upsertCues(cues: readonly Cue[]): void;
  /** 播放器状态：暂停/跳转/倍速/广告/结束。 */
  onPlayer(state: PlayerState, reason: string): void;
  /** 使旧播放代失效：立刻停播并清空队列，旧回调不得发声。 */
  invalidate(epoch: number): void;
  onEvent(listener: (event: DubbingEvent) => void): () => void;
  stats(): DubbingStats;
  dispose(): void;
}

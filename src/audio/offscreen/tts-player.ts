/**
 * offscreen 云端配音播放器：合成 → 解码 → 独立 GainNode → 扬声器。
 *
 * - 同一时刻只有一个 utterance；新的 play 会打断旧的（发出 interrupted）。
 * - stop 立即：中止合成请求、停止并断开 AudioBufferSource/GainNode、解除 onended 监听；
 *   迟到的合成/解码结果因不再是当前条目而被丢弃，不会发声（T15）。
 * - 不创建对象 URL（直接 decodeAudioData），因此无 URL 需要释放。
 * - 记录已停止的 utteranceId（有上限）：stop 先于 play 到达时，之后同 id 的 play 一律拒绝（tts-utterance-stopped）。
 * - 合成结果按「地址 + 模型 + 声音 + 语速 + 文本」做有上限的 LRU 缓存（默认 50 条 / 20 MB，存编码后的音频字节）；
 *   会话变化、clearCache()、dispose() 时释放。
 * - 空闲一段时间后关闭专用 AudioContext。
 */
import { AppError, toAppErrorInfo } from '../../domain/errors';
import { rememberSecret } from '../../domain/known-secrets';
import type { OffscreenEvent, OffscreenRequest } from '../../messaging/offscreen-protocol';
import { releaseAllSync } from '../cleanup';
import { t } from '../../i18n';

export type TtsPlayRequest = Extract<OffscreenRequest, { kind: 'tts/play' }>;

type TimerHandle = unknown;

export interface TtsPlayerDeps {
  createAudioContext(): AudioContext;
  synthesize(req: {
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    text: string;
    speed: number;
    signal: AbortSignal;
  }): Promise<{ audio: ArrayBuffer }>;
  emit(event: OffscreenEvent): void;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (h: TimerHandle) => void;
  idleCloseMs?: number;
  cacheMaxEntries?: number;
  cacheMaxBytes?: number;
}

interface Entry {
  utteranceId: string;
  controller: AbortController;
  phase: 'fetching' | 'decoding' | 'playing';
  source?: AudioBufferSourceNode;
  gain?: GainNode;
}

export class TtsPlayer {
  private current: Entry | null = null;
  private ctx: AudioContext | null = null;
  private idleTimer: TimerHandle | null = null;
  private lastFailed = false;
  private readonly stoppedIds = new Set<string>();
  private readonly cache = new Map<string, ArrayBuffer>();
  private cacheBytes = 0;
  private cacheSessionId: string | null = null;
  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimer: (h: TimerHandle) => void;

  constructor(private readonly deps: TtsPlayerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get busy(): boolean {
    return this.current !== null;
  }

  get pendingRequests(): number {
    return this.current?.phase === 'fetching' ? 1 : 0;
  }

  get state(): 'idle' | 'speaking' | 'error' {
    if (this.current) return 'speaking';
    return this.lastFailed ? 'error' : 'idle';
  }

  contextState(): 'none' | 'running' | 'suspended' | 'closed' {
    if (!this.ctx) return 'none';
    const s = this.ctx.state as string;
    return s === 'running' || s === 'closed' ? s : 'suspended';
  }

  /** 已被停止过的 utteranceId（迟到的 play 应被拒绝）。 */
  isStopped(utteranceId: string): boolean {
    return this.stoppedIds.has(utteranceId);
  }

  get cacheSize(): { entries: number; bytes: number } {
    return { entries: this.cache.size, bytes: this.cacheBytes };
  }

  clearCache(): void {
    this.cache.clear();
    this.cacheBytes = 0;
  }

  private rememberStopped(utteranceId: string): void {
    this.stoppedIds.delete(utteranceId);
    this.stoppedIds.add(utteranceId);
    while (this.stoppedIds.size > 200)
      this.stoppedIds.delete(this.stoppedIds.values().next().value!);
  }

  private cacheKey(req: TtsPlayRequest): string {
    return JSON.stringify([
      req.baseUrl,
      req.model,
      req.voice,
      Math.round(req.speed * 100) / 100,
      req.text,
    ]);
  }

  private cachePut(key: string, audio: ArrayBuffer): void {
    const max = this.deps.cacheMaxBytes ?? 20 * 1024 * 1024;
    if (audio.byteLength > max) return;
    const old = this.cache.get(key);
    if (old) {
      this.cacheBytes -= old.byteLength;
      this.cache.delete(key);
    }
    this.cache.set(key, audio);
    this.cacheBytes += audio.byteLength;
    const maxEntries = this.deps.cacheMaxEntries ?? 50;
    while (this.cache.size > maxEntries || this.cacheBytes > max) {
      const [k, v] = this.cache.entries().next().value!;
      this.cache.delete(k);
      this.cacheBytes -= v.byteLength;
    }
  }

  private cacheGet(key: string): ArrayBuffer | undefined {
    const hit = this.cache.get(key);
    if (!hit) return undefined;
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.slice(0);
  }

  /** 开始朗读；utteranceId 已被停止过时抛出 tts-utterance-stopped，不发声。 */
  play(req: TtsPlayRequest): void {
    if (this.stoppedIds.has(req.utteranceId)) {
      throw new AppError({
        code: 'tts-utterance-stopped',
        category: 'cancelled',
        retryable: false,
        message: t('background.offscreen.ttsStopped'),
      });
    }
    if (this.cacheSessionId !== req.owner.sessionId) {
      this.clearCache();
      this.cacheSessionId = req.owner.sessionId;
    }
    this.stop();
    this.cancelIdleClose();
    const entry: Entry = {
      utteranceId: req.utteranceId,
      controller: new AbortController(),
      phase: 'fetching',
    };
    this.current = entry;
    void this.run(entry, req);
  }

  private async run(entry: Entry, req: TtsPlayRequest): Promise<void> {
    try {
      rememberSecret(req.apiKey);
      const key = this.cacheKey(req);
      let audio = this.cacheGet(key);
      if (!audio) {
        const synthesized = await this.deps.synthesize({
          baseUrl: req.baseUrl,
          apiKey: req.apiKey,
          model: req.model,
          voice: req.voice,
          text: req.text,
          speed: req.speed,
          signal: entry.controller.signal,
        });
        // decodeAudioData 会转移 ArrayBuffer，缓存保存副本。
        this.cachePut(key, synthesized.audio.slice(0));
        audio = synthesized.audio;
      }
      if (this.current !== entry) return;
      entry.phase = 'decoding';
      const ctx = this.ensureContext();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
      if (this.current !== entry) return;
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(audio);
      } catch (error) {
        this.cache.delete(key);
        this.cacheBytes = Array.from(this.cache.values()).reduce((n, b) => n + b.byteLength, 0);
        throw new AppError(
          {
            code: 'tts-decode-failed',
            category: 'tts',
            retryable: false,
            message: t('background.offscreen.ttsDecodeFailed'),
          },
          { cause: error },
        );
      }
      if (this.current !== entry) return;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = Math.min(1, Math.max(0, req.volume));
      source.connect(gain);
      gain.connect(ctx.destination);
      entry.source = source;
      entry.gain = gain;
      source.onended = () => {
        if (this.current !== entry) return;
        this.current = null;
        this.release(entry);
        this.lastFailed = false;
        this.deps.emit({ kind: 'tts/event', utteranceId: entry.utteranceId, event: 'end' });
        this.scheduleIdleClose();
      };
      source.start();
      entry.phase = 'playing';
      this.lastFailed = false;
      this.deps.emit({ kind: 'tts/event', utteranceId: entry.utteranceId, event: 'start' });
    } catch (error) {
      if (this.current !== entry) return;
      // 先记录是否由停止触发，再释放（release 会 abort）。
      const aborted = entry.controller.signal.aborted;
      this.current = null;
      this.release(entry);
      if (aborted) return;
      this.lastFailed = true;
      this.deps.emit({
        kind: 'tts/event',
        utteranceId: entry.utteranceId,
        event: 'error',
        error: toAppErrorInfo(error, {
          code: 'tts-play-failed',
          category: 'tts',
          message: t('background.offscreen.ttsPlayFailed'),
        }),
      });
      this.scheduleIdleClose();
    }
  }

  /** 停止当前（或指定 id 的）朗读；返回是否确实停止了某个条目。 */
  stop(utteranceId?: string): boolean {
    if (utteranceId !== undefined) this.rememberStopped(utteranceId);
    else if (this.current) this.rememberStopped(this.current.utteranceId);
    const entry = this.current;
    if (!entry || (utteranceId !== undefined && entry.utteranceId !== utteranceId)) return false;
    this.current = null;
    this.release(entry);
    this.deps.emit({ kind: 'tts/event', utteranceId: entry.utteranceId, event: 'interrupted' });
    this.scheduleIdleClose();
    return true;
  }

  private release(entry: Entry): void {
    releaseAllSync([
      ['tts-fetch', () => entry.controller.abort()],
      ['tts-onended', entry.source ? () => void (entry.source!.onended = null) : null],
      [
        'tts-source-stop',
        entry.source && entry.phase === 'playing' ? () => entry.source!.stop() : null,
      ],
      ['tts-source-disconnect', entry.source ? () => entry.source!.disconnect() : null],
      ['tts-gain-disconnect', entry.gain ? () => entry.gain!.disconnect() : null],
    ]);
    entry.source = undefined;
    entry.gain = undefined;
  }

  private ensureContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = this.deps.createAudioContext();
    return this.ctx;
  }

  private cancelIdleClose(): void {
    if (this.idleTimer !== null) {
      this.clearTimer(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    if (!this.ctx) return;
    this.idleTimer = this.setTimer(() => {
      this.idleTimer = null;
      if (this.current || !this.ctx) return;
      const ctx = this.ctx;
      this.ctx = null;
      ctx.close().catch(() => undefined);
    }, this.deps.idleCloseMs ?? 20_000);
  }

  /** 释放全部资源（可重复调用）。 */
  async dispose(): Promise<void> {
    this.clearCache();
    const entry = this.current;
    if (entry) {
      this.current = null;
      this.release(entry);
      this.deps.emit({ kind: 'tts/event', utteranceId: entry.utteranceId, event: 'interrupted' });
    }
    this.cancelIdleClose();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') {
      try {
        await ctx.close();
      } catch {
        // 已关闭或不可关闭
      }
    }
  }
}

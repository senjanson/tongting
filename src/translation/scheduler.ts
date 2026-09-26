/**
 * 翻译调度器（每个会话一个实例，运行在 service worker）。
 *
 * 不变量（对应 EXECUTION_PLAN §9.1 与 T07–T13、T27、T38）：
 * 1. 只有批次开始时的 (sessionId, epoch, configRevision) 仍为当前值时，结果才会以 done/failed 发出。
 *    epoch 变化后仍在途且与新播放区间相关的请求可以继续；其通过校验的结果进入缓存，
 *    再由当前 epoch 通过缓存命中路径发出，绝不以旧 epoch 直接回写。
 * 2. cue 的 revision/原文变化会让旧请求结果失效（按条目 gen 比对），不会错配。
 * 3. setConfig / pause / setCues / dispose 立即中止在途 HTTP 请求（AbortController），不是只忽略结果。
 * 4. 失败、空译文、partial 结果不写缓存；缓存读写失败或超时只计数，不影响翻译。
 * 5. 429：共享冷却、并发降为 1、暂停预取，冷却后串行恢复；连续成功若干次后恢复并发与预取。
 * 6. 401/403/余额/配置类错误不重试；连续多次失败（格式、5xx、网络）触发熔断。两者都暂停发送新请求，
 *    原因通过 stats().blockedError 暴露，直到 resume / retryFailed / setConfig / setCues。
 * 7. 已发出 running 的 cue 回到待翻译（退避、中止、暂停、冷却、换 provider）时发出 pending，
 *    不会停留在 running。
 * 8. 所有时间、随机数、定时器可注入；dispose 后不再发出任何回调。
 */
import type { Cue } from '../domain/cue';
import { toAppErrorInfo, type AppErrorInfo } from '../domain/errors';
import { isSameLanguage } from '../domain/languages';
import type { TranslationStats } from '../domain/session';
import type {
  TextProvider,
  TranslateBatchInput,
  TranslateBatchResult,
  TranslateOptions,
  TranslationContextLine,
} from '../providers/text/types';
import { buildTranslationCacheKey } from '../storage/translation-cache';
import {
  backoffDelay,
  isAutoRetryable,
  isBlockingError,
  retryDelay,
  shortFingerprint,
} from './retry';
import type {
  CreateTranslationScheduler,
  CueTranslationUpdate,
  Playhead,
  SchedulerIdentity,
  TranslationConfig,
  TranslationScheduler,
  TranslationSchedulerDeps,
} from './types';
import { t as tr } from '../i18n';
import { diag } from '../diagnostics/log';

export interface SchedulerTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SchedulerOptions {
  /** 正常并发上限。 */
  maxConcurrency: number;
  maxBatchItems: number;
  /** 单批原文字符上限（单条超长 cue 单独成批）。 */
  maxBatchChars: number;
  contextLines: number;
  contextChars: number;
  /** 前文只取批次开始前这段时间内的 cue，避免跳转后带入无关上下文。 */
  contextWindowMs: number;
  /** 当前窗口：播放点之后多少毫秒（按倍速放大）。 */
  currentAheadMs: number;
  /** 预取窗口：播放点之后多少毫秒（按倍速放大）。 */
  prefetchAheadMs: number;
  /** 完整字幕轨道：播放点之前仍视为当前的范围。 */
  trackLookbehindMs: number;
  /** 增量字幕 / ASR：最终结果通常晚于播放点到达，回看范围更大。 */
  incrementalLookbehindMs: number;
  /** 窗口内未完成 cue 的上限；达到后停止远期预取。 */
  maxPendingCues: number;
  maxRetries: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  /** Retry-After 超过该值时不自动等待重试，直接标记失败（冷却仍然生效）。 */
  maxAutoRetryAfterMs: number;
  /** 冷却期上限，防止异常的 Retry-After 让调度器长期沉睡。 */
  maxCooldownMs: number;
  /** 限流后恢复正常并发所需的连续成功次数（成功后也恢复预取）。 */
  rateLimitRecoverySuccesses: number;
  /** 冷却结束后多久在并发 1 的前提下恢复预取（避免播放暂停时永远凑不够成功次数）。 */
  prefetchResumeDelayMs: number;
  /** 同一 provider 连续失败（无任何有效译文）的请求次数达到该值时熔断，暂停发送。 */
  circuitBreakerThreshold: number;
  /** 单次缓存读取的等待上限；超时视为未命中并计数。 */
  cacheLookupTimeoutMs: number;
  /** 播放点偏离预期超过该值视为跳转。 */
  jumpThresholdMs: number;
  maxConcurrentLookups: number;
  memoryResultLimit: number;
  timers: SchedulerTimers;
}

export const DEFAULT_SCHEDULER_OPTIONS: Omit<SchedulerOptions, 'timers'> = {
  maxConcurrency: 2,
  maxBatchItems: 8,
  maxBatchChars: 1_200,
  contextLines: 3,
  contextChars: 600,
  contextWindowMs: 30_000,
  currentAheadMs: 8_000,
  prefetchAheadMs: 45_000,
  trackLookbehindMs: 1_500,
  incrementalLookbehindMs: 30_000,
  maxPendingCues: 60,
  maxRetries: 2,
  baseRetryDelayMs: 1_000,
  maxRetryDelayMs: 30_000,
  maxAutoRetryAfterMs: 60_000,
  maxCooldownMs: 15 * 60_000,
  rateLimitRecoverySuccesses: 3,
  prefetchResumeDelayMs: 15_000,
  circuitBreakerThreshold: 5,
  cacheLookupTimeoutMs: 800,
  jumpThresholdMs: 3_000,
  maxConcurrentLookups: 80,
  memoryResultLimit: 2_000,
};

/** 允许的最长译文（与 Cue.translatedText 上限一致）。 */
const MAX_TRANSLATED_LENGTH = 8_000;
/** 查找窗口起点时额外回看的 cue 时长上限。 */
const MAX_CUE_SPAN_MS = 60_000;

type EntryStatus = 'inactive' | 'skipped' | 'idle' | 'lookup' | 'running' | 'done' | 'failed';

interface Entry {
  cue: Cue;
  status: EntryStatus;
  /** 全局递增；cue 内容或翻译配置变化时更新，用于判定旧结果是否仍适用。 */
  gen: number;
  text?: string;
  error?: AppErrorInfo;
  attempts: number;
  notBefore: number;
  /** 批量格式失败后改为单条请求。 */
  single: boolean;
  /** 最近一次对外发出的状态是 running（回到待翻译时需要补发 pending）。 */
  reportedRunning: boolean;
  batchId?: number;
  cacheKey?: string;
  cacheKeyGen?: number;
  lookedUpGen?: number;
  lookupToken?: number;
  blockedGen?: number;
}

interface BatchCue {
  id: string;
  revision: number;
  gen: number;
  cacheKey?: string;
}

interface Batch {
  id: number;
  controller: AbortController;
  aborted: boolean;
  sessionId: string;
  epoch: number;
  configRevision: number;
  config: TranslationConfig;
  provider: TextProvider;
  configKey: string;
  cues: BatchCue[];
}

interface Candidate {
  entry: Entry;
  /** 0 当前窗口；1 预取；2 全片补译（最低优先级，仅在其他工作全部空闲时发送）。 */
  tier: 0 | 1 | 2;
  distance: number;
}

/** 每轮最多加入的补译候选数（控制缓存查询与扫描开销）。 */
const BACKFILL_CANDIDATES_PER_PASS = 32;

/**
 * TranslateOptions 的实现扩展（与 providers/text/text-provider.ts 的 ExtendedTranslateOptions 一致）：
 * 单条重试时关闭 provider 内的格式修复，避免重复计费。不认识该字段的 provider 会忽略它。
 */
export type SchedulerTranslateOptions = TranslateOptions & { maxRepairAttempts?: number };

export interface SchedulerInspection {
  /** 当前在途的真实请求数（包括旧 epoch 仍在途的请求）。 */
  inflightRequests: number;
  /** 调用 provider.translateBatch 的总次数。 */
  providerCalls: number;
  concurrencyLimit: number;
  prefetchSuspended: boolean;
  blockedError?: AppErrorInfo;
  paused: boolean;
  disposed: boolean;
  cacheReadFailures: number;
  cacheReadTimeouts: number;
  cacheWriteFailures: number;
  consecutiveFailedCalls: number;
  pendingLookups: number;
  memoryResults: number;
}

export interface InspectableTranslationScheduler extends TranslationScheduler {
  /** 测试与诊断用：真实副作用计数。 */
  inspect(): SchedulerInspection;
}

const realTimers: SchedulerTimers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createTranslationSchedulerWithOptions(
  deps: TranslationSchedulerDeps,
  initialConfig: TranslationConfig,
  initialIdentity: SchedulerIdentity,
  overrides: Partial<SchedulerOptions> = {},
): InspectableTranslationScheduler {
  const opts: SchedulerOptions = { ...DEFAULT_SCHEDULER_OPTIONS, timers: realTimers, ...overrides };
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const cache = deps.cache;

  let provider = deps.provider;
  let config: TranslationConfig = { ...initialConfig, glossary: [...initialConfig.glossary] };
  let identity: SchedulerIdentity = { ...initialIdentity };
  let configKey = computeConfigKey(provider, config);

  const entries = new Map<string, Entry>();
  let order: Entry[] = [];
  let orderIndex = new Map<Entry, number>();
  let orderDirty = true;

  const inflight = new Map<number, Batch>();
  const memory = new Map<string, string>();
  const listeners = new Set<(updates: CueTranslationUpdate[]) => void>();
  let pendingUpdates: CueTranslationUpdate[] = [];

  let playhead: Playhead = { mediaTimeMs: 0, playing: false, playbackRate: 1 };
  let playheadAt: number | undefined;

  let genSeq = 0;
  let batchSeq = 0;
  let lookupSeq = 0;
  let providerCalls = 0;
  let pendingLookups = 0;
  let cacheReadFailures = 0;
  let cacheReadTimeouts = 0;
  let cacheWriteFailures = 0;

  let paused = false;
  let disposed = false;
  let blockedError: AppErrorInfo | undefined;
  let consecutiveFailedCalls = 0;
  let rateLimitedUntil = 0;
  let concurrencyLimit = opts.maxConcurrency;
  let backfill = false;
  let successesSinceRateLimit = 0;
  let consecutiveRateLimits = 0;
  let rateLimitResumeAt = 0;
  let wakeHandle: unknown;
  let wakeAt = Infinity;

  let lastLatencyMs: number | undefined;
  let lastModel: string | undefined;

  /** 影响译文内容的配置指纹（不含 prefetch / useCache / timeoutMs 等只影响调度的字段）。 */
  function computeConfigKey(p: TextProvider, c: TranslationConfig): string {
    const fp = shortFingerprint(
      JSON.stringify([
        p.profileKey,
        c.sourceLanguage,
        c.targetLanguage,
        c.style,
        c.glossary.map((g) => [g.source, g.target]),
      ]),
    );
    return `${p.promptVersion}:${fp}`.slice(0, 200);
  }

  // ---------- 发出更新 ----------

  function queue(update: CueTranslationUpdate): void {
    if (!disposed) pendingUpdates.push(update);
  }

  function flush(): void {
    if (disposed || pendingUpdates.length === 0) {
      pendingUpdates = [];
      return;
    }
    const updates = pendingUpdates;
    pendingUpdates = [];
    for (const listener of [...listeners]) {
      try {
        listener(updates);
      } catch {
        // 监听器异常不影响调度
      }
    }
  }

  // ---------- 条目状态 ----------

  function effectiveSourceLanguage(cue: Cue): string {
    if (config.sourceLanguage && config.sourceLanguage !== 'auto') return config.sourceLanguage;
    return cue.sourceLanguage && cue.sourceLanguage !== 'und' ? cue.sourceLanguage : 'auto';
  }

  function initialStatus(cue: Cue): EntryStatus {
    if (cue.stability !== 'final') return 'inactive';
    if (!cue.sourceText.trim()) return 'skipped';
    if (isSameLanguage(effectiveSourceLanguage(cue), config.targetLanguage)) return 'skipped';
    return 'idle';
  }

  /** 回到待翻译；如果对外最后报告的是 running，则补发 pending。 */
  function markIdle(entry: Entry, emitPending = true): void {
    entry.status = 'idle';
    if (entry.reportedRunning) {
      entry.reportedRunning = false;
      if (emitPending) {
        queue({ cueId: entry.cue.id, cueRevision: entry.cue.revision, state: 'pending' });
      }
    }
  }

  function markDone(entry: Entry, text: string, translationKey: string, fromCache: boolean): void {
    entry.status = 'done';
    entry.text = text;
    entry.error = undefined;
    entry.reportedRunning = false;
    const update: CueTranslationUpdate = {
      cueId: entry.cue.id,
      cueRevision: entry.cue.revision,
      state: 'done',
      translatedText: text,
      translationKey,
    };
    if (fromCache) update.fromCache = true;
    queue(update);
  }

  /** 重置条目的翻译状态（cue 或配置变化）。 */
  function resetEntry(entry: Entry, cue: Cue): void {
    entry.cue = cue;
    entry.gen = ++genSeq;
    entry.text = undefined;
    entry.error = undefined;
    entry.attempts = 0;
    entry.notBefore = 0;
    entry.single = false;
    entry.reportedRunning = false;
    entry.batchId = undefined;
    entry.cacheKey = undefined;
    entry.cacheKeyGen = undefined;
    entry.lookedUpGen = undefined;
    entry.lookupToken = undefined;
    entry.blockedGen = undefined;
    entry.status = initialStatus(cue);
    if (entry.status === 'skipped') {
      queue({ cueId: cue.id, cueRevision: cue.revision, state: 'skipped' });
    }
  }

  function createEntry(cue: Cue): Entry {
    const entry = {
      cue,
      status: 'idle',
      gen: 0,
      attempts: 0,
      notBefore: 0,
      single: false,
      reportedRunning: false,
    } as Entry;
    resetEntry(entry, cue);
    return entry;
  }

  function ensureOrder(): void {
    if (!orderDirty) return;
    order = [...entries.values()].sort(
      (a, b) =>
        a.cue.startMs - b.cue.startMs || (a.cue.id < b.cue.id ? -1 : a.cue.id > b.cue.id ? 1 : 0),
    );
    orderIndex = new Map(order.map((entry, index) => [entry, index]));
    orderDirty = false;
  }

  // ---------- 阻断与熔断 ----------

  function unblock(): void {
    blockedError = undefined;
    consecutiveFailedCalls = 0;
  }

  /** 记录一次「没有得到任何有效译文」的请求；连续达到阈值时熔断。 */
  function noteFailedCall(info: AppErrorInfo): void {
    consecutiveFailedCalls++;
    if (blockedError || consecutiveFailedCalls < opts.circuitBreakerThreshold) return;
    blockedError = {
      code: 'circuit-open',
      category: info.category,
      retryable: true,
      message: tr('background.scheduler.circuitOpen', { count: consecutiveFailedCalls }),
      detail: `last=${info.code}${info.httpStatus ? ` http=${info.httpStatus}` : ''}`,
      at: now(),
    };
  }

  // ---------- 批次中止 ----------

  function abortBatch(batch: Batch, emitPending = true): void {
    if (batch.aborted) return;
    batch.aborted = true;
    inflight.delete(batch.id);
    try {
      batch.controller.abort();
    } catch {
      // 忽略
    }
    for (const bc of batch.cues) {
      const entry = entries.get(bc.id);
      if (entry && entry.batchId === batch.id) {
        entry.batchId = undefined;
        if (entry.status === 'running') {
          markIdle(entry, emitPending);
          // 被中止的请求可能仍迟到返回并写入缓存；再次发送前先重新查缓存。
          entry.lookedUpGen = undefined;
        }
      }
    }
  }

  function abortAll(emitPending = true): void {
    for (const batch of [...inflight.values()]) abortBatch(batch, emitPending);
  }

  /** 没有任何条目还在等待该批次时中止它（全部被删除或修订）。 */
  function abortIfOrphan(batchId: number | undefined): void {
    if (batchId === undefined) return;
    const batch = inflight.get(batchId);
    if (!batch) return;
    const stillUsed = batch.cues.some((bc) => {
      const entry = entries.get(bc.id);
      return entry !== undefined && entry.batchId === batch.id && entry.gen === bc.gen;
    });
    if (!stillUsed) abortBatch(batch);
  }

  /** 跳转后：中止与新播放区间无关的在途请求。 */
  function abortIrrelevant(): void {
    const wanted = new Set(collectCandidates().map((c) => c.entry));
    for (const batch of [...inflight.values()]) {
      const relevant = batch.cues.some((bc) => {
        const entry = entries.get(bc.id);
        return entry !== undefined && entry.batchId === batch.id && wanted.has(entry);
      });
      if (!relevant) abortBatch(batch);
    }
  }

  // ---------- 窗口与批次选择 ----------

  function prefetchAllowed(): boolean {
    if (!config.prefetch) return false;
    return (
      concurrencyLimit >= opts.maxConcurrency ||
      now() >= rateLimitedUntil + opts.prefetchResumeDelayMs
    );
  }

  function collectCandidates(): Candidate[] {
    ensureOrder();
    const t = playhead.mediaTimeMs;
    const rate = Math.max(1, Number.isFinite(playhead.playbackRate) ? playhead.playbackRate : 1);
    const aheadEnd = t + opts.currentAheadMs * rate;
    const allowPrefetch = prefetchAllowed();
    const prefetchEnd = allowPrefetch ? t + opts.prefetchAheadMs * rate : aheadEnd;
    const lowStart =
      t - Math.max(opts.trackLookbehindMs, opts.incrementalLookbehindMs) - MAX_CUE_SPAN_MS;

    let lo = 0;
    let hi = order.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (order[mid]!.cue.startMs < lowStart) lo = mid + 1;
      else hi = mid;
    }

    const out: Candidate[] = [];
    let unfinished = 0;
    for (let i = lo; i < order.length; i++) {
      const entry = order[i]!;
      const cue = entry.cue;
      if (cue.startMs >= Math.max(aheadEnd, prefetchEnd)) break;
      if (entry.status === 'inactive' || entry.status === 'skipped') continue;
      const lookbehind =
        cue.source === 'caption-track' ? opts.trackLookbehindMs : opts.incrementalLookbehindMs;
      let tier: 0 | 1;
      if (cue.endMs > t - lookbehind && cue.startMs < aheadEnd) tier = 0;
      else if (allowPrefetch && cue.startMs >= t && cue.startMs < prefetchEnd) tier = 1;
      else continue;
      const finished = entry.status === 'done';
      if (tier === 1 && !finished && unfinished >= opts.maxPendingCues) continue;
      if (!finished) unfinished++;
      let distance: number;
      if (cue.startMs <= t && cue.endMs > t) distance = 0;
      else if (cue.startMs > t) distance = cue.startMs - t;
      else distance = t - cue.endMs + 1;
      out.push({ entry, tier, distance });
    }
    if (backfill && allowPrefetch && !out.some((c) => c.tier < 2 && c.entry.status !== 'done')) {
      // 全片补译：播放窗口内没有未完成工作时，从播放点之后开始、再回到开头，按顺序补齐完整轨道的译文。
      const seen = new Set(out.map((c) => c.entry));
      const pick = (entry: Entry): boolean => {
        if (seen.has(entry) || entry.cue.source !== 'caption-track') return false;
        if (entry.status !== 'idle' && entry.status !== 'lookup') return false;
        const d =
          entry.cue.startMs >= t
            ? entry.cue.startMs - t
            : Number.MAX_SAFE_INTEGER / 2 + entry.cue.startMs;
        out.push({ entry, tier: 2, distance: d });
        return out.filter((c) => c.tier === 2).length >= BACKFILL_CANDIDATES_PER_PASS;
      };
      let full = false;
      for (let i = lo; i < order.length && !full; i++) full = pick(order[i]!);
      for (let i = 0; i < lo && !full; i++) full = pick(order[i]!);
    }
    return out;
  }

  function isReady(entry: Entry, t: number): boolean {
    return entry.status === 'idle' && entry.notBefore <= t && entry.lookedUpGen === entry.gen;
  }

  function buildBatch(candidates: Candidate[], t: number): Entry[] | undefined {
    let seed: Candidate | undefined;
    const wanted = new Set<Entry>();
    for (const c of candidates) {
      wanted.add(c.entry);
      if (!isReady(c.entry, t)) continue;
      if (!seed || c.tier < seed.tier || (c.tier === seed.tier && c.distance < seed.distance))
        seed = c;
    }
    if (!seed) return undefined;
    // 补译只在没有任何在途请求时发送（并发 1），不与播放窗口争用额度。
    if (seed.tier === 2 && inflight.size > 0) return undefined;
    // 当前窗口还有 cue 在查缓存时不发送预取批次，保证播放位置优先。
    if (seed.tier === 1 && candidates.some((c) => c.tier === 0 && c.entry.status === 'lookup'))
      return undefined;
    const members = [seed.entry];
    if (seed.entry.single) return members;
    let chars = seed.entry.cue.sourceText.length;
    const index = orderIndex.get(seed.entry)!;
    const canJoin = (entry: Entry | undefined): entry is Entry =>
      entry !== undefined && wanted.has(entry) && isReady(entry, t) && !entry.single;
    for (let j = index + 1; j < order.length && members.length < opts.maxBatchItems; j++) {
      const entry = order[j];
      if (!canJoin(entry) || chars + entry.cue.sourceText.length > opts.maxBatchChars) break;
      members.push(entry);
      chars += entry.cue.sourceText.length;
    }
    for (let j = index - 1; j >= 0 && members.length < opts.maxBatchItems; j--) {
      const entry = order[j];
      if (!canJoin(entry) || chars + entry.cue.sourceText.length > opts.maxBatchChars) break;
      members.unshift(entry);
      chars += entry.cue.sourceText.length;
    }
    return members;
  }

  function buildContext(first: Entry): TranslationContextLine[] {
    const index = orderIndex.get(first);
    if (index === undefined) return [];
    const lines: TranslationContextLine[] = [];
    let chars = 0;
    for (let j = index - 1; j >= 0 && lines.length < opts.contextLines; j--) {
      const entry = order[j]!;
      if (entry.cue.endMs < first.cue.startMs - opts.contextWindowMs) break;
      if (entry.status === 'inactive') continue;
      const text = entry.cue.sourceText.trim();
      if (!text) continue;
      if (chars + text.length > opts.contextChars) break;
      chars += text.length;
      lines.unshift(
        entry.status === 'done' && entry.text ? { text, translation: entry.text } : { text },
      );
    }
    return lines;
  }

  // ---------- 缓存查找 ----------

  function rememberInMemory(key: string, value: string): void {
    memory.delete(key);
    memory.set(key, value);
    while (memory.size > opts.memoryResultLimit) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  }

  async function ensureCacheKey(entry: Entry): Promise<string> {
    if (entry.cacheKeyGen === entry.gen && entry.cacheKey) return entry.cacheKey;
    const gen = entry.gen;
    const key = await buildTranslationCacheKey({
      sourceKey: identity.sourceKey,
      sourceText: entry.cue.sourceText,
      sourceLanguage: effectiveSourceLanguage(entry.cue),
      targetLanguage: config.targetLanguage,
      profileKey: provider.profileKey,
      promptVersion: provider.promptVersion,
      style: config.style,
      glossary: config.glossary,
    });
    if (entry.gen === gen) {
      entry.cacheKey = key;
      entry.cacheKeyGen = gen;
    }
    return key;
  }

  /** 读取持久缓存，带等待上限：超时或出错都视为未命中，不让调度器停摆。 */
  function readCacheWithTimeout(key: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      let settled = false;
      const timer = opts.timers.setTimeout(() => {
        if (settled) return;
        settled = true;
        cacheReadTimeouts++;
        resolve(undefined);
      }, opts.cacheLookupTimeoutMs);
      let pending: Promise<string | undefined>;
      try {
        pending = cache.get(key);
      } catch (error) {
        pending = Promise.reject(error);
      }
      pending.then(
        (value) => {
          if (settled) return;
          settled = true;
          opts.timers.clearTimeout(timer);
          resolve(value);
        },
        () => {
          if (settled) return;
          settled = true;
          opts.timers.clearTimeout(timer);
          cacheReadFailures++;
          resolve(undefined);
        },
      );
    });
  }

  /**
   * 成组查缓存：命中逐条发出；未命中的整组完成后才触发一次 pump，避免批次被切碎（多花请求）。
   * 每条读取都有等待上限，因此一组的等待时间有界。
   */
  function startLookups(group: Entry[]): void {
    if (group.length === 0) return;
    const token = ++lookupSeq;
    const members = group.map((entry) => ({ entry, gen: entry.gen }));
    for (const entry of group) {
      entry.status = 'lookup';
      entry.lookupToken = token;
    }
    pendingLookups += group.length;

    const lookupOne = async ({ entry, gen }: { entry: Entry; gen: number }): Promise<void> => {
      const stillValid = () =>
        !disposed &&
        entries.get(entry.cue.id) === entry &&
        entry.gen === gen &&
        entry.lookupToken === token &&
        entry.status === 'lookup';
      let hit: string | undefined;
      let keyOk = true;
      try {
        const key = await ensureCacheKey(entry);
        if (!stillValid()) return;
        hit = memory.get(key);
        if (hit === undefined && config.useCache) {
          hit = await readCacheWithTimeout(key);
          if (!stillValid()) return;
          if (hit !== undefined && hit.trim() && hit.length <= MAX_TRANSLATED_LENGTH)
            rememberInMemory(key, hit);
        }
      } catch {
        // 缓存键计算失败：不使用缓存，直接翻译（结果也不会写缓存）。
        keyOk = false;
        if (!stillValid()) return;
      }
      entry.lookupToken = undefined;
      if (paused) {
        entry.status = 'idle';
        return;
      }
      if (keyOk && hit !== undefined && hit.trim() && hit.length <= MAX_TRANSLATED_LENGTH) {
        markDone(entry, hit.trim(), configKey, true);
        flush();
      } else {
        entry.status = 'idle';
        entry.lookedUpGen = gen;
      }
    };

    void Promise.all(
      members.map((member) =>
        lookupOne(member).finally(() => {
          pendingLookups--;
        }),
      ),
    ).finally(() => {
      if (!disposed) pump();
    });
  }

  // ---------- 请求 ----------

  function startBatch(members: Entry[]): void {
    const batch: Batch = {
      id: ++batchSeq,
      controller: new AbortController(),
      aborted: false,
      sessionId: identity.sessionId,
      epoch: identity.epoch,
      configRevision: identity.configRevision,
      config,
      provider,
      configKey,
      cues: members.map((entry) => ({
        id: entry.cue.id,
        revision: entry.cue.revision,
        gen: entry.gen,
        cacheKey: entry.cacheKeyGen === entry.gen ? entry.cacheKey : undefined,
      })),
    };
    const context = buildContext(members[0]!);
    for (const entry of members) {
      entry.status = 'running';
      entry.batchId = batch.id;
      entry.reportedRunning = true;
      queue({ cueId: entry.cue.id, cueRevision: entry.cue.revision, state: 'running' });
    }
    inflight.set(batch.id, batch);

    const languages = new Set(members.map((entry) => effectiveSourceLanguage(entry.cue)));
    const input: TranslateBatchInput = {
      items: members.map((entry) => ({ id: entry.cue.id, text: entry.cue.sourceText.trim() })),
      context,
      sourceLanguage: languages.size === 1 ? [...languages][0]! : 'auto',
      targetLanguage: config.targetLanguage,
      style: config.style,
      glossary: config.glossary,
    };
    const translateOptions: SchedulerTranslateOptions = {
      signal: batch.controller.signal,
      timeoutMs: batch.config.timeoutMs,
      onPartial: (items) => onPartial(batch, items),
    };
    // 批量格式失败后的单条重试本身就是修复，不再让 provider 追加修复请求。
    if (members.length === 1 && members[0]!.single) translateOptions.maxRepairAttempts = 0;

    providerCalls++;
    let promise: Promise<TranslateBatchResult>;
    try {
      promise = batch.provider.translateBatch(input, translateOptions);
    } catch (error) {
      promise = Promise.reject(error);
    }
    promise.then(
      (result) => onBatchSuccess(batch, result),
      (error: unknown) => onBatchFailure(batch, error),
    );
  }

  function isCurrentBatch(batch: Batch): boolean {
    return (
      batch.sessionId === identity.sessionId &&
      batch.epoch === identity.epoch &&
      batch.configRevision === identity.configRevision
    );
  }

  function entryForBatch(batch: Batch, bc: BatchCue): Entry | undefined {
    const entry = entries.get(bc.id);
    return entry && entry.batchId === batch.id && entry.gen === bc.gen ? entry : undefined;
  }

  function onPartial(batch: Batch, items: { id: string; text: string }[]): void {
    if (disposed || paused || batch.aborted || !isCurrentBatch(batch)) return;
    for (const item of items) {
      const bc = batch.cues.find((c) => c.id === item.id);
      if (!bc) continue;
      const entry = entryForBatch(batch, bc);
      if (!entry || entry.status !== 'running' || !item.text.trim()) continue;
      queue({
        cueId: bc.id,
        cueRevision: bc.revision,
        state: 'running',
        translatedText: item.text,
        partial: true,
      });
    }
    flush();
  }

  function onBatchSuccess(batch: Batch, result: TranslateBatchResult): void {
    if (disposed) return;
    const results = new Map<string, string>();
    for (const item of result.items ?? []) {
      const text = typeof item.text === 'string' ? item.text.trim() : '';
      if (text && text.length <= MAX_TRANSLATED_LENGTH) results.set(item.id, text);
    }
    // 通过校验的终态结果可以进入缓存（使用该批次自己的配置对应的键），即使批次已过期。
    for (const bc of batch.cues) {
      const text = results.get(bc.id);
      if (!text || !bc.cacheKey) continue;
      rememberInMemory(bc.cacheKey, text);
      if (batch.config.useCache) {
        cache.set(bc.cacheKey, text).catch(() => {
          cacheWriteFailures++;
        });
      }
    }
    if (batch.aborted) return;
    inflight.delete(batch.id);

    lastLatencyMs = result.latencyMs;
    lastModel = result.model;
    const sameProvider = batch.provider.profileKey === provider.profileKey;
    if (sameProvider) {
      if (results.size > 0) {
        consecutiveFailedCalls = 0;
        noteSuccess();
      } else {
        const info: AppErrorInfo = {
          code: 'translation-incomplete',
          category: 'format',
          retryable: true,
          message: tr('background.scheduler.noValidTranslation'),
        };
        noteFailedCall(info);
        logRequestFailure(info, batch);
      }
    }

    const current = isCurrentBatch(batch);
    for (const bc of batch.cues) {
      const entry = entryForBatch(batch, bc);
      if (!entry) continue;
      entry.batchId = undefined;
      const text = results.get(bc.id);
      if (text) {
        if (current) {
          markDone(entry, text, batch.configKey, false);
        } else {
          // 旧 epoch 的结果：不直接回写，交给当前 epoch 的缓存命中路径发出。
          markIdle(entry);
          entry.lookedUpGen = undefined;
        }
      } else {
        handleFormatFailure(entry, batch, current, {
          code: 'translation-incomplete',
          category: 'format',
          retryable: true,
          message: tr('background.scheduler.cueNoValidTranslation'),
          at: now(),
        });
      }
    }
    pump();
  }

  function handleFormatFailure(
    entry: Entry,
    batch: Batch,
    current: boolean,
    info: AppErrorInfo,
  ): void {
    if (batch.cues.length > 1 && !entry.single) {
      // 批量结果不可信时改为单条请求一次，避免相邻字幕错配。
      entry.single = true;
      markIdle(entry);
      return;
    }
    failEntry(entry, info, current);
  }

  function failEntry(entry: Entry, info: AppErrorInfo, current: boolean): void {
    if (!current) {
      // 旧 epoch 的失败不发出；保留尝试次数，在当前 epoch 再判定。
      markIdle(entry);
      entry.lookedUpGen = undefined;
      return;
    }
    entry.status = 'failed';
    entry.error = info;
    entry.reportedRunning = false;
    queue({ cueId: entry.cue.id, cueRevision: entry.cue.revision, state: 'failed', error: info });
  }

  function noteSuccess(): void {
    consecutiveRateLimits = 0;
    if (concurrencyLimit < opts.maxConcurrency && now() >= rateLimitedUntil) {
      successesSinceRateLimit++;
      if (successesSinceRateLimit >= opts.rateLimitRecoverySuccesses) {
        concurrencyLimit = opts.maxConcurrency;
        successesSinceRateLimit = 0;
      }
    }
  }

  function applyRateLimit(info: AppErrorInfo, t: number): void {
    consecutiveRateLimits++;
    const delay =
      info.retryAfterMs ??
      backoffDelay(
        consecutiveRateLimits,
        { baseDelayMs: opts.baseRetryDelayMs, maxDelayMs: opts.maxRetryDelayMs },
        random,
      );
    const until = t + Math.min(delay, opts.maxCooldownMs);
    if (until > rateLimitedUntil) {
      rateLimitedUntil = until;
      // 冷却后的恢复时间只抖动一次并由所有受影响 cue 共享：避免同一批 cue 在不同时刻就绪而被拆成碎片请求。
      rateLimitResumeAt = until + Math.round(random() * Math.min(1_000, opts.baseRetryDelayMs));
    }
    concurrencyLimit = 1;
    successesSinceRateLimit = 0;
  }

  /** 诊断日志：每次请求失败的错误码、HTTP 状态与服务返回的错误类型；同类失败只在变化时和每 20 次记录。 */
  let failureLog = { key: '', count: 0 };
  function logRequestFailure(info: AppErrorInfo, batch: Batch): void {
    const key = `${info.code}|${info.httpStatus}|${info.detail}`;
    if (key === failureLog.key) {
      failureLog.count++;
      if (failureLog.count % 20 !== 0) return;
    } else {
      failureLog = { key, count: 1 };
    }
    diag(
      'translate.request-failed',
      {
        code: info.code,
        category: info.category,
        httpStatus: info.httpStatus,
        retryable: info.retryable,
        retryAfterMs: info.retryAfterMs,
        detail: info.detail,
        message: info.message,
        cues: batch.cues.length,
        consecutiveFailedCalls,
        count: failureLog.count,
      },
      'warn',
    );
  }

  function onBatchFailure(batch: Batch, error: unknown): void {
    if (disposed || batch.aborted) return;
    inflight.delete(batch.id);
    let info = toAppErrorInfo(error);
    const t = now();

    if (info.category === 'cancelled') {
      // 不是本调度器中止的（本调度器中止的批次在上面已返回）：按可重试的网络错误处理，计入次数并退避，
      // 避免传输层反复自行取消时无限立即重发。
      info = {
        code: 'request-cancelled',
        category: 'network',
        retryable: true,
        message: tr('background.scheduler.unexpectedAbort'),
        at: t,
      };
    }

    const sameProvider = batch.provider.profileKey === provider.profileKey;
    if (sameProvider) {
      if (info.category === 'rate-limit') applyRateLimit(info, t);
      else if (isBlockingError(info)) blockedError = info;
      else noteFailedCall(info);
    }
    logRequestFailure(info, batch);

    const current = isCurrentBatch(batch);
    // 同一次失败只计算一次退避（按尝试次数），同批 cue 同时就绪，重试时仍能合并成完整批次。
    const delayByAttempt = new Map<number, number>();
    for (const bc of batch.cues) {
      const entry = entryForBatch(batch, bc);
      if (!entry) continue;
      entry.batchId = undefined;
      if (isAutoRetryable(info)) {
        const tooLong =
          info.retryAfterMs !== undefined && info.retryAfterMs > opts.maxAutoRetryAfterMs;
        if (entry.attempts < opts.maxRetries && !tooLong) {
          entry.attempts++;
          markIdle(entry);
          if (info.category === 'rate-limit') {
            entry.notBefore = Math.max(rateLimitResumeAt, t);
          } else {
            let delay = delayByAttempt.get(entry.attempts);
            if (delay === undefined) {
              delay = retryDelay(
                info,
                entry.attempts,
                { baseDelayMs: opts.baseRetryDelayMs, maxDelayMs: opts.maxRetryDelayMs },
                random,
              );
              delayByAttempt.set(entry.attempts, delay);
            }
            entry.notBefore = t + delay;
          }
          continue;
        }
        failEntry(entry, info, current);
      } else if (info.category === 'format') {
        handleFormatFailure(entry, batch, current, info);
      } else {
        failEntry(entry, info, current);
      }
    }
    pump();
  }

  // ---------- 主循环 ----------

  function cancelWake(): void {
    if (wakeHandle !== undefined) {
      opts.timers.clearTimeout(wakeHandle);
      wakeHandle = undefined;
    }
    wakeAt = Infinity;
  }

  function scheduleWake(at: number, t: number): void {
    if (at >= wakeAt && wakeHandle !== undefined) return;
    cancelWake();
    wakeAt = at;
    wakeHandle = opts.timers.setTimeout(
      () => {
        wakeHandle = undefined;
        wakeAt = Infinity;
        pump();
      },
      Math.max(0, at - t),
    );
  }

  function pump(): void {
    if (disposed || paused) {
      flush();
      return;
    }
    const t = now();
    const candidates = collectCandidates();

    // 本轮需要查缓存的 cue 作为一组（本地读取、有等待上限），整组完成后再组批，保证批次完整。
    const lookupGroup: Entry[] = [];
    let lookupBudget = opts.maxConcurrentLookups - pendingLookups;
    for (const c of candidates) {
      if (lookupBudget <= 0) break;
      const entry = c.entry;
      if (
        entry.status === 'idle' &&
        entry.lookedUpGen !== entry.gen &&
        entry.lookupToken === undefined
      ) {
        lookupGroup.push(entry);
        lookupBudget--;
      }
    }
    startLookups(lookupGroup);

    let nextWake = Infinity;
    if (blockedError) {
      // 服务级错误或熔断：不再发送请求；当前窗口里已确认缓存未命中的 cue 标记为同一错误。
      for (const c of candidates) {
        const entry = c.entry;
        if (c.tier === 0 && isReady(entry, t) && entry.blockedGen !== entry.gen) {
          entry.blockedGen = entry.gen;
          failEntry(entry, blockedError, true);
        }
      }
    } else if (t < rateLimitedUntil) {
      nextWake = rateLimitedUntil;
    } else {
      while (inflight.size < concurrencyLimit) {
        const members = buildBatch(candidates, t);
        if (!members) break;
        startBatch(members);
      }
    }

    for (const c of candidates) {
      if (c.entry.status === 'idle' && c.entry.notBefore > t)
        nextWake = Math.min(nextWake, c.entry.notBefore);
    }
    if (config.prefetch && concurrencyLimit < opts.maxConcurrency && !blockedError) {
      const resumeAt = rateLimitedUntil + opts.prefetchResumeDelayMs;
      if (resumeAt > t) nextWake = Math.min(nextWake, resumeAt);
    }
    if (nextWake < Infinity) scheduleWake(nextWake, t);
    else cancelWake();
    flush();
  }

  /** 失败条目回到待翻译并发出 pending（重试 / 解除阻断时）。 */
  function requeueFailed(entry: Entry): void {
    entry.status = 'idle';
    entry.error = undefined;
    entry.attempts = 0;
    entry.notBefore = 0;
    entry.lookedUpGen = undefined;
    entry.blockedGen = undefined;
    entry.reportedRunning = false;
    queue({ cueId: entry.cue.id, cueRevision: entry.cue.revision, state: 'pending' });
  }

  // ---------- 公共接口 ----------

  const scheduler: InspectableTranslationScheduler = {
    setCues(cues, nextIdentity) {
      if (disposed) return;
      // 整体替换：协调器会在本地重置状态，旧 cue 不再补发 pending（避免误作用于同 id 的新 cue）。
      abortAll(false);
      entries.clear();
      identity = { ...nextIdentity };
      unblock();
      for (const cue of cues) {
        const existing = entries.get(cue.id);
        if (existing) resetEntry(existing, cue);
        else entries.set(cue.id, createEntry(cue));
      }
      orderDirty = true;
      pump();
    },

    upsertCues(cues) {
      if (disposed) return;
      for (const cue of cues) {
        const existing = entries.get(cue.id);
        if (!existing) {
          entries.set(cue.id, createEntry(cue));
          orderDirty = true;
          continue;
        }
        if (existing.cue.startMs !== cue.startMs || existing.cue.endMs !== cue.endMs)
          orderDirty = true;
        const changed =
          existing.cue.revision !== cue.revision ||
          existing.cue.sourceText !== cue.sourceText ||
          existing.cue.stability !== cue.stability ||
          existing.cue.sourceLanguage !== cue.sourceLanguage;
        if (!changed) {
          existing.cue = cue;
          continue;
        }
        const batchId = existing.batchId;
        resetEntry(existing, cue);
        abortIfOrphan(batchId);
      }
      pump();
    },

    removeCues(ids) {
      if (disposed) return;
      const batchIds = new Set<number>();
      for (const id of ids) {
        const entry = entries.get(id);
        if (!entry) continue;
        if (entry.batchId !== undefined) batchIds.add(entry.batchId);
        entries.delete(id);
        orderDirty = true;
      }
      for (const batchId of batchIds) abortIfOrphan(batchId);
      pump();
    },

    setPlayhead(next) {
      if (disposed) return;
      const t = now();
      const previous = playhead;
      const previousAt = playheadAt;
      playhead = {
        mediaTimeMs: Math.max(0, Number.isFinite(next.mediaTimeMs) ? next.mediaTimeMs : 0),
        playing: next.playing,
        playbackRate:
          Number.isFinite(next.playbackRate) && next.playbackRate > 0 ? next.playbackRate : 1,
      };
      playheadAt = t;
      if (previousAt !== undefined) {
        const expected =
          previous.mediaTimeMs + (previous.playing ? (t - previousAt) * previous.playbackRate : 0);
        if (Math.abs(playhead.mediaTimeMs - expected) > opts.jumpThresholdMs) abortIrrelevant();
      }
      pump();
    },

    setEpoch(epoch) {
      if (disposed || epoch === identity.epoch) return;
      identity = { ...identity, epoch };
      abortIrrelevant();
      pump();
    },

    setConfig(nextConfig, configRevision, nextProvider) {
      if (disposed) return;
      const nextConfigCopy = { ...nextConfig, glossary: [...nextConfig.glossary] };
      const nextKey = computeConfigKey(nextProvider, nextConfigCopy);
      unblock();
      if (configRevision === identity.configRevision && nextKey === configKey) {
        // 译文相关指纹未变（只改预取 / 缓存 / 超时 / 流式，或换了 Key）：保留已完成译文。
        if (nextProvider !== provider) {
          // 新 provider 实例可能意味着 Key 已更换或删除：旧实例的在途请求立即中止，不再使用旧凭证。
          abortAll();
          for (const entry of entries.values()) {
            if (entry.status === 'failed' && entry.error && isBlockingError(entry.error)) {
              requeueFailed(entry);
            }
          }
        }
        provider = nextProvider;
        config = nextConfigCopy;
        pump();
        return;
      }
      // 译文相关配置变化（新 revision；或同 revision 但指纹变化，按新 revision 语义处理）：
      // 中止全部请求并清空译文。对外报告过 running/done/failed 的 cue 发出 pending，避免静默清空。
      abortAll(false);
      if (nextProvider.profileKey !== provider.profileKey) {
        rateLimitedUntil = 0;
        rateLimitResumeAt = 0;
        concurrencyLimit = opts.maxConcurrency;
        successesSinceRateLimit = 0;
        consecutiveRateLimits = 0;
      }
      provider = nextProvider;
      config = nextConfigCopy;
      identity = { ...identity, configRevision };
      configKey = nextKey;
      lastModel = undefined;
      for (const entry of entries.values()) {
        const reported =
          entry.reportedRunning ||
          entry.status === 'running' ||
          entry.status === 'done' ||
          entry.status === 'failed';
        resetEntry(entry, entry.cue);
        if (reported && entry.status === 'idle') {
          queue({ cueId: entry.cue.id, cueRevision: entry.cue.revision, state: 'pending' });
        }
      }
      pump();
    },

    pause() {
      if (disposed) return;
      paused = true;
      abortAll();
      cancelWake();
      for (const entry of entries.values()) {
        if (entry.status === 'lookup') {
          entry.status = 'idle';
          entry.lookupToken = undefined;
        }
      }
      flush();
    },

    resume() {
      if (disposed) return;
      paused = false;
      unblock();
      pump();
    },

    setBackfill(enabled) {
      if (disposed || backfill === enabled) return;
      backfill = enabled;
      pump();
    },

    retryFailed() {
      if (disposed) return 0;
      let count = 0;
      for (const entry of entries.values()) {
        if (entry.status !== 'failed') continue;
        requeueFailed(entry);
        count++;
      }
      unblock();
      pump();
      return count;
    },

    onUpdate(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    stats(): TranslationStats {
      let total = 0;
      let done = 0;
      let pending = 0;
      let running = 0;
      let failed = 0;
      for (const entry of entries.values()) {
        switch (entry.status) {
          case 'inactive':
          case 'skipped':
            continue;
          case 'done':
            done++;
            break;
          case 'running':
            running++;
            break;
          case 'failed':
            failed++;
            break;
          default:
            pending++;
        }
        total++;
      }
      const stats: TranslationStats = { total, done, pending, running, failed };
      if (rateLimitedUntil > now()) stats.rateLimitedUntil = rateLimitedUntil;
      if (lastLatencyMs !== undefined) stats.lastLatencyMs = lastLatencyMs;
      if (lastModel !== undefined) stats.model = lastModel;
      if (blockedError) stats.blockedError = blockedError;
      if (cacheWriteFailures > 0) stats.cacheWriteFailures = cacheWriteFailures;
      return stats;
    },

    dispose() {
      if (disposed) return;
      abortAll(false);
      cancelWake();
      disposed = true;
      listeners.clear();
      entries.clear();
      pendingUpdates = [];
      memory.clear();
    },

    inspect(): SchedulerInspection {
      return {
        inflightRequests: inflight.size,
        providerCalls,
        concurrencyLimit,
        prefetchSuspended: config.prefetch && !prefetchAllowed(),
        blockedError,
        paused,
        disposed,
        cacheReadFailures,
        cacheReadTimeouts,
        cacheWriteFailures,
        consecutiveFailedCalls,
        pendingLookups,
        memoryResults: memory.size,
      };
    },
  };

  return scheduler;
}

export const createTranslationScheduler: CreateTranslationScheduler = (deps, config, identity) =>
  createTranslationSchedulerWithOptions(deps, config, identity);

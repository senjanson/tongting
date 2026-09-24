/**
 * 调度器测试替身：可控时钟/定时器、可控 provider（手动决定每次调用何时成功或失败）。
 */
import { AppError, cancelledError, type AppErrorInfo } from '@src/domain/errors';
import type { Cue } from '@src/domain/cue';
import type {
  TextProvider,
  TranslateBatchInput,
  TranslateBatchResult,
  TranslateOptions,
} from '@src/providers/text/types';
import type { SchedulerTimers } from '@src/translation/scheduler';
import type { CueTranslationUpdate, TranslationConfig } from '@src/translation/types';

export class FakeClock implements SchedulerTimers {
  t = 1_000_000;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();

  now = (): number => this.t;

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  pendingTimers(): number {
    return this.timers.size;
  }

  /** 推进时间并依次触发到期定时器。 */
  async advance(ms: number): Promise<void> {
    const target = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = next[1].at;
      next[1].fn();
      await settle();
    }
    this.t = target;
    await settle();
  }
}

const BARRIER = new Uint8Array(1);

/**
 * 让 microtask / webcrypto 回调跑完。缓存键的 SHA-256 在线程池中计算，慢机器（CI）上
 * 只让出事件循环不足以等到它完成：每轮先做一次摘要作为屏障（线程池按序取任务），再让出一轮。
 */
export async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await crypto.subtle.digest('SHA-256', BARRIER);
    await new Promise<void>((r) => setImmediate(r));
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitUntil timeout');
    await new Promise<void>((r) => setTimeout(r, 2));
  }
  await settle(2);
}

export interface ProviderCall {
  input: TranslateBatchInput;
  options: TranslateOptions;
  aborted: boolean;
  settled: boolean;
  resolve(result: TranslateBatchResult): void;
  reject(error: unknown): void;
}

export class FakeProvider implements TextProvider {
  readonly promptVersion = 'test-prompt-v1';
  readonly calls: ProviderCall[] = [];
  /** 历史最大同时在途调用数。 */
  maxOpen = 0;

  constructor(
    readonly profileKey = 'https://api.example.com|responses|model-a|reasoning=omit',
    /** 为 true 时模拟不响应 abort 的传输（结果可能迟到）。 */
    private readonly ignoreAbort = false,
  ) {}

  translateBatch(
    input: TranslateBatchInput,
    options: TranslateOptions,
  ): Promise<TranslateBatchResult> {
    return new Promise((resolve, reject) => {
      const call: ProviderCall = {
        input,
        options,
        aborted: false,
        settled: false,
        resolve: (r) => {
          if (call.settled) return;
          call.settled = true;
          resolve(r);
        },
        reject: (e) => {
          if (call.settled) return;
          call.settled = true;
          reject(e);
        },
      };
      options.signal.addEventListener('abort', () => {
        call.aborted = true;
        if (!this.ignoreAbort) call.reject(cancelledError());
      });
      this.calls.push(call);
      this.maxOpen = Math.max(this.maxOpen, this.open().length);
    });
  }

  /** 未结束且未被中止的调用（模拟真实在途请求）。 */
  open(): ProviderCall[] {
    return this.calls.filter((c) => !c.settled && !c.aborted);
  }

  last(): ProviderCall {
    const call = this.calls.at(-1);
    if (!call) throw new Error('no provider call');
    return call;
  }

  respond(
    call: ProviderCall,
    translate: (id: string, text: string) => string | undefined = (_id, text) => `译：${text}`,
    latencyMs = 321,
  ): void {
    const items = call.input.items
      .map((item) => ({ id: item.id, text: translate(item.id, item.text) }))
      .filter((item): item is { id: string; text: string } => item.text !== undefined);
    call.resolve({
      items,
      model: 'model-a-2026',
      protocol: 'responses',
      promptVersion: this.promptVersion,
      latencyMs,
      repairAttempts: 0,
    });
  }

  fail(call: ProviderCall, info: Omit<AppErrorInfo, 'at'>): void {
    call.reject(new AppError(info));
  }
}

export function makeCue(
  id: string,
  startMs: number,
  endMs: number,
  text: string,
  overrides: Partial<Cue> = {},
): Cue {
  return {
    id,
    revision: 0,
    startMs,
    endMs,
    sourceText: text,
    sourceLanguage: 'en',
    targetLanguage: 'zh-CN',
    source: 'caption-track',
    stability: 'final',
    translationState: 'pending',
    ...overrides,
  };
}

/** 每条 2 秒的连续字幕。 */
export function makeTrack(
  count: number,
  prefix = 'c',
  stepMs = 2_000,
  text = (i: number) => `This is line number ${i} of the video.`,
): Cue[] {
  return Array.from({ length: count }, (_, i) =>
    makeCue(`${prefix}${i}`, i * stepMs, (i + 1) * stepMs, text(i)),
  );
}

export const baseConfig: TranslationConfig = {
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  style: 'natural',
  glossary: [],
  prefetch: true,
  useCache: true,
  timeoutMs: 15_000,
};

export function collectUpdates() {
  const all: CueTranslationUpdate[] = [];
  const listener = (updates: CueTranslationUpdate[]) => {
    all.push(...updates);
  };
  return {
    all,
    listener,
    of: (state: CueTranslationUpdate['state']) =>
      all.filter((u) => u.state === state && !u.partial),
    doneFor: (id: string) => all.filter((u) => u.cueId === id && u.state === 'done'),
    clear: () => {
      all.length = 0;
    },
  };
}

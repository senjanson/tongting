/**
 * 笔记自动保存（与 React 无关，便于测试）。
 *
 * - 输入后延迟保存；保存串行执行，保存期间的新输入在当前保存结束后再保存最新内容。
 * - 保存失败显示 error，内容保留等待重试；不会显示「已保存」。
 * - 冲突（笔记已被其他页面修改）后保持 conflict：后续输入只更新待保存内容，不自动保存、
 *   也不降级为 saved/pending（即使文本改回本页上次保存的版本，存储里仍是另一页面的内容），
 *   直到用户选择覆盖（retry）或载入最新版本（调用方丢弃本实例）。
 * - dispose 时尽力保存尚未保存的内容，之后不再回调状态。
 */
export type NoteSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

export interface NoteAutosaverOptions {
  videoId: string;
  baseline: string;
  save(videoId: string, text: string): Promise<void>;
  onStatus(status: NoteSaveStatus): void;
  /** 判断保存错误是否为冲突（笔记已被其他页面修改）。 */
  isConflict?: (error: unknown) => boolean;
  delayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class NoteAutosaver {
  /** 本页最后确认写入存储的内容；冲突后存储里是其他页面的内容，置为 null，覆盖时必须实际写入。 */
  private lastSaved: string | null;
  private pendingText: string | null = null;
  private inFlight: Promise<void> | null = null;
  private timer: unknown = null;
  private disposed = false;
  private status: NoteSaveStatus = 'idle';
  private readonly delayMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: NoteAutosaverOptions) {
    this.lastSaved = options.baseline;
    this.delayMs = options.delayMs ?? 800;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  get currentStatus(): NoteSaveStatus {
    return this.status;
  }

  /** 是否有尚未成功保存的内容。 */
  get hasUnsaved(): boolean {
    return (
      this.pendingText !== null ||
      this.inFlight !== null ||
      this.status === 'error' ||
      this.status === 'conflict'
    );
  }

  change(text: string): void {
    if (this.disposed) return;
    this.pendingText = text;
    this.cancelTimer();
    // 冲突待用户决定：保留最新输入供「覆盖」使用，不自动保存（必然再次冲突），状态保持 conflict。
    if (this.status === 'conflict') return;
    if (!this.inFlight) this.setStatus(text === this.lastSaved ? 'saved' : 'pending');
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  /** 立即保存待保存内容；等待全部串行保存结束。 */
  async flush(): Promise<void> {
    this.cancelTimer();
    while (this.inFlight) {
      await this.inFlight;
    }
    // 冲突期间只有 retry（用户选择覆盖）才会写入；冲突前排定的定时保存、dispose 与 beforeunload
    // 不再尝试，内容保留在 pendingText，由调用方写入草稿。
    if (this.status === 'conflict') return;
    const text = this.pendingText;
    if (text === null) return;
    this.pendingText = null;
    if (text === this.lastSaved && this.status !== 'error') {
      this.setStatus('saved');
      return;
    }
    this.setStatus('saving');
    let failed: 'error' | 'conflict' | null = null;
    this.inFlight = this.options.save(this.options.videoId, text).then(
      () => {
        this.lastSaved = text;
      },
      (error: unknown) => {
        failed = this.options.isConflict?.(error) ? 'conflict' : 'error';
        if (failed === 'conflict') this.lastSaved = null;
        // 保留内容以便重试（除非期间已有更新的输入）。
        if (this.pendingText === null) this.pendingText = text;
      },
    );
    try {
      await this.inFlight;
    } finally {
      this.inFlight = null;
    }
    if (failed) {
      this.setStatus(failed);
      return;
    }
    if (this.pendingText !== null && !this.disposed) {
      await this.flush();
    } else if (this.pendingText === null) {
      this.setStatus('saved');
    }
  }

  /** 重试保存，或冲突时用户选择「用本页内容覆盖」：立即写入最新输入（冲突后总会实际写入）。 */
  retry(): Promise<void> {
    if (this.pendingText === null) return Promise.resolve();
    this.status = 'pending';
    return this.flush();
  }

  /**
   * 停止回调并尽力保存未保存内容。
   * @returns 是否已全部保存；false 时调用方应保留草稿（例如写入本地草稿存储），不得静默丢弃。
   */
  async dispose(): Promise<boolean> {
    const flushing = this.pendingText !== null ? this.flush() : Promise.resolve();
    this.disposed = true;
    try {
      await flushing;
      while (this.inFlight) await this.inFlight;
    } catch {
      return false;
    }
    return this.pendingText === null && this.status !== 'error' && this.status !== 'conflict';
  }

  /** 放弃未保存内容并停止（用户明确选择丢弃时使用）。 */
  discard(): void {
    this.cancelTimer();
    this.pendingText = null;
    this.disposed = true;
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private setStatus(status: NoteSaveStatus): void {
    this.status = status;
    if (!this.disposed) this.options.onStatus(status);
  }
}

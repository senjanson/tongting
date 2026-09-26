/**
 * 内容脚本端的诊断日志发送：暂存页面与 MAIN world 桥的记录，连接 worker 后批量发送。
 *
 * - 不为了发日志唤醒 worker（否则会形成「日志 → 唤醒 → 日志」的保活循环）；未连接时只暂存最近的记录；
 * - 同时输出到页面控制台，方便在 YouTube 页面的开发者工具中直接查看。
 */
import type { DiagLogEntry } from '../messaging/content-protocol';
import { formatDiagEntry, type DiagRecord } from './log';

const BATCH = 50;

export interface ContentDiagSender {
  record(record: DiagRecord, src: 'page' | 'bridge'): void;
  /** 连接就绪（收到 welcome）后调用：发送暂存的记录。 */
  flush(): void;
  /** 暂存的记录数（测试与诊断用）。 */
  readonly pending: number;
  dispose(): void;
}

export interface ContentDiagSenderOptions {
  /** 发送一批记录；未连接或发送失败时返回 false（记录保留，等待下次 flush）。 */
  send(entries: DiagLogEntry[]): boolean;
  canSend(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  console?: Pick<Console, 'info' | 'warn' | 'error'> | null;
  maxBuffer?: number;
  flushDelayMs?: number;
}

export function createContentDiagSender(opts: ContentDiagSenderOptions): ContentDiagSender {
  const maxBuffer = opts.maxBuffer ?? 300;
  const flushDelayMs = opts.flushDelayMs ?? 300;
  let buffer: DiagLogEntry[] = [];
  let timer: unknown;
  let disposed = false;

  const flush = () => {
    if (timer !== undefined) opts.clearTimeout(timer);
    timer = undefined;
    while (!disposed && buffer.length && opts.canSend()) {
      const batch = buffer.slice(0, BATCH);
      if (!opts.send(batch)) break;
      buffer = buffer.slice(batch.length);
    }
  };

  const schedule = () => {
    if (timer !== undefined || disposed || !opts.canSend()) return;
    timer = opts.setTimeout(() => {
      timer = undefined;
      flush();
    }, flushDelayMs);
  };

  return {
    record(record, src) {
      if (disposed) return;
      const entry: DiagLogEntry = { ...record, src };
      buffer.push(entry);
      if (buffer.length > maxBuffer) buffer = buffer.slice(buffer.length - maxBuffer);
      try {
        const out = opts.console;
        const line = formatDiagEntry(entry);
        if (out) {
          if (entry.level === 'error') out.error('[vocasub]', line);
          else if (entry.level === 'warn') out.warn('[vocasub]', line);
          else out.info('[vocasub]', line);
        }
      } catch {
        // 控制台不可用时忽略。
      }
      schedule();
    },
    flush,
    get pending() {
      return buffer.length;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) opts.clearTimeout(timer);
      timer = undefined;
      buffer = [];
    },
  };
}

/**
 * service worker 端的诊断日志存储：环形缓冲 + 写入扩展本地存储（worker 休眠、浏览器重启后仍保留）。
 *
 * - 超过条数或总字符上限时丢弃最早的记录；
 * - 写入按 3 秒合并，避免每条记录都写存储（worker 即将休眠时由 onSuspend 立即写入）；
 * - 来自页面的记录不可信：逐条校验形状、再次脱敏、限制单条大小，并按标签页限速。
 */
import type { KeyValueArea } from '../background/deps';
import { DIAG_EVENT_MAX, type DiagEntry, type DiagLevel } from './log';
import { redact } from './redact';

export const DIAG_STORAGE_KEY = 'diagnosticsLog';
const STORAGE_VERSION = 1;
const LEVELS: ReadonlySet<string> = new Set(['info', 'warn', 'error']);
const EVENT_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MAX_REMOTE_DATA_CHARS = 2_000;
const DAY_MS = 24 * 3600 * 1000;

export interface DiagnosticsStore {
  /** 从存储读回历史记录完成。 */
  readonly ready: Promise<void>;
  add(entry: DiagEntry): void;
  /** 页面（内容脚本 / MAIN world 桥）上报的记录。 */
  addFromPage(tabId: number, entries: readonly unknown[]): void;
  entries(): DiagEntry[];
  clear(): Promise<void>;
  flush(): Promise<void>;
}

export interface DiagnosticsStoreOptions {
  area: KeyValueArea;
  now?: () => number;
  maxEntries?: number;
  maxChars?: number;
  saveDelayMs?: number;
  /** 每个标签页每分钟最多接收的页面记录数。 */
  pageRatePerMinute?: number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
}

interface Stored {
  entry: DiagEntry;
  chars: number;
}

function sizeOf(entry: DiagEntry): number {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 200;
  }
}

function isEntry(value: unknown): value is DiagEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.t === 'number' &&
    (e.src === 'bg' || e.src === 'page' || e.src === 'bridge') &&
    typeof e.level === 'string' &&
    LEVELS.has(e.level) &&
    typeof e.event === 'string' &&
    e.event.length <= DIAG_EVENT_MAX &&
    (e.tab === undefined || typeof e.tab === 'number')
  );
}

export function createDiagnosticsStore(opts: DiagnosticsStoreOptions): DiagnosticsStore {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 1_500;
  const maxChars = opts.maxChars ?? 600_000;
  const saveDelayMs = opts.saveDelayMs ?? 3_000;
  const pageRate = opts.pageRatePerMinute ?? 240;
  const setTimer = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    opts.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let items: Stored[] = [];
  let chars = 0;
  let saveTimer: unknown;
  let saving: Promise<void> = Promise.resolve();
  let cleared = false;
  const budgets = new Map<number, { windowStart: number; count: number; dropped: number }>();

  const trim = () => {
    let drop = 0;
    while (items.length - drop > maxEntries || (chars > maxChars && items.length - drop > 1)) {
      chars -= items[drop]!.chars;
      drop++;
    }
    if (drop) items = items.slice(drop);
  };

  const push = (entry: DiagEntry) => {
    const chars1 = sizeOf(entry);
    items.push({ entry, chars: chars1 });
    chars += chars1;
    trim();
  };

  const save = (): Promise<void> => {
    const snapshot = items.map((i) => i.entry);
    saving = saving
      .catch(() => undefined)
      .then(() => opts.area.set({ [DIAG_STORAGE_KEY]: { v: STORAGE_VERSION, entries: snapshot } }))
      .catch(() => undefined);
    return saving;
  };

  const scheduleSave = () => {
    if (saveTimer !== undefined) return;
    saveTimer = setTimer(() => {
      saveTimer = undefined;
      void save();
    }, saveDelayMs);
  };

  const ready = opts.area
    .get([DIAG_STORAGE_KEY])
    .then((got) => {
      if (cleared) return;
      const raw = got[DIAG_STORAGE_KEY] as { v?: unknown; entries?: unknown } | undefined;
      if (!raw || raw.v !== STORAGE_VERSION || !Array.isArray(raw.entries)) return;
      const earlier = raw.entries.filter(isEntry);
      const current = items;
      items = [];
      chars = 0;
      for (const e of earlier) push(e);
      for (const s of current) push(s.entry);
    })
    .catch(() => undefined);

  const add = (entry: DiagEntry) => {
    push(entry);
    scheduleSave();
  };

  return {
    ready,
    add,
    addFromPage(tabId, entries) {
      const t = now();
      let budget = budgets.get(tabId);
      if (!budget || t - budget.windowStart >= 60_000) {
        if (budget?.dropped)
          add({
            t,
            src: 'bg',
            level: 'warn',
            event: 'diag.page-dropped',
            data: { tab: tabId, dropped: budget.dropped },
          });
        budget = { windowStart: t, count: 0, dropped: 0 };
        budgets.set(tabId, budget);
      }
      for (const raw of entries) {
        if (typeof raw !== 'object' || raw === null) continue;
        const r = raw as Record<string, unknown>;
        if (r.src !== 'page' && r.src !== 'bridge') continue;
        if (typeof r.event !== 'string' || !EVENT_RE.test(r.event)) continue;
        if (budget.count >= pageRate) {
          budget.dropped++;
          continue;
        }
        budget.count++;
        const level: DiagLevel =
          typeof r.level === 'string' && LEVELS.has(r.level) ? (r.level as DiagLevel) : 'info';
        const at = typeof r.t === 'number' && Math.abs(r.t - t) < DAY_MS ? r.t : t;
        let data = r.data === undefined ? undefined : redact(r.data);
        if (data !== undefined && JSON.stringify(data).length > MAX_REMOTE_DATA_CHARS)
          data = '[too large]';
        add({
          t: at,
          src: r.src,
          level,
          event: r.event,
          tab: tabId,
          ...(data === undefined ? {} : { data }),
        });
      }
    },
    entries: () => items.map((i) => i.entry),
    async clear() {
      cleared = true;
      items = [];
      chars = 0;
      budgets.clear();
      if (saveTimer !== undefined) clearTimer(saveTimer);
      saveTimer = undefined;
      await save();
    },
    async flush() {
      if (saveTimer !== undefined) clearTimer(saveTimer);
      saveTimer = undefined;
      await save();
    },
  };
}

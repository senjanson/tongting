/**
 * 诊断日志入口。各运行环境（service worker、YouTube 内容脚本）各自设置一个接收端：
 * - service worker：写入本地日志存储（见 store.ts），并同时输出到 worker 控制台；
 * - 内容脚本：暂存后经内容端口批量交给 worker，并同时输出到页面控制台。
 * 没有设置接收端时（例如单元测试）记录为空操作。
 *
 * 只记录状态、计数、长度、错误码；不记录 Key、令牌、字幕原文、音频或带授权参数的 URL。
 * 数据写入前统一经过 redact() 兜底脱敏。
 */
import { redact } from './redact';

export type DiagSource = 'bg' | 'page' | 'bridge';
export type DiagLevel = 'info' | 'warn' | 'error';

export interface DiagEntry {
  /** epoch ms */
  t: number;
  src: DiagSource;
  level: DiagLevel;
  event: string;
  /** 来自页面的记录附带标签页 ID。 */
  tab?: number;
  data?: unknown;
}

export type DiagRecord = Omit<DiagEntry, 'src' | 'tab'>;

export const DIAG_EVENT_MAX = 80;

let sink: ((record: DiagRecord) => void) | undefined;

export function setDiagSink(next: ((record: DiagRecord) => void) | undefined): void {
  sink = next;
}

/** 只在当前接收端仍是 owner 时清除（避免后创建的实例被先前实例的清理覆盖）。 */
export function releaseDiagSink(owner: (record: DiagRecord) => void): void {
  if (sink === owner) sink = undefined;
}

export function diag(event: string, data?: unknown, level: DiagLevel = 'info'): void {
  if (!sink) return;
  try {
    sink({
      t: Date.now(),
      level,
      event: event.slice(0, DIAG_EVENT_MAX),
      ...(data === undefined ? {} : { data: redact(data) }),
    });
  } catch {
    // 日志失败不能影响业务。
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** 本地时间（带时区偏移），便于和用户描述的操作时间对应。 */
export function formatLocalTime(t: number): string {
  const d = new Date(t);
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

export function formatDiagEntry(e: DiagEntry): string {
  const where = e.tab === undefined ? e.src : `${e.src}#${e.tab}`;
  const data = e.data === undefined ? '' : ` ${JSON.stringify(e.data)}`;
  return `${formatLocalTime(e.t)} ${where.padEnd(10)} ${e.level.toUpperCase().padEnd(5)} ${e.event}${data}`;
}

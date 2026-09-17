/**
 * 字幕记录仓库（IndexedDB transcripts）。可重建数据；删除记录不影响笔记与收藏。
 *
 * 读出的记录视为不可信（可能来自旧版本、未来版本或损坏）：
 * - 顶层字段不完整的记录被忽略；
 * - getTranscript / loadTranscript 逐条校验 cue，丢弃无效条目（loadTranscript 返回丢弃数量）；
 * - schemaVersion 高于当前版本的记录标记为只读，UI 不应修改或删除。
 */
import { CueSchema, SubtitleCoverageSchema, type Cue, type SubtitleCoverage } from '../domain/cue';
import { SourceModeSchema, type SourceMode } from '../domain/session';
import { openTongtingDb, RECORD_SCHEMA_VERSION, type TranscriptRecord } from './db';

export interface ListTranscriptsOptions {
  /** 最多返回条数，默认 50。 */
  limit?: number;
}

/** 列表用的记录摘要（不含字幕正文）。 */
export interface TranscriptSummary {
  recordId: string;
  videoId: string;
  title?: string;
  channel?: string;
  targetLanguage: string;
  sourceLanguage: string;
  sourceMode: SourceMode;
  sourceKey: string;
  sourceLabel?: string;
  lastSessionId: string;
  cueCount: number;
  coverage: SubtitleCoverage;
  durationMs?: number;
  schemaVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface LoadedTranscript {
  record: TranscriptRecord;
  /** 校验失败而被丢弃的字幕条数。 */
  invalidCueCount: number;
  /** 记录来自更新版本的扩展：只读显示。 */
  readOnly: boolean;
}

const EMPTY_COVERAGE: SubtitleCoverage = { complete: false, ranges: [], gaps: [] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function analyze(
  raw: unknown,
  validateCues: boolean,
): { record: TranscriptRecord; invalidCueCount: number } | undefined {
  if (!isObject(raw)) return undefined;
  if (
    !isNonEmptyString(raw.recordId) ||
    !isNonEmptyString(raw.videoId) ||
    typeof raw.targetLanguage !== 'string' ||
    typeof raw.sourceKey !== 'string' ||
    !Array.isArray(raw.cues) ||
    typeof raw.updatedAt !== 'number' ||
    !Number.isFinite(raw.updatedAt)
  ) {
    return undefined;
  }
  const record = raw as unknown as TranscriptRecord;
  const coverage = SubtitleCoverageSchema.safeParse(raw.coverage);
  const sourceMode = SourceModeSchema.safeParse(raw.sourceMode);
  let cues: Cue[] = record.cues;
  let invalidCueCount = 0;
  if (validateCues) {
    cues = [];
    for (const item of record.cues as unknown[]) {
      const parsed = CueSchema.safeParse(item);
      if (parsed.success) cues.push(parsed.data);
      else invalidCueCount++;
    }
    cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }
  return {
    invalidCueCount,
    record: {
      ...record,
      schemaVersion: typeof raw.schemaVersion === 'number' ? raw.schemaVersion : 0,
      sourceLanguage: typeof raw.sourceLanguage === 'string' ? raw.sourceLanguage : 'und',
      sourceMode: sourceMode.success ? sourceMode.data : 'none',
      lastSessionId: typeof raw.lastSessionId === 'string' ? raw.lastSessionId : '',
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : record.updatedAt,
      coverage: coverage.success ? coverage.data : EMPTY_COVERAGE,
      cues,
    },
  };
}

/**
 * 校验并规范化从数据库读出的记录。
 * @param validateCues 是否逐条校验 cue（为性能可跳过，只保证是数组）。
 */
export function normalizeTranscriptRecord(
  raw: unknown,
  validateCues = true,
): TranscriptRecord | undefined {
  return analyze(raw, validateCues)?.record;
}

function toSummary(record: TranscriptRecord): TranscriptSummary {
  return {
    recordId: record.recordId,
    videoId: record.videoId,
    title: record.title,
    channel: record.channel,
    targetLanguage: record.targetLanguage,
    sourceLanguage: record.sourceLanguage,
    sourceMode: record.sourceMode,
    sourceKey: record.sourceKey,
    sourceLabel: record.sourceLabel,
    lastSessionId: record.lastSessionId,
    cueCount: record.cues.length,
    coverage: record.coverage,
    durationMs: record.durationMs,
    schemaVersion: record.schemaVersion,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function putTranscript(record: TranscriptRecord): Promise<void> {
  if (!isNonEmptyString(record.recordId) || !isNonEmptyString(record.videoId)) {
    throw new TypeError('字幕记录缺少 recordId 或 videoId');
  }
  const db = await openTongtingDb();
  const tx = db.transaction('transcripts', 'readwrite');
  await Promise.all([tx.store.put(record), tx.done]);
}

export async function getTranscript(recordId: string): Promise<TranscriptRecord | undefined> {
  const db = await openTongtingDb();
  const raw: unknown = await db.get('transcripts', recordId);
  return normalizeTranscriptRecord(raw);
}

/** 读取记录并报告被丢弃的无效字幕数量与是否只读（未来版本）。 */
export async function loadTranscript(recordId: string): Promise<LoadedTranscript | undefined> {
  const db = await openTongtingDb();
  const result = analyze(await db.get('transcripts', recordId), true);
  if (!result) return undefined;
  return { ...result, readOnly: result.record.schemaVersion > RECORD_SCHEMA_VERSION };
}

async function eachByUpdatedAt(
  limit: number,
  visit: (record: TranscriptRecord) => void,
): Promise<void> {
  if (limit <= 0) return;
  const db = await openTongtingDb();
  const tx = db.transaction('transcripts', 'readonly');
  const done = tx.done;
  done.catch(() => undefined);
  let count = 0;
  let cursor = await tx.store.index('byUpdatedAt').openCursor(null, 'prev');
  while (cursor && count < limit) {
    const record = normalizeTranscriptRecord(cursor.value, false);
    if (record) {
      visit(record);
      count++;
    }
    cursor = await cursor.continue();
  }
  await done;
}

/** 按 updatedAt 倒序列出记录。 */
export async function listTranscripts(
  options: ListTranscriptsOptions = {},
): Promise<TranscriptRecord[]> {
  const out: TranscriptRecord[] = [];
  await eachByUpdatedAt(Math.max(0, Math.floor(options.limit ?? 50)), (record) => out.push(record));
  return out;
}

/**
 * 按 updatedAt 倒序列出记录摘要。IndexedDB 无法只读部分字段，
 * 但摘要不保留字幕正文，读取后即可释放内存。
 */
export async function listTranscriptSummaries(
  options: ListTranscriptsOptions = {},
): Promise<TranscriptSummary[]> {
  const out: TranscriptSummary[] = [];
  await eachByUpdatedAt(Math.max(0, Math.floor(options.limit ?? 50)), (record) =>
    out.push(toSummary(record)),
  );
  return out;
}

/** 某视频的全部记录（不同目标语言/来源），按 updatedAt 倒序。 */
export async function listTranscriptsByVideo(videoId: string): Promise<TranscriptRecord[]> {
  const db = await openTongtingDb();
  const raws: unknown[] = await db.getAllFromIndex('transcripts', 'byVideo', videoId);
  return raws
    .map((raw) => normalizeTranscriptRecord(raw))
    .filter((r): r is TranscriptRecord => r !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 删除字幕记录。笔记与收藏属于用户数据，不随记录删除。 */
export async function deleteTranscript(recordId: string): Promise<void> {
  const db = await openTongtingDb();
  const tx = db.transaction('transcripts', 'readwrite');
  await Promise.all([tx.store.delete(recordId), tx.done]);
}

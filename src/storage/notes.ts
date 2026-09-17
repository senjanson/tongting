/**
 * 视频笔记（用户数据）。按 videoId 保存；字幕失败或字幕记录删除都不影响笔记。
 * 保存失败必须抛出，调用方据此显示「保存失败」而不是「已保存」。
 *
 * 多个页面同时编辑同一视频笔记时，使用 saveNoteChecked 按 updatedAt 检测冲突，
 * 避免后保存的页面静默覆盖另一页面的内容。
 */
import { VideoIdSchema } from '../domain/session';
import { openTongtingDb, RECORD_SCHEMA_VERSION, type NoteRecord } from './db';

/** 单条笔记最大字符数，防止意外粘贴超大内容拖垮存储。 */
export const MAX_NOTE_LENGTH = 200_000;

/** 笔记已被其他页面修改（存储中的 updatedAt 与预期不一致）。 */
export class NoteConflictError extends Error {
  constructor(readonly current: NoteRecord | undefined) {
    super('笔记已在其他页面修改');
    this.name = 'NoteConflictError';
  }
}

function normalizeNote(videoId: string, raw: unknown): NoteRecord | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Partial<NoteRecord>;
  if (typeof record.text !== 'string') return undefined;
  return {
    schemaVersion:
      typeof record.schemaVersion === 'number' ? record.schemaVersion : RECORD_SCHEMA_VERSION,
    videoId,
    text: record.text,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
  };
}

function validate(videoId: string, text: string): void {
  if (!VideoIdSchema.safeParse(videoId).success) {
    throw new TypeError('无效的视频 ID');
  }
  if (text.length > MAX_NOTE_LENGTH) {
    throw new RangeError(`笔记超过 ${MAX_NOTE_LENGTH} 字符上限`);
  }
}

export async function getNote(videoId: string): Promise<NoteRecord | undefined> {
  const db = await openTongtingDb();
  return normalizeNote(videoId, await db.get('notes', videoId));
}

export async function saveNote(videoId: string, text: string): Promise<void> {
  validate(videoId, text);
  const db = await openTongtingDb();
  const tx = db.transaction('notes', 'readwrite');
  const record: NoteRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    videoId,
    text,
    updatedAt: Date.now(),
  };
  await Promise.all([tx.store.put(record), tx.done]);
}

/**
 * 带冲突检测的保存：expectedUpdatedAt 为本页读取/上次保存时的 updatedAt（不存在记录时为 0）。
 * 存储中的版本不同则抛出 NoteConflictError，不写入。成功返回新记录。
 */
export async function saveNoteChecked(
  videoId: string,
  text: string,
  expectedUpdatedAt: number,
): Promise<NoteRecord> {
  validate(videoId, text);
  const db = await openTongtingDb();
  const tx = db.transaction('notes', 'readwrite');
  const done = tx.done;
  done.catch(() => undefined);
  const current = normalizeNote(videoId, await tx.store.get(videoId));
  if ((current?.updatedAt ?? 0) !== expectedUpdatedAt) {
    tx.abort();
    throw new NoteConflictError(current);
  }
  const record: NoteRecord = {
    schemaVersion: RECORD_SCHEMA_VERSION,
    videoId,
    text,
    // 保证单调递增，避免同一毫秒内的两次保存无法区分。
    updatedAt: Math.max(Date.now(), expectedUpdatedAt + 1),
  };
  await tx.store.put(record);
  await done;
  return record;
}

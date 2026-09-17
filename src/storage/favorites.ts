/**
 * 字幕收藏（用户数据，与可重建的字幕记录分开保存）。
 *
 * UI 应使用 setFavorite 传入期望状态（幂等），避免「切换」在并发或读取未完成时翻转成相反结果。
 */
import { openTongtingDb, RECORD_SCHEMA_VERSION, type FavoriteRecord } from './db';

export type FavoriteInput = Omit<FavoriteRecord, 'schemaVersion' | 'favoriteId' | 'createdAt'>;

export function favoriteKey(recordId: string, cueId: string): string {
  return `${recordId}|${cueId}`;
}

function sortByTime(records: FavoriteRecord[]): FavoriteRecord[] {
  return records.sort((a, b) => a.startMs - b.startMs || a.createdAt - b.createdAt);
}

function assertInput(input: FavoriteInput): void {
  if (!input.recordId || !input.cueId || !input.videoId) {
    throw new TypeError('收藏缺少 recordId、videoId 或 cueId');
  }
}

function toRecord(input: FavoriteInput, favoriteId: string): FavoriteRecord {
  return {
    schemaVersion: RECORD_SCHEMA_VERSION,
    favoriteId,
    recordId: input.recordId,
    videoId: input.videoId,
    cueId: input.cueId,
    startMs: input.startMs,
    endMs: input.endMs,
    sourceText: input.sourceText,
    ...(input.translatedText !== undefined ? { translatedText: input.translatedText } : {}),
    createdAt: Date.now(),
  };
}

/**
 * 在同一读写事务内完成读取与写入。
 * @param desired undefined 表示切换；true/false 表示设置为该状态（幂等）。
 */
async function writeFavorite(input: FavoriteInput, desired: boolean | undefined): Promise<boolean> {
  assertInput(input);
  const db = await openTongtingDb();
  const tx = db.transaction('favorites', 'readwrite');
  // 先挂上处理函数，避免中途抛错时 tx.done 的拒绝未被处理；最终仍通过 await done 传播。
  const done = tx.done;
  done.catch(() => undefined);
  const favoriteId = favoriteKey(input.recordId, input.cueId);
  const existing = await tx.store.get(favoriteId);
  const next = desired ?? !existing;
  if (!next && existing) {
    await tx.store.delete(favoriteId);
  } else if (next && !existing) {
    await tx.store.put(toRecord(input, favoriteId));
  }
  await done;
  return next;
}

/** 切换收藏状态，返回切换后的状态（true 表示已收藏）。 */
export function toggleFavorite(input: FavoriteInput): Promise<boolean> {
  return writeFavorite(input, undefined);
}

/** 设置收藏状态（幂等），返回最终状态。 */
export function setFavorite(input: FavoriteInput, favorited: boolean): Promise<boolean> {
  return writeFavorite(input, favorited);
}

export async function listFavoritesByRecord(recordId: string): Promise<FavoriteRecord[]> {
  const db = await openTongtingDb();
  return sortByTime(await db.getAllFromIndex('favorites', 'byRecord', recordId));
}

export async function listFavoritesByVideo(videoId: string): Promise<FavoriteRecord[]> {
  const db = await openTongtingDb();
  return sortByTime(await db.getAllFromIndex('favorites', 'byVideo', videoId));
}

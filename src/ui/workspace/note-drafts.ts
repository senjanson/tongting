/**
 * 笔记草稿兜底：页面关闭或切换视频时保存失败的内容写入本机 localStorage，
 * 下次打开该视频笔记时提示恢复，避免静默丢失。不会自动覆盖已保存的笔记。
 *
 * - 同一视频可以有多份草稿：用户尚未处理旧草稿时本页又写入草稿，不能覆盖旧的那份。
 * - 删除必须指明是哪一份（内容相同的，或某个写入者的），不按 videoId 整体删除。
 */
export interface NoteDraft {
  /** 写入者的标识：同一次编辑反复写入时只替换自己的那份。 */
  id: string;
  text: string;
  savedAt: number;
  /** 草稿基于的笔记 updatedAt。 */
  baseUpdatedAt: number;
}

const PREFIX = 'tongting:note-draft:';

function parseDraft(value: unknown): NoteDraft | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const draft = value as Partial<NoteDraft>;
  if (typeof draft.text !== 'string' || typeof draft.savedAt !== 'number') return undefined;
  return {
    // 旧版本没有 id：按保存时间生成稳定的标识。
    id: typeof draft.id === 'string' ? draft.id : `saved-${draft.savedAt}`,
    text: draft.text,
    savedAt: draft.savedAt,
    baseUpdatedAt: typeof draft.baseUpdatedAt === 'number' ? draft.baseUpdatedAt : 0,
  };
}

function loadDrafts(videoId: string): NoteDraft[] {
  try {
    const raw = localStorage.getItem(PREFIX + videoId);
    if (!raw) return [];
    const value: unknown = JSON.parse(raw);
    // 旧版本每个视频只存一份（单个对象）。
    const list: unknown[] = Array.isArray(value) ? value : [value];
    return list.map(parseDraft).filter((d): d is NoteDraft => d !== undefined);
  } catch {
    return [];
  }
}

function storeDrafts(videoId: string, drafts: NoteDraft[]): boolean {
  try {
    if (drafts.length === 0) localStorage.removeItem(PREFIX + videoId);
    else localStorage.setItem(PREFIX + videoId, JSON.stringify(drafts));
    return true;
  } catch {
    return false;
  }
}

/** 该视频的全部草稿，最新的在前；内容相同的只保留最新一份。 */
export function readNoteDrafts(videoId: string): NoteDraft[] {
  const seen = new Set<string>();
  const drafts: NoteDraft[] = [];
  for (const draft of loadDrafts(videoId).sort((a, b) => b.savedAt - a.savedAt)) {
    if (seen.has(draft.text)) continue;
    seen.add(draft.text);
    drafts.push(draft);
  }
  return drafts;
}

/** 最新的一份草稿。 */
export function readNoteDraft(videoId: string): NoteDraft | undefined {
  return readNoteDrafts(videoId)[0];
}

/** 写入草稿：只替换同一 id 的那份，其他草稿保留。 */
export function writeNoteDraft(videoId: string, draft: NoteDraft): boolean {
  return storeDrafts(videoId, [...loadDrafts(videoId).filter((d) => d.id !== draft.id), draft]);
}

/**
 * 删除草稿，必须指明哪一份：`text` 删除内容相同的草稿（内容已保存、与笔记相同，或用户丢弃了这份内容）；
 * `id` 删除该写入者的草稿。
 */
export function clearNoteDraft(videoId: string, match: { text: string } | { id: string }): void {
  const drafts = loadDrafts(videoId);
  const rest = drafts.filter((d) => ('id' in match ? d.id !== match.id : d.text !== match.text));
  if (rest.length !== drafts.length) storeDrafts(videoId, rest);
}

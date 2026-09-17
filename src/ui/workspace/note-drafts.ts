/**
 * 笔记草稿兜底：页面关闭或切换视频时保存失败的内容写入本机 localStorage，
 * 下次打开该视频笔记时提示恢复，避免静默丢失。不会自动覆盖已保存的笔记。
 */
export interface NoteDraft {
  text: string;
  savedAt: number;
  /** 草稿基于的笔记 updatedAt。 */
  baseUpdatedAt: number;
}

const PREFIX = 'tongting:note-draft:';

export function readNoteDraft(videoId: string): NoteDraft | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + videoId);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as Partial<NoteDraft>;
    if (typeof value.text !== 'string' || typeof value.savedAt !== 'number') return undefined;
    return { text: value.text, savedAt: value.savedAt, baseUpdatedAt: value.baseUpdatedAt ?? 0 };
  } catch {
    return undefined;
  }
}

export function writeNoteDraft(videoId: string, draft: NoteDraft): boolean {
  try {
    localStorage.setItem(PREFIX + videoId, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearNoteDraft(videoId: string): void {
  try {
    localStorage.removeItem(PREFIX + videoId);
  } catch {
    // 忽略
  }
}

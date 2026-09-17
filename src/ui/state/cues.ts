/**
 * 会话字幕的本地镜像（纯函数）。
 *
 * - 订阅（含重连后重新订阅）后进入 loading，只接受完整（full）消息作为基线，
 *   在此之前到达的增量丢弃；worker 重启后 cueVersion 可能重新开始，也能正确接受。
 * - 基线建立后只接受 cueVersion 更大的消息；增量按 id 更新并删除 removedIds。
 * - 输出按 startMs、endMs、id 排序；未变化的 cue 保持对象引用，便于列表局部重渲染。
 */
import type { Cue } from '../../domain/cue';
import type { CuesMessage } from './snapshot';

export interface CuesState {
  sessionId: string | null;
  /** idle：未订阅；loading：等待完整基线；ready：已同步。 */
  status: 'idle' | 'loading' | 'ready';
  cueVersion: number;
  cues: readonly Cue[];
}

export const IDLE_CUES_STATE: CuesState = Object.freeze({
  sessionId: null,
  status: 'idle',
  cueVersion: 0,
  cues: Object.freeze([]) as readonly Cue[],
}) as CuesState;

export function compareCues(
  a: Pick<Cue, 'startMs' | 'endMs' | 'id'>,
  b: Pick<Cue, 'startMs' | 'endMs' | 'id'>,
): number {
  return a.startMs - b.startMs || a.endMs - b.endMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** 订阅新会话：清空旧会话的字幕。 */
export function subscribeCuesState(sessionId: string): CuesState {
  return { sessionId, status: 'loading', cueVersion: 0, cues: [] };
}

/** 重连或重新订阅同一会话：保留已显示内容，等待新的完整基线。 */
export function resyncCuesState(state: CuesState): CuesState {
  if (!state.sessionId) return state;
  return { ...state, status: 'loading' };
}

function mergeCues(
  existing: readonly Cue[],
  upserts: readonly Cue[],
  removedIds: readonly string[] | undefined,
): Cue[] {
  const removed = new Set(removedIds ?? []);
  const indexById = new Map<string, number>();
  existing.forEach((c, i) => indexById.set(c.id, i));
  const next = existing.slice();
  let needsSort = false;
  for (const cue of upserts) {
    const index = indexById.get(cue.id);
    if (index === undefined) {
      indexById.set(cue.id, next.length);
      next.push(cue);
      needsSort = true;
    } else {
      const previous = next[index]!;
      if (previous.startMs !== cue.startMs || previous.endMs !== cue.endMs) needsSort = true;
      next[index] = cue;
    }
  }
  const filtered = removed.size ? next.filter((c) => !removed.has(c.id)) : next;
  if (needsSort) filtered.sort(compareCues);
  return filtered;
}

export function applyCuesMessage(state: CuesState, message: CuesMessage): CuesState {
  if (!state.sessionId || message.sessionId !== state.sessionId) return state;
  if (state.status === 'loading') {
    if (!message.full) return state;
    return {
      sessionId: state.sessionId,
      status: 'ready',
      cueVersion: message.cueVersion,
      cues: [...message.cues].sort(compareCues),
    };
  }
  if (message.cueVersion <= state.cueVersion) return state;
  if (message.full) {
    return { ...state, cueVersion: message.cueVersion, cues: [...message.cues].sort(compareCues) };
  }
  return {
    ...state,
    cueVersion: message.cueVersion,
    cues: mergeCues(state.cues, message.cues, message.removedIds),
  };
}

/**
 * 覆盖层字幕存储（纯逻辑）：按 sessionId / epoch / cueVersion 丢弃过期消息，维护按 startMs 升序的字幕。
 *
 * - session/state 为 null：清空；sessionId 变化：清空并重置版本基线；
 * - session/cues：sessionId 必须等于当前会话；epoch 小于已知 epoch 丢弃，大于则跟进；
 *   cueVersion 必须大于上次接受的版本（重连/worker 重启后调用 resetVersionBaseline，下一条消息重新建立基线）；
 * - full=true 替换全部；full=false 按 id 更新（旧 revision 不覆盖新 revision）并删除 removedIds。
 */
import type { BackgroundToContent, DisplayCue } from '../../messaging/content-protocol';

export type SessionStateMsg = Extract<BackgroundToContent, { type: 'session/state' }>;
export type SessionCuesMsg = Extract<BackgroundToContent, { type: 'session/cues' }>;
export type OverlaySession = NonNullable<SessionStateMsg['session']>;

export interface CueStore {
  readonly session: OverlaySession | null;
  readonly cues: readonly DisplayCue[];
  get(id: string): DisplayCue | undefined;
  /** 返回是否清空了字幕。 */
  setSession(session: OverlaySession | null): { cleared: boolean };
  /** 返回是否接受了该消息。 */
  applyCues(msg: SessionCuesMsg): boolean;
  resetVersionBaseline(): void;
  clear(): void;
}

function sortCues(cues: DisplayCue[]): DisplayCue[] {
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function createCueStore(): CueStore {
  let session: OverlaySession | null = null;
  let byId = new Map<string, DisplayCue>();
  let sorted: DisplayCue[] = [];
  let lastVersion = -1;

  const rebuild = () => {
    sorted = sortCues([...byId.values()].filter((c) => c.endMs > c.startMs));
  };

  const clear = () => {
    byId = new Map();
    sorted = [];
    lastVersion = -1;
  };

  return {
    get session() {
      return session;
    },
    get cues() {
      return sorted;
    },
    get(id) {
      return byId.get(id);
    },
    setSession(next) {
      if (!next) {
        const had = session !== null || sorted.length > 0;
        session = null;
        clear();
        return { cleared: had };
      }
      if (!session || session.sessionId !== next.sessionId) {
        session = { ...next };
        clear();
        return { cleared: true };
      }
      session = { ...next };
      return { cleared: false };
    },
    applyCues(msg) {
      if (!session || msg.sessionId !== session.sessionId) return false;
      if (msg.epoch < session.epoch) return false;
      if (msg.cueVersion <= lastVersion) return false;
      if (msg.epoch > session.epoch) session = { ...session, epoch: msg.epoch };
      lastVersion = msg.cueVersion;
      if (msg.full) {
        byId = new Map(msg.cues.map((c) => [c.id, c]));
      } else {
        for (const c of msg.cues) {
          const prev = byId.get(c.id);
          if (prev && prev.revision > c.revision) continue;
          byId.set(c.id, c);
        }
        for (const id of msg.removedIds ?? []) byId.delete(id);
      }
      rebuild();
      return true;
    },
    resetVersionBaseline() {
      lastVersion = -1;
    },
    clear() {
      session = null;
      clear();
    },
  };
}

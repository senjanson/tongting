/**
 * 会话与页面状态变化记录：worker 每次整理快照时对比上一次的摘要，只记录变化的字段。
 * 摘要只含阶段、来源、提示、错误码、资源状态与计数，不含字幕原文、标题或 URL。
 */
import type { CaptionTrackInfo, SessionSnapshot } from '../domain/session';
import type { DiagLevel } from './log';

type Log = (event: string, data?: unknown, level?: DiagLevel) => void;

export interface TracedPage {
  tabId: number;
  videoId: string | null;
  navigationId: number;
  captionsAvailability: string;
  tracks: readonly CaptionTrackInfo[];
  isLive: boolean;
}

type Summary = Record<string, string | number | boolean | null>;

const PROGRESS_MARKS = [1, 5, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000];

function sessionSummary(s: SessionSnapshot): Summary {
  return {
    phase: s.phase,
    desired: s.desiredState,
    source: s.sourceMode,
    output: s.outputMode,
    notice: s.notice ? `${s.notice.code}: ${s.notice.message}` : null,
    error: s.error ? `${s.error.code}: ${s.error.message}` : null,
    buffer: s.playbackBuffer?.state ?? null,
    capture: s.resources.capture,
    asr: s.resources.asr,
    // 配音每句都会在 speaking / idle 之间切换：只记录其他状态，首次发声单独记录。
    tts: s.resources.tts === 'speaking' ? 'idle' : s.resources.tts,
    failed: s.translation.failed,
    blocked: s.translation.blockedError?.code ?? null,
    track: s.sourceTrack ? `${s.sourceTrack.languageCode}:${s.sourceTrack.kind}` : null,
  };
}

function pageSummary(p: TracedPage): Summary {
  return {
    video: p.videoId,
    nav: p.navigationId,
    captions: p.captionsAvailability,
    tracks: p.tracks.map((t) => `${t.languageCode}:${t.kind}`).join(',') || null,
    live: p.isLive,
  };
}

function diff(prev: Summary | undefined, next: Summary): Summary | undefined {
  if (!prev) return next;
  const out: Summary = {};
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (prev[k] !== v) {
      out[k] = v;
      changed = true;
    }
  }
  return changed ? out : undefined;
}

export interface StateTracer {
  trace(sessions: readonly SessionSnapshot[], pages: readonly TracedPage[]): void;
}

export function createStateTracer(log: Log): StateTracer {
  const sessions = new Map<string, { summary: Summary; mark: number; spoke: boolean }>();
  const pages = new Map<number, Summary>();

  return {
    trace(nextSessions, nextPages) {
      const seen = new Set<string>();
      for (const s of nextSessions) {
        const id = s.identity.sessionId;
        seen.add(id);
        const summary = sessionSummary(s);
        const prev = sessions.get(id);
        const changed = diff(prev?.summary, summary);
        if (changed) {
          const level: DiagLevel =
            summary.error !== null || summary.phase === 'error'
              ? 'error'
              : changed.notice !== undefined && summary.notice !== null
                ? 'warn'
                : 'info';
          log(
            prev ? 'session.state' : 'session.new',
            {
              session: id,
              tab: s.identity.tabId,
              video: s.identity.videoId,
              ...changed,
              ...(prev ? {} : { target: s.targetLanguage }),
            },
            level,
          );
        }
        let mark = prev?.mark ?? 0;
        const done = s.translation.done;
        const nextMark = PROGRESS_MARKS.filter((m) => done >= m).at(-1) ?? 0;
        if (nextMark > mark) {
          mark = nextMark;
          log('session.progress', {
            session: id,
            done,
            total: s.translation.total,
            pending: s.translation.pending,
            failed: s.translation.failed,
            latencyMs: s.translation.lastLatencyMs,
          });
        }
        let spoke = prev?.spoke ?? false;
        if (!spoke && s.resources.tts === 'speaking') {
          spoke = true;
          log('session.first-speech', { session: id, dubBacklog: s.resources.dubBacklog });
        }
        sessions.set(id, { summary, mark, spoke });
      }
      for (const id of [...sessions.keys()]) {
        if (!seen.has(id)) {
          sessions.delete(id);
          log('session.gone', { session: id });
        }
      }
      const seenTabs = new Set<number>();
      for (const p of nextPages) {
        seenTabs.add(p.tabId);
        const summary = pageSummary(p);
        const changed = diff(pages.get(p.tabId), summary);
        if (changed) log('page.state', { tab: p.tabId, ...changed });
        pages.set(p.tabId, summary);
      }
      for (const tab of [...pages.keys()]) {
        if (!seenTabs.has(tab)) {
          pages.delete(tab);
          log('page.gone', { tab });
        }
      }
    },
  };
}

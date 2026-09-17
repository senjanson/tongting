/**
 * YouTube timedtext json3 解析。
 *
 * 已知结构（公开格式，待真实样本核对）：
 * { events: [{ tStartMs, dDurationMs?, wWinId?, aAppend?, segs?: [{ utf8, tOffsetMs?, acAsrConf? }] }] }
 * - 无 segs 的事件是窗口定义，跳过；
 * - 自动字幕以逐词 seg（带 tOffsetMs）组成一行，随后常有 aAppend=1 且仅含 "\n" 的事件；
 * - aAppend=1 且含实际文字时，追加到同一窗口的上一条片段。
 * json3 的 utf8 是纯文本，不做 HTML 实体解码。
 */
import {
  CaptionParseError,
  MAX_CAPTION_BODY_CHARS,
  MAX_RAW_EVENTS,
  emptyStats,
  finalizeCandidates,
  type CaptionParseResult,
  type CueCandidate,
} from './normalize';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function parseJson3(body: string | unknown): CaptionParseResult {
  let data: unknown = body;
  if (typeof body === 'string') {
    if (body.length > MAX_CAPTION_BODY_CHARS) throw new CaptionParseError('too-large');
    try {
      data = JSON.parse(body);
    } catch {
      throw new CaptionParseError('invalid-json');
    }
  }
  if (!isRecord(data)) throw new CaptionParseError('invalid-structure');
  const events = data.events;
  if (events === undefined) {
    // 没有任何字幕事件的合法空轨道。
    return finalizeCandidates('json3', []);
  }
  if (!Array.isArray(events) || events.length > MAX_RAW_EVENTS)
    throw new CaptionParseError('invalid-structure');

  const stats = emptyStats();
  const candidates: Array<CueCandidate & { win: number | undefined }> = [];
  const lastByWindow = new Map<number | undefined, CueCandidate & { win: number | undefined }>();

  for (const ev of events) {
    if (!isRecord(ev)) {
      stats.rejected++;
      continue;
    }
    const segs = ev.segs;
    if (segs === undefined) continue; // 窗口定义
    const start = num(ev.tStartMs);
    if (!Array.isArray(segs) || start === undefined || segs.length > 1_000) {
      stats.rejected++;
      continue;
    }
    let text = '';
    for (const seg of segs) {
      if (isRecord(seg) && typeof seg.utf8 === 'string') text += seg.utf8;
    }
    const duration = num(ev.dDurationMs);
    const win = num(ev.wWinId);
    const end = duration !== undefined && duration > 0 ? start + duration : undefined;

    if (ev.aAppend === 1 || ev.aAppend === true) {
      if (!text.trim()) continue; // 仅换行的追加事件
      const target = lastByWindow.get(win);
      if (target) {
        target.text += text;
        if (end !== undefined) target.endMs = Math.max(target.endMs ?? end, end);
        continue;
      }
    }
    if (!text.trim()) continue;
    const cand = { startMs: start, endMs: end, text, win };
    candidates.push(cand);
    lastByWindow.set(win, cand);
  }

  return finalizeCandidates(
    'json3',
    candidates.map(({ startMs, endMs, text }) => ({ startMs, endMs, text })),
    stats,
  );
}

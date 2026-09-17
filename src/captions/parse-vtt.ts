/**
 * WebVTT 解析（YouTube fmt=vtt 与通用 VTT）。
 *
 * - 支持可选 cue 标识、`hh:mm:ss.ttt` / `mm:ss.ttt` 时间与 cue settings；跳过 NOTE/STYLE/REGION 块；
 * - 剥离 <c>、<v>、<b>、<i>、<u>、<ruby>、<rt>、<lang> 与 `<00:00:01.000>` 时间标签，实体只解码一层；
 * - YouTube 自动字幕 VTT 会滚动重复上一行，并插入约 10ms 的过渡 cue：
 *   去掉与上一条末尾相同的开头行，完全重复的过渡 cue 丢弃。
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
import { decodeEntities, normalizeCaptionLines } from './text';

const TIMING_RE =
  /^((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s+-->\s+((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})(?:\s+.*)?$/;

export function parseVttTimestamp(ts: string): number | undefined {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(ts.trim());
  if (!m) return undefined;
  const h = m[1] ? Number(m[1]) : 0;
  const min = Number(m[2]);
  const s = Number(m[3]);
  if (min > 59 || s > 59) return undefined;
  const frac = Number(m[4]!.padEnd(3, '0'));
  return ((h * 60 + min) * 60 + s) * 1000 + frac;
}

function cueTextToLines(raw: string): string[] {
  const noTags = raw
    .replace(/<\d{1,3}:\d{2}(?::\d{2})?[.,]\d{1,3}>/g, '') // 行内时间戳
    .replace(/<\/?(?:c|v|b|i|u|ruby|rt|lang)(?:[.\s][^<>]*)?>/gi, '');
  return normalizeCaptionLines(decodeEntities(noTags));
}

export function parseVtt(body: string): CaptionParseResult {
  if (body.length > MAX_CAPTION_BODY_CHARS) throw new CaptionParseError('too-large');
  const text = body.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) throw new CaptionParseError('invalid-structure');

  const blocks = text.split(/\n{2,}/);
  if (blocks.length > MAX_RAW_EVENTS) throw new CaptionParseError('invalid-structure');
  const stats = emptyStats();
  const candidates: CueCandidate[] = [];
  let prevLines: string[] = [];
  let prevEnd = -1;

  for (let bi = 1; bi < blocks.length; bi++) {
    const lines = blocks[bi]!.split('\n');
    while (lines.length && !lines[0]!.trim()) lines.shift();
    if (!lines.length) continue;
    const head = lines[0]!.trim();
    if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(head)) continue;
    const timingIndex = TIMING_RE.test(head) ? 0 : 1;
    if (timingIndex === 1 && !(lines[1] && TIMING_RE.test(lines[1].trim()))) {
      // 既不是 cue 也不是已知块：忽略（例如头部元数据行 Kind:/Language:）。
      if (lines.some((l) => l.includes('-->'))) stats.rejected++;
      continue;
    }
    const timing = TIMING_RE.exec(lines[timingIndex]!.trim())!;
    const start = parseVttTimestamp(timing[1]!);
    const end = parseVttTimestamp(timing[2]!);
    if (start === undefined || end === undefined || end <= start) {
      stats.rejected++;
      continue;
    }
    const fullLines = cueTextToLines(lines.slice(timingIndex + 1).join('\n'));
    let newLines = fullLines;

    // 滚动字幕：当前 cue 开头若与上一条 cue 末尾若干行相同（且时间相接），去掉这些重复行。
    if (prevLines.length && fullLines.length && start <= prevEnd + 50) {
      for (let k = Math.min(prevLines.length, fullLines.length); k >= 1; k--) {
        const tail = prevLines.slice(prevLines.length - k);
        if (tail.every((l, i) => l === fullLines[i])) {
          newLines = fullLines.slice(k);
          break;
        }
      }
      if (!newLines.length) stats.duplicates++;
    }
    if (fullLines.length) {
      prevLines = fullLines;
      prevEnd = Math.max(end, start);
    }
    if (!newLines.length) continue;
    candidates.push({ startMs: start, endMs: end, text: newLines.join('\n') });
  }

  return finalizeCandidates('vtt', candidates, stats);
}

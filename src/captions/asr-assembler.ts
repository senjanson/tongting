/**
 * ASR 分段结果 → cue。
 *
 * - offscreen 分段约 3–6 秒且相邻分段有少量重叠，识别文本在重叠处会重复；
 *   按「时间重叠 + 文本后缀/前缀相同」共同去重：从后一段开头删除重复 token，并按字符比例后移其起点。
 * - 前一段仍为临时结果且末词被切断（"te" vs "test"）时，删除前一段的残词。
 * - 已发出的 final 段冻结（文本、起止时间都不再因相邻段变化）：之后到达的相邻段（包括时间更早但迟到的段）
 *   自己让出重叠部分，避免已确认（可能已翻译、朗读）的句子被反复修订。
 * - 同一 segmentId 的新 revision 更新同一 cue；段一旦 final，后续结果（含更高 revision）都被忽略。
 * - cue.revision 只在文本变化时递增；仅起止时间、stability、endEstimated 变化时 revision 不变，
 *   worker 可据此保留已有译文而不重新翻译。
 * - 不同 segmentId 但时间几乎重合（≥80%）的结果：文本相同视为重复；文本不同时仅在旧结果仍为临时时替换。
 * - 输出 cue 起点单调：起点不早于前一个有效 cue 的结束时间。
 */
import { MAX_CUE_TEXT_LENGTH, MAX_MEDIA_TIME_MS, type Cue } from '../domain/cue';
import type { AsrCueAssembler } from './types';
import {
  joinTokens,
  normalizeCaptionText,
  stableIdPrefix,
  tokenKey,
  tokenize,
  type CaptionToken,
} from './text';

type AsrResult = Parameters<AsrCueAssembler['push']>[0];
type UpdateResult = { upserts: Cue[]; removedIds: string[] };

interface KeyedToken extends CaptionToken {
  key: string;
}

interface Emitted {
  text: string;
  startMs: number;
  endMs: number;
  final: boolean;
  endEstimated: boolean;
  language: string;
  revision: number;
}

interface Segment {
  segmentId: string;
  cueId: string;
  startMs: number;
  endMs: number;
  endEstimated: boolean;
  tokens: KeyedToken[];
  language: string;
  final: boolean;
  revision: number;
  emitted?: Emitted;
}

const MAX_SEGMENTS = 10_000;
/** 相邻分段视为可能重叠的时间容差。 */
const ADJACENT_TOLERANCE_MS = 300;
/** 重叠去重最多比较的 token 数。 */
const MAX_OVERLAP_TOKENS = 30;
const SAME_RANGE_RATIO = 0.8;

export interface AsrAssemblerOptions {
  idPrefix: string;
  targetLanguage: string;
}

export function createAsrCueAssembler(opts: AsrAssemblerOptions): AsrCueAssembler {
  const prefix = stableIdPrefix(opts.idPrefix);
  /** 按 startMs 升序。 */
  let segments: Segment[] = [];
  /** segmentId → 实际承载的 segment（别名用于重复分段）。 */
  let byId = new Map<string, Segment>();

  function clampTime(ms: number): number {
    return Math.min(MAX_MEDIA_TIME_MS, Math.max(0, Math.round(ms)));
  }

  function overlapRatio(
    a: { startMs: number; endMs: number },
    b: { startMs: number; endMs: number },
  ): number {
    // 以较长者为分母：短分段落在长分段内部不算「同一范围」。
    const inter = Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs);
    const longer = Math.max(a.endMs - a.startMs, b.endMs - b.startMs);
    if (inter <= 0 || longer <= 0) return 0;
    return inter / longer;
  }

  function insertSorted(seg: Segment): void {
    let lo = 0;
    let hi = segments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (segments[mid]!.startMs <= seg.startMs) lo = mid + 1;
      else hi = mid;
    }
    segments.splice(lo, 0, seg);
  }

  function resort(seg: Segment): void {
    const idx = segments.indexOf(seg);
    if (idx >= 0) segments.splice(idx, 1);
    insertSorted(seg);
  }

  /**
   * 计算相邻两段的重叠：返回从 b 开头删除的 token 数，以及是否删除 a 的末尾残词。
   */
  function resolveOverlap(
    a: Segment,
    b: Segment,
  ): { dropFromB: number; dropLastOfA: boolean; window: number; partialFirst: boolean } {
    const none = { dropFromB: 0, dropLastOfA: false, window: 0, partialFirst: false };
    if (!a.tokens.length || !b.tokens.length) return none;
    if (b.startMs > a.endMs + ADJACENT_TOLERANCE_MS) return none;
    const A = a.tokens;
    const B = b.tokens;
    const maxK = Math.min(A.length, B.length, MAX_OVERLAP_TOKENS);
    for (let k = maxK; k >= 1; k--) {
      let exact = true;
      let partialLast = false;
      let partialFirst = false;
      for (let i = 0; i < k; i++) {
        const x = A[A.length - k + i]!.key;
        const y = B[i]!.key;
        if (x === y) continue;
        // a 的最后一个 token 被切断（"te" ⊂ "test"）。
        if (i === k - 1 && x.length >= 1 && y.length > x.length && y.startsWith(x)) {
          partialLast = true;
          continue;
        }
        // b 的第一个 token 从词中间开始（"st" ⊂ "test"）。
        if (i === 0 && y.length >= 2 && x.length > y.length && x.endsWith(y)) {
          partialFirst = true;
          continue;
        }
        exact = false;
        break;
      }
      if (!exact) continue;
      const matchedChars = B.slice(0, k).reduce((n, t) => n + t.key.length, 0);
      // 单 token 重叠只在较长词、确有时间重叠时接受，避免 "the"/"a" 这类误删。
      if (k === 1 && (matchedChars < 3 || b.startMs >= a.endMs)) continue;
      if (partialLast && !a.final) {
        return { dropFromB: k - 1, dropLastOfA: true, window: k, partialFirst };
      }
      if (partialFirst) return { dropFromB: k, dropLastOfA: false, window: k, partialFirst };
      return { dropFromB: partialLast ? k - 1 : k, dropLastOfA: false, window: k, partialFirst };
    }
    return none;
  }

  function prevWithTokens(index: number): Segment | undefined {
    for (let i = index - 1; i >= 0; i--) {
      if (segments[i]!.tokens.length) return segments[i];
    }
    return undefined;
  }

  function nextWithTokens(index: number): Segment | undefined {
    for (let i = index + 1; i < segments.length; i++) {
      if (segments[i]!.tokens.length) return segments[i];
    }
    return undefined;
  }

  /** 已发出的 final 段：文本与时间冻结。 */
  const isFrozen = (s: Segment) => s.emitted?.final === true;

  function computeEmission(index: number): Emitted | null {
    const seg = segments[index]!;
    if (isFrozen(seg)) return seg.emitted!;
    let tokens = seg.tokens;
    let startMs = seg.startMs;
    let endMs = seg.endMs;
    const prev = prevWithTokens(index);
    const next = nextWithTokens(index);
    if (next) {
      const r = resolveOverlap(seg, next);
      if (isFrozen(next)) {
        // 后面的段已冻结：由本段让出重叠词（后段从词中间开始时保留本段完整词）。
        const drop = r.partialFirst ? r.window - 1 : r.window;
        if (drop > 0) tokens = tokens.slice(0, Math.max(0, tokens.length - drop));
        endMs = Math.min(endMs, next.emitted!.startMs);
      } else if (r.dropLastOfA) {
        tokens = tokens.slice(0, -1);
      }
    }
    if (prev) {
      const r = resolveOverlap(prev, seg);
      if (r.dropFromB > 0) {
        const total = seg.tokens.reduce((n, t) => n + t.text.length, 0) || 1;
        const dropped = seg.tokens.slice(0, r.dropFromB).reduce((n, t) => n + t.text.length, 0);
        startMs = seg.startMs + Math.round(((seg.endMs - seg.startMs) * dropped) / total);
        tokens = tokens.slice(r.dropFromB);
      }
      const prevEnd = prev.emitted?.endMs ?? prev.endMs;
      if (prevEnd > startMs) startMs = prevEnd;
    }
    if (!tokens.length) return null;
    const text = joinTokens(tokens).slice(0, MAX_CUE_TEXT_LENGTH * 4);
    if (!text) return null;
    startMs = clampTime(Math.min(startMs, MAX_MEDIA_TIME_MS - 1));
    endMs = clampTime(Math.max(endMs, startMs + 1));
    return {
      text,
      startMs,
      endMs,
      final: seg.final,
      endEstimated: seg.endEstimated,
      language: seg.language,
      revision: seg.emitted ? seg.emitted.revision : 0,
    };
  }

  function sameEmission(a: Emitted, b: Emitted): boolean {
    return (
      a.text === b.text &&
      a.startMs === b.startMs &&
      a.endMs === b.endMs &&
      a.final === b.final &&
      a.endEstimated === b.endEstimated &&
      a.language === b.language
    );
  }

  function refresh(seg: Segment, out: UpdateResult): void {
    const index = segments.indexOf(seg);
    if (index < 0) return;
    const next = computeEmission(index);
    if (!next) {
      if (seg.emitted) {
        out.removedIds.push(seg.cueId);
        seg.emitted = undefined;
      }
      return;
    }
    if (seg.emitted && sameEmission(seg.emitted, next)) return;
    // revision 只随文本变化递增。
    const revision = seg.emitted
      ? seg.emitted.revision + (seg.emitted.text !== next.text ? 1 : 0)
      : 0;
    seg.emitted = { ...next, revision };
    out.upserts.push({
      id: seg.cueId,
      revision,
      startMs: next.startMs,
      endMs: next.endMs,
      endEstimated: next.endEstimated,
      sourceText: next.text,
      sourceLanguage: next.language,
      targetLanguage: opts.targetLanguage,
      source: 'asr',
      stability: next.final ? 'final' : 'interim',
      translationState: 'pending',
    });
  }

  function refreshAround(seg: Segment, out: UpdateResult): void {
    const index = segments.indexOf(seg);
    if (index < 0) return;
    // 前一段（残词可能被删除）→ 本段 → 后一段（起点与去重依赖本段）。
    const prev = prevWithTokens(index);
    const affected = new Set<Segment>();
    if (prev) affected.add(prev);
    if (index > 0) affected.add(segments[index - 1]!);
    affected.add(seg);
    const next = nextWithTokens(index);
    if (index + 1 < segments.length) affected.add(segments[index + 1]!);
    if (next) {
      affected.add(next);
      const nextIndex = segments.indexOf(next);
      if (nextIndex + 1 < segments.length) affected.add(segments[nextIndex + 1]!);
    }
    for (const s of [...affected].sort((a, b) => segments.indexOf(a) - segments.indexOf(b)))
      refresh(s, out);
  }

  function makeCueId(segmentId: string): string {
    return `${prefix}:${segmentId.length > 40 ? segmentId.slice(0, 40) : segmentId}`;
  }

  function uniqueCueId(segmentId: string): string {
    const base = makeCueId(segmentId);
    let id = base;
    const used = new Set(segments.map((s) => s.cueId));
    for (let n = 1; used.has(id); n++) id = `${base}.${n}`;
    return id;
  }

  return {
    push(result: AsrResult) {
      const out: UpdateResult = { upserts: [], removedIds: [] };
      if (
        !result ||
        typeof result.segmentId !== 'string' ||
        !result.segmentId ||
        result.segmentId.length > 200
      )
        return out;
      if (
        ![result.startMs, result.endMs, result.revision].every(
          (n) => typeof n === 'number' && Number.isFinite(n),
        )
      )
        return out;
      if (result.startMs < 0 || result.startMs >= MAX_MEDIA_TIME_MS) return out;
      const startMs = clampTime(result.startMs);
      const endMs = clampTime(Math.max(result.endMs, startMs + 1));
      const text = normalizeCaptionText(
        typeof result.text === 'string' ? result.text.slice(0, MAX_CUE_TEXT_LENGTH * 4) : '',
      );
      const tokens: KeyedToken[] = tokenize(text).map((t) => ({ ...t, key: tokenKey(t.text) }));
      const language =
        typeof result.language === 'string' && result.language.length <= 20 && result.language
          ? result.language
          : 'und';
      const final = result.final === true;

      let seg = byId.get(result.segmentId);
      if (seg) {
        if (seg.final) return out; // final 段冻结：不回退、不再修订
        const newer = result.revision > seg.revision || (result.revision === seg.revision && final);
        if (!newer) return out;
        seg.revision = result.revision;
        seg.final = final;
        seg.tokens = tokens;
        seg.language = language;
        seg.endEstimated = result.endEstimated === true;
        const moved = seg.startMs !== startMs;
        const oldIndex = segments.indexOf(seg);
        const oldNeighbors = [segments[oldIndex - 1], segments[oldIndex + 1]].filter(
          (s): s is Segment => !!s,
        );
        seg.startMs = startMs;
        seg.endMs = endMs;
        if (moved) resort(seg);
        refreshAround(seg, out);
        if (moved) for (const n of oldNeighbors) refreshAround(n, out);
        return out;
      }

      // 新 segmentId：检查是否与已有分段几乎同一时间范围（例如回退后重新识别同一段音频）。
      const range = { startMs, endMs };
      const key = tokens.map((t) => t.key).join(' ');
      const twin = segments.find((s) => overlapRatio(s, range) >= SAME_RANGE_RATIO);
      if (twin) {
        byId.set(result.segmentId, twin);
        const sameText = twin.tokens.map((t) => t.key).join(' ') === key;
        if (twin.final) return out; // 保留第一次确认的最终结果，避免已确认句子被反复修订
        if (sameText && !final) return out; // 重复的临时结果
        // 旧结果仍为临时：用新结果替换内容（沿用旧 cue id，revision 递增）。
        twin.tokens = tokens;
        twin.final = final || twin.final;
        twin.language = language;
        twin.endEstimated = result.endEstimated === true;
        twin.revision = Math.max(twin.revision, result.revision);
        refreshAround(twin, out);
        return out;
      }

      seg = {
        segmentId: result.segmentId,
        cueId: uniqueCueId(result.segmentId),
        startMs,
        endMs,
        endEstimated: result.endEstimated === true,
        tokens,
        language,
        final,
        revision: result.revision,
      };
      byId.set(result.segmentId, seg);
      insertSorted(seg);
      if (segments.length > MAX_SEGMENTS) {
        const dropped = segments.shift()!;
        for (const [id, s] of byId) if (s === dropped) byId.delete(id);
      }
      refreshAround(seg, out);
      return out;
    },

    reset() {
      segments = [];
      byId = new Map();
    },
  };
}

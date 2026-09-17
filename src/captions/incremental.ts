/**
 * 增量可见字幕组装：只能读取播放器当前显示的字幕（.ytp-caption-segment）时使用。
 *
 * 输入是每次变化后「当前可见的全部字幕文本」，可能是：
 * - 自动字幕滚动：逐词追加、上一行滚出、末词被修订（"wor" → "world"、"world" → "world."）；
 * - 普通字幕：整句替换、清空；
 * - 重绘：同一文本重复出现，或只剩已见过的一部分。
 *
 * 做法：维护已确认 token 尾部（tail）与当前临时句（open）。新文本与「tail + open」的最长后缀/前缀重叠部分视为已见，
 * 剩余 token 追加到临时句；无重叠则视为新字幕并结束临时句。临时句以 interim 发出，遇句末、超长、清空、
 * 新字幕、断点（跳转/flush）时以 final 发出（同一 id）。
 *
 * 提前 final：文本稳定一段时间（整批出现或句末 ≈400ms，滚动逐词 ≈1500ms）的临时句先以 final + endEstimated 发出，
 * 文本冻结，便于尽早翻译；之后同一 cue 只延长/确定结束时间。调用方需在文本不变时也定期 push（心跳）。
 *
 * revision 语义：只在 sourceText 变化时递增。仅 endMs / endEstimated / stability 变化时 revision 不变，
 * worker 应据此保留已有译文、不重新翻译。
 */
import { MAX_CUE_TEXT_LENGTH, MAX_MEDIA_TIME_MS, type Cue } from '../domain/cue';
import type { IncrementalCaptionAssembler } from './types';
import {
  endsClause,
  endsSentence,
  joinTokens,
  normalizeCaptionText,
  stableIdPrefix,
  tokenKey,
  tokenize,
  type CaptionToken,
} from './text';

export interface IncrementalAssemblerOptions {
  idPrefix: string;
  sourceLanguage: string;
  targetLanguage: string;
  /** 临时句超过该字符数时，在较早到达的 token 处断句。 */
  maxChars?: number;
  /** 临时句超过该时长时断句。 */
  maxDurationMs?: number;
  /** 临时句结束时间估计 = 最近变化 + holdMs。 */
  holdMs?: number;
  /** 整批出现或以句末结尾的文本稳定该时长后提前 final。 */
  stableFinalMs?: number;
  /** 逐词滚动的文本稳定该时长后提前 final。 */
  rollingFinalMs?: number;
}

type UpdateResult = { upserts: Cue[]; removedIds: string[] };

interface TimedToken extends CaptionToken {
  key: string;
  atMs: number;
}

interface OpenCue {
  id: string;
  startMs: number;
  tokens: TimedToken[];
  revision: number;
  emitted: boolean;
  emittedText: string;
  emittedEndMs: number;
  emittedFinal: boolean;
  /** 文本最近一次变化的媒体时间。 */
  lastChangeAt: number;
  /** 已提前 final：文本冻结，只更新结束时间。 */
  frozen: boolean;
}

interface FinalRecord {
  id: string;
  startMs: number;
  endMs: number;
  key: string;
  revision: number;
  text: string;
}

const TAIL_TOKENS = 64;
const MAX_FINAL_RECORDS = 400;
const MAX_USED_IDS = 5_000;
/** 媒体时间回退超过该值视为跳转断点。 */
const BACKWARD_JUMP_MS = 1_000;
/** 两次采样间隔超过该值视为断点（跳转或长时间暂停后）。 */
const FORWARD_JUMP_MS = 15_000;
const DUPLICATE_WINDOW_MS = 2_000;
const MAX_VISIBLE_CHARS = 2_000;

export function createIncrementalCaptionAssembler(
  opts: IncrementalAssemblerOptions,
): IncrementalCaptionAssembler {
  const prefix = stableIdPrefix(opts.idPrefix);
  const maxChars = opts.maxChars ?? 160;
  const maxDurationMs = opts.maxDurationMs ?? 8_000;
  const holdMs = opts.holdMs ?? 2_500;
  const stableFinalMs = opts.stableFinalMs ?? 400;
  const rollingFinalMs = opts.rollingFinalMs ?? 1_500;

  const newOpen = (startMs: number, tokens: TimedToken[]): OpenCue => ({
    id: newId(startMs),
    startMs,
    tokens,
    revision: 0,
    emitted: false,
    emittedText: '',
    emittedEndMs: 0,
    emittedFinal: false,
    lastChangeAt: startMs,
    frozen: false,
  });

  let tail: TimedToken[] = [];
  let open: OpenCue | null = null;
  let lastTime: number | undefined;
  let lastVisibleText = '';
  let finals: FinalRecord[] = [];
  let usedIds = new Set<string>();

  function sanitizeTime(ms: number): number | undefined {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0 || ms > MAX_MEDIA_TIME_MS)
      return undefined;
    return Math.min(Math.round(ms), MAX_MEDIA_TIME_MS - 1);
  }

  function newId(startMs: number): string {
    const base = `${prefix}:v${startMs}`;
    let id = base;
    for (let n = 1; usedIds.has(id); n++) id = `${base}.${n}`;
    usedIds.add(id);
    if (usedIds.size > MAX_USED_IDS) {
      const first = usedIds.values().next().value;
      if (first !== undefined) usedIds.delete(first);
    }
    return id;
  }

  function makeCue(
    id: string,
    revision: number,
    startMs: number,
    endMs: number,
    text: string,
    final: boolean,
    endEstimated: boolean,
  ): Cue {
    const start = Math.min(startMs, MAX_MEDIA_TIME_MS - 1);
    const end = Math.min(MAX_MEDIA_TIME_MS, Math.max(endMs, start + 1));
    return {
      id,
      revision,
      startMs: start,
      endMs: end,
      endEstimated,
      sourceText: text.slice(0, MAX_CUE_TEXT_LENGTH * 4),
      sourceLanguage: opts.sourceLanguage || 'und',
      targetLanguage: opts.targetLanguage,
      source: 'visible-caption',
      stability: final ? 'final' : 'interim',
      translationState: 'pending',
    };
  }

  function pushTail(tokens: TimedToken[]): void {
    tail = tail.concat(tokens);
    if (tail.length > TAIL_TOKENS) tail = tail.slice(tail.length - TAIL_TOKENS);
  }

  function recordFinal(rec: FinalRecord): void {
    finals.push(rec);
    if (finals.length > MAX_FINAL_RECORDS) finals = finals.slice(finals.length - MAX_FINAL_RECORDS);
  }

  /** 以 final（结束时间已确定）发出临时句的前 count 个 token；剩余 token 成为新的临时句。 */
  function finalizeOpen(count: number, endMs: number, out: UpdateResult): void {
    if (!open) return;
    const cur = open;
    const toks = cur.tokens.slice(0, count);
    const rest = cur.tokens.slice(count);
    if (toks.length) {
      const text = joinTokens(toks);
      const key = toks.map((t) => t.key).join(' ');
      const startMs = cur.startMs;
      const end = Math.max(endMs, startMs + 1);
      if (cur.frozen) {
        // 已提前 final：文本不变，只确定结束时间（revision 不变）。
        out.upserts.push(makeCue(cur.id, cur.revision, startMs, end, cur.emittedText, true, false));
        const rec = finals.find((f) => f.id === cur.id);
        if (rec) rec.endMs = end;
      } else {
        const dup = finals.find(
          (f) => f.key === key && Math.abs(f.startMs - startMs) <= DUPLICATE_WINDOW_MS,
        );
        if (dup) {
          // 与刚确认过的句子相同（重绘或小幅回退）：撤回临时 id，保留原最终句。
          if (cur.emitted) out.removedIds.push(cur.id);
        } else {
          const revision = cur.emitted ? cur.revision + (text !== cur.emittedText ? 1 : 0) : 0;
          out.upserts.push(makeCue(cur.id, revision, startMs, end, text, true, false));
          recordFinal({ id: cur.id, startMs, endMs: end, key, revision, text });
        }
      }
      pushTail(toks);
    }
    open = rest.length ? newOpen(rest[0]!.atMs, rest) : null;
  }

  function emitOpen(now: number, out: UpdateResult): void {
    if (!open || !open.tokens.length) return;
    const text = open.frozen ? open.emittedText : joinTokens(open.tokens);
    const lastAt = open.tokens[open.tokens.length - 1]!.atMs;
    const endMs = Math.min(MAX_MEDIA_TIME_MS, Math.max(lastAt, now) + holdMs);
    if (
      open.emitted &&
      text === open.emittedText &&
      open.frozen === open.emittedFinal &&
      endMs - open.emittedEndMs < 1_000
    ) {
      return;
    }
    const revision = open.emitted ? open.revision + (text !== open.emittedText ? 1 : 0) : 0;
    out.upserts.push(makeCue(open.id, revision, open.startMs, endMs, text, open.frozen, true));
    open.emitted = true;
    open.revision = revision;
    open.emittedText = text;
    open.emittedEndMs = endMs;
    open.emittedFinal = open.frozen;
  }

  /** 文本稳定后提前 final（冻结文本）。与近期已确认句重复时改为跟踪那条 cue。 */
  function maybeFreeze(now: number, out: UpdateResult): void {
    if (!open || open.frozen || !open.tokens.length) return;
    const toks = open.tokens;
    const singleBatch = toks.every((t) => t.atMs === toks[0]!.atMs);
    const threshold =
      singleBatch || endsSentence(toks[toks.length - 1]!.text) ? stableFinalMs : rollingFinalMs;
    if (now - open.lastChangeAt < threshold) return;
    const text = joinTokens(toks);
    const key = toks.map((t) => t.key).join(' ');
    const dup = finals.find(
      (f) => f.key === key && Math.abs(f.startMs - open!.startMs) <= DUPLICATE_WINDOW_MS,
    );
    if (dup) {
      if (open.emitted) out.removedIds.push(open.id);
      open = {
        ...open,
        id: dup.id,
        startMs: dup.startMs,
        revision: dup.revision,
        emitted: true,
        emittedText: dup.text,
        emittedEndMs: 0,
        emittedFinal: true,
        frozen: true,
      };
      emitOpen(now, out);
      return;
    }
    open.frozen = true;
    emitOpen(now, out);
    recordFinal({
      id: open.id,
      startMs: open.startMs,
      endMs: open.emittedEndMs,
      key,
      revision: open.revision,
      text,
    });
  }

  /** 句末 / 超长 / 超时拆分临时句。只在较晚到达的 token 处拆分，同一时刻出现的整句不拆。 */
  function splitOpen(now: number, out: UpdateResult): void {
    for (let guard = 0; open && !open.frozen && guard < 20; guard++) {
      const toks: TimedToken[] = open.tokens;
      let idx = -1;
      for (let i = 0; i < toks.length - 1; i++) {
        if (endsSentence(toks[i]!.text) && toks[i + 1]!.atMs > open.startMs) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        const tooLong = joinTokens(toks).length > maxChars || now - open.startMs > maxDurationMs;
        if (!tooLong) break;
        // 只在「到达批次」之间拆分；优先选最后一个从句标点处，否则选最后一个批次边界。
        let lastBoundary = -1;
        let lastClause = -1;
        for (let i = 0; i < toks.length - 1; i++) {
          if (toks[i + 1]!.atMs > toks[i]!.atMs) {
            lastBoundary = i;
            if (endsClause(toks[i]!.text)) lastClause = i;
          }
        }
        idx = lastClause >= 0 ? lastClause : lastBoundary;
        if (idx < 0) {
          if (joinTokens(toks).length > MAX_CUE_TEXT_LENGTH * 4) {
            finalizeOpen(toks.length, now, out);
          }
          break;
        }
      }
      finalizeOpen(idx + 1, toks[idx + 1]!.atMs, out);
    }
  }

  function breakpoint(endMs: number, out: UpdateResult): void {
    if (open) {
      const lastAt = open.tokens[open.tokens.length - 1]?.atMs ?? open.startMs;
      finalizeOpen(open.tokens.length, Math.max(endMs, lastAt), out);
    }
    tail = [];
    lastVisibleText = '';
    lastTime = undefined;
  }

  function findOverlap(
    seen: readonly TimedToken[],
    visible: readonly TimedToken[],
    openLen: number,
  ): { m: number; reviseLast: boolean } | null {
    for (let m = Math.min(seen.length, visible.length); m >= 1; m--) {
      let ok = true;
      let reviseLast = false;
      for (let i = 0; i < m; i++) {
        const s = seen[seen.length - m + i]!;
        const v = visible[i]!;
        if (s.key === v.key) continue;
        // 末词逐字修订：已见的最后一个 token 是新 token 的前缀，且仍在临时句中。
        if (i === m - 1 && openLen > 0 && v.key.length > s.key.length && v.key.startsWith(s.key)) {
          reviseLast = true;
          continue;
        }
        ok = false;
        break;
      }
      if (!ok) continue;
      // 单 token 重叠容易误判（例如「I said no.」→「No. Absolutely.」），仅在临时句恰好只有这个 token 时接受。
      if (m >= 2 || openLen === 1) return { m, reviseLast };
    }
    return null;
  }

  function containsWindow(seen: readonly TimedToken[], visible: readonly TimedToken[]): boolean {
    if (visible.length < 3 || visible.length > seen.length) return false;
    outer: for (let p = 0; p + visible.length <= seen.length; p++) {
      for (let i = 0; i < visible.length; i++) {
        if (seen[p + i]!.key !== visible[i]!.key) continue outer;
      }
      return true;
    }
    return false;
  }

  return {
    push(sample) {
      const out: UpdateResult = { upserts: [], removedIds: [] };
      const now = sanitizeTime(sample?.mediaTimeMs);
      if (now === undefined) return out;
      if (
        lastTime !== undefined &&
        (now < lastTime - BACKWARD_JUMP_MS || now > lastTime + FORWARD_JUMP_MS)
      ) {
        breakpoint(lastTime, out);
      }
      lastTime = now;

      const text = normalizeCaptionText(
        typeof sample.text === 'string' ? sample.text.slice(0, MAX_VISIBLE_CHARS) : '',
      );
      if (!text) {
        if (open) finalizeOpen(open.tokens.length, now, out);
        lastVisibleText = '';
        return out;
      }
      if (text === lastVisibleText) {
        // 无变化（心跳）：稳定够久则提前 final；否则定期延长估计结束时间。
        maybeFreeze(now, out);
        if (open?.emitted) emitOpen(now, out);
        return out;
      }
      const prevVisibleText = lastVisibleText;
      lastVisibleText = text;

      const visible: TimedToken[] = tokenize(text).map((t) => ({
        ...t,
        key: tokenKey(t.text),
        atMs: now,
      }));
      const openTokens = open?.tokens ?? [];
      // 字幕区清空后再出现的文本视为新字幕（重复显示的同一句由 finalize 的时间窗口去重）。
      const seen = prevVisibleText ? tail.concat(openTokens) : [];
      const overlap = findOverlap(seen, visible, openTokens.length);

      if (!overlap) {
        if (containsWindow(seen, visible)) return out; // 未清空时只重绘了已见过的部分
        if (open) finalizeOpen(open.tokens.length, now, out);
        open = newOpen(now, visible);
      } else {
        const { m, reviseLast } = overlap;
        if (open && !open.frozen) {
          // 同 key 但原文不同（例如补了标点）或末词修订：更新临时句中的 token 原文。
          const openStartInSeen = seen.length - open.tokens.length;
          for (let i = 0; i < m; i++) {
            const seenIndex = seen.length - m + i;
            if (seenIndex < openStartInSeen) continue;
            const tok = open.tokens[seenIndex - openStartInSeen]!;
            const v = visible[i]!;
            if (tok.text !== v.text && (tok.key === v.key || (reviseLast && i === m - 1))) {
              open.tokens[seenIndex - openStartInSeen] = { ...v, atMs: tok.atMs };
              open.lastChangeAt = now;
            }
          }
        }
        const added = visible.slice(m);
        if (added.length) {
          if (open?.frozen) {
            // 已冻结的句子不再追加：在此结束，新词另起一句。
            finalizeOpen(open.tokens.length, now, out);
          }
          if (open) {
            open.tokens = open.tokens.concat(added);
            open.lastChangeAt = now;
          } else {
            open = newOpen(now, added);
          }
        }
      }

      splitOpen(now, out);
      emitOpen(now, out);
      return out;
    },

    flush(mediaTimeMs) {
      const out: UpdateResult = { upserts: [], removedIds: [] };
      const t = sanitizeTime(mediaTimeMs);
      if (open) {
        const lastAt = open.tokens[open.tokens.length - 1]?.atMs ?? open.startMs;
        const observedEnd = Math.max(lastTime ?? lastAt, lastAt);
        const end =
          t !== undefined && t > open.startMs && t <= observedEnd + DUPLICATE_WINDOW_MS
            ? t
            : observedEnd;
        finalizeOpen(open.tokens.length, end, out);
      }
      tail = [];
      lastVisibleText = '';
      lastTime = undefined;
      return out;
    },

    reset() {
      tail = [];
      open = null;
      lastTime = undefined;
      lastVisibleText = '';
      finals = [];
      usedIds = new Set();
    },
  };
}

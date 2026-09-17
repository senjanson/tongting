/**
 * 捕获音频时间 → 视频媒体时间映射（纯逻辑）。
 *
 * 输入：worker 转发的 MediaAnchor 序列。锚点表示「在 epoch 时刻 epochMs，媒体时间为 mediaTimeMs，
 * 速率为 playbackRate」。discontinuityId 在暂停、跳转、倍速、广告、换视频时递增，
 * 同一 discontinuityId 内的锚点只是周期性校准。
 *
 * 规则：
 * - 某 epoch 时刻生效的锚点 = epochMs ≤ 该时刻的最新锚点。
 * - 同一断点区间内：media = anchor.mediaTimeMs + (t − anchor.epochMs) × playbackRate。
 *   倍速下 1 秒捕获音频对应 playbackRate 秒媒体时间（按采样区间换算）。
 * - 跨断点的音频区间拆分为多段；暂停/跳转中/缓冲/广告区间以及过短的片段丢弃。
 * - 区间终点晚于最近一次锚点确认过多（staleAnchorMs）时 endEstimated = true。
 */
import type { MediaAnchor } from '../messaging/offscreen-protocol';
import { MAX_MEDIA_TIME_MS } from '../domain/cue';

export interface EpochRange {
  startEpochMs: number;
  endEpochMs: number;
}

export type DropReason = 'no-anchor' | 'ad' | 'not-playing' | 'too-short';

export type TimelinePiece =
  | (EpochRange & { disposition: 'send'; discontinuityId: number; playbackRate: number })
  | (EpochRange & { disposition: 'drop'; reason: DropReason });

export interface TimelineOptions {
  maxAnchors?: number;
  staleAnchorMs?: number;
  minPieceMs?: number;
  /** 同一断点区间内保留的校准锚点最小间隔。 */
  minSpacingMs?: number;
}

export type MapResult =
  | { ok: true; startMs: number; endMs: number; endEstimated: boolean; clipped: boolean }
  | { ok: false; reason: DropReason | 'discontinuity-changed' };

export function isPlayable(anchor: MediaAnchor): boolean {
  return !anchor.paused && !anchor.seeking && !anchor.buffering && !anchor.ad;
}

export function mediaTimeAt(anchor: MediaAnchor, epochMs: number): number {
  const advance = isPlayable(anchor) ? (epochMs - anchor.epochMs) * anchor.playbackRate : 0;
  return clampMedia(anchor.mediaTimeMs + advance);
}

function clampMedia(ms: number): number {
  if (!Number.isFinite(ms)) return 0;
  return Math.min(MAX_MEDIA_TIME_MS, Math.max(0, ms));
}

/** 两个锚点之间是否存在需要断开映射的变化。 */
export function isBoundary(prev: MediaAnchor | undefined, next: MediaAnchor): boolean {
  if (!prev) return true;
  return (
    prev.discontinuityId !== next.discontinuityId ||
    isPlayable(prev) !== isPlayable(next) ||
    prev.ad !== next.ad ||
    prev.playbackRate !== next.playbackRate
  );
}

export class MediaTimeline {
  private anchors: MediaAnchor[] = [];
  private readonly maxAnchors: number;
  private readonly staleAnchorMs: number;
  private readonly minPieceMs: number;
  private readonly minSpacingMs: number;

  constructor(options: TimelineOptions = {}) {
    this.maxAnchors = options.maxAnchors ?? 400;
    this.staleAnchorMs = options.staleAnchorMs ?? 3_000;
    this.minPieceMs = options.minPieceMs ?? 800;
    this.minSpacingMs = options.minSpacingMs ?? 1_000;
  }

  get size(): number {
    return this.anchors.length;
  }

  latest(): MediaAnchor | undefined {
    return this.anchors[this.anchors.length - 1];
  }

  /**
   * 加入锚点（按 epochMs 有序插入）。返回该锚点是否构成断点。
   *
   * 协调器每次收到播放器状态都会转发锚点（频率可能很高）。为避免 maxAnchors 被周期性校准锚点挤满、
   * 丢失积压分段仍需要的旧断点，同一断点区间内相邻校准锚点间隔小于 minSpacingMs 时，用新锚点替换末尾的校准锚点。
   */
  add(anchor: MediaAnchor): { boundary: boolean } {
    let idx = this.anchors.length;
    while (idx > 0 && this.anchors[idx - 1]!.epochMs > anchor.epochMs) idx--;
    const prev = this.anchors[idx - 1];
    const boundary = isBoundary(prev, anchor);
    if (!boundary && idx === this.anchors.length && idx >= 2) {
      const prevPrev = this.anchors[idx - 2]!;
      if (!isBoundary(prevPrev, prev!) && anchor.epochMs - prevPrev.epochMs < this.minSpacingMs) {
        this.anchors[idx - 1] = anchor;
        return { boundary: false };
      }
    }
    this.anchors.splice(idx, 0, anchor);
    if (this.anchors.length > this.maxAnchors)
      this.anchors.splice(0, this.anchors.length - this.maxAnchors);
    return { boundary };
  }

  /** 丢弃早于 epochMs 的锚点，但保留在该时刻仍生效的那一个。 */
  prune(beforeEpochMs: number): void {
    let keepFrom = 0;
    for (let i = 0; i < this.anchors.length; i++) {
      if (this.anchors[i]!.epochMs <= beforeEpochMs) keepFrom = i;
      else break;
    }
    if (keepFrom > 0) this.anchors.splice(0, keepFrom);
  }

  clear(): void {
    this.anchors = [];
  }

  anchorAt(epochMs: number): MediaAnchor | undefined {
    let lo = 0;
    let hi = this.anchors.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.anchors[mid]!.epochMs <= epochMs) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? this.anchors[found] : undefined;
  }

  /** (start, end) 内构成断点的锚点时刻，升序。 */
  boundariesWithin(range: EpochRange): number[] {
    const out: number[] = [];
    let prev = this.anchorAt(range.startEpochMs);
    for (const a of this.anchors) {
      if (a.epochMs <= range.startEpochMs) continue;
      if (a.epochMs >= range.endEpochMs) break;
      if (isBoundary(prev, a)) out.push(a.epochMs);
      prev = a;
    }
    return out;
  }

  /** 发送识别前的规划：按断点拆分区间，并标记每段发送或丢弃。 */
  plan(range: EpochRange): TimelinePiece[] {
    if (!(range.endEpochMs > range.startEpochMs)) return [];
    const cuts = [range.startEpochMs, ...this.boundariesWithin(range), range.endEpochMs];
    const pieces: TimelinePiece[] = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const startEpochMs = cuts[i]!;
      const endEpochMs = cuts[i + 1]!;
      if (endEpochMs <= startEpochMs) continue;
      const anchor = this.anchorAt(startEpochMs);
      const base = { startEpochMs, endEpochMs };
      if (!anchor) pieces.push({ ...base, disposition: 'drop', reason: 'no-anchor' });
      else if (anchor.ad) pieces.push({ ...base, disposition: 'drop', reason: 'ad' });
      else if (!isPlayable(anchor))
        pieces.push({ ...base, disposition: 'drop', reason: 'not-playing' });
      else if (endEpochMs - startEpochMs < this.minPieceMs)
        pieces.push({ ...base, disposition: 'drop', reason: 'too-short' });
      else
        pieces.push({
          ...base,
          disposition: 'send',
          discontinuityId: anchor.discontinuityId,
          playbackRate: anchor.playbackRate,
        });
    }
    return pieces;
  }

  /**
   * 识别结果返回时的映射：用当时已知的全部锚点重新核对。
   * - 起点所在断点区间必须与发送时一致，否则丢弃（迟到的断点）。
   * - 区间内若出现新的断点，终点截断到断点处。
   */
  map(
    range: EpochRange,
    expectedDiscontinuityId: number,
    options: { timingEstimated?: boolean } = {},
  ): MapResult {
    const anchor = this.anchorAt(range.startEpochMs);
    if (!anchor) return { ok: false, reason: 'no-anchor' };
    if (anchor.discontinuityId !== expectedDiscontinuityId)
      return { ok: false, reason: 'discontinuity-changed' };
    if (anchor.ad) return { ok: false, reason: 'ad' };
    if (!isPlayable(anchor)) return { ok: false, reason: 'not-playing' };
    let endEpoch = Math.max(range.startEpochMs, range.endEpochMs);
    let clipped = false;
    const boundaries = this.boundariesWithin({
      startEpochMs: range.startEpochMs,
      endEpochMs: endEpoch,
    });
    if (boundaries.length > 0) {
      endEpoch = boundaries[0]!;
      clipped = true;
    }
    const startMs = Math.round(mediaTimeAt(anchor, range.startEpochMs));
    // 终点使用同一断点区间内最新的锚点校准，并保证不早于起点。
    const endAnchor = this.anchorAt(endEpoch);
    const lineAnchor =
      endAnchor && endAnchor.discontinuityId === anchor.discontinuityId && isPlayable(endAnchor)
        ? endAnchor
        : anchor;
    const endMs = Math.max(startMs, Math.round(mediaTimeAt(lineAnchor, endEpoch)));
    const latest = this.latest();
    const unconfirmed = !clipped && (!latest || latest.epochMs + this.staleAnchorMs < endEpoch);
    return {
      ok: true,
      startMs,
      endMs,
      endEstimated: unconfirmed || !!options.timingEstimated,
      clipped,
    };
  }
}

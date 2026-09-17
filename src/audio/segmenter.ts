/**
 * 识别分段器：把连续的 16 kHz 单声道 PCM 切成有界分段。
 *
 * 策略（参数需实测调整，见 docs/validation/p0-audio.md）：
 * - 分段长度落在 [minSegmentMs, maxSegmentMs]，目标约为 segmentMs。
 * - 达到最短长度后，优先在「持续静音」的中点切分（不重叠）。
 * - 到达最长长度仍无静音时，在允许区间内能量最低的帧处强制切分，并保留 overlapMs 重叠，
 *   重叠产生的重复文本由 worker 的 AsrCueAssembler 按时间与文本去重。
 * - 有声时长不足 minVoicedMs 的分段标记为 silent，调用方不送识别。
 * - 切分用的静音门限为自适应：动态范围 ≥ 10 dB 时取 max(silenceDbfs, min(噪声底 + 6 dB, -30 dBFS))，否则取 silenceDbfs；
 *   判断分段「是否有声」使用相对门限（见 voicedThreshold）：有音节起伏（p90 − p10 ≥ 6 dB）的段以
 *   max(floorDbfs, p10 + 6 dB) 为门限，低音量语音（例如 -45 dBFS 左右）不会被当作静音；
 *   起伏很小的稳定信号仍用 silenceDbfs + 3 dB，避免把稳定底噪送去识别。低于 floorDbfs(-60) 的帧永不算有声。
 *   不区分音乐与人声（未实现）。
 *
 * 样本序号均为「自最近一次 reset 起」的绝对序号，调用方据此换算时间。
 */
import { rms, toDbfs } from './pcm';

export interface SegmenterOptions {
  sampleRate: number;
  segmentMs: number;
  minSegmentMs?: number;
  maxSegmentMs?: number;
  overlapMs?: number;
  frameMs?: number;
  silenceDbfs?: number;
  minSilenceGapMs?: number;
  minVoicedMs?: number;
  /** 断点/收尾产生的分段短于该值时丢弃。 */
  minFlushMs?: number;
  /** 绝对下限：低于该电平的帧永不算有声。 */
  floorDbfs?: number;
}

export type SegmentCut = 'silence' | 'forced' | 'boundary' | 'flush';

export interface PcmSegment {
  startSample: number;
  /** 不含。 */
  endSample: number;
  samples: Float32Array;
  cut: SegmentCut;
  voicedMs: number;
  rmsDbfs: number;
  /** 非 null 表示不应送识别。 */
  discard: null | 'silent' | 'too-short';
}

interface ResolvedOptions {
  sampleRate: number;
  frame: number;
  minS: number;
  maxS: number;
  overlapS: number;
  silenceDbfs: number;
  minSilenceFrames: number;
  minVoicedMs: number;
  minFlushS: number;
  frameMs: number;
  floorDbfs: number;
}

export function resolveSegmenterOptions(o: SegmenterOptions): ResolvedOptions {
  const sr = o.sampleRate;
  if (!(sr > 0)) throw new RangeError('sampleRate 无效');
  const segmentMs = Math.max(1000, o.segmentMs);
  const minMs = o.minSegmentMs ?? Math.max(1000, Math.round(segmentMs * 0.6));
  const maxMs = Math.min(
    28_000,
    o.maxSegmentMs ?? Math.max(minMs + 500, Math.round(segmentMs * 1.4)),
  );
  if (maxMs < minMs) throw new RangeError('maxSegmentMs 必须不小于 minSegmentMs');
  const frameMs = o.frameMs ?? 30;
  const frame = Math.max(1, Math.round((frameMs / 1000) * sr));
  const overlapMs = Math.min(o.overlapMs ?? 300, Math.floor(minMs / 2));
  return {
    sampleRate: sr,
    frame,
    frameMs: (frame / sr) * 1000,
    minS: Math.round((minMs / 1000) * sr),
    maxS: Math.round((maxMs / 1000) * sr),
    overlapS: Math.round((overlapMs / 1000) * sr),
    silenceDbfs: o.silenceDbfs ?? -45,
    minSilenceFrames: Math.max(1, Math.round((o.minSilenceGapMs ?? 180) / ((frame / sr) * 1000))),
    minVoicedMs: o.minVoicedMs ?? 300,
    floorDbfs: o.floorDbfs ?? -60,
    minFlushS: Math.round(((o.minFlushMs ?? 700) / 1000) * sr),
  };
}

/**
 * 分段内「有声帧」门限（相对门限）：
 * - 帧电平动态范围（p90 − p10）≥ 6 dB：max(floorDbfs, p10 + 6)，适配低音量但有音节起伏的语音；
 * - 否则（稳定信号/底噪）：silenceDbfs + 3。
 */
export function voicedThreshold(
  frameDbs: readonly number[],
  silenceDbfs: number,
  floorDbfs: number,
): number {
  if (frameDbs.length === 0) return silenceDbfs + 3;
  const sorted = frameDbs.slice().sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)]!;
  const p90 = sorted[Math.floor(sorted.length * 0.9)]!;
  if (p90 - p10 >= 6) return Math.max(floorDbfs, p10 + 6);
  return silenceDbfs + 3;
}

export class PcmSegmenter {
  private readonly o: ResolvedOptions;
  private buffer = new Float32Array(0);
  private length = 0;
  private start = 0;
  private frameDb: number[] = [];

  constructor(options: SegmenterOptions) {
    this.o = resolveSegmenterOptions(options);
  }

  get bufferStartSample(): number {
    return this.start;
  }

  get bufferedSamples(): number {
    return this.length;
  }

  /** 下一个到达样本的绝对序号。 */
  get endSample(): number {
    return this.start + this.length;
  }

  reset(startSample = 0): void {
    this.buffer = new Float32Array(0);
    this.length = 0;
    this.start = startSample;
    this.frameDb = [];
  }

  push(chunk: Float32Array): PcmSegment[] {
    if (chunk.length === 0) return [];
    const needed = this.length + chunk.length;
    if (needed > this.buffer.length) {
      const next = new Float32Array(
        Math.max(needed, this.buffer.length * 2, this.o.maxS + this.o.frame * 4),
      );
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
    return this.drain();
  }

  /** 在绝对样本序号处强制断开（时间轴断点）。断点之前的内容作为 boundary 分段输出。 */
  cutAt(absSample: number): PcmSegment[] {
    const rel = Math.min(this.length, Math.round(absSample - this.start));
    if (rel <= 0) return [];
    const out = [this.emit(rel, rel, 'boundary')];
    return out.concat(this.drain());
  }

  /** 输出剩余全部内容。 */
  flush(): PcmSegment[] {
    if (this.length === 0) return [];
    return [this.emit(this.length, this.length, 'flush')];
  }

  private ensureFrames(): number[] {
    const full = Math.floor(this.length / this.o.frame);
    for (let i = this.frameDb.length; i < full; i++) {
      const s = i * this.o.frame;
      this.frameDb.push(toDbfs(rms(this.buffer, s, s + this.o.frame)));
    }
    return this.frameDb;
  }

  private threshold(frames: readonly number[]): number {
    if (frames.length === 0) return this.o.silenceDbfs;
    const sorted = frames.slice().sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.1)]!;
    const high = sorted[Math.floor(sorted.length * 0.9)]!;
    // 动态范围很小（持续噪声或持续低音量内容）时无法区分，退回绝对门限。
    if (high - floor < 10) return this.o.silenceDbfs;
    return Math.max(this.o.silenceDbfs, Math.min(floor + 6, -30));
  }

  private drain(): PcmSegment[] {
    const out: PcmSegment[] = [];
    for (;;) {
      if (this.length < this.o.minS) break;
      const frames = this.ensureFrames();
      const thr = this.threshold(frames);
      const minFrame = Math.ceil(this.o.minS / this.o.frame);
      const maxAvail = Math.min(frames.length, Math.floor(this.o.maxS / this.o.frame));
      let cutFrame = -1;
      let runStart = -1;
      for (let i = 0; i <= maxAvail; i++) {
        const silent = i < maxAvail && frames[i]! <= thr;
        if (silent) {
          if (runStart < 0) runStart = i;
          continue;
        }
        if (runStart >= 0) {
          const len = i - runStart;
          if (len >= this.o.minSilenceFrames) {
            const mid = runStart + Math.floor(len / 2);
            if (mid >= minFrame) {
              cutFrame = mid;
              break;
            }
          }
          runStart = -1;
        }
      }
      if (cutFrame >= 0) {
        const cut = cutFrame * this.o.frame;
        out.push(this.emit(cut, cut, 'silence'));
        continue;
      }
      if (this.length >= this.o.maxS) {
        let best = minFrame;
        let bestDb = Infinity;
        for (let i = minFrame; i < maxAvail; i++) {
          if (frames[i]! < bestDb) {
            bestDb = frames[i]!;
            best = i;
          }
        }
        const cut = Math.min(this.o.maxS, best * this.o.frame + Math.floor(this.o.frame / 2));
        const keepFrom = Math.max(1, cut - this.o.overlapS);
        out.push(this.emit(cut, keepFrom, 'forced'));
        continue;
      }
      break;
    }
    return out;
  }

  private emit(endRel: number, keepFromRel: number, cut: SegmentCut): PcmSegment {
    const samples = this.buffer.slice(0, endRel);
    const frames = this.ensureFrames();
    const segFrames = Math.min(Math.floor(endRel / this.o.frame), frames.length);
    const voiceThr = voicedThreshold(
      frames.slice(0, segFrames),
      this.o.silenceDbfs,
      this.o.floorDbfs,
    );
    let voicedFrames = 0;
    for (let i = 0; i < segFrames; i++) if (frames[i]! > voiceThr) voicedFrames++;
    // 尾部不足一帧的样本单独判断。
    const tailStart = segFrames * this.o.frame;
    let voicedMs = voicedFrames * this.o.frameMs;
    if (endRel > tailStart && toDbfs(rms(samples, tailStart, endRel)) > voiceThr) {
      voicedMs += ((endRel - tailStart) / this.o.sampleRate) * 1000;
    }
    let discard: PcmSegment['discard'] = null;
    if ((cut === 'boundary' || cut === 'flush') && endRel < this.o.minFlushS) discard = 'too-short';
    else if (voicedMs < this.o.minVoicedMs) discard = 'silent';
    const segment: PcmSegment = {
      startSample: this.start,
      endSample: this.start + endRel,
      samples,
      cut,
      voicedMs,
      rmsDbfs: toDbfs(rms(samples)),
      discard,
    };
    const keep = Math.min(keepFromRel, this.length);
    this.buffer.copyWithin(0, keep, this.length);
    this.length -= keep;
    this.start += keep;
    this.frameDb = [];
    return segment;
  }
}

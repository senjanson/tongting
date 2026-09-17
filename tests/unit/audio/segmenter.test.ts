import { describe, expect, it } from 'vitest';
import { PcmSegmenter, type PcmSegment } from '@src/audio/segmenter';

const SR = 16000;

function tone(ms: number, amp = 0.3, freq = 220): Float32Array {
  const n = Math.round((ms / 1000) * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}
const silence = (ms: number) => new Float32Array(Math.round((ms / 1000) * SR));

function feed(seg: PcmSegmenter, audio: Float32Array, chunk = 1365): PcmSegment[] {
  const out: PcmSegment[] = [];
  for (let i = 0; i < audio.length; i += chunk) out.push(...seg.push(audio.subarray(i, i + chunk)));
  return out;
}

function join(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('PcmSegmenter', () => {
  it('cuts at a silence gap once the minimum length is reached (no overlap)', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    // 3.5 s 语音 + 400 ms 静音 + 3 s 语音
    const segs = feed(s, join(tone(3500), silence(400), tone(3000)));
    expect(segs).toHaveLength(1);
    const first = segs[0]!;
    expect(first.cut).toBe('silence');
    const cutMs = (first.endSample / SR) * 1000;
    expect(cutMs).toBeGreaterThan(3500);
    expect(cutMs).toBeLessThan(3900);
    expect(first.discard).toBeNull();
    // 下一段从切点开始，没有重叠
    expect(s.bufferStartSample).toBe(first.endSample);
  });

  it('adapts the silence threshold to a noise floor', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    let seed = 7;
    const noise = (ms: number) => {
      const out = new Float32Array(Math.round((ms / 1000) * SR));
      for (let i = 0; i < out.length; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        out[i] = ((seed / 0x7fffffff) * 2 - 1) * 0.02; // 约 -39 dBFS，高于绝对门限
      }
      return out;
    };
    const mix = (a: Float32Array, b: Float32Array) => a.map((v, i) => v + (b[i] ?? 0));
    const segs = feed(
      s,
      join(mix(tone(3600), noise(3600)), noise(500), mix(tone(3000), noise(3000))),
    );
    expect(segs[0]?.cut).toBe('silence');
    expect((segs[0]!.endSample / SR) * 1000).toBeGreaterThan(3600);
  });

  it('ignores silence before the minimum length', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    const segs = feed(s, join(tone(1000), silence(400), tone(1500)));
    expect(segs).toHaveLength(0);
  });

  it('forces a cut at the lowest-energy frame at max length and keeps an overlap', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 4000, overlapMs: 300 });
    // 连续语音无静音；在 4.5 s 处有一个较弱但不足以视为静音的区域
    const audio = join(tone(4500, 0.3), tone(60, 0.05), tone(2000, 0.3));
    const segs = feed(s, audio);
    expect(segs.length).toBeGreaterThanOrEqual(1);
    const first = segs[0]!;
    expect(first.cut).toBe('forced');
    const lenMs = ((first.endSample - first.startSample) / SR) * 1000;
    expect(lenMs).toBeGreaterThanOrEqual(2400);
    expect(lenMs).toBeLessThanOrEqual(5600);
    expect(s.bufferStartSample).toBe(first.endSample - Math.round(0.3 * SR));
  });

  it('bounds every segment length for long continuous speech', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 3000 });
    const segs = feed(s, tone(30_000));
    expect(segs.length).toBeGreaterThanOrEqual(6);
    for (const seg of segs) {
      const lenMs = ((seg.endSample - seg.startSample) / SR) * 1000;
      expect(lenMs).toBeLessThanOrEqual(3000 * 1.4 + 1);
      expect(seg.samples.length).toBe(seg.endSample - seg.startSample);
    }
    // 样本序号单调推进
    for (let i = 1; i < segs.length; i++)
      expect(segs[i]!.startSample).toBeGreaterThan(segs[i - 1]!.startSample);
  });

  it('marks near-silent segments as silent so they are not sent', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 3000 });
    const segs = feed(s, join(silence(5000), tone(100, 0.2), silence(5000)));
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((x) => x.discard === 'silent')).toBe(true);
  });

  it('does not treat a quiet but voiced track as silence', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 3000 });
    const segs = feed(s, tone(10_000, 0.02)); // 约 -37 dBFS
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((x) => x.discard === null)).toBe(true);
  });

  it('cutAt emits a boundary segment and drops too-short ones', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000, minFlushMs: 700 });
    s.push(tone(2000));
    const [a] = s.cutAt(SR * 1.5);
    expect(a!.cut).toBe('boundary');
    expect(a!.endSample).toBe(SR * 1.5);
    expect(a!.discard).toBeNull();
    expect(s.bufferStartSample).toBe(SR * 1.5);
    const [b] = s.cutAt(SR * 1.8);
    expect(b!.discard).toBe('too-short');
    expect(s.cutAt(0)).toEqual([]);
  });

  it('flush returns the remainder and reset restarts numbering', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    s.push(tone(1200));
    const [f] = s.flush();
    expect(f!.cut).toBe('flush');
    expect(f!.endSample).toBe(Math.round(1.2 * SR));
    expect(s.flush()).toEqual([]);
    s.reset(100);
    expect(s.bufferStartSample).toBe(100);
    expect(s.bufferedSamples).toBe(0);
  });

  it('review#11: quiet but modulated speech (about -46 dBFS) is not discarded; steady low noise still is', () => {
    const s = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    const n = SR * 12;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / SR);
      x[i] = 0.01 * env * Math.sin((2 * Math.PI * 200 * i) / SR);
    }
    const segs = s.push(x).concat(s.flush());
    expect(segs.length).toBeGreaterThan(0);
    expect(segs.every((g) => g.discard === null)).toBe(true);
    const quietNoise = new PcmSegmenter({ sampleRate: SR, segmentMs: 5000 });
    const hum = tone(12_000, 0.0025, 300); // 稳定 -55 dBFS，无起伏
    const noiseSegs = quietNoise.push(hum).concat(quietNoise.flush());
    expect(noiseSegs.every((g) => g.discard === 'silent')).toBe(true);
  });
});

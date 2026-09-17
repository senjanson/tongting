import { describe, expect, it } from 'vitest';
import {
  concatFloat32,
  downmixToMono,
  floatToInt16,
  int16ToFloat,
  rms,
  toDbfs,
} from '@src/audio/pcm';
import { StreamingResampler } from '@src/audio/resampler';
import { decodeWavPcm16, encodeWavPcm16, WAV_HEADER_BYTES } from '@src/audio/wav';

function sine(freq: number, rate: number, seconds: number, amp = 0.5): Float32Array {
  const n = Math.round(rate * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 用 Goertzel 估计某频率的幅度。 */
function toneAmplitude(samples: Float32Array, freq: number, rate: number): number {
  const k = (2 * Math.PI * freq) / rate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < samples.length; i++) {
    re += samples[i]! * Math.cos(k * i);
    im += samples[i]! * Math.sin(k * i);
  }
  return (2 * Math.sqrt(re * re + im * im)) / samples.length;
}

describe('pcm', () => {
  it('downmixes by averaging channels and handles missing channels', () => {
    const l = Float32Array.from([1, 0.5, -1]);
    const r = Float32Array.from([0, 0.5, 1]);
    expect(Array.from(downmixToMono([l, r]))).toEqual([0.5, 0.5, 0]);
    expect(Array.from(downmixToMono([], 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(downmixToMono([l]))).toEqual([1, 0.5, -1]);
  });

  it('converts float <-> int16 with clipping and NaN protection', () => {
    const i16 = floatToInt16(Float32Array.from([1, -1, 2, -2, 0, Number.NaN]));
    expect(Array.from(i16)).toEqual([32767, -32768, 32767, -32768, 0, 0]);
    const back = int16ToFloat(i16);
    expect(back[0]).toBeCloseTo(1, 5);
    expect(back[1]).toBeCloseTo(-1, 5);
  });

  it('computes rms / dBFS', () => {
    expect(rms(sine(440, 16000, 1, 1))).toBeCloseTo(Math.SQRT1_2, 2);
    expect(toDbfs(0)).toBe(-120);
    expect(toDbfs(1)).toBeCloseTo(0, 6);
    expect(concatFloat32([Float32Array.from([1]), Float32Array.from([2, 3])]).length).toBe(3);
  });
});

describe('StreamingResampler', () => {
  it.each([48000, 44100, 32000, 22050])(
    'keeps a 1 kHz tone at %i Hz → 16 kHz with unity gain',
    (rate) => {
      const input = sine(1000, rate, 1, 0.5);
      const rs = new StreamingResampler(rate, 16000);
      const out = concatFloat32([rs.process(input), rs.flush()]);
      expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(2);
      // 去掉两端滤波器过渡区后测量
      const mid = out.subarray(800, out.length - 800);
      expect(toneAmplitude(mid, 1000, 16000)).toBeCloseTo(0.5, 2);
    },
  );

  it('suppresses content above the output Nyquist (anti-aliasing)', () => {
    // 12 kHz 在 16 kHz 输出中会混叠到 4 kHz；带抗混叠滤波时应被强烈衰减。
    const rs = new StreamingResampler(48000, 16000);
    const out = rs.process(sine(12000, 48000, 1, 0.5));
    const mid = out.subarray(800, out.length - 800);
    const aliased = toneAmplitude(mid, 4000, 16000);
    expect(toDbfs(aliased / 0.5)).toBeLessThan(-50);
    // 对照：朴素抽取（每 3 个取 1）会产生明显混叠
    const naive = new Float32Array(16000);
    const src = sine(12000, 48000, 1, 0.5);
    for (let i = 0; i < naive.length; i++) naive[i] = src[i * 3]!;
    expect(toneAmplitude(naive, 4000, 16000)).toBeGreaterThan(0.3);
  });

  it('produces identical output for chunked and one-shot input', () => {
    const input = sine(700, 44100, 0.6, 0.3);
    const a = new StreamingResampler(44100, 16000);
    const oneShot = a.process(input);
    const b = new StreamingResampler(44100, 16000);
    const parts: Float32Array[] = [];
    for (let i = 0; i < input.length; i += 128 + (i % 7))
      parts.push(b.process(input.subarray(i, i + 128 + (i % 7))));
    const chunked = concatFloat32(parts);
    expect(chunked.length).toBe(oneShot.length);
    for (let i = 0; i < chunked.length; i++) expect(chunked[i]).toBeCloseTo(oneShot[i]!, 6);
  });

  it('maps output index to exact input position and supports reset', () => {
    const rs = new StreamingResampler(44100, 16000);
    expect(rs.inputPositionOf(16000)).toBe(44100);
    expect(rs.inputPositionOf(160)).toBeCloseTo(441, 9);
    rs.process(new Float32Array(10000));
    expect(rs.totalOutput).toBeGreaterThan(0);
    rs.reset();
    expect(rs.totalOutput).toBe(0);
    expect(rs.totalInput).toBe(0);
  });

  it('passes through when rates match and rejects invalid rates', () => {
    const rs = new StreamingResampler(16000, 16000);
    const input = sine(300, 16000, 0.1);
    expect(Array.from(rs.process(input))).toEqual(Array.from(input));
    expect(() => new StreamingResampler(0, 16000)).toThrow();
  });

  it('aligns an impulse without group delay offset', () => {
    const rate = 48000;
    const input = new Float32Array(rate);
    input[24000] = 1; // 0.5 s
    const rs = new StreamingResampler(rate, 16000);
    const out = concatFloat32([rs.process(input), rs.flush()]);
    let peak = 0;
    for (let i = 1; i < out.length; i++) if (Math.abs(out[i]!) > Math.abs(out[peak]!)) peak = i;
    expect(peak).toBe(8000);
  });
});

describe('WAV PCM16', () => {
  it('encodes an independently decodable mono 16 kHz file', () => {
    const samples = sine(440, 16000, 0.25, 0.4);
    const wav = encodeWavPcm16(samples, 16000);
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + samples.length * 2);
    const view = new DataView(wav);
    const ascii = (o: number) => String.fromCharCode(...new Uint8Array(wav, o, 4));
    expect(ascii(0)).toBe('RIFF');
    expect(ascii(8)).toBe('WAVE');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(28, true)).toBe(32000);
    const decoded = decodeWavPcm16(wav);
    expect(decoded.sampleRate).toBe(16000);
    expect(decoded.channels).toBe(1);
    expect(decoded.durationMs).toBeCloseTo(250, 5);
    for (let i = 0; i < samples.length; i += 97)
      expect(decoded.samples[i]).toBeCloseTo(samples[i]!, 3);
  });

  it('rejects malformed input and invalid sample rates', () => {
    expect(() => decodeWavPcm16(new ArrayBuffer(4))).toThrow();
    expect(() => decodeWavPcm16(new TextEncoder().encode('RIFF0000WAVEjunk').buffer)).toThrow();
    expect(() => encodeWavPcm16(new Float32Array(1), 16000.5)).toThrow();
  });
});

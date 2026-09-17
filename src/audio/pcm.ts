/**
 * PCM 基础运算：下混、能量、格式转换。全部为纯函数，便于单测。
 */

/** 识别使用的目标采样率。 */
export const ASR_SAMPLE_RATE = 16_000;

/** 将多声道平面数据平均下混为单声道。channels 为空时返回长度为 frames 的静音。 */
export function downmixToMono(channels: readonly Float32Array[], frames?: number): Float32Array {
  const length = frames ?? channels[0]?.length ?? 0;
  const out = new Float32Array(length);
  if (channels.length === 0) return out;
  if (channels.length === 1) {
    out.set(channels[0]!.subarray(0, length));
    return out;
  }
  const scale = 1 / channels.length;
  for (const ch of channels) {
    const n = Math.min(length, ch.length);
    for (let i = 0; i < n; i++) out[i]! += ch[i]! * scale;
  }
  return out;
}

/** 均方根（线性幅度）。 */
export function rms(samples: Float32Array, start = 0, end = samples.length): number {
  const s = Math.max(0, start);
  const e = Math.min(samples.length, end);
  if (e <= s) return 0;
  let sum = 0;
  for (let i = s; i < e; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / (e - s));
}

/** 线性幅度转 dBFS；0 返回 -Infinity 的替代值 -120。 */
export function toDbfs(linear: number): number {
  if (!(linear > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(linear));
}

export function dbfsToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

/** Float32 [-1, 1] → Int16，超出范围截断。 */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i]!;
    if (Number.isNaN(v)) v = 0;
    if (v > 1) v = 1;
    else if (v < -1) v = -1;
    out[i] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
  }
  return out;
}

export function int16ToFloat(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

/** 拼接多个 Float32Array。 */
export function concatFloat32(parts: readonly Float32Array[]): Float32Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function samplesToMs(samples: number, sampleRate: number): number {
  return (samples / sampleRate) * 1000;
}

export function msToSamples(ms: number, sampleRate: number): number {
  return Math.round((ms / 1000) * sampleRate);
}

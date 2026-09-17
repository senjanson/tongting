/**
 * 流式重采样器（窗函数 sinc 多相插值，带抗混叠低通）。
 *
 * - 不假设输入采样率：由调用方传入 AudioContext 实际 sampleRate。
 * - 输出第 k 个样本精确对应输入位置 k × inRate / outRate（相对最近一次 reset），
 *   因而可以由输出样本序号换算回输入帧号，用于时间映射；滤波器是对称的，不引入群延迟偏移。
 * - 降采样时截止频率取输出奈奎斯特频率的 `cutoffRatio` 倍，并用 Kaiser 窗抑制旁瓣。
 * - 分块输入与一次性输入的输出完全一致（有单测覆盖）。
 */

export interface ResamplerOptions {
  /** 每侧过零点数量，决定滤波器长度与过渡带陡峭程度。 */
  zeroCrossings?: number;
  /** 截止频率相对输出奈奎斯特频率的比例（<1 留出过渡带）。 */
  cutoffRatio?: number;
  /** Kaiser 窗 beta。 */
  kaiserBeta?: number;
  /** 多相表的相位数量。 */
  phases?: number;
}

function besselI0(x: number): number {
  // 级数展开，收敛足够快。
  let sum = 1;
  let term = 1;
  const half = x / 2;
  for (let k = 1; k < 50; k++) {
    term *= (half / k) * (half / k);
    sum += term;
    if (term < sum * 1e-12) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x;
}

export class StreamingResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  /** 约分后的整数比：输入位置 = k × inStep / outStep。 */
  private readonly inStep: number;
  private readonly outStep: number;
  private readonly halfWidth: number;
  private readonly phases: number;
  /** table[phase * taps + tap]，phase ∈ [0, phases]（多一行用于插值）。 */
  private readonly table: Float32Array;
  private readonly taps: number;
  private readonly passthrough: boolean;

  /** 缓冲区中的输入样本及其首个样本的绝对序号。 */
  private buffer = new Float32Array(0);
  private bufferStart = 0;
  private bufferLength = 0;
  /** 已接收的输入样本总数（绝对序号上界）。 */
  private inputCount = 0;
  /** 下一个输出样本序号。 */
  private outputIndex = 0;

  constructor(inputRate: number, outputRate: number, options: ResamplerOptions = {}) {
    if (
      !(inputRate > 0) ||
      !(outputRate > 0) ||
      !Number.isFinite(inputRate) ||
      !Number.isFinite(outputRate)
    ) {
      throw new RangeError('采样率必须为正数');
    }
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    // 实际 AudioContext 采样率一般为整数（44100/48000 等）；非整数时按 1e3 精度近似。
    const inInt = Math.round(inputRate * 1000);
    const outInt = Math.round(outputRate * 1000);
    const g = gcd(inInt, outInt);
    this.inStep = inInt / g;
    this.outStep = outInt / g;
    this.passthrough = this.inStep === this.outStep;

    const zeroCrossings = options.zeroCrossings ?? 16;
    const cutoffRatio = options.cutoffRatio ?? 0.9;
    const beta = options.kaiserBeta ?? 8;
    this.phases = options.phases ?? 256;
    // 截止频率（以输入采样率归一化，单位 cycles/sample）。
    const fc = 0.5 * Math.min(1, outputRate / inputRate) * cutoffRatio;
    this.halfWidth = Math.ceil(zeroCrossings / (2 * fc));
    this.taps = 2 * this.halfWidth;
    this.table = new Float32Array((this.phases + 1) * this.taps);
    const i0Beta = besselI0(beta);
    for (let p = 0; p <= this.phases; p++) {
      const frac = p / this.phases;
      let sum = 0;
      const row = p * this.taps;
      // tap j 对应输入样本 floor(pos) - halfWidth + 1 + j，距离 d = (j - halfWidth + 1) - frac。
      for (let j = 0; j < this.taps; j++) {
        const d = j - this.halfWidth + 1 - frac;
        const x = 2 * fc * d;
        const sinc = Math.abs(x) < 1e-9 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
        const r = d / (this.halfWidth + 1);
        const w = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0Beta;
        const v = 2 * fc * sinc * w;
        this.table[row + j] = v;
        sum += v;
      }
      // 归一化直流增益为 1。
      if (sum !== 0) for (let j = 0; j < this.taps; j++) this.table[row + j]! /= sum;
    }
  }

  /** 滤波器单侧长度（输入样本数），即输出需要等待的前瞻量。 */
  get lookaheadSamples(): number {
    return this.passthrough ? 0 : this.halfWidth;
  }

  /** 输出样本序号 k 对应的输入位置（相对 reset）。 */
  inputPositionOf(outputIndex: number): number {
    return (outputIndex * this.inStep) / this.outStep;
  }

  get totalInput(): number {
    return this.inputCount;
  }

  get totalOutput(): number {
    return this.outputIndex;
  }

  reset(): void {
    this.buffer = new Float32Array(0);
    this.bufferStart = 0;
    this.bufferLength = 0;
    this.inputCount = 0;
    this.outputIndex = 0;
  }

  private append(chunk: Float32Array): void {
    const needed = this.bufferLength + chunk.length;
    if (needed > this.buffer.length) {
      const next = new Float32Array(Math.max(needed, this.buffer.length * 2, 4096));
      next.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = next;
    }
    this.buffer.set(chunk, this.bufferLength);
    this.bufferLength += chunk.length;
    this.inputCount += chunk.length;
  }

  private sampleAt(absIndex: number): number {
    if (absIndex < 0 || absIndex >= this.inputCount) return 0;
    const rel = absIndex - this.bufferStart;
    if (rel < 0 || rel >= this.bufferLength) return 0;
    return this.buffer[rel]!;
  }

  private compute(outIndex: number): number {
    const num = outIndex * this.inStep;
    const base = Math.floor(num / this.outStep);
    const fracNum = num - base * this.outStep;
    const phasePos = (fracNum / this.outStep) * this.phases;
    const p0 = Math.floor(phasePos);
    const mix = phasePos - p0;
    const row0 = p0 * this.taps;
    const row1 = Math.min(this.phases, p0 + 1) * this.taps;
    const first = base - this.halfWidth + 1;
    let acc = 0;
    const rel0 = first - this.bufferStart;
    if (
      rel0 >= 0 &&
      rel0 + this.taps <= this.bufferLength &&
      first >= 0 &&
      first + this.taps <= this.inputCount
    ) {
      // 快路径：全部样本在缓冲区中。
      for (let j = 0; j < this.taps; j++) {
        const coeff = this.table[row0 + j]! + (this.table[row1 + j]! - this.table[row0 + j]!) * mix;
        acc += coeff * this.buffer[rel0 + j]!;
      }
    } else {
      for (let j = 0; j < this.taps; j++) {
        const coeff = this.table[row0 + j]! + (this.table[row1 + j]! - this.table[row0 + j]!) * mix;
        acc += coeff * this.sampleAt(first + j);
      }
    }
    return acc;
  }

  private trim(): void {
    // 下一次输出需要的最早输入样本。
    const nextBase = Math.floor((this.outputIndex * this.inStep) / this.outStep);
    const keepFrom = nextBase - this.halfWidth + 1;
    const drop = keepFrom - this.bufferStart;
    if (drop > 4096 && drop <= this.bufferLength) {
      this.buffer.copyWithin(0, drop, this.bufferLength);
      this.bufferLength -= drop;
      this.bufferStart += drop;
    }
  }

  /** 输入一块样本，返回当前可确定的输出样本。 */
  process(chunk: Float32Array): Float32Array {
    if (this.passthrough) {
      this.inputCount += chunk.length;
      this.outputIndex += chunk.length;
      return chunk.slice();
    }
    this.append(chunk);
    const out: number[] = [];
    for (;;) {
      const base = Math.floor((this.outputIndex * this.inStep) / this.outStep);
      // 需要右侧 halfWidth 个样本已经到达。
      if (base + this.halfWidth >= this.inputCount) break;
      out.push(this.compute(this.outputIndex));
      this.outputIndex++;
    }
    this.trim();
    return Float32Array.from(out);
  }

  /** 以静音补齐右侧，输出所有输入覆盖范围内的剩余样本（用于停止或断点前收尾）。 */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0);
    const out: number[] = [];
    for (;;) {
      const pos = (this.outputIndex * this.inStep) / this.outStep;
      if (pos >= this.inputCount) break;
      out.push(this.compute(this.outputIndex));
      this.outputIndex++;
    }
    return Float32Array.from(out);
  }
}

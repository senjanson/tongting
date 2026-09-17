/**
 * AudioWorklet：从捕获流取 PCM（原声增益之前的分支），下混为单声道后按块发送到主线程。
 *
 * 运行在 AudioWorkletGlobalScope，构建为独立文件（扩展 CSP 下只能从扩展自身 origin 加载，不能用 blob:）。
 * 消息：{ type: 'pcm', frame: 块首样本的 AudioContext 帧号, samples: Float32Array }（transfer）。
 * 主线程发送 { type: 'stop' } 后处理器返回 false，允许被回收。
 */

import { PCM_TAP_PROCESSOR_NAME } from './constants';

declare const currentFrame: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}
declare function registerProcessor(name: string, processorCtor: unknown): void;

interface TapOptions {
  processorOptions?: { chunkFrames?: number };
}

class PcmTapProcessor extends AudioWorkletProcessor {
  private readonly chunkFrames: number;
  private buffer: Float32Array;
  private filled = 0;
  private startFrame = 0;
  private active = true;

  constructor(options?: TapOptions) {
    super(options);
    const requested = options?.processorOptions?.chunkFrames ?? 2048;
    this.chunkFrames = Math.max(128, Math.min(16384, Math.floor(requested)));
    this.buffer = new Float32Array(this.chunkFrames);
    this.port.onmessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === 'stop') this.active = false;
    };
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const channels = inputs[0] ?? [];
    const frames = channels[0]?.length ?? 128;
    const count = channels.length;
    for (let i = 0; i < frames; i++) {
      if (this.filled === 0) this.startFrame = currentFrame + i;
      let v = 0;
      if (count === 1) v = channels[0]![i]!;
      else if (count > 1) {
        for (let c = 0; c < count; c++) v += channels[c]![i]!;
        v /= count;
      }
      this.buffer[this.filled++] = v;
      if (this.filled === this.chunkFrames) {
        const samples = this.buffer;
        this.port.postMessage({ type: 'pcm', frame: this.startFrame, samples }, [samples.buffer]);
        this.buffer = new Float32Array(this.chunkFrames);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor(PCM_TAP_PROCESSOR_NAME, PcmTapProcessor);

/**
 * WAV 编解码（PCM16）。每个分段编码为独立、完整可解码的 RIFF 文件，
 * 不依赖 MediaRecorder 的后续 chunk。
 */
import { floatToInt16, int16ToFloat } from './pcm';

export const WAV_HEADER_BYTES = 44;

/** 单声道 PCM16 WAV 编码。 */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0)
    throw new RangeError('WAV 采样率必须为正整数');
  const pcm = floatToInt16(samples);
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Int16Array(buffer, WAV_HEADER_BYTES, pcm.length).set(pcm);
  return buffer;
}

export interface DecodedWav {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** 第一声道样本。 */
  samples: Float32Array;
  durationMs: number;
}

/** 解析 PCM16 WAV（逐 chunk 查找 fmt/data，容忍额外 chunk）。格式不符时抛错。 */
export function decodeWavPcm16(buffer: ArrayBuffer): DecodedWav {
  if (buffer.byteLength < 12) throw new Error('WAV 数据过短');
  const view = new DataView(buffer);
  const ascii = (offset: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
    return s;
  };
  if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件');
  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null =
    null;
  let data: { offset: number; length: number } | null = null;
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > buffer.byteLength) throw new Error('fmt chunk 无效');
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, buffer.byteLength - body) };
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('缺少 fmt 或 data chunk');
  if (fmt.format !== 1 || fmt.bitsPerSample !== 16) throw new Error('仅支持 PCM16');
  if (fmt.channels < 1) throw new Error('声道数无效');
  const frameCount = Math.floor(data.length / (2 * fmt.channels));
  const interleaved = new Int16Array(
    buffer.slice(data.offset, data.offset + frameCount * 2 * fmt.channels),
  );
  const first = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) first[i] = interleaved[i * fmt.channels]!;
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    samples: int16ToFloat(first),
    durationMs: (frameCount / fmt.sampleRate) * 1000,
  };
}

/** 读取 WAV 头部得到时长（ms），不解码样本；无法解析时返回 undefined。 */
export function wavDurationMs(buffer: ArrayBuffer): number | undefined {
  try {
    return decodeWavPcm16(buffer).durationMs;
  } catch {
    return undefined;
  }
}

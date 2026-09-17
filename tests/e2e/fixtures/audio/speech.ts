/**
 * P0 测试音频：用 macOS `say` 生成若干英文短句，句间插入已知长度的静音，拼接为 44.1 kHz 立体声 WAV。
 * 同时返回每段静音在媒体时间轴上的区间，用于核对「捕获音频 → 媒体时间」映射误差。
 */
import { execFile } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const FFMPEG = '/opt/homebrew/bin/ffmpeg';
export const FFPROBE = '/opt/homebrew/bin/ffprobe';

export const PHRASES = [
  'The quick brown fox jumps over the lazy dog near the river bank.',
  'Real time translation needs accurate timestamps for every sentence.',
  'Audio is captured from the tab and resampled to sixteen kilohertz.',
  'Each segment is encoded as an independent wave file for recognition.',
  'When the video pauses, the dubbing must stop immediately.',
  'Seeking to a new position invalidates all pending work.',
  'Numbers like forty two and three point one four must be kept.',
  'This is the final sentence of the synthetic test recording.',
];
export const GAP_MS = 1200;

export async function toolsAvailable(): Promise<boolean> {
  try {
    await access('/usr/bin/say');
    await access(FFMPEG);
    await access(FFPROBE);
    return true;
  } catch {
    return false;
  }
}

export interface SpeechFixture {
  path: string;
  durationMs: number;
  /** 句间静音区间（媒体时间，ms）。 */
  gaps: Array<{ startMs: number; endMs: number }>;
}

async function durationMs(file: string): Promise<number> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Math.round(Number(stdout.trim()) * 1000);
}

export async function generateSpeech(dir: string): Promise<SpeechFixture> {
  const parts: string[] = [];
  const gaps: SpeechFixture['gaps'] = [];
  let cursor = 0;
  const silence = join(dir, 'gap.wav');
  await run(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=44100:cl=stereo`,
    '-t',
    String(GAP_MS / 1000),
    '-c:a',
    'pcm_s16le',
    silence,
  ]);
  for (let i = 0; i < PHRASES.length; i++) {
    const aiff = join(dir, `p${i}.aiff`);
    const wav = join(dir, `p${i}.wav`);
    await run('/usr/bin/say', ['-v', 'Samantha', '-o', aiff, PHRASES[i]!]);
    // 去掉 say 输出首尾的静音，保证静音区间只来自人为插入的 gap
    await run(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-i',
      aiff,
      '-af',
      'silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      wav,
    ]);
    const d = await durationMs(wav);
    parts.push(wav);
    cursor += d;
    if (i < PHRASES.length - 1) {
      parts.push(silence);
      gaps.push({ startMs: cursor, endMs: cursor + GAP_MS });
      cursor += GAP_MS;
    }
  }
  const list = join(dir, 'list.txt');
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  const out = join(dir, 'speech.wav');
  await run(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    list,
    '-c:a',
    'pcm_s16le',
    out,
  ]);
  return { path: out, durationMs: await durationMs(out), gaps };
}

export async function ffprobeStream(
  file: string,
): Promise<{ codec: string; sampleRate: number; channels: number; durationMs: number }> {
  const { stdout } = await run(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'stream=codec_name,sample_rate,channels:format=duration',
    '-of',
    'json',
    file,
  ]);
  const j = JSON.parse(stdout) as {
    streams: Array<{ codec_name: string; sample_rate: string; channels: number }>;
    format: { duration: string };
  };
  const s = j.streams[0]!;
  return {
    codec: s.codec_name,
    sampleRate: Number(s.sample_rate),
    channels: s.channels,
    durationMs: Math.round(Number(j.format.duration) * 1000),
  };
}

export async function readBytes(file: string): Promise<Buffer> {
  return readFile(file);
}

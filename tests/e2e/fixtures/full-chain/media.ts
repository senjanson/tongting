/**
 * 全链路夹具媒体（运行时用 ffmpeg / macOS say 生成，缓存在系统临时目录，不入库）：
 * - 长视频：黑屏 + 静音音轨，用于有字幕链路的远距离跳转（T11）。
 * - 语音视频：say 合成的清晰英文句子（句间已知静音），用于无字幕 + 真实本地识别（T03）。
 * 生成的内容全部是人工合成，不含任何真实视频或私人音频。
 */
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FFMPEG, FFPROBE, GAP_MS, PHRASES, generateSpeech } from '../audio/speech';

const run = promisify(execFile);
const CACHE_DIR = join(tmpdir(), 'tongting-e2e-full-chain-media-v1');

export async function ffmpegAvailable(): Promise<boolean> {
  try {
    await access(FFMPEG);
    await access(FFPROBE);
    return true;
  } catch {
    return false;
  }
}

export async function sayAvailable(): Promise<boolean> {
  try {
    await access('/usr/bin/say');
    return true;
  } catch {
    return false;
  }
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

/** 黑屏 + 静音的 WebM（VP8/Opus）。 */
export async function silentVideo(seconds: number): Promise<Buffer> {
  await mkdir(CACHE_DIR, { recursive: true });
  const out = join(CACHE_DIR, `silent-${seconds}s.webm`);
  try {
    return await readFile(out);
  } catch {
    // 生成
  }
  await run(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=0x202020:s=160x90:r=5:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `anullsrc=r=48000:cl=stereo`,
    '-t',
    String(seconds),
    '-c:v',
    'libvpx',
    '-b:v',
    '40k',
    '-g',
    '10',
    '-c:a',
    'libopus',
    '-b:a',
    '24k',
    '-shortest',
    out,
  ]);
  return readFile(out);
}

export interface SpeechVideo {
  file: string;
  bytes: Buffer;
  durationMs: number;
  leadInMs: number;
  /** 每句话在媒体时间轴上的区间。 */
  phrases: Array<{ text: string; startMs: number; endMs: number }>;
}

/** say 合成英文语音 + 黑屏视频（开头留 leadInMs 静音，便于先建立捕获再出声）。 */
export async function speechVideo(leadInMs = 2_000): Promise<SpeechVideo> {
  await mkdir(CACHE_DIR, { recursive: true });
  const out = join(CACHE_DIR, `speech-lead${leadInMs}.webm`);
  const meta = join(CACHE_DIR, `speech-lead${leadInMs}.json`);
  try {
    const cached = JSON.parse(await readFile(meta, 'utf8')) as Omit<SpeechVideo, 'bytes'>;
    return { ...cached, bytes: await readFile(out) };
  } catch {
    // 生成
  }
  const work = join(CACHE_DIR, `work-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const speech = await generateSpeech(work);
    const seconds = Math.ceil((speech.durationMs + leadInMs + 3_000) / 1000);
    await run(FFMPEG, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=0x103020:s=160x90:r=5:d=${seconds}`,
      '-i',
      speech.path,
      '-filter_complex',
      `[1:a]adelay=${leadInMs}|${leadInMs},apad[a]`,
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-t',
      String(seconds),
      '-c:v',
      'libvpx',
      '-b:v',
      '40k',
      '-g',
      '10',
      '-c:a',
      'libopus',
      '-b:a',
      '64k',
      '-ar',
      '48000',
      out,
    ]);
    // 由 gaps 反推每句区间（gaps 为句间静音，首句从 0 开始，末句到语音结束）。
    const phrases: SpeechVideo['phrases'] = [];
    let cursor = 0;
    for (let i = 0; i < PHRASES.length; i++) {
      const gap = speech.gaps[i];
      const end = gap ? gap.startMs : speech.durationMs;
      phrases.push({ text: PHRASES[i]!, startMs: cursor + leadInMs, endMs: end + leadInMs });
      cursor = gap ? gap.endMs : end;
    }
    const info: Omit<SpeechVideo, 'bytes'> = {
      file: out,
      durationMs: await durationMs(out),
      leadInMs,
      phrases,
    };
    await writeFile(meta, JSON.stringify(info, null, 2));
    return { ...info, bytes: await readFile(out) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export { GAP_MS, PHRASES };

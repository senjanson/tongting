/**
 * P0 本地模拟服务（只监听 127.0.0.1，不访问任何外部或付费服务）：
 * - 静态页面：播放测试语音。
 * - 本地识别服务替身：遵循 src/providers/asr/types.ts 的 HTTP 契约；与真实服务一致，不返回 CORS 头，OPTIONS 也要求令牌。
 * - 云端语音合成替身：/v1/audio/speech 返回一段 WAV。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decodeWavPcm16, encodeWavPcm16 } from '../../../../src/audio/wav';

export interface ReceivedSegment {
  index: number;
  receivedAt: number;
  bytes: number;
  file: string;
  sampleRate: number;
  durationMs: number;
  rmsDbfs: number;
  language: string | null;
}

export interface MockServers {
  pageUrl: string;
  asrBaseUrl: string;
  ttsBaseUrl: string;
  segments: ReceivedSegment[];
  requests: Array<{
    method: string;
    path: string;
    authorized: boolean;
    origin?: string;
    secFetchSite?: string;
  }>;
  inFlight(): number;
  close(): Promise<void>;
}

export const ASR_TOKEN = 'p0-local-token';
export const TTS_KEY = 'p0-fake-key-not-real';

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

export async function startMockServers(options: {
  speechWav: string;
  outDir: string;
  asrDelayMs?: number;
  ttsDelayMs?: number;
}): Promise<MockServers> {
  const segments: ReceivedSegment[] = [];
  const requests: MockServers['requests'] = [];
  let inflight = 0;
  const speech = await readFile(options.speechWav);

  const page = createServer((req, res) => {
    if (req.url === '/speech.wav') {
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': speech.length,
        'accept-ranges': 'none',
      });
      res.end(speech);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>p0 audio page</title></head><body>
<audio id="a" src="/speech.wav" preload="auto"></audio>
<script>
  const a = document.getElementById('a');
  window.__play = (volume) => { a.volume = volume ?? 1; return a.play().then(() => 'playing', (e) => 'play-failed:' + e.name); };
  window.__media = () => ({ epochMs: performance.timeOrigin + performance.now(), mediaTimeMs: a.currentTime * 1000, paused: a.paused, ended: a.ended, rate: a.playbackRate });
</script></body></html>`);
  });

  const api = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorized =
      req.headers.authorization === `Bearer ${ASR_TOKEN}` ||
      req.headers.authorization === `Bearer ${TTS_KEY}`;
    requests.push({
      method: req.method ?? '',
      path: url.pathname,
      authorized,
      origin: req.headers.origin,
      secFetchSite: req.headers['sec-fetch-site'] as string | undefined,
    });
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/health' && req.method === 'GET') {
      return json(200, {
        status: 'ok',
        ready: true,
        model: 'mock',
        device: 'cpu',
        computeType: 'int8_float32',
        version: 'p0-mock',
      });
    }
    if (!authorized)
      return json(401, { error: { code: 'unauthorized', message: 'token required' } });
    if (url.pathname === '/v1/transcribe' && req.method === 'POST') {
      inflight++;
      try {
        const body = await readBody(req);
        const index = segments.length;
        const file = join(options.outDir, `segment-${String(index).padStart(2, '0')}.wav`);
        await writeFile(file, body);
        const wav = decodeWavPcm16(new Uint8Array(body).buffer);
        let sum = 0;
        for (const v of wav.samples) sum += v * v;
        const rms = Math.sqrt(sum / Math.max(1, wav.samples.length));
        segments.push({
          index,
          receivedAt: Date.now(),
          bytes: body.length,
          file,
          sampleRate: wav.sampleRate,
          durationMs: Math.round(wav.durationMs),
          rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : -120,
          language: url.searchParams.get('language'),
        });
        await new Promise((r) => setTimeout(r, options.asrDelayMs ?? 300));
        const text = `p0 segment ${index}`;
        return json(200, {
          text,
          language: 'en',
          languageProbability: 0.99,
          durationMs: Math.round(wav.durationMs),
          processingMs: options.asrDelayMs ?? 300,
          // 段首 0 ms 开始的一个分段：映射后的 startMs 应等于该分段起点的媒体时间
          segments: [
            {
              startMs: 0,
              endMs: Math.min(1000, Math.round(wav.durationMs)),
              text,
              avgLogprob: -0.1,
              noSpeechProb: 0.01,
            },
          ],
        });
      } finally {
        inflight--;
      }
    }
    if (url.pathname === '/v1/audio/speech' && req.method === 'POST') {
      await readBody(req);
      await new Promise((r) => setTimeout(r, options.ttsDelayMs ?? 500));
      const tone = new Float32Array(16000 * 0.8);
      for (let i = 0; i < tone.length; i++)
        tone[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / 16000);
      const wavBytes = Buffer.from(encodeWavPcm16(tone, 16000));
      res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wavBytes.length });
      res.end(wavBytes);
      return;
    }
    return json(404, { error: { code: 'not_found', message: 'not found' } });
  });

  const pagePort = await listen(page);
  const apiPort = await listen(api);
  return {
    pageUrl: `http://127.0.0.1:${pagePort}/`,
    asrBaseUrl: `http://127.0.0.1:${apiPort}`,
    ttsBaseUrl: `http://127.0.0.1:${apiPort}`,
    segments,
    requests,
    inFlight: () => inflight,
    async close() {
      await Promise.all([new Promise((r) => page.close(r)), new Promise((r) => api.close(r))]);
    },
  };
}

/**
 * 视频自然结束时的识别尾段排空：结尾已播放的音频在分段缓冲或识别队列里，结束后仍要识别完。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaAnchor, OffscreenEvent } from '@src/messaging/offscreen-protocol';
import type { AsrTranscription } from '@src/providers/asr/types';
import {
  CaptureSession,
  type CaptureSessionDeps,
  type CaptureStartRequest,
} from '@src/audio/offscreen/capture-session';
import { deferred, FakeAudioContext, FakeStream, FakeWorkletNode, tone } from './fakes';

const T0 = 1_800_000_000_000;
const SR = 48000;

function anchor(p: Partial<MediaAnchor> = {}): MediaAnchor {
  return {
    epochMs: T0 + 970,
    mediaTimeMs: 60_000,
    playbackRate: 1,
    paused: false,
    seeking: false,
    buffering: false,
    ad: false,
    discontinuityId: 1,
    ...p,
  };
}

function request(): CaptureStartRequest {
  return {
    kind: 'capture/start',
    leaseId: 'lease-0001',
    owner: { sessionId: 'session-0001', tabId: 7, epoch: 1 },
    leaseTtlMs: 30_000,
    streamId: 'stream-abc',
    asr: { backend: 'local', baseUrl: 'http://127.0.0.1:8765', token: 'tok' },
    language: 'auto',
    segmentMs: 5000,
    originalVolume: 0.8,
    anchor: anchor(),
  };
}

function setup() {
  const events: OffscreenEvent[] = [];
  const ctx = new FakeAudioContext(SR);
  const stream = new FakeStream();
  const worklets: FakeWorkletNode[] = [];
  const calls: { d: ReturnType<typeof deferred<AsrTranscription>>; ms: number }[] = [];
  let id = 0;
  const now = () => T0 + ctx.currentTime * 1000 + 1000;
  const deps: CaptureSessionDeps = {
    getUserMedia: async () => stream as unknown as MediaStream,
    createAudioContext: () => ctx as unknown as AudioContext,
    createWorkletNode: (_c, name, options) => {
      const n = new FakeWorkletNode(name, options);
      worklets.push(n);
      return n as unknown as AudioWorkletNode;
    },
    workletUrl: '/w.js',
    createAsrProvider: () => ({
      kind: 'mock',
      transcribe: (wav) => {
        const d = deferred<AsrTranscription>();
        calls.push({ d, ms: ((wav.byteLength - 44) / 2 / 16000) * 1000 });
        return d.promise;
      },
      health: async () => ({ status: 'ok', ready: true }),
    }),
    emit: (e) => events.push(e),
    now,
    clock: { dateNow: now, performance: { now: () => ctx.currentTime * 1000 + 1000 } },
    randomId: (prefix) => `${prefix}${++id}`,
  };
  return { deps, events, ctx, worklets, calls, now };
}

function pump(ctx: FakeAudioContext, tap: FakeWorkletNode, audio: Float32Array) {
  let frame = 0;
  for (let i = 0; i < audio.length; i += 2048) {
    const samples = audio.slice(i, i + 2048);
    ctx.currentTime = (frame + samples.length) / SR;
    tap.deliver({ type: 'pcm', frame, samples });
    frame += samples.length;
  }
}

function join(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const texts = (events: OffscreenEvent[]) =>
  events.flatMap((e) => (e.kind === 'asr/result' ? [e.text] : []));

/** 3.5 s 语音 + 0.4 s 静音 + 结尾 2 s 语音，视频在此结束；第一段已在识别中。 */
async function playUntilEnd() {
  const env = setup();
  const s = new CaptureSession(request(), env.deps);
  await s.start();
  pump(
    env.ctx,
    env.worklets[0]!,
    join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(2000, SR)),
  );
  await vi.advanceTimersByTimeAsync(400);
  expect(env.calls).toHaveLength(1);
  // worker 收到 ended：先发结束锚点（之后的音频不属于视频），再请求排空。
  s.addAnchor(anchor({ epochMs: env.now(), mediaTimeMs: 65_900, paused: true }));
  return { ...env, s };
}

describe('CaptureSession.drain', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('视频结束后结尾 2 秒仍送识别并发出结果', async () => {
    const { s, calls, events } = await playUntilEnd();
    let drained: boolean | undefined;
    void s.drain(10_000).then((v) => (drained = v));
    await vi.advanceTimersByTimeAsync(400);
    calls[0]!.d.resolve({ text: 'first part', language: 'en', durationMs: 3700, segments: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.ms).toBeGreaterThan(1800);
    expect(drained).toBeUndefined();
    calls[1]!.d.resolve({ text: 'tail words', language: 'en', durationMs: 2000, segments: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(true);
    expect(texts(events)).toEqual(['first part', 'tail words']);
    await s.stop('stopped');
  });

  it('识别一直不返回时按期限结束，不无限等待', async () => {
    const { s } = await playUntilEnd();
    let drained: boolean | undefined;
    void s.drain(2_000).then((v) => (drained = v));
    await vi.advanceTimersByTimeAsync(1_900);
    expect(drained).toBeUndefined();
    // 期限按 deps.now 计算；本夹具的 now 不随定时器前进，另加锚点确认的 320 ms。
    await vi.advanceTimersByTimeAsync(500);
    expect(drained).toBe(false);
    await s.stop('stopped');
  });

  it('排空期间停止捕获，排空立即结束', async () => {
    const { s } = await playUntilEnd();
    let settled = false;
    void s.drain(10_000).then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(400);
    await s.stop('stopped');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
  });
});

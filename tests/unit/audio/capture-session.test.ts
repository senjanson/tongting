import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import type { MediaAnchor, OffscreenEvent } from '@src/messaging/offscreen-protocol';
import { OffscreenEventSchema } from '@src/messaging/offscreen-protocol';
import type { AsrProvider, AsrTranscription } from '@src/providers/asr/types';
import {
  CaptureSession,
  type CaptureSessionDeps,
  type CaptureStartRequest,
} from '@src/audio/offscreen/capture-session';
import { deferred, FakeAudioContext, FakeStream, FakeWorkletNode, tone } from './fakes';

const T0 = 1_800_000_000_000;
const SR = 48000;

function anchor(p: Partial<MediaAnchor> = {}): MediaAnchor {
  // 与 FakeAudioContext 的时钟一致：contextTime 0 ↔ epoch T0 + 1000 − 30（延迟补偿）↔ 媒体 60 s
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

function request(p: Partial<CaptureStartRequest> = {}): CaptureStartRequest {
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
    ...p,
  };
}

function setup(
  opts: {
    getUserMedia?: CaptureSessionDeps['getUserMedia'];
    transcribe?: AsrProvider['transcribe'];
    createAsrProvider?: CaptureSessionDeps['createAsrProvider'];
    skewMs?: number;
  } = {},
) {
  const events: OffscreenEvent[] = [];
  const ctx = new FakeAudioContext(SR);
  const stream = new FakeStream();
  const worklets: FakeWorkletNode[] = [];
  const transcribeCalls: {
    wav: ArrayBuffer;
    signal: AbortSignal;
    d: ReturnType<typeof deferred<AsrTranscription>>;
  }[] = [];
  const onEnded = vi.fn();
  let idCounter = 0;
  const deps: CaptureSessionDeps = {
    getUserMedia: opts.getUserMedia ?? (async () => stream as unknown as MediaStream),
    createAudioContext: () => ctx as unknown as AudioContext,
    createWorkletNode: (_ctx, name, options) => {
      const node = new FakeWorkletNode(name, options);
      worklets.push(node);
      return node as unknown as AudioWorkletNode;
    },
    workletUrl: '/assets/pcm-tap.worklet.js',
    createAsrProvider:
      opts.createAsrProvider ??
      (() => ({
        kind: 'mock',
        transcribe:
          opts.transcribe ??
          ((wav, o) => {
            const d = deferred<AsrTranscription>();
            transcribeCalls.push({ wav, signal: o.signal, d });
            return d.promise;
          }),
        health: async () => ({ status: 'ok', ready: true }),
      })),
    emit: (e) => {
      // 所有事件都必须满足协议 schema
      expect(OffscreenEventSchema.safeParse(e).success).toBe(true);
      events.push(e);
    },
    onEnded,
    // 跨文档 epoch 时钟（Date.now 基准）；本文档 performance 时钟可能与之相差 skewMs（系统睡眠/漂移）。
    now: () => T0 + (opts.skewMs ?? 0) + ctx.currentTime * 1000 + 1000,
    clock: {
      dateNow: () => T0 + (opts.skewMs ?? 0) + ctx.currentTime * 1000 + 1000,
      performance: { now: () => ctx.currentTime * 1000 + 1000 },
    },
    randomId: (prefix) => `${prefix}${++idCounter}`,
  };
  return { deps, events, ctx, stream, worklets, transcribeCalls, onEnded };
}

/** 以 2048 帧块向 worklet 注入 PCM，同时推进上下文时间。 */
function pump(
  ctx: FakeAudioContext,
  tap: FakeWorkletNode,
  audio: Float32Array,
  startFrame: number,
): number {
  let frame = startFrame;
  for (let i = 0; i < audio.length; i += 2048) {
    const samples = audio.slice(i, i + 2048);
    ctx.currentTime = (frame + samples.length) / SR;
    tap.deliver({ type: 'pcm', frame, samples });
    frame += samples.length;
  }
  return frame;
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

describe('CaptureSession', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('builds the graph: source → original gain → destination, and source → PCM tap (before gain)', async () => {
    const { deps, events, ctx, worklets } = setup();
    const session = new CaptureSession(request(), deps);
    await expect(session.start()).resolves.toEqual({ sampleRate: SR });
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith('/assets/pcm-tap.worklet.js');
    const source = ctx.sources[0]!;
    const gain = ctx.gains[0]!;
    const tap = worklets[0]!;
    expect(gain.gain.value).toBe(0.8);
    expect(source.connections).toEqual([gain, tap]);
    expect(gain.connections).toEqual([ctx.destination]);
    expect(tap.name).toBe('tongting-pcm-tap');
    expect(events[0]).toMatchObject({
      kind: 'capture/started',
      leaseId: 'lease-0001',
      sampleRate: SR,
    });
    expect(session.state).toBe('active');
    expect(session.activeTracks).toBe(1);
    await session.stop('stopped');
  });

  it('T14: stop during getUserMedia stops the late stream and never starts', async () => {
    const d = deferred<MediaStream>();
    const late = new FakeStream();
    const { deps, events, ctx } = setup({ getUserMedia: () => d.promise });
    const session = new CaptureSession(request(), deps);
    const started = session.start();
    await session.stop('stopped');
    d.resolve(late as unknown as MediaStream);
    await expect(started).rejects.toMatchObject({ info: { category: 'cancelled' } });
    expect(late.tracks[0]!.stop).toHaveBeenCalled();
    expect(ctx.audioWorklet.addModule).not.toHaveBeenCalled();
    expect(events.filter((e) => e.kind === 'capture/started')).toHaveLength(0);
    expect(session.activeTracks).toBe(0);
  });

  it('T14: stop while the worklet module loads releases tracks and closes the context', async () => {
    const { deps, events, ctx, stream } = setup();
    const gate = deferred<void>();
    ctx.addModuleImpl = () => gate.promise;
    const session = new CaptureSession(request(), deps);
    const started = session.start();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = session.stop('stopped');
    gate.resolve();
    await expect(started).rejects.toMatchObject({ info: { category: 'cancelled' } });
    await stopping;
    expect(stream.tracks[0]!.stop).toHaveBeenCalled();
    expect(ctx.state).toBe('closed');
    expect(ctx.sources).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it('maps permission errors from getUserMedia', async () => {
    const { deps } = setup({
      getUserMedia: async () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });
    const session = new CaptureSession(request(), deps);
    await expect(session.start()).rejects.toMatchObject({
      info: { code: 'capture-permission-denied', category: 'capture' },
    });
  });

  it('T25: track ended → capture/ended(track-ended) and all resources released', async () => {
    const { deps, events, ctx, stream, worklets, onEnded } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    stream.tracks[0]!.fireEnded();
    await vi.advanceTimersByTimeAsync(0);
    const ended = events.find((e) => e.kind === 'capture/ended');
    expect(ended).toMatchObject({ reason: 'track-ended', error: { code: 'capture-track-ended' } });
    expect(onEnded).toHaveBeenCalledWith('track-ended');
    expect(ctx.state).toBe('closed');
    expect(worklets[0]!.port.close).toHaveBeenCalled();
    expect(worklets[0]!.port.onmessage).toBeNull();
    expect(stream.tracks[0]!.listenerCount).toBe(0);
    expect(session.state).toBe('ended');
  });

  it('T26: failing cleanup steps do not prevent other releases; stop is idempotent', async () => {
    const { deps, events, ctx, stream, worklets } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    worklets[0]!.disconnect.mockImplementation(() => {
      throw new Error('disconnect failed');
    });
    ctx.closeImpl = async () => {
      throw new Error('close failed');
    };
    const first = session.stop('stopped');
    const second = session.stop('error');
    expect(second).toBe(first);
    const report = await first;
    expect(report.failed.map((f) => f.name).sort()).toEqual(['audio-context', 'worklet-node']);
    expect(stream.tracks[0]!.stop).toHaveBeenCalled();
    expect(ctx.sources[0]!.disconnect).toHaveBeenCalled();
    expect(ctx.gains[0]!.disconnect).toHaveBeenCalled();
    expect(events.filter((e) => e.kind === 'capture/ended')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'capture/ended', reason: 'stopped' });
  });

  it('turns tab PCM into mapped asr/result events (48 kHz → 16 kHz, silence cut)', async () => {
    const { deps, events, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    const tap = worklets[0]!;
    const frame = pump(
      ctx,
      tap,
      join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(2500, SR)),
      0,
    );
    // 等待锚点稳定期后送识别
    session.addAnchor(anchor({ epochMs: T0 + 970 + 8_000, mediaTimeMs: 68_000 }));
    await vi.advanceTimersByTimeAsync(400);
    expect(transcribeCalls).toHaveLength(1);
    const wav = new DataView(transcribeCalls[0]!.wav);
    expect(wav.getUint32(24, true)).toBe(16000);
    const seconds = (transcribeCalls[0]!.wav.byteLength - 44) / 32000;
    expect(seconds).toBeGreaterThan(3.5);
    expect(seconds).toBeLessThan(3.95);
    transcribeCalls[0]!.d.resolve({
      text: 'hello world',
      language: 'en',
      durationMs: seconds * 1000,
      segments: [
        { startMs: 500, endMs: 3000, text: ' hello world ', noSpeechProb: 0.01, avgLogprob: -0.2 },
        { startMs: 3000, endMs: 3400, text: 'thanks', noSpeechProb: 0.9, avgLogprob: -1.5 },
      ],
    });
    await vi.advanceTimersByTimeAsync(0);
    const results = events.filter((e) => e.kind === 'asr/result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      text: 'hello world',
      startMs: 60_500,
      endMs: 63_000,
      endEstimated: false,
      final: true,
      revision: 0,
      language: 'en',
      owner: { epoch: 1 },
    });
    const diag = session.diagnostics();
    expect(diag.chunks).toBeGreaterThan(0);
    expect(diag.maxChunkDbfs).toBeGreaterThan(-20);
    expect(diag.resultsDropped).toBe(1); // 疑似静音幻觉被过滤
    pump(ctx, tap, tone(100, SR), frame);
    await session.stop('stopped');
  });

  it('set-epoch aborts in-flight recognition and never emits old-epoch results', async () => {
    const { deps, events, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    pump(
      ctx,
      worklets[0]!,
      join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(1000, SR)),
      0,
    );
    await vi.advanceTimersByTimeAsync(400);
    expect(transcribeCalls).toHaveLength(1);
    session.setEpoch(2);
    expect(transcribeCalls[0]!.signal.aborted).toBe(true);
    transcribeCalls[0]!.d.resolve({
      text: 'stale',
      durationMs: 3000,
      segments: [{ startMs: 0, endMs: 1000, text: 'stale' }],
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter((e) => e.kind === 'asr/result')).toHaveLength(0);
    const status = events.filter((e) => e.kind === 'asr/status').at(-1);
    expect(status).toMatchObject({ owner: { epoch: 2 }, activeTracks: 1 });
    await session.stop('stopped');
  });

  it('discards empty (no speech) transcriptions without emitting a result or language', async () => {
    const { deps, events, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    pump(
      ctx,
      worklets[0]!,
      join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(1000, SR)),
      0,
    );
    await vi.advanceTimersByTimeAsync(400);
    transcribeCalls[0]!.d.resolve({
      text: '',
      language: 'en',
      languageProbability: 0.39,
      durationMs: 3700,
      segments: [],
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(events.filter((e) => e.kind === 'asr/result')).toHaveLength(0);
    await session.stop('stopped');
  });

  it('drops audio captured during an ad and during pause', async () => {
    const { deps, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    // 从 contextTime 0 开始就是广告
    session.addAnchor(anchor({ epochMs: T0 + 970, discontinuityId: 2, ad: true, mediaTimeMs: 0 }));
    pump(
      ctx,
      worklets[0]!,
      join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(1000, SR)),
      0,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(transcribeCalls).toHaveLength(0);
    expect(session.diagnostics().timelineDroppedMs.ad).toBeGreaterThan(3000);
    await session.stop('stopped');
  });

  it('set-recognition(false) keeps original audio path and stops sending; gain ramps', async () => {
    const { deps, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    session.setRecognition(false);
    pump(
      ctx,
      worklets[0]!,
      join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(1000, SR)),
      0,
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(transcribeCalls).toHaveLength(0);
    expect(ctx.gains[0]!.connections).toEqual([ctx.destination]);
    expect(session.asrState()).toBe('idle');
    session.setOriginalGain(0.3, 200);
    const param = ctx.gains[0]!.gain;
    expect(param.cancelScheduledValues).toHaveBeenCalled();
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0.3, ctx.currentTime + 0.2);
    await session.stop('stopped');
    expect(() => session.setOriginalGain(1, 0)).toThrow(AppError);
  });

  it('keeps capturing when the ASR route is invalid and reports asr/error', async () => {
    const { deps, events } = setup({
      createAsrProvider: () => {
        throw new AppError({
          code: 'asr-local-url-not-loopback',
          category: 'config',
          retryable: false,
          message: 'bad',
        });
      },
    });
    const session = new CaptureSession(request(), deps);
    await session.start();
    expect(
      events.some((e) => e.kind === 'asr/error' && e.error.code === 'asr-local-url-not-loopback'),
    ).toBe(true);
    expect(session.state).toBe('active');
    expect(session.asrState()).toBe('error');
    await session.stop('stopped');
  });

  it.each([
    ['2 hours', 2 * 3600_000],
    ['2 seconds', 2_000],
  ])(
    'maps correctly when the offscreen performance clock lags the epoch clock by %s',
    async (_label, skew) => {
      const { deps, events, ctx, worklets, transcribeCalls } = setup({ skewMs: skew });
      const session = new CaptureSession(
        request({ anchor: anchor({ epochMs: T0 + skew + 970 }) }),
        deps,
      );
      await session.start();
      pump(
        ctx,
        worklets[0]!,
        join(tone(3500, SR), new Float32Array(Math.round(0.4 * SR)), tone(2500, SR)),
        0,
      );
      session.addAnchor(anchor({ epochMs: T0 + skew + 970 + 8_000, mediaTimeMs: 68_000 }));
      await vi.advanceTimersByTimeAsync(400);
      expect(transcribeCalls).toHaveLength(1);
      transcribeCalls[0]!.d.resolve({
        text: 'hi',
        durationMs: 3700,
        segments: [{ startMs: 500, endMs: 3000, text: 'hi' }],
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(events.find((e) => e.kind === 'asr/result')).toMatchObject({
        startMs: 60_500,
        endMs: 63_000,
      });
      await session.stop('stopped');
    },
  );

  it('activeTracks reports the real readyState after release (stop() failure is visible)', async () => {
    const { deps, stream } = setup();
    stream.tracks[0]!.stop.mockImplementation(() => {
      throw new Error('stop failed');
    });
    const session = new CaptureSession(request(), deps);
    await session.start();
    await session.stop('stopped');
    expect(stream.tracks[0]!.readyState).toBe('live');
    expect(session.activeTracks).toBe(1);
    expect(session.diagnostics().trackReadyStates).toEqual(['live']);
  });

  it('reports asr-input-quiet when signal is present but always judged as no speech', async () => {
    const { deps, events, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    // 稳定的 -55 dBFS 底噪（有信号、无起伏）：不送识别
    const noise = new Float32Array(SR * 20);
    for (let i = 0; i < noise.length; i++)
      noise[i] = 0.0025 * Math.sin((2 * Math.PI * 300 * i) / SR);
    session.addAnchor(anchor({ epochMs: T0 + 970 + 30_000, mediaTimeMs: 90_000 }));
    pump(ctx, worklets[0]!, noise, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(transcribeCalls).toHaveLength(0);
    expect(session.diagnostics().quietInputMs).toBeGreaterThanOrEqual(15_000);
    expect(
      events.filter((e) => e.kind === 'asr/error' && e.error.code === 'asr-input-quiet'),
    ).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'asr/status').at(-1)).toMatchObject({
      quietInputMs: expect.any(Number),
    });
    await session.stop('stopped');
  });

  it('sends quiet but modulated speech (about -46 dBFS) to recognition', async () => {
    const { deps, ctx, worklets, transcribeCalls } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    const n = SR * 8;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4 * i) / SR);
      x[i] = 0.01 * env * Math.sin((2 * Math.PI * 200 * i) / SR);
    }
    session.addAnchor(anchor({ epochMs: T0 + 970 + 10_000, mediaTimeMs: 70_000 }));
    pump(ctx, worklets[0]!, x, 0);
    await vi.advanceTimersByTimeAsync(500);
    expect(transcribeCalls.length).toBeGreaterThan(0);
    await session.stop('stopped');
  });

  it('AudioContext statechange: suspended → clock reset + resume; unexpected close → capture/ended(error)', async () => {
    const { deps, events, ctx } = setup();
    const session = new CaptureSession(request(), deps);
    await session.start();
    ctx.fireStateChange('suspended');
    expect(ctx.resume).toHaveBeenCalled();
    expect(session.diagnostics().contextStateChanges).toEqual(['suspended']);
    ctx.fireStateChange('closed');
    await vi.advanceTimersByTimeAsync(0);
    expect(events.at(-1)).toMatchObject({
      kind: 'capture/ended',
      reason: 'error',
      error: { code: 'audio-context-closed' },
    });
    expect(ctx.stateListenerCount).toBe(0);
  });
});

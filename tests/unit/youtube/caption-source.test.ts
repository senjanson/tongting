import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@src/domain/errors';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';
import type {
  BridgeCommandResultMsg,
  BridgePlayerResponseMsg,
  BridgeTimedtextMsg,
} from '@src/youtube/bridge-client';
import { createCaptionSource, selectCaptionTrack } from '@src/youtube/caption-source';

const ORIGIN = 'https://www.youtube.com';
const A = 'AAAAAAAAAAA';
const B = 'BBBBBBBBBBB';
const json3 = readFileSync(
  resolve(import.meta.dirname, '../../fixtures/youtube/manual.json3'),
  'utf8',
);
const autoJson3 = readFileSync(
  resolve(import.meta.dirname, '../../fixtures/youtube/auto.json3'),
  'utf8',
);
const env = { __tongting: BRIDGE_TAG, dir: 'to-isolated' } as const;

const response = (
  videoId: string,
  tracks = [
    { languageCode: 'en', kind: null, name: 'English', vssId: '.en' },
    { languageCode: 'en', kind: 'asr', name: 'English (auto)', vssId: 'a.en' },
    { languageCode: 'ja', kind: null, name: '日本語', vssId: '.ja' },
  ],
): BridgePlayerResponseMsg => ({ ...env, type: 'player-response', videoId, isLive: false, tracks });

const body = (videoId: string, lang: string, text = json3, extra = ''): BridgeTimedtextMsg => ({
  ...env,
  type: 'timedtext',
  url: `${ORIGIN}/api/timedtext?v=${videoId}&lang=${lang}${extra}&signature=SECRET`,
  status: 200,
  body: text,
  via: 'xhr',
});

function setup() {
  const bridge = { loadTrack: vi.fn(), restoreCaptions: vi.fn(), requestPlayerResponse: vi.fn() };
  let id = 0;
  const onPassiveBody = vi.fn();
  const source = createCaptionSource({
    bridge,
    origin: ORIGIN,
    newId: () => `cmd${++id}`,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    onPassiveBody,
    metadataWaitMs: 1_000,
    loadTimeoutMs: 5_000,
    noCaptureGraceMs: 500,
  });
  source.setNavigation({ navigationId: 1, videoId: A });
  const result = (
    commandId: string,
    ok: boolean,
    extra: Partial<BridgeCommandResultMsg> = {},
  ): BridgeCommandResultMsg => ({
    ...env,
    type: 'command-result',
    commandId,
    ok,
    ...extra,
  });
  return { bridge, source, result, onPassiveBody };
}

/** 立即挂上处理器，避免假定时器推进期间出现未处理拒绝。 */
function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function expectCode(p: Promise<{ ok: boolean; error?: unknown }>, code: string) {
  const r = await p;
  expect(r.ok).toBe(false);
  expect(r.error).toBeInstanceOf(AppError);
  expect((r.error as AppError).info.code).toBe(code);
}

describe('selectCaptionTrack', () => {
  const tracks = [
    { trackKey: 'a.en', languageCode: 'en', label: 'auto', kind: 'asr' as const },
    { trackKey: '.en-GB', languageCode: 'en-GB', label: 'en-GB', kind: 'manual' as const },
    { trackKey: '.ja', languageCode: 'ja', label: 'ja', kind: 'manual' as const, isDefault: true },
  ];
  it('prefers exact trackKey, then manual exact/primary language, then default manual', () => {
    expect(selectCaptionTrack(tracks, { trackKey: 'a.en' })?.trackKey).toBe('a.en');
    expect(selectCaptionTrack(tracks, { trackKey: 'missing' })).toBeNull();
    expect(selectCaptionTrack(tracks, { preferredLanguage: 'en' })?.trackKey).toBe('.en-GB');
    expect(selectCaptionTrack(tracks, { preferredLanguage: 'EN-gb' })?.trackKey).toBe('.en-GB');
    expect(selectCaptionTrack(tracks, { preferredLanguage: 'auto' })?.trackKey).toBe('.ja');
    expect(selectCaptionTrack(tracks, { preferredLanguage: 'fr' })?.trackKey).toBe('.ja');
    expect(selectCaptionTrack([], {})).toBeNull();
  });
});

describe('caption source', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('only accepts metadata for the current video', () => {
    const { source } = setup();
    source.handlePlayerResponse(response(B));
    expect(source.metadata).toBeNull();
    expect(source.availability).toBe('unknown');
    source.handlePlayerResponse(response(A));
    expect(source.availability).toBe('available');
    source.handlePlayerResponse(response(A, []));
    expect(source.availability).toBe('unavailable');
  });

  it('loads a track through the player and parses the captured body', async () => {
    const { bridge, source, result } = setup();
    source.handlePlayerResponse(response(A));
    const p = source.loadTrack({ trackKey: '.en' });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.loadTrack).toHaveBeenCalledWith({
      commandId: 'cmd1',
      videoId: A,
      languageCode: 'en',
      kind: 'standard',
      vssId: '.en',
    });
    source.handleCommandResult(result('cmd1', true, { changedCaptions: true }));
    source.handleTimedtext(body(A, 'en'));
    const loaded = await p;
    expect(loaded.track.trackKey).toBe('.en');
    expect(loaded.format).toBe('json3');
    expect(loaded.complete).toBe(true);
    expect(loaded.cues.length).toBeGreaterThan(5);
    expect(JSON.stringify(loaded)).not.toContain('SECRET');
    expect(source.changedNativeCaptions).toBe(true);
    source.restoreNativeCaptions();
    expect(bridge.restoreCaptions).toHaveBeenCalledWith({ commandId: 'cmd2', videoId: A });
    expect(source.changedNativeCaptions).toBe(false);
    // 再次请求：命中缓存，不再驱动播放器。
    await expect(source.loadTrack({ trackKey: '.en' })).resolves.toBe(loaded);
    expect(bridge.loadTrack).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent loads of the same track without a boolean lock', async () => {
    const { bridge, source } = setup();
    source.handlePlayerResponse(response(A));
    const p1 = source.loadTrack({ trackKey: 'a.en' });
    const p2 = source.loadTrack({ preferredLanguage: 'en' });
    const p3 = source.loadTrack({ trackKey: 'a.en' });
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.loadTrack).toHaveBeenCalledTimes(2); // a.en 与 .en 是两条不同轨道
    source.handleTimedtext(body(A, 'en', autoJson3, '&kind=asr'));
    source.handleTimedtext(body(A, 'en'));
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(r3);
    expect(r1.track.kind).toBe('asr');
    expect(r2.track.trackKey).toBe('.en');
  });

  it('ignores bodies for other videos, other origins and YouTube auto-translations', async () => {
    const { source } = setup();
    source.handlePlayerResponse(response(A));
    const p = settle(source.loadTrack({ trackKey: '.ja' }));
    await vi.advanceTimersByTimeAsync(0);
    source.handleTimedtext(body(B, 'ja'));
    source.handleTimedtext({
      ...body(A, 'ja'),
      url: `https://evil.example/api/timedtext?v=${A}&lang=ja`,
    });
    source.handleTimedtext(body(A, 'ja', json3, '&tlang=zh-Hans'));
    expect(source.droppedBodies).toBe(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await expectCode(p, 'captions-load-timeout');
  });

  it('rejects loads with navigation-changed when the video switches mid-wait, and discards late bodies', async () => {
    const { source, bridge } = setup();
    source.handlePlayerResponse(response(A));
    const p = settle(source.loadTrack({ trackKey: '.en' }));
    await vi.advanceTimersByTimeAsync(0);
    source.setNavigation({ navigationId: 2, videoId: B });
    await expectCode(p, 'navigation-changed');
    source.handleTimedtext(body(A, 'en'));
    expect(source.droppedBodies).toBe(1); // 不属于当前导航（B）
    // A→B→A：窗口内到达的 A 正文（仍核对 v=）被新的 A 导航采用，不再驱动播放器。
    source.setNavigation({ navigationId: 3, videoId: A });
    source.handlePlayerResponse(response(A));
    await expect(source.loadTrack({ trackKey: '.en' })).resolves.toMatchObject({ navigationId: 3 });
    expect(bridge.loadTrack).toHaveBeenCalledTimes(1);
    // 超过窗口的相邻导航正文不采用。
    source.setNavigation({ navigationId: 4, videoId: B });
    source.handleTimedtext(body(A, 'ja'));
    await vi.advanceTimersByTimeAsync(6_000);
    source.setNavigation({ navigationId: 5, videoId: A });
    source.handlePlayerResponse(response(A));
    expect(source.hasBodyFor('.ja')).toBe(false);
  });

  it('maps bridge failures and parse failures to caption errors', async () => {
    const { source, result, bridge } = setup();
    source.handlePlayerResponse(response(A));
    const notFound = settle(source.loadTrack({ trackKey: '.ja' }));
    await vi.advanceTimersByTimeAsync(0);
    source.handleCommandResult(result('cmd1', false, { code: 'track-not-found' }));
    await expectCode(notFound, 'captions-track-not-found');

    const noCapture = settle(source.loadTrack({ trackKey: 'a.en' }));
    await vi.advanceTimersByTimeAsync(0);
    source.handleCommandResult(result('cmd2', false, { code: 'no-capture' }));
    await vi.advanceTimersByTimeAsync(600);
    await expectCode(noCapture, 'captions-load-timeout');

    const bad = settle(source.loadTrack({ trackKey: '.en' }));
    await vi.advanceTimersByTimeAsync(0);
    source.handleTimedtext(body(A, 'en', '<html>not captions</html>'));
    // 无法解析的正文不终止加载：改为要求桥直接做 fmt=json3 兜底；兜底也失败后报解析失败。
    expect(bridge.loadTrack).toHaveBeenLastCalledWith(
      expect.objectContaining({ commandId: 'cmd4', fetchOnly: true }),
    );
    source.handleCommandResult(result('cmd4', false, { code: 'no-capture' }));
    await vi.advanceTimersByTimeAsync(600);
    await expectCode(bad, 'captions-parse-failed');
  });

  it('R3: an unparsable passive body does not block a later load, which falls back to fetch', async () => {
    const { source, bridge } = setup();
    source.handlePlayerResponse(response(A));
    source.handleTimedtext(body(A, 'en', '<transcript><text start="0">srv1</text></transcript>'));
    const p = settle(source.loadTrack({ trackKey: '.en' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.loadTrack).toHaveBeenCalledTimes(1);
    source.handleTimedtext({ ...body(A, 'en'), via: 'bridge-fetch' });
    expect((await p).ok).toBe(true);
  });

  it('R1/R2: passive bodies never overwrite a parsed body, and same-language tracks do not share bodies', async () => {
    const { source, bridge } = setup();
    source.handlePlayerResponse(
      response(A, [
        { languageCode: 'en', kind: null, name: 'English', vssId: '.en' },
        { languageCode: 'en', kind: null, name: 'English (SDH)', vssId: '.en.sdh' },
      ]),
    );
    source.handleTimedtext(body(A, 'en'));
    source.handleTimedtext(
      body(
        A,
        'en',
        JSON.stringify({
          events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'FORGED' }] }],
        }),
      ),
    );
    const first = await source.loadTrack({ trackKey: '.en' });
    expect(first.cues[0]!.text).toBe('Welcome to the');
    const second = settle(source.loadTrack({ trackKey: '.en.sdh' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(bridge.loadTrack).toHaveBeenCalledWith(expect.objectContaining({ vssId: '.en.sdh' }));
    source.handleTimedtext(body(A, 'en', json3, '&name=sdh'));
    expect((await second).ok).toBe(true);
  });

  it('a late body within the no-capture grace period still succeeds', async () => {
    const { source, result } = setup();
    source.handlePlayerResponse(response(A));
    const p = source.loadTrack({ trackKey: '.en' });
    await vi.advanceTimersByTimeAsync(0);
    source.handleCommandResult(result('cmd1', false, { code: 'no-capture' }));
    await vi.advanceTimersByTimeAsync(200);
    source.handleTimedtext(body(A, 'en'));
    await expect(p).resolves.toMatchObject({ format: 'json3' });
  });

  it('waits for metadata, errors when there are no tracks or the bridge never answers', async () => {
    const { source, bridge } = setup();
    const noBridge = settle(source.loadTrack({}));
    await vi.advanceTimersByTimeAsync(1_100);
    await expectCode(noBridge, 'captions-bridge-unavailable');
    expect(bridge.requestPlayerResponse).toHaveBeenCalledWith(A);

    const waiting = settle(source.loadTrack({}));
    await vi.advanceTimersByTimeAsync(100);
    source.handlePlayerResponse(response(A, []));
    await expectCode(waiting, 'captions-no-tracks');
  });

  it('external cancellation stops waiting without cancelling the shared load', async () => {
    const { source } = setup();
    source.handlePlayerResponse(response(A));
    const ac = new AbortController();
    const cancelled = settle(source.loadTrack({ trackKey: '.en' }, ac.signal));
    const other = source.loadTrack({ trackKey: '.en' });
    await vi.advanceTimersByTimeAsync(0);
    ac.abort();
    await expectCode(cancelled, 'cancelled');
    source.handleTimedtext(body(A, 'en'));
    await expect(other).resolves.toMatchObject({ track: { trackKey: '.en' } });
  });

  it('reports passive page-requested bodies with their track key, but not bridge fallback fetches', () => {
    const { source, onPassiveBody } = setup();
    source.handlePlayerResponse(response(A));
    source.handleTimedtext(body(A, 'ja'));
    expect(onPassiveBody).toHaveBeenLastCalledWith({
      trackKey: '.ja',
      languageCode: 'ja',
      asr: false,
    });
    expect(source.hasBodyFor('.ja')).toBe(true);
    source.handleTimedtext({ ...body(A, 'en'), via: 'bridge-fetch' });
    expect(onPassiveBody).toHaveBeenCalledTimes(1);
  });

  it('C3: a late changedCaptions result after navigation restores native captions immediately', async () => {
    const { source, bridge, result } = setup();
    source.handlePlayerResponse(response(A));
    const p = settle(source.loadTrack({ trackKey: '.en' }));
    await vi.advanceTimersByTimeAsync(0);
    source.setNavigation({ navigationId: 2, videoId: B });
    await p;
    source.handleCommandResult(result('cmd1', true, { changedCaptions: true }));
    expect(bridge.restoreCaptions).toHaveBeenCalledWith(expect.objectContaining({ videoId: A }));
    expect(source.changedNativeCaptions).toBe(false);
  });
});

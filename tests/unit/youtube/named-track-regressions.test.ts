// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractPlayerResponse, installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';
import { BridgePlayerResponseSchema, toPlayerMetadata } from '@src/youtube/bridge-client';
import { createCaptionSource } from '@src/youtube/caption-source';

// Public MIT video's observed track shape; body and signature are synthetic, with no network.
const VIDEO = 'ZA-tUyM_y7s';
const VSS = '.en.j3PyPqV-e1s';
const NAME = 'CC (English)';
const ORIGIN = 'https://www.youtube.com';
const env = { __tongting: BRIDGE_TAG, dir: 'to-isolated' } as const;
const body = (text = 'Synthetic caption') =>
  JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 3_000, segs: [{ utf8: text }] }] });
const url = (videoId = VIDEO, name = NAME) =>
  `${ORIGIN}/api/timedtext?v=${videoId}&lang=en&name=${encodeURIComponent(name)}&signature=FAKE_SECRET`;
const rawResponse = (baseUrl = url(), videoId = VIDEO) => ({
  videoDetails: { videoId },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        {
          languageCode: 'en',
          vssId: VSS,
          name: { simpleText: 'English - CC (English)' },
          baseUrl,
        },
      ],
    },
  },
});
const metadata = (name = NAME) =>
  BridgePlayerResponseSchema.parse({
    ...env,
    ...extractPlayerResponse(rawResponse(url(VIDEO, name)))!.payload,
  });

function sourceFixture() {
  const bridge = { loadTrack: vi.fn(), restoreCaptions: vi.fn(), requestPlayerResponse: vi.fn() };
  const onPassiveBody = vi.fn();
  let id = 0;
  const source = createCaptionSource({
    bridge,
    origin: ORIGIN,
    newId: () => `named-${++id}`,
    onPassiveBody,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  });
  source.setNavigation({ navigationId: 1, videoId: VIDEO });
  source.handlePlayerResponse(metadata());
  const capture = (name = NAME, text?: string, via: 'xhr' | 'replay' = 'xhr') =>
    source.handleTimedtext({
      ...env,
      type: 'timedtext',
      url: url(VIDEO, name),
      status: 200,
      body: body(text),
      via,
    });
  return { source, bridge, onPassiveBody, capture };
}

type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;
const posted: Array<Record<string, unknown>> = [];
const nativeFetch = vi.fn(async () => new realWin.Response(body(), { status: 200 }));
realWin.fetch = nativeFetch as unknown as typeof fetch;
const win: HappyWindow = new Proxy(realWin, {
  get(target, prop) {
    if (prop === 'postMessage')
      return (data: Record<string, unknown>) => posted.push(structuredClone(data));
    if (prop === 'setTimeout') return (fn: () => void, ms: number) => setTimeout(fn, ms);
    if (prop === 'clearTimeout') return (id: ReturnType<typeof setTimeout>) => clearTimeout(id);
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' && typeof prop === 'string' && /^[a-z]/.test(prop)
      ? value.bind(target)
      : value;
  },
  set: (target, prop, value) => Reflect.set(target, prop, value, target),
});
installMainWorldBridge(win);
let sequence = 0;
let current: Record<string, unknown> | null;
let mainVideo: string;
let autoCapture: boolean;
let tracklist: Array<Record<string, unknown>>;
const setOption = vi.fn((_module: string, _option: string, value: Record<string, unknown>) => {
  current = value.languageCode ? { ...value } : null;
  if (current && autoCapture) void win.fetch(url(mainVideo, String(current.name ?? '')));
});
function send(msg: Record<string, unknown>) {
  realWin.dispatchEvent(
    new realWin.MessageEvent('message', {
      source: win as unknown as Window,
      data: { __tongting: BRIDGE_TAG, dir: 'to-main', ...msg },
    }),
  );
}
function load(owner = `named-owner-${sequence}`, commandId = `${owner}-load`) {
  send({
    type: 'load-track',
    commandId,
    ownerId: owner,
    videoId: mainVideo,
    languageCode: 'en',
    kind: 'standard',
    vssId: VSS,
  });
}
function release(owner = `named-owner-${sequence}`) {
  send({
    type: 'restore-captions',
    commandId: `${owner}-release`,
    ownerId: owner,
    videoId: mainVideo,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  posted.length = 0;
  nativeFetch.mockClear();
  setOption.mockClear();
  mainVideo = `NAMETRACK${String(++sequence).padStart(2, '0')}`;
  realWin.happyDOM.setURL(`${ORIGIN}/watch?v=${mainVideo}`);
  current = null;
  autoCapture = true;
  tracklist = [
    { languageCode: 'en', kind: '', name: NAME, vss_id: '.en.different' },
    { languageCode: 'en', kind: '', name: NAME, vss_id: VSS },
  ];
  document.body.replaceChildren();
  const root = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
  root.id = 'movie_player';
  root.getPlayerResponse = () => rawResponse(url(mainVideo), mainVideo);
  root.getOption = (_module: string, option: string) => (option === 'track' ? current : tracklist);
  root.setOption = setOption;
  document.body.append(root);
});
afterEach(async () => {
  release();
  await vi.advanceTimersByTimeAsync(0);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('opaque vssId and actual timedtext name', () => {
  it('carries only the decoded request name through the metadata trust boundary', () => {
    const extracted = extractPlayerResponse(rawResponse())!;
    expect(extracted.payload.tracks[0]).toEqual({
      languageCode: 'en',
      kind: null,
      name: 'English - CC (English)',
      vssId: VSS,
      requestName: NAME,
    });
    expect(JSON.stringify(extracted.payload)).not.toMatch(/FAKE_SECRET|baseUrl|https:/);
    expect(toPlayerMetadata(metadata()).bridgeTracks.get(VSS)?.requestName).toBe(NAME);
    for (const requestName of [123, 'x'.repeat(201)]) {
      const parsed = BridgePlayerResponseSchema.parse({
        ...metadata(),
        tracks: [{ ...metadata().tracks[0], requestName }],
      });
      expect(parsed.tracks).toEqual([]);
    }
  });

  it.each([
    url().replace(ORIGIN, 'https://untrusted.invalid'),
    url().replace('/api/timedtext', '/other'),
    url().replace(VIDEO, 'BBBBBBBBBBB'),
    url().replace('lang=en', 'lang=ja'),
    `${url()}&kind=asr`,
    `${url()}&tlang=zh`,
    url(VIDEO, 'x'.repeat(201)),
  ])('does not derive name from a mismatched or unbounded URL: %s', (baseUrl) => {
    expect(
      extractPlayerResponse(rawResponse(baseUrl))!.payload.tracks[0]!.requestName,
    ).toBeUndefined();
  });

  it('loads, caches, and reports native selection for the actual name, never the opaque suffix', async () => {
    const { source, bridge, capture, onPassiveBody } = sourceFixture();
    try {
      const pending = source.loadTrack({ trackKey: VSS });
      await vi.advanceTimersByTimeAsync(0);
      capture('j3PyPqV-e1s', 'Wrong track');
      expect(source.hasBodyFor(VSS)).toBe(false);
      capture();
      const loaded = await pending;
      expect(loaded.cues[0]!.text).toBe('Synthetic caption');
      expect(source.hasBodyFor(VSS)).toBe(true);
      expect(await source.loadTrack({ trackKey: VSS })).toBe(loaded);
      expect(bridge.loadTrack).toHaveBeenCalledTimes(1);
      onPassiveBody.mockClear();
      capture();
      expect(onPassiveBody).toHaveBeenCalledWith({ trackKey: VSS, languageCode: 'en', asr: false });
    } finally {
      source.dispose();
    }
  });

  it('uses updated request identity rather than reusing a loaded record for the same vssId', async () => {
    const { source, capture } = sourceFixture();
    try {
      capture();
      const first = await source.loadTrack({ trackKey: VSS });
      source.handlePlayerResponse(metadata('English (revised)'));
      expect(source.hasBodyFor(VSS)).toBe(false);
      capture('English (revised)', 'Revised caption');
      const second = await source.loadTrack({ trackKey: VSS });
      expect(second).not.toBe(first);
      expect(second.cues[0]!.text).toBe('Revised caption');
    } finally {
      source.dispose();
    }
  });

  it('isolates a cancelled owner and A → B → A load while accepting replay for the new owner', async () => {
    const { source, bridge, capture } = sourceFixture();
    try {
      const old = source.loadTrack({ trackKey: VSS }).then(
        () => 'resolved',
        () => 'cancelled',
      );
      await vi.advanceTimersByTimeAsync(0);
      const oldOwner = bridge.loadTrack.mock.calls[0]![0].ownerId;
      source.setNavigation({ navigationId: 2, videoId: 'BBBBBBBBBBB' });
      source.setNavigation({ navigationId: 3, videoId: VIDEO });
      source.handlePlayerResponse(metadata());
      const next = source.loadTrack({ trackKey: VSS });
      await vi.advanceTimersByTimeAsync(0);
      source.handleCaptionsChanged({
        ...env,
        type: 'captions-changed',
        ownerId: oldOwner,
        commandId: bridge.loadTrack.mock.calls[0]![0].commandId,
      });
      expect(source.changedNativeCaptions).toBe(false);
      capture(NAME, 'Replayed caption', 'replay');
      expect(await old).toBe('cancelled');
      expect((await next).cues[0]!.text).toBe('Replayed caption');
    } finally {
      source.dispose();
    }
  });

  it('captures the named player response immediately and later replays it without toggling CC', async () => {
    load();
    await vi.advanceTimersByTimeAsync(0);
    expect(setOption).toHaveBeenCalledWith('captions', 'track', tracklist[1]);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'command-result',
        commandId: `named-owner-${sequence}-load`,
        ok: true,
        fetched: false,
      }),
    );
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    release();
    setOption.mockClear();
    load(`cached-owner-${sequence}`);
    await vi.advanceTimersByTimeAsync(0);
    expect(setOption).not.toHaveBeenCalled();
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual(expect.objectContaining({ type: 'timedtext', via: 'replay' }));
    release(`cached-owner-${sequence}`);
  });

  it('supplies actual name when the player tracklist is unavailable', async () => {
    tracklist = [];
    load();
    await vi.advanceTimersByTimeAsync(0);
    expect(setOption).toHaveBeenCalledWith('captions', 'track', { languageCode: 'en', name: NAME });
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'command-result', ok: true, fetched: false }),
    );
  });

  it('ignores a different name while waiting and cancels without a late fallback or native mutation', async () => {
    autoCapture = false;
    load();
    await win.fetch(url(mainVideo, 'j3PyPqV-e1s'));
    await vi.advanceTimersByTimeAsync(0);
    expect(posted.some((msg) => msg.type === 'command-result')).toBe(false);
    release();
    expect(current).toBeNull();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(nativeFetch).toHaveBeenCalledTimes(1);
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'command-result', code: 'cancelled' }),
    );
  });
});

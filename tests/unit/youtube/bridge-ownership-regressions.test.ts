// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMainWorldBridge } from '@src/youtube/bridge/main-world';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';

type HappyWindow = Window & typeof globalThis & { happyDOM: { setURL(url: string): void } };
const realWin = document.defaultView as unknown as HappyWindow;
const posted: Array<Record<string, unknown>> = [];
const pending: Array<{ signal?: AbortSignal; resolve: (response: Response) => void }> = [];
const fetchStub = vi.fn(
  (_url: unknown, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      pending.push({ signal: init?.signal ?? undefined, resolve });
    }),
);
realWin.fetch = fetchStub as unknown as typeof fetch;
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
let videoId: string;
let track: Record<string, unknown> | null;
let failRestore: boolean;
const setOption = vi.fn((_m: string, _o: string, value: Record<string, unknown>) => {
  if (failRestore && !value.languageCode) {
    failRestore = false;
    throw new Error('temporary player failure');
  }
  track = value.languageCode ? { ...value } : null;
});
function send(msg: Record<string, unknown>) {
  realWin.dispatchEvent(
    new realWin.MessageEvent('message', {
      source: win as unknown as Window,
      data: { __tongting: BRIDGE_TAG, dir: 'to-main', ...msg },
    }),
  );
}
function load(ownerId: string, commandId = `${ownerId}-load`) {
  send({ type: 'load-track', commandId, ownerId, videoId, languageCode: 'en', kind: 'standard' });
}
function release(ownerId: string) {
  send({ type: 'restore-captions', commandId: `${ownerId}-release`, ownerId, videoId });
}

beforeEach(() => {
  vi.useFakeTimers();
  posted.length = 0;
  pending.length = 0;
  fetchStub.mockClear();
  setOption.mockClear();
  videoId = `OWNERSHIP${String(++sequence).padStart(2, '0')}`;
  realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${videoId}`);
  track = null;
  failRestore = false;
  document.body.replaceChildren();
  const root = document.createElement('div') as HTMLDivElement & Record<string, unknown>;
  root.id = 'movie_player';
  root.getPlayerResponse = () => ({
    videoDetails: { videoId },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          { languageCode: 'en', vssId: '.en', baseUrl: `/api/timedtext?v=${videoId}&lang=en` },
        ],
      },
    },
  });
  root.getOption = (_m: string, option: string) => (option === 'track' ? track : undefined);
  root.setOption = setOption;
  root.loadModule = () => undefined;
  root.unloadModule = () => undefined;
  document.body.append(root);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('R12 bridge ownership and bounded cancellation', () => {
  it('isolates A → B → A owners, including an old A release after re-entry', async () => {
    const a = videoId;
    load('aba-first');
    await vi.advanceTimersByTimeAsync(4_000);
    release('aba-first');
    videoId = 'BBBBBBBBBBB';
    realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${videoId}`);
    load('aba-middle');
    release('aba-middle');
    videoId = a;
    realWin.happyDOM.setURL(`https://www.youtube.com/watch?v=${videoId}`);
    load('aba-last');
    release('aba-first');
    pending[0]!.resolve(
      new realWin.Response('{"events":[]}', { status: 200 }) as unknown as Response,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(track?.languageCode).toBe('en');
    expect(posted.filter((m) => m.type === 'timedtext')).toHaveLength(0);
    release('aba-last');
    expect(track).toBeNull();
  });

  it('acknowledges the physical caption change before network and cancels before fallback starts', async () => {
    load('immediate');
    expect((track as Record<string, unknown> | null)?.languageCode).toBe('en');
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'captions-changed', ownerId: 'immediate' }),
    );
    expect(posted.some((m) => m.type === 'command-result')).toBe(false);
    release('immediate');
    expect(track).toBeNull();
    await vi.advanceTimersByTimeAsync(13_000);
    expect(fetchStub).not.toHaveBeenCalled();
    load('immediate', 'queued-old-command');
    expect(track).toBeNull();
  });

  it('aborts a pending fallback and ignores its late body and late release after a new owner starts', async () => {
    load('old');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pending).toHaveLength(1);
    release('old');
    expect(pending[0]!.signal?.aborted).toBe(true);
    load('new');
    expect((track as Record<string, unknown> | null)?.languageCode).toBe('en');
    pending[0]!.resolve(
      new realWin.Response('{"events":[]}', { status: 200 }) as unknown as Response,
    );
    await vi.advanceTimersByTimeAsync(0);
    release('old');
    expect((track as Record<string, unknown> | null)?.languageCode).toBe('en');
    expect(posted.filter((m) => m.type === 'timedtext')).toHaveLength(0);
    release('new');
    expect(track).toBeNull();
  });

  it('bounds an unresponsive fallback to 12 seconds and still restores its native switch', async () => {
    load('timeout');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(pending[0]!.signal?.aborted).toBe(true);
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'command-result',
        commandId: 'timeout-load',
        ok: false,
        code: 'cancelled',
      }),
    );
    release('timeout');
    expect(track).toBeNull();
  });

  it('preserves user native selection changes and retries a transient restore failure', async () => {
    load('manual');
    track = { languageCode: 'ja' };
    release('manual');
    expect(track).toEqual({ languageCode: 'ja' });
    track = null;
    load('retry');
    failRestore = true;
    release('retry');
    expect((track as Record<string, unknown> | null)?.languageCode).toBe('en');
    await vi.advanceTimersByTimeAsync(100);
    expect(track).toBeNull();
    load('next');
    await vi.advanceTimersByTimeAsync(1_500);
    expect((track as Record<string, unknown> | null)?.languageCode).toBe('en');
    release('next');
  });
});

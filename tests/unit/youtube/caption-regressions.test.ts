// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DisplayCue } from '@src/messaging/content-protocol';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';
import { createCaptionSource } from '@src/youtube/caption-source';
import { createCaptionOverlay } from '@src/youtube/overlay/overlay';
import type { OverlaySession } from '@src/youtube/overlay/cue-store';

const videoId = 'AAAAAAAAAAA';
const envelope = { __tongting: BRIDGE_TAG, dir: 'to-isolated' } as const;
const json3 = (text: string) =>
  JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: text }] }] });
const body = (languageCode: string, text = languageCode) => ({
  ...envelope,
  type: 'timedtext' as const,
  via: 'xhr' as const,
  status: 200,
  url: `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${languageCode}`,
  body: json3(text),
});
function sourceHarness() {
  const bridge = { loadTrack: vi.fn(), restoreCaptions: vi.fn(), requestPlayerResponse: vi.fn() };
  const onPassiveBody = vi.fn();
  let seq = 0;
  const source = createCaptionSource({
    bridge,
    onPassiveBody,
    origin: 'https://www.youtube.com',
    newId: () => `test${++seq}`,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  });
  source.setNavigation({ navigationId: 1, videoId });
  source.handlePlayerResponse({
    ...envelope,
    type: 'player-response',
    videoId,
    isLive: false,
    tracks: ['en', 'ja'].map((languageCode) => ({
      languageCode,
      kind: null,
      vssId: `.${languageCode}`,
      name: languageCode,
    })),
  });
  return { source, bridge, onPassiveBody };
}

describe('caption source lifecycle regressions', () => {
  it('R11: programmatic native switching is a baseline and its captured body cannot become a new user intent', async () => {
    const { source, bridge, onPassiveBody } = sourceHarness();
    source.handleCaptionSelection({
      ...envelope,
      type: 'caption-selection',
      videoId,
      languageCode: 'en',
      kind: 'standard',
      vssId: '.en',
    });
    const load = source.loadTrack({ trackKey: '.ja' });
    await Promise.resolve();
    const command = bridge.loadTrack.mock.calls[0]![0];
    source.handleCaptionsChanged({
      ...envelope,
      type: 'captions-changed',
      commandId: command.commandId,
      ownerId: command.ownerId,
    });
    source.handleTimedtext(body('ja'));
    await load;
    source.handleTimedtext({ ...body('en'), via: 'replay' });
    await source.loadTrack({ trackKey: '.en' });
    source.handleCaptionSelection({
      ...envelope,
      type: 'caption-selection',
      videoId,
      languageCode: 'ja',
      kind: 'standard',
      vssId: '.ja',
    });
    expect(onPassiveBody).not.toHaveBeenCalled();
    source.handleCaptionSelection({
      ...envelope,
      type: 'caption-selection',
      videoId,
      languageCode: 'en',
      kind: 'standard',
      vssId: '.en',
    });
    expect(onPassiveBody).toHaveBeenCalledWith({ trackKey: '.en', languageCode: 'en', asr: false });
    source.dispose();
  });

  it('R11: observing an unchanged native selection cannot undo an explicit extension track choice', async () => {
    const { source, onPassiveBody } = sourceHarness();
    const select = (lang: string) =>
      source.handleCaptionSelection({
        ...envelope,
        type: 'caption-selection',
        videoId,
        languageCode: lang,
        kind: 'standard',
        vssId: `.${lang}`,
      });
    select('en');
    source.handleTimedtext({ ...body('ja'), via: 'replay' });
    await source.loadTrack({ trackKey: '.ja' });
    select('en');
    expect(onPassiveBody).not.toHaveBeenCalled();
    select('ja');
    select('en');
    expect(onPassiveBody.mock.calls.map(([info]) => info.trackKey)).toEqual(['.ja', '.en']);
    source.dispose();
  });

  it('R12: stop while waiting for metadata rejects promptly and later metadata cannot launch a command', async () => {
    const { source, bridge } = sourceHarness();
    source.setNavigation({ navigationId: 2, videoId });
    const result = source.loadTrack({ trackKey: '.en' }).catch((e) => e);
    source.restoreNativeCaptions();
    expect((await result).info.code).toBe('cancelled');
    source.handlePlayerResponse({
      ...envelope,
      type: 'player-response',
      videoId,
      isLive: false,
      tracks: [{ languageCode: 'en', kind: null, vssId: '.en', name: 'English' }],
    });
    await Promise.resolve();
    expect(bridge.loadTrack).not.toHaveBeenCalled();
    source.dispose();
  });

  it('R11: cache reuse still reports en → ja → en without accepting replacement subtitle text', async () => {
    const { source, bridge, onPassiveBody } = sourceHarness();
    source.handleTimedtext(body('en', 'Original'));
    source.handleTimedtext(body('ja'));
    source.handleTimedtext(body('en', 'Replaced'));
    expect(onPassiveBody.mock.calls.map(([info]) => info.trackKey)).toEqual(['.en', '.ja', '.en']);
    expect((await source.loadTrack({ trackKey: '.en' })).cues[0]!.text).toBe('Original');
    source.handleCaptionSelection({
      ...envelope,
      type: 'caption-selection',
      videoId,
      languageCode: 'en',
      kind: 'standard',
      vssId: '.not-known',
    });
    expect(onPassiveBody).toHaveBeenCalledTimes(3);
    source.dispose();
    expect(bridge.restoreCaptions).not.toHaveBeenCalled();
  });

  it('R12: cleanup releases an issued owner before acknowledgement and ignores late old-owner results', async () => {
    const { source, bridge } = sourceHarness();
    const first = source.loadTrack({ trackKey: '.en' }).catch((e) => e);
    await Promise.resolve();
    const oldCommand = bridge.loadTrack.mock.calls[0]![0];
    source.restoreNativeCaptions();
    expect(bridge.restoreCaptions).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: oldCommand.ownerId }),
    );
    const second = source.loadTrack({ trackKey: '.en' });
    await Promise.resolve();
    const newCommand = bridge.loadTrack.mock.calls.at(-1)![0];
    expect(newCommand.ownerId).not.toBe(oldCommand.ownerId);
    source.handleCaptionsChanged({
      ...envelope,
      type: 'captions-changed',
      commandId: oldCommand.commandId,
      ownerId: oldCommand.ownerId,
    });
    source.handleCommandResult({
      ...envelope,
      type: 'command-result',
      commandId: oldCommand.commandId,
      ok: true,
      changedCaptions: true,
    });
    expect(source.changedNativeCaptions).toBe(false);
    expect(bridge.restoreCaptions).toHaveBeenCalledTimes(1);
    source.handleCaptionsChanged({
      ...envelope,
      type: 'captions-changed',
      commandId: newCommand.commandId,
      ownerId: newCommand.ownerId,
    });
    expect(source.changedNativeCaptions).toBe(true);
    source.handleTimedtext(body('en'));
    await expect(second).resolves.toMatchObject({ videoId });
    expect((await first).info.code).toBe('cancelled');
    source.dispose();
    expect(bridge.restoreCaptions).toHaveBeenLastCalledWith(
      expect.objectContaining({ ownerId: newCommand.ownerId }),
    );
  });
});

const overlays: Array<ReturnType<typeof createCaptionOverlay>> = [];
afterEach(() => {
  for (const overlay of overlays) overlay.destroy();
  overlays.length = 0;
});
function overlayHarness() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'movie_player';
  const video = document.createElement('video');
  root.append(video);
  document.body.append(root);
  const overlay = createCaptionOverlay({ doc: document, win: window });
  overlays.push(overlay);
  overlay.bind(root, video);
  overlay.setPageVideoId(videoId);
  const session: OverlaySession = {
    sessionId: 'regression-session',
    videoId,
    epoch: 0,
    phase: 'running',
    outputMode: 'subtitle',
    sourceMode: 'incremental-captions',
  };
  overlay.setSession(session);
  const cues: DisplayCue[] = [
    {
      id: 'late',
      revision: 0,
      startMs: 0,
      endMs: 1000,
      sourceText: 'Hello',
      translatedText: '你好',
      stability: 'final',
      translationState: 'done',
    },
  ];
  const apply = (epoch = 0, cueVersion = 1) =>
    overlay.applyCues({
      type: 'session/cues',
      sessionId: session.sessionId,
      epoch,
      cueVersion,
      full: true,
      cues,
    });
  const main = () => overlay.host?.shadowRoot?.querySelector<HTMLElement>('.main');
  return { overlay, video, session, apply, main };
}

describe('R9 incremental late display boundaries', () => {
  it('shows the first translation after its original interval, then expires it, while full-track gaps remain empty', () => {
    const { overlay, video, session, apply, main } = overlayHarness();
    video.currentTime = 2;
    apply();
    expect(main()?.textContent).toBe('你好');
    expect(main()?.hidden).toBe(false);
    video.currentTime = 9.1;
    overlay.render();
    expect(main()?.hidden).toBe(true);
    video.currentTime = 2;
    overlay.setSession({ ...session, sourceMode: 'full-track' });
    expect(main()?.hidden).toBe(true);
  });

  it('clears retained late translations on seek and on a new translation epoch, regardless of message order', () => {
    const { overlay, video, session, apply, main } = overlayHarness();
    video.currentTime = 2;
    apply();
    expect(main()?.hidden).toBe(false);
    video.currentTime = 3;
    video.dispatchEvent(new Event('seeking'));
    expect(main()?.hidden).toBe(true);
    overlay.setSession(null);
    overlay.setSession(session);
    apply();
    expect(main()?.hidden).toBe(false);
    overlay.setSession({ ...session, epoch: 1 });
    expect(main()?.hidden).toBe(true);
    overlay.setSession(null);
    overlay.setSession(session);
    apply();
    expect(main()?.hidden).toBe(false);
    apply(1, 2);
    expect(main()?.hidden).toBe(true);
  });
});

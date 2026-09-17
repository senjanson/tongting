// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import type { CaptionSettings } from '@src/domain/settings';
import type { DisplayCue } from '@src/messaging/content-protocol';
import { createCaptionOverlay } from '@src/youtube/overlay/overlay';
import type { OverlaySession } from '@src/youtube/overlay/cue-store';
import { createNativeCaptionHider } from '@src/youtube/native-captions';
import { TT_ATTRS } from '@src/youtube/selectors';

const A = 'AAAAAAAAAAA';
const settings: CaptionSettings = {
  enabled: true,
  bilingual: true,
  position: 'bottom',
  fontSizePx: 22,
  backgroundOpacity: 0.75,
  offsetMs: 0,
};
const session: OverlaySession = {
  sessionId: 'session-0001',
  epoch: 0,
  videoId: A,
  phase: 'running',
  outputMode: 'subtitle',
};

function buildPlayer() {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'movie_player';
  root.className = 'html5-video-player';
  const container = document.createElement('div');
  container.className = 'html5-video-container';
  const video = document.createElement('video');
  video.className = 'video-stream html5-main-video';
  container.appendChild(video);
  const chrome = document.createElement('div');
  chrome.className = 'ytp-chrome-bottom';
  root.append(container, chrome);
  document.body.appendChild(root);
  return { root, video };
}

const cue = (over: Partial<DisplayCue> = {}): DisplayCue => ({
  id: 'c1',
  revision: 0,
  startMs: 1_000,
  endMs: 2_000,
  sourceText: '<img src=x onerror="window.__tt_xss=1">Hello',
  translatedText: '<script>window.__tt_xss=1</script>你好',
  translationState: 'done',
  stability: 'final',
  ...over,
});

function shadowOf(host: Element | null) {
  const shadow = host?.shadowRoot;
  if (!shadow) throw new Error('no shadow root');
  return {
    main: shadow.querySelector<HTMLElement>('.main')!,
    secondary: shadow.querySelector<HTMLElement>('.secondary')!,
    badge: shadow.querySelector<HTMLElement>('.badge')!,
    caption: shadow.querySelector<HTMLElement>('.caption')!,
    shadow,
  };
}

let overlays: Array<ReturnType<typeof createCaptionOverlay>> = [];
afterEach(() => {
  for (const o of overlays) o.destroy();
  overlays = [];
});

function make() {
  const o = createCaptionOverlay({ doc: document, win: window });
  overlays.push(o);
  return o;
}

describe('caption overlay', () => {
  it('shows a late speech-recognition translation after its media time only for asr sessions', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession({ ...session, sourceMode: 'full-track' });
    o.applyCues({
      type: 'session/cues',
      sessionId: session.sessionId,
      epoch: 0,
      cueVersion: 1,
      full: true,
      cues: [cue({ sourceText: 'Hello', translatedText: '你好' })],
    });
    // 译文到达时播放位置已越过该句 2.6 s。
    video.currentTime = 4.6;
    o.render();
    const s = shadowOf(o.host);
    expect(s.main.hidden).toBe(true);
    o.setSession({ ...session, sourceMode: 'asr' });
    expect(s.main.hidden).toBe(false);
    expect(s.main.textContent).toBe('你好');
    video.currentTime = 11;
    o.render();
    expect(s.main.hidden).toBe(true);
  });

  it('mounts only while a session exists and never mounts twice', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    expect(root.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(0);
    o.setSession(session);
    o.bind(root, video);
    o.setSettings(settings);
    o.render();
    expect(root.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(1);
    expect(shadowOf(o.host).badge.textContent).toBe('同听 · 运行中');
    o.setSession({ ...session, statusText: '识别服务未配置' });
    expect(shadowOf(o.host).badge.textContent).toBe('同听 · 识别服务未配置');
    o.setSession(null);
    expect(root.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(0);
    expect(o.mounted).toBe(false);
  });

  it('renders caption text with textContent only (HTML stays literal) and follows local currentTime and offset', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession(session);
    expect(
      o.applyCues({
        type: 'session/cues',
        sessionId: session.sessionId,
        epoch: 0,
        cueVersion: 1,
        full: true,
        cues: [cue()],
      }),
    ).toBe(true);
    video.currentTime = 1.5;
    o.render();
    const s = shadowOf(o.host);
    expect(s.main.textContent).toBe('<script>window.__tt_xss=1</script>你好');
    expect(s.secondary.textContent).toBe('<img src=x onerror="window.__tt_xss=1">Hello');
    expect(s.shadow.querySelectorAll('img, script')).toHaveLength(0);
    expect((window as unknown as { __tt_xss?: number }).__tt_xss).toBeUndefined();

    o.setSettings({ ...settings, bilingual: false });
    expect(s.secondary.hidden).toBe(true);

    video.currentTime = 2.3;
    o.render();
    expect(s.main.hidden).toBe(true);
    o.setSettings({ ...settings, offsetMs: 500 }); // 延后显示 500ms：2.3s 时显示 1.8s 的字幕
    expect(s.main.hidden).toBe(false);
    expect(s.main.textContent).toContain('你好');
  });

  it('shows the real source text marked pending when there is no translation yet', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession(session);
    o.applyCues({
      type: 'session/cues',
      sessionId: session.sessionId,
      epoch: 0,
      cueVersion: 1,
      full: true,
      cues: [cue({ translatedText: undefined, translationState: 'running', stability: 'interim' })],
    });
    video.currentTime = 1.2;
    o.render();
    const s = shadowOf(o.host);
    expect(s.main.textContent).toBe('<img src=x onerror="window.__tt_xss=1">Hello');
    expect(s.main.dataset.pending).toBe('running');
    expect(s.main.dataset.interim).toBe('');
    expect(s.secondary.hidden).toBe(true);
  });

  it('hides captions during ads, when disabled, and when the session belongs to another video', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession(session);
    o.applyCues({
      type: 'session/cues',
      sessionId: session.sessionId,
      epoch: 0,
      cueVersion: 1,
      full: true,
      cues: [cue()],
    });
    video.currentTime = 1.5;
    o.render();
    const s = shadowOf(o.host);
    expect(s.main.hidden).toBe(false);
    o.setAd(true);
    expect(s.main.hidden).toBe(true);
    o.setAd(false);
    expect(s.main.hidden).toBe(false);
    o.setPageVideoId('BBBBBBBBBBB');
    expect(o.mounted).toBe(false); // 会话属于其他视频：整个覆盖层（含状态标签）都不显示
    o.setPageVideoId(A);
    expect(o.mounted).toBe(true);
    o.setSettings({ ...settings, enabled: false });
    expect(o.host!.hidden).toBe(true);
  });

  it('drops stale cue messages and keeps rendering after a reconnect baseline reset', () => {
    const { root, video } = buildPlayer();
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession(session);
    o.applyCues({
      type: 'session/cues',
      sessionId: session.sessionId,
      epoch: 0,
      cueVersion: 5,
      full: true,
      cues: [cue()],
    });
    expect(
      o.applyCues({
        type: 'session/cues',
        sessionId: session.sessionId,
        epoch: 0,
        cueVersion: 4,
        full: true,
        cues: [],
      }),
    ).toBe(false);
    expect(
      o.applyCues({
        type: 'session/cues',
        sessionId: 'old-session-x',
        epoch: 9,
        cueVersion: 99,
        full: true,
        cues: [],
      }),
    ).toBe(false);
    o.resetVersionBaseline();
    expect(
      o.applyCues({
        type: 'session/cues',
        sessionId: session.sessionId,
        epoch: 0,
        cueVersion: 1,
        full: false,
        cues: [cue({ revision: 1, translatedText: '新译文' })],
      }),
    ).toBe(true);
    video.currentTime = 1.1;
    o.render();
    expect(shadowOf(o.host).main.textContent).toBe('新译文');
  });

  it('moves with the player root, removes stale hosts and adapts bottom offset to the control bar', () => {
    const { root, video } = buildPlayer();
    const stale = document.createElement('div');
    stale.setAttribute(TT_ATTRS.overlayHost, '');
    root.appendChild(stale);
    const o = make();
    o.bind(root, video);
    o.setPageVideoId(A);
    o.setSettings(settings);
    o.setSession(session);
    expect(root.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(1);
    expect(stale.isConnected).toBe(false);
    expect(o.host!.style.getPropertyValue('--tt-bottom')).toBe('64px');
    root.classList.add('ytp-autohide');
    o.updateLayout();
    expect(o.host!.style.getPropertyValue('--tt-bottom')).toBe('24px');
    o.setSettings({ ...settings, position: 'top' });
    expect(shadowOf(o.host).caption.dataset.position).toBe('top');

    const next = buildPlayer();
    o.bind(next.root, next.video);
    expect(next.root.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(1);
    o.destroy();
    expect(document.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(0);
    o.setSession(session);
    expect(document.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)).toHaveLength(0);
  });
});

describe('native caption hider', () => {
  it('scopes hiding to an attribute on the player root and cleans up', () => {
    const { root } = buildPlayer();
    const other = document.createElement('div');
    document.body.appendChild(other);
    const h = createNativeCaptionHider(document);
    h.set(root, true);
    expect(root.hasAttribute(TT_ATTRS.hideNative)).toBe(true);
    const style = document.querySelector(`style[${TT_ATTRS.nativeStyle}]`)!;
    expect(style.textContent).toBe(
      `[${TT_ATTRS.hideNative}] .ytp-caption-window-container{visibility:hidden !important;}`,
    );
    h.set(other, true);
    expect(root.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
    h.set(other, false);
    expect(other.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
    h.set(root, true);
    h.dispose();
    h.dispose();
    expect(root.hasAttribute(TT_ATTRS.hideNative)).toBe(false);
    expect(document.querySelector(`style[${TT_ATTRS.nativeStyle}]`)).toBeNull();
  });
});

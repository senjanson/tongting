/**
 * 翻译字幕覆盖层。
 *
 * - Shadow DOM（open，便于自动化测试检查；其中不含任何敏感数据），宿主挂在实际播放器根节点内，全屏时仍在全屏子树中；
 * - pointer-events: none，不拦截播放器操作；控制栏显示时抬高底部偏移，自动隐藏后回落；
 * - 只用 textContent 渲染字幕文本，禁止 innerHTML；
 * - 按本地 video.currentTime（减去 offsetMs）用 findActiveCue 选中当前字幕，播放时用 rAF 刷新，不依赖逐帧消息；
 * - 只在当前页面视频的会话存在时挂载；广告播放、显示关闭时不显示字幕；没有真实字幕时只显示状态标签；
 * - 外观主题（settings.uiTheme）写在 .stage 的 data-theme 上，只切换 CSS，不重建 DOM、不影响字幕选择。
 */
import { createDisplaySelector } from './display-select';
import type { CaptionSettings, UiThemePreference } from '../../domain/settings';
import type { SessionPhase } from '../../domain/session';
import { TT_ATTRS, areControlsHidden, chromeBottomHeight } from '../selectors';
import {
  createCueStore,
  type CueStore,
  type OverlaySession,
  type SessionCuesMsg,
} from './cue-store';
import { OVERLAY_CSS } from './styles';
import { t, type MessageKey } from '../../i18n';

export interface CaptionOverlayOptions {
  doc: Document;
  win: Window;
}

export interface CaptionOverlay {
  /** 绑定（或重新绑定）到播放器根节点与 video；幂等，不会重复挂载。 */
  bind(root: HTMLElement | null, video: HTMLVideoElement | null): void;
  setSettings(settings: CaptionSettings): void;
  /** 外观主题；auto 按纸墨外观显示。只改样式属性，不触发重新选择字幕。 */
  setTheme(theme: UiThemePreference): void;
  setSession(session: OverlaySession | null): void;
  applyCues(msg: SessionCuesMsg): boolean;
  /** 当前页面的视频身份（导航后更新）；会话属于其他视频时不显示字幕。 */
  setPageVideoId(videoId: string | null): void;
  setAd(ad: boolean): void;
  /** 控制栏显示/隐藏、全屏变化后重新计算位置。 */
  updateLayout(): void;
  /** worker 重连后，下一条 session/cues 重新建立版本基线。 */
  resetVersionBaseline(): void;
  render(): void;
  readonly store: CueStore;
  readonly mounted: boolean;
  readonly host: HTMLElement | null;
  destroy(): void;
}

/** 字幕层实际使用的外观。 */
export type OverlayTheme = Exclude<UiThemePreference, 'auto'>;

/**
 * auto 固定使用纸墨外观：字幕层叠在视频画面上，画面明暗与页面/系统的明暗模式无关，
 * 因此不查询 prefers-color-scheme。
 */
export function resolveOverlayTheme(theme: UiThemePreference): OverlayTheme {
  return theme === 'auto' ? 'paper' : theme;
}

/** 强制下一次 render 重新写入 DOM 的哨兵值（不会与 cue key 冲突）。 */
const FORCE_RENDER = '#force';

const PHASE_LABEL: Record<SessionPhase, MessageKey> = {
  idle: 'background.overlay.phase.idle',
  configuring: 'background.overlay.phase.configuring',
  starting: 'background.overlay.phase.starting',
  running: 'background.overlay.phase.running',
  pausing: 'background.overlay.phase.pausing',
  paused: 'background.overlay.phase.paused',
  stopping: 'background.overlay.phase.stopping',
  error: 'background.overlay.phase.error',
};

export function createCaptionOverlay(opts: CaptionOverlayOptions): CaptionOverlay {
  const { doc, win } = opts;
  const store = createCueStore();
  const selector = createDisplaySelector();
  let settings: CaptionSettings = {
    enabled: true,
    bilingual: true,
    position: 'bottom',
    fontSizePx: 22,
    backgroundOpacity: 0.75,
    offsetMs: 0,
  };
  let root: HTMLElement | null = null;
  let video: HTMLVideoElement | null = null;
  let pageVideoId: string | null = null;
  let ad = false;
  let destroyed = false;
  let theme: OverlayTheme = 'paper';

  let host: HTMLElement | null = null;
  let stageEl: HTMLElement | null = null;
  let captionEl: HTMLElement | null = null;
  let plateEl: HTMLElement | null = null;
  let mainEl: HTMLElement | null = null;
  let secondaryEl: HTMLElement | null = null;
  let badgeEl: HTMLElement | null = null;
  let brandEl: HTMLElement | null = null;
  let labelEl: HTMLElement | null = null;

  let videoAbort: AbortController | null = null;
  let rootObserver: MutationObserver | null = null;
  let rafId: number | undefined;
  let lastRenderKey = '';
  let lateAfterMs = -Infinity;

  const ensureHost = () => {
    if (host) return host;
    host = doc.createElement('div');
    host.setAttribute(TT_ATTRS.overlayHost, '');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = OVERLAY_CSS;
    const stage = doc.createElement('div');
    stage.className = 'stage';
    stage.dataset.theme = theme;
    stageEl = stage;
    badgeEl = doc.createElement('div');
    badgeEl.className = 'badge';
    badgeEl.setAttribute('part', 'badge');
    // 品牌标记：纯 CSS 的四条声波竖条（空元素，不含文本、不用 SVG/图片）。
    const mark = doc.createElement('span');
    mark.className = 'mark';
    mark.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < 4; i++) {
      const bar = doc.createElement('span');
      bar.className = 'bar';
      mark.appendChild(bar);
    }
    brandEl = doc.createElement('span');
    brandEl.className = 'brand';
    labelEl = doc.createElement('span');
    labelEl.className = 'label';
    badgeEl.append(mark, brandEl, labelEl);
    captionEl = doc.createElement('div');
    captionEl.className = 'caption';
    captionEl.setAttribute('role', 'presentation');
    // 底板：纸墨/夜墨主题下两行共用一块底色；两行都没有内容时隐藏，避免留下空底板。
    plateEl = doc.createElement('div');
    plateEl.className = 'plate';
    plateEl.hidden = true;
    mainEl = doc.createElement('div');
    mainEl.className = 'line main';
    mainEl.hidden = true;
    secondaryEl = doc.createElement('div');
    secondaryEl.className = 'line secondary';
    secondaryEl.hidden = true;
    plateEl.append(mainEl, secondaryEl);
    captionEl.append(plateEl);
    stage.append(badgeEl, captionEl);
    shadow.append(style, stage);
    return host;
  };

  /**
   * 状态标签：品牌名与状态分开着色。文案整体来自 i18n（background.overlay.badge），
   * 以 {label} 结尾时把末尾的状态单独放进 .label；否则整句放进 .brand。textContent 始终是完整文案。
   */
  const setBadge = (label: string) => {
    if (!brandEl || !labelEl) return;
    const text = t('background.overlay.badge', { label });
    const split = label && text.endsWith(label) ? text.length - label.length : text.length;
    const brand = text.slice(0, split);
    const status = text.slice(split);
    if (brandEl.textContent !== brand) brandEl.textContent = brand;
    if (labelEl.textContent !== status) labelEl.textContent = status;
  };

  const stopLoop = () => {
    if (rafId !== undefined) win.cancelAnimationFrame(rafId);
    rafId = undefined;
  };

  // 会话必须属于当前页面视频：导航后 worker 尚未更新会话时，不在新视频上显示旧会话的状态标签。
  const shouldMount = () =>
    !destroyed && !!root && store.session !== null && store.session.videoId === pageVideoId;

  const placeHost = () => {
    if (!shouldMount()) {
      host?.remove();
      stopLoop();
      return;
    }
    const el = ensureHost();
    // 全屏元素包含 video 但不包含播放器根节点时（少见），挂到全屏元素内。
    const fs = doc.fullscreenElement;
    let parent: Element = root!;
    if (
      fs &&
      !(fs instanceof HTMLVideoElement) &&
      video &&
      fs.contains(video) &&
      !fs.contains(root!)
    )
      parent = fs;
    // 清理其他实例遗留的宿主，保证只有一层覆盖。
    for (const stale of parent.querySelectorAll(`[${TT_ATTRS.overlayHost}]`)) {
      if (stale !== el) stale.remove();
    }
    if (el.parentElement !== parent) parent.appendChild(el);
  };

  const sessionMatchesPage = () => {
    const s = store.session;
    return !!s && s.videoId === pageVideoId;
  };

  const applyStyleVars = () => {
    if (!host) return;
    host.style.setProperty('--tt-font-size', `${settings.fontSizePx}px`);
    host.style.setProperty('--tt-bg-opacity', String(settings.backgroundOpacity));
    const hidden = areControlsHidden(root);
    const bottom = hidden ? 24 : chromeBottomHeight(root) + 16;
    host.style.setProperty('--tt-bottom', `${bottom}px`);
    if (captionEl) captionEl.dataset.position = settings.position;
  };

  const setText = (el: HTMLElement | null, text: string | null) => {
    if (!el) return;
    if (text) {
      if (el.textContent !== text) el.textContent = text;
      el.hidden = false;
    } else {
      el.textContent = '';
      el.hidden = true;
    }
  };

  const currentSelection = () => {
    if (!video) return undefined;
    const t = video.currentTime;
    if (!Number.isFinite(t)) return undefined;
    return selector.select(store.cues, t * 1000 - settings.offsetMs, (id) => store.get(id), {
      late:
        store.session?.sourceMode === 'asr' || store.session?.sourceMode === 'incremental-captions',
      lateAfterMs,
    });
  };

  const render = () => {
    if (!host || !host.isConnected) return;
    const session = store.session;
    const visible = settings.enabled && !!session;
    host.hidden = !visible;
    if (!visible || !session) return;

    setBadge(session.statusText?.trim() || t(PHASE_LABEL[session.phase]));

    const selection = !ad && sessionMatchesPage() ? currentSelection() : undefined;
    const cue = selection?.cue;
    const key = cue
      ? `${cue.id}:${cue.revision}:${cue.translationState}:${cue.stability}:${settings.bilingual}:${selection.held}:${cue.translatedText ?? ''}`
      : '';
    if (key === lastRenderKey) return;
    lastRenderKey = key;
    if (!cue) {
      setText(mainEl, null);
      setText(secondaryEl, null);
      if (plateEl) plateEl.hidden = true;
      return;
    }
    const translated = cue.translatedText?.trim();
    if (translated) {
      setText(mainEl, translated);
      setText(secondaryEl, settings.bilingual ? cue.sourceText : null);
      delete mainEl!.dataset.pending;
    } else {
      // 尚无译文：显示真实原文并标记为待翻译（不是占位假字幕）。
      setText(mainEl, cue.sourceText);
      setText(secondaryEl, null);
      mainEl!.dataset.pending = cue.translationState;
    }
    if (cue.stability === 'interim') mainEl!.dataset.interim = '';
    else delete mainEl!.dataset.interim;
    if (selection.held) mainEl!.dataset.held = '';
    else delete mainEl!.dataset.held;
    if (plateEl) plateEl.hidden = !!mainEl?.hidden && !!secondaryEl?.hidden;
  };

  const loop = () => {
    rafId = undefined;
    if (destroyed || !host?.isConnected || !video || video.paused) return;
    render();
    rafId = win.requestAnimationFrame(loop);
  };

  const startLoop = () => {
    if (rafId !== undefined || !video || video.paused || !host?.isConnected) return;
    rafId = win.requestAnimationFrame(loop);
  };

  const refresh = () => {
    lastRenderKey = FORCE_RENDER;
    placeHost();
    applyStyleVars();
    render();
    startLoop();
  };

  const bindVideo = (next: HTMLVideoElement | null) => {
    if (next === video) return;
    videoAbort?.abort();
    videoAbort = null;
    stopLoop();
    video = next;
    if (!video) return;
    videoAbort = new AbortController();
    const signal = videoAbort.signal;
    const onChange = (event: Event) => {
      if (event.type === 'seeking') {
        selector.reset();
        lateAfterMs = video!.currentTime * 1000 - settings.offsetMs;
      }
      lastRenderKey = FORCE_RENDER;
      render();
      startLoop();
    };
    for (const type of [
      'play',
      'playing',
      'pause',
      'seeked',
      'seeking',
      'timeupdate',
      'ratechange',
      'emptied',
      'loadedmetadata',
    ]) {
      video.addEventListener(type, onChange, { signal });
    }
  };

  const bindRoot = (next: HTMLElement | null) => {
    if (next === root) return;
    rootObserver?.disconnect();
    rootObserver = null;
    root = next;
    if (!root) return;
    rootObserver = new MutationObserver(() => {
      applyStyleVars();
    });
    rootObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
  };

  const fsAbort = new AbortController();
  doc.addEventListener('fullscreenchange', () => refresh(), { signal: fsAbort.signal });

  return {
    store,
    get mounted() {
      return !!host?.isConnected;
    },
    get host() {
      return host;
    },
    bind(nextRoot, nextVideo) {
      if (destroyed) return;
      bindRoot(nextRoot);
      bindVideo(nextVideo);
      refresh();
    },
    setSettings(next) {
      settings = { ...next };
      refresh();
    },
    setTheme(next) {
      if (destroyed) return;
      theme = resolveOverlayTheme(next);
      // 宿主尚未创建时，ensureHost 按当前主题创建；主题不影响字幕选择，无需重新渲染。
      if (stageEl && stageEl.dataset.theme !== theme) stageEl.dataset.theme = theme;
    },
    setSession(session) {
      const previous = store.session;
      if (previous?.sessionId !== session?.sessionId) {
        selector.reset();
        lateAfterMs = -Infinity;
      } else if (previous?.epoch !== session?.epoch) {
        selector.reset();
        lateAfterMs = video ? video.currentTime * 1000 - settings.offsetMs : -Infinity;
      }
      store.setSession(session);
      refresh();
    },
    applyCues(msg) {
      const previousEpoch = store.session?.epoch;
      const ok = store.applyCues(msg);
      if (ok) {
        if (previousEpoch !== store.session?.epoch) {
          selector.reset();
          lateAfterMs = video ? video.currentTime * 1000 - settings.offsetMs : -Infinity;
        }
        refresh();
      }
      return ok;
    },
    setPageVideoId(videoId) {
      if (pageVideoId !== videoId) {
        selector.reset();
        lateAfterMs = -Infinity;
      }
      pageVideoId = videoId;
      refresh();
    },
    setAd(next) {
      if (ad === next) return;
      ad = next;
      refresh();
    },
    updateLayout() {
      refresh();
    },
    resetVersionBaseline() {
      store.resetVersionBaseline();
    },
    render() {
      refresh();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopLoop();
      videoAbort?.abort();
      rootObserver?.disconnect();
      fsAbort.abort();
      host?.remove();
      host = null;
      stageEl = null;
      store.clear();
    },
  };
}

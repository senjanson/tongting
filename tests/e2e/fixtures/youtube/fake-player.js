/* global document, window, location, history, XMLHttpRequest, CustomEvent, URL */
// 人工构造的「假 movie_player API」，模拟 YouTube 播放器在 MAIN world 中暴露的少量方法，
// 以及 SPA 导航事件、原生字幕渲染、广告 class 与 video 元素替换。仅用于 E2E，待与真实页面核对。
//
// 模拟的播放器行为（均为推断，未与真实 YouTube 逐项核对）：
// - 目标轨道已激活时 setOption 同一轨道不会重新请求 timedtext（先关再开才会重新请求）。
// - 自动翻译：轨道选项带 translationLanguage 时请求带 &tlang=，服务端返回译文正文。
// - PLAYER_OPTIONS.captionsDefault：页面加载（或播放器就绪）后立即按用户偏好打开字幕并请求正文，早于内容脚本就绪。
// - PLAYER_OPTIONS.initDelayMs：播放器 API（getPlayerResponse 等）延迟出现。
// - getOption('captions', 'track') 反映实际开关与轨道（关闭时为 {}）；tracklist 在字幕模块未加载时为空数组。
// - 字幕开关与所选语言是跨视频保留的用户偏好：SPA 导航不重置，新视频有同语言轨道时自动请求其正文。
// - 视频的 nativeCues：timedtext 返回空正文时播放器仍能渲染的字幕（模拟扩展拿不到正文、只能读取显示字幕的情况）。
// full-chain 夹具会整体替换 VIDEOS 与 PLAYER_OPTIONS 两个常量。
(() => {
  const VIDEOS = {
    AAAAAAAAAAA: {
      title: 'Fixture Video A',
      lengthSeconds: 20,
      tracks: [
        { lang: 'en', kind: null, name: 'English', vss: '.en' },
        { lang: 'en', kind: 'asr', name: 'English (auto-generated)', vss: 'a.en' },
      ],
    },
    BBBBBBBBBBB: { title: 'Fixture Video B', lengthSeconds: 20, tracks: [] },
  };
  const PLAYER_OPTIONS = { initDelayMs: 0, captionsDefault: null };

  const app = document.getElementById('app');
  const player = document.getElementById('movie_player');
  const captionContainer = player.querySelector('.ytp-caption-window-container');
  const state = {
    calls: [],
    ready: false,
    moduleLoaded: false,
    captionsOn: false,
    track: null,
    /** 跨视频保留的用户字幕偏好：{ languageCode, kind, translationLanguage } 或 null。 */
    preferred: null,
    cues: [],
    timedtextRequests: 0,
    timedtextLog: [],
  };
  window.__fixture = state;

  const currentVideoId = () => new URL(location.href).searchParams.get('v');
  const video = () => player.querySelector('video');
  const isAsr = (k) => k === 'asr';

  function playerResponse() {
    const id = currentVideoId();
    const v = VIDEOS[id];
    if (!v) return null;
    return {
      videoDetails: {
        videoId: id,
        title: v.title,
        author: 'Fixture Channel',
        lengthSeconds: String(v.lengthSeconds || 20),
        isLive: false,
      },
      captions: v.tracks.length
        ? {
            playerCaptionsTracklistRenderer: {
              captionTracks: v.tracks.map((t) => ({
                baseUrl: `https://www.youtube.com/api/timedtext?v=${id}&lang=${t.lang}${t.kind ? `&kind=${t.kind}` : ''}&signature=FIXTURESIG`,
                name: { simpleText: t.name },
                vssId: t.vss,
                languageCode: t.lang,
                ...(t.kind ? { kind: t.kind } : {}),
              })),
            },
          }
        : undefined,
    };
  }

  function findTrack(languageCode, kind) {
    const v = VIDEOS[currentVideoId()];
    if (!v) return null;
    return (
      v.tracks.find((t) => t.lang === languageCode && isAsr(t.kind) === isAsr(kind)) ||
      (kind === undefined ? v.tracks.find((t) => t.lang === languageCode) : null) ||
      null
    );
  }

  function trackOption(t, translationLanguage) {
    return {
      languageCode: t.lang,
      kind: t.kind || '',
      name: t.name,
      vss_id: t.vss,
      ...(translationLanguage ? { translationLanguage: { ...translationLanguage } } : {}),
    };
  }

  function renderCaptions() {
    captionContainer.replaceChildren();
    if (!state.captionsOn) return;
    const t = (video()?.currentTime ?? 0) * 1000;
    const cue = state.cues.find((c) => c.start <= t && t < c.end);
    if (!cue) return;
    const win = document.createElement('div');
    win.className = 'caption-window';
    const line = document.createElement('span');
    line.className = 'caption-visual-line';
    const seg = document.createElement('span');
    seg.className = 'ytp-caption-segment';
    seg.textContent = cue.text;
    line.append(seg);
    win.append(line);
    captionContainer.append(win);
  }

  function requestTrack(track) {
    const id = currentVideoId();
    const xhr = new XMLHttpRequest();
    const kind = track.kind === 'asr' ? '&kind=asr' : '';
    const tlang = track.translationLanguage?.languageCode
      ? `&tlang=${encodeURIComponent(track.translationLanguage.languageCode)}`
      : '';
    // 模拟播放器生成的 pot 与签名参数；夹具服务端只在带 pot 时返回正文。
    xhr.open(
      'GET',
      `/api/timedtext?v=${id}&lang=${track.languageCode}${kind}${tlang}&fmt=json3&pot=FIXTUREPOT&signature=FIXTURESIG`,
    );
    state.timedtextLog.push({
      videoId: id,
      lang: track.languageCode,
      tlang: tlang ? track.translationLanguage.languageCode : null,
    });
    xhr.onload = () => {
      if (currentVideoId() !== id) return;
      state.timedtextRequests++;
      let parsed;
      try {
        const data = JSON.parse(xhr.responseText);
        parsed = (data.events || [])
          .filter((e) => e.segs)
          .map((e) => ({
            start: e.tStartMs,
            end: e.tStartMs + (e.dDurationMs || 2000),
            text: e.segs.map((s) => s.utf8).join(''),
          }));
      } catch {
        parsed = [];
      }
      const native = VIDEOS[id]?.nativeCues;
      state.cues =
        parsed.length || !native
          ? parsed
          : native.map((c) => ({ start: c.startMs, end: c.startMs + c.durationMs, text: c.text }));
      renderCaptions();
    };
    xhr.send();
  }

  /** 按跨视频保留的偏好为当前视频选择轨道（播放器就绪或 SPA 导航后调用）。 */
  function applyPreference() {
    state.cues = [];
    const pref = state.preferred;
    const t = pref ? findTrack(pref.languageCode, pref.kind) : null;
    if (!pref || !t) {
      // 偏好保留，但当前视频没有该语言轨道：不显示字幕。
      state.captionsOn = false;
      state.track = null;
      renderCaptions();
      return;
    }
    state.moduleLoaded = true;
    state.captionsOn = true;
    state.track = trackOption(t, pref.translationLanguage);
    requestTrack(state.track);
  }

  function installApi() {
    player.getPlayerResponse = playerResponse;
    player.loadModule = (m) => {
      state.calls.push(['loadModule', m]);
      if (m === 'captions') state.moduleLoaded = true;
    };
    player.unloadModule = (m) => {
      state.calls.push(['unloadModule', m]);
      if (m !== 'captions') return;
      state.moduleLoaded = false;
      state.captionsOn = false;
      state.track = null;
      state.preferred = null;
      renderCaptions();
    };
    player.getOption = (m, o) => {
      if (m !== 'captions') return undefined;
      if (o === 'track') {
        return state.moduleLoaded && state.captionsOn && state.track
          ? JSON.parse(JSON.stringify(state.track))
          : {};
      }
      if (o === 'tracklist') {
        if (!state.moduleLoaded) return [];
        const v = VIDEOS[currentVideoId()];
        return (v?.tracks || []).map((t) => ({
          languageCode: t.lang,
          kind: t.kind || '',
          name: t.name,
          vss_id: t.vss,
          displayName: t.name,
        }));
      }
      return undefined;
    };
    player.setOption = (m, o, v) => {
      state.calls.push([
        'setOption',
        m,
        o,
        v && v.languageCode
          ? {
              languageCode: v.languageCode,
              kind: v.kind || '',
              ...(v.translationLanguage ? { tlang: v.translationLanguage.languageCode } : {}),
            }
          : {},
      ]);
      if (m !== 'captions' || o !== 'track') return;
      if (v && v.languageCode) {
        const t = findTrack(v.languageCode, v.kind === undefined ? undefined : v.kind || null);
        if (!t) return;
        const tl = v.translationLanguage?.languageCode ? { ...v.translationLanguage } : undefined;
        const cur = state.track;
        const same =
          state.captionsOn &&
          !!cur &&
          cur.languageCode === t.lang &&
          isAsr(cur.kind) === isAsr(t.kind) &&
          (cur.translationLanguage?.languageCode ?? null) === (tl?.languageCode ?? null);
        state.moduleLoaded = true;
        state.preferred = { languageCode: t.lang, kind: t.kind || '', translationLanguage: tl };
        if (same) {
          // 真实播放器对同一轨道的重复设置不会重新请求 timedtext。
          state.calls.push(['noop-same-track', t.lang]);
          return;
        }
        state.track = trackOption(t, tl);
        state.captionsOn = true;
        requestTrack(state.track);
      } else {
        state.track = null;
        state.captionsOn = false;
        state.preferred = null;
        state.cues = [];
        renderCaptions();
      }
    };
    state.ready = true;
    if (PLAYER_OPTIONS.captionsDefault && !state.preferred) {
      state.preferred = { ...PLAYER_OPTIONS.captionsDefault };
    }
    applyPreference();
  }

  function attachVideo(el, id) {
    el.src = `/tt-fixture/test-video.webm?v=${id}`;
    el.addEventListener('timeupdate', renderCaptions);
    el.addEventListener('seeked', renderCaptions);
  }
  attachVideo(video(), currentVideoId());
  if (PLAYER_OPTIONS.initDelayMs > 0) {
    window.setTimeout(installApi, PLAYER_OPTIONS.initDelayMs);
  } else {
    installApi();
  }

  state.navigate = (id) => {
    app.dispatchEvent(new CustomEvent('yt-navigate-start', { bubbles: true }));
    history.pushState({}, '', `/watch?v=${id}`);
    // 字幕开关与所选语言跨视频保留（与 YouTube 相同）；轨道按新视频重新选择。
    if (state.ready) applyPreference();
    attachVideo(video(), id);
    app.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true }));
    app.dispatchEvent(new CustomEvent('yt-page-data-updated', { bubbles: true }));
  };
  state.replaceVideo = () => {
    const old = video();
    const next = document.createElement('video');
    next.className = old.className;
    next.setAttribute('playsinline', '');
    old.replaceWith(next);
    attachVideo(next, currentVideoId());
    window.__fixtureOldVideo = old;
    return true;
  };
  state.setAd = (on) => player.classList.toggle('ad-showing', on);
  /** 模拟用户在播放器中切换字幕（与点击 CC / 设置菜单等价的播放器调用）。 */
  state.userSetCaptions = (option) => player.setOption('captions', 'track', option || {});
  document
    .getElementById('fixture-fullscreen')
    .addEventListener('click', () => player.requestFullscreen());
})();

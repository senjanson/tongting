/**
 * 全链路 E2E 的 YouTube 夹具路由：复用 fixtures/youtube 的观看页与假播放器脚本，
 * 但把其中的视频表替换为可配置的多视频（各自的字幕、时长与媒体文件）。
 * 所有 https://www.youtube.com/** 请求都在浏览器内由 context.route 处理，不访问真实 YouTube。
 */
import type { BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const YT_DIR = resolve(import.meta.dirname, '../youtube');
const WATCH_HTML = readFileSync(resolve(YT_DIR, 'watch.html'), 'utf8');
const FAKE_PLAYER = readFileSync(resolve(YT_DIR, 'fake-player.js'), 'utf8');
const DEFAULT_VIDEO = readFileSync(resolve(YT_DIR, 'test-video.webm'));

export interface CaptionLine {
  startMs: number;
  durationMs: number;
  text: string;
}

export interface FixtureTrack {
  lang: string;
  kind: string | null;
  name: string;
  vss: string;
}

export interface FixtureVideo {
  videoId: string;
  title: string;
  lengthSeconds: number;
  /** 不提供则该视频没有字幕轨道。 */
  captions?: CaptionLine[];
  /** 字幕轨道列表，默认只有一条人工英文轨道 `.en`（有 captions 时）。 */
  tracks?: FixtureTrack[];
  /**
   * timedtext 对该视频总是返回空正文（即使带 pot）；播放器仍按 captions 渲染原生字幕。
   * 用于「拿不到完整轨道、只能读取当前显示字幕」的退回路径。
   */
  timedtextBlocked?: boolean;
  /** 前 N 次带 pot 的 timedtext 请求返回空正文（模拟播放器首次请求失败，轨道已激活但没有正文）。 */
  timedtextFailFirst?: number;
  media?: Buffer;
}

/** 假播放器行为开关（见 fixtures/youtube/fake-player.js 顶部说明）。 */
export interface PlayerOptions {
  /** 播放器 API 延迟出现的毫秒数。 */
  initDelayMs?: number;
  /** 页面加载时的用户字幕偏好（播放器就绪后立即请求正文）。 */
  captionsDefault?: {
    languageCode: string;
    kind?: string;
    translationLanguage?: { languageCode: string; languageName?: string };
  } | null;
}

export interface TimedtextHit {
  videoId: string | null;
  withPot: boolean;
  lang: string | null;
  tlang: string | null;
  at: number;
}

export interface RouteStats {
  timedtext: TimedtextHit[];
  media: Record<string, number>;
}

export function captionsJson3(lines: CaptionLine[], textPrefix = ''): string {
  return JSON.stringify({
    wireMagic: 'pb3',
    events: [
      { tStartMs: 0, dDurationMs: 3_600_000, id: 1, wpWinPosId: 0, wsWinStyleId: 0 },
      ...lines.map((l) => ({
        tStartMs: l.startMs,
        dDurationMs: l.durationMs,
        segs: [{ utf8: `${textPrefix}${l.text}` }],
      })),
    ],
  });
}

/** 生成等间隔的人工字幕行。 */
export function makeCaptionLines(
  prefix: string,
  count: number,
  stepMs = 3_000,
  firstMs = 500,
): CaptionLine[] {
  return Array.from({ length: count }, (_, i) => ({
    startMs: firstMs + i * stepMs,
    durationMs: stepMs - 200,
    text: `${prefix} line ${i + 1} says hello number ${i + 1}.`,
  }));
}

const DEFAULT_TRACKS: FixtureTrack[] = [{ lang: 'en', kind: null, name: 'English', vss: '.en' }];

function tracksOf(v: FixtureVideo): FixtureTrack[] {
  return v.captions ? (v.tracks ?? DEFAULT_TRACKS) : [];
}

function patchedPlayer(videos: FixtureVideo[], options: PlayerOptions): string {
  const table: Record<string, unknown> = {};
  for (const v of videos) {
    table[v.videoId] = {
      title: v.title,
      lengthSeconds: v.lengthSeconds,
      tracks: tracksOf(v),
      ...(v.timedtextBlocked && v.captions ? { nativeCues: v.captions } : {}),
    };
  }
  const videosRe = /const VIDEOS = \{[\s\S]*?\n {2}\};\n/;
  const optionsRe = /const PLAYER_OPTIONS = \{[^\n]*\};\n/;
  if (!videosRe.test(FAKE_PLAYER) || !optionsRe.test(FAKE_PLAYER)) {
    throw new Error('fake-player.js 结构已变化，请同步更新 full-chain 夹具的替换规则');
  }
  const playerOptions = {
    initDelayMs: options.initDelayMs ?? 0,
    captionsDefault: options.captionsDefault ?? null,
  };
  return FAKE_PLAYER.replace(videosRe, () => `const VIDEOS = ${JSON.stringify(table)};\n`).replace(
    optionsRe,
    () => `const PLAYER_OPTIONS = ${JSON.stringify(playerOptions)};\n`,
  );
}

export async function routeFullChainYoutube(
  context: BrowserContext,
  videos: FixtureVideo[],
  playerOptions: PlayerOptions = {},
): Promise<RouteStats> {
  const player = patchedPlayer(videos, playerOptions);
  const byId = new Map(videos.map((v) => [v.videoId, v]));
  const stats: RouteStats = { timedtext: [], media: {} };
  await context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/watch') {
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: WATCH_HTML,
      });
    }
    if (url.pathname === '/tt-fixture/fake-player.js') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: player });
    }
    if (url.pathname === '/tt-fixture/test-video.webm') {
      const id = url.searchParams.get('v') ?? '';
      stats.media[id] = (stats.media[id] ?? 0) + 1;
      const body = byId.get(id)?.media ?? DEFAULT_VIDEO;
      const range = /^bytes=(\d*)-(\d*)$/.exec(route.request().headers()['range'] ?? '');
      if (range) {
        const start = range[1] ? Number(range[1]) : 0;
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        return route.fulfill({
          status: 206,
          headers: {
            'Content-Type': 'video/webm',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${body.length}`,
            'Content-Length': String(end - start + 1),
          },
          body: body.subarray(start, end + 1),
        });
      }
      return route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes' },
        body,
      });
    }
    if (url.pathname === '/api/timedtext') {
      const id = url.searchParams.get('v');
      const withPot = !!url.searchParams.get('pot');
      const lang = url.searchParams.get('lang');
      const tlang = url.searchParams.get('tlang');
      stats.timedtext.push({ videoId: id, withPot, lang, tlang, at: Date.now() });
      const v = id ? byId.get(id) : undefined;
      const track = v ? tracksOf(v).find((t) => t.lang === lang) : undefined;
      // 与真实 YouTube 相同：缺少播放器参数时返回空正文。
      let body = '';
      const potHitsForVideo = stats.timedtext.filter((t) => t.withPot && t.videoId === id).length;
      const failing = withPot && (v?.timedtextFailFirst ?? 0) >= potHitsForVideo;
      if (withPot && v?.captions && track && !v.timedtextBlocked && !failing) {
        const first = tracksOf(v)[0]!;
        // 非首选语言轨道加前缀区分；tlang 自动翻译返回带目标语言前缀的「译文」。
        const prefix = `${track.lang !== first.lang ? `(${track.lang}) ` : ''}${tlang ? `[auto-${tlang}] ` : ''}`;
        body = captionsJson3(v.captions, prefix);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    return route.fulfill({ status: 404, body: '' });
  });
  return stats;
}

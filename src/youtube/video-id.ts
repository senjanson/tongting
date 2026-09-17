/**
 * 从 YouTube URL 取视频身份：/watch?v=、/shorts/<id>、/live/<id>。
 * 只接受 youtube.com 主站域名与合法 videoId 形状，其余返回 null。
 */
/**
 * 与 domain/session 的 VideoIdSchema 保持一致（单元测试核对）。这里不引入 zod，
 * 因为该模块也被打包进 MAIN world 桥脚本，需保持体积小。
 */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export type PageKind = 'watch' | 'shorts' | 'live' | 'other';

export interface VideoPageInfo {
  videoId: string | null;
  kind: PageKind;
}

const YOUTUBE_HOSTS = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com']);

export function isValidVideoId(id: string | null | undefined): id is string {
  return typeof id === 'string' && VIDEO_ID_RE.test(id);
}

export function parseYoutubeUrl(href: string): VideoPageInfo {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return { videoId: null, kind: 'other' };
  }
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname))
    return { videoId: null, kind: 'other' };
  const path = url.pathname;
  if (path === '/watch') {
    const v = url.searchParams.get('v');
    return isValidVideoId(v) ? { videoId: v, kind: 'watch' } : { videoId: null, kind: 'other' };
  }
  const m = /^\/(shorts|live)\/([^/?#]+)\/?$/.exec(path);
  if (m) {
    const id = m[2]!;
    return isValidVideoId(id)
      ? { videoId: id, kind: m[1] as 'shorts' | 'live' }
      : { videoId: null, kind: 'other' };
  }
  return { videoId: null, kind: 'other' };
}

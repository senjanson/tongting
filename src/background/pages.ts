import type { CaptionTrackInfo, PageInfo, PlayerState } from '../domain/session';
import type { ContentConnection } from './connections';

/** 已连接的 YouTube 页面（内容脚本实例）。 */
export interface PageState {
  tabId: number;
  /** chrome documentId；不可用时为内容脚本 pageInstanceId。 */
  documentId: string;
  pageInstanceId: string;
  url: string;
  conn: ContentConnection;
  navigationId: number;
  videoId: string | null;
  title?: string;
  channel?: string;
  durationMs?: number;
  isLive: boolean;
  isShorts: boolean;
  player?: PlayerState;
  tracks: CaptionTrackInfo[];
  captionsAvailability: 'unknown' | 'available' | 'unavailable';
  connectedAt: number;
}

export function toPageInfo(p: PageState): PageInfo {
  return {
    tabId: p.tabId,
    documentId: p.documentId,
    url: sanitizeYoutubeUrl(p.url),
    videoId: p.videoId,
    title: p.title,
    player: p.player,
    tracks: p.tracks,
    captionsAvailability: p.captionsAvailability,
    connectedAt: p.connectedAt,
  };
}

/** 只保留 YouTube 页面路径与视频参数，去掉其他查询参数。 */
export function sanitizeYoutubeUrl(url: string): string {
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    return `${u.origin}${u.pathname}${v ? `?v=${encodeURIComponent(v)}` : ''}`.slice(0, 2_000);
  } catch {
    return '';
  }
}

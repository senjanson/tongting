import { describe, expect, it } from 'vitest';
import { VideoIdSchema } from '@src/domain/session';
import { FINISH_CLAIM_WINDOW_MS, createNavigationTracker } from '@src/youtube/navigation';
import { VIDEO_ID_RE, parseYoutubeUrl } from '@src/youtube/video-id';

const A = 'https://www.youtube.com/watch?v=AAAAAAAAAAA';
const B = 'https://www.youtube.com/watch?v=BBBBBBBBBBB';

function clock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('parseYoutubeUrl', () => {
  it('extracts ids from watch, shorts and live URLs', () => {
    expect(parseYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      kind: 'watch',
    });
    expect(parseYoutubeUrl('https://www.youtube.com/shorts/abcDEF_-123')).toEqual({
      videoId: 'abcDEF_-123',
      kind: 'shorts',
    });
    expect(parseYoutubeUrl('https://www.youtube.com/live/abcDEF_-123?si=x')).toEqual({
      videoId: 'abcDEF_-123',
      kind: 'live',
    });
    expect(parseYoutubeUrl('https://m.youtube.com/watch?v=dQw4w9WgXcQ').videoId).toBe(
      'dQw4w9WgXcQ',
    );
  });

  it('rejects other hosts, schemes, pages and malformed ids', () => {
    expect(parseYoutubeUrl('https://www.youtube.com/')).toEqual({ videoId: null, kind: 'other' });
    expect(parseYoutubeUrl('https://www.youtube.com/results?search_query=x')).toEqual({
      videoId: null,
      kind: 'other',
    });
    expect(parseYoutubeUrl('https://evil.example/watch?v=dQw4w9WgXcQ').videoId).toBeNull();
    expect(parseYoutubeUrl('http://www.youtube.com/watch?v=dQw4w9WgXcQ').videoId).toBeNull();
    expect(parseYoutubeUrl('https://www.youtube.com/watch?v=<script>').videoId).toBeNull();
    expect(parseYoutubeUrl('https://www.youtube.com/shorts/a/b').videoId).toBeNull();
    expect(parseYoutubeUrl('not a url').videoId).toBeNull();
  });

  it('keeps the MAIN-world-safe regex equivalent to VideoIdSchema', () => {
    for (const id of [
      'dQw4w9WgXcQ',
      'abc',
      'a'.repeat(6),
      'a'.repeat(20),
      'a'.repeat(21),
      'abc$def',
      'abc-def_12',
    ]) {
      expect(VIDEO_ID_RE.test(id)).toBe(VideoIdSchema.safeParse(id).success);
    }
  });
});

describe('navigation tracker', () => {
  it('assigns a new, increasing navigationId for A→B→A', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    const ids = [t.current.navigationId];
    c.advance(5_000);
    t.markNavigateStart();
    ids.push(t.observe(B, 'yt-navigate-finish')!.navigationId);
    c.advance(5_000);
    t.markNavigateStart();
    const again = t.observe(A, 'yt-navigate-finish')!;
    ids.push(again.navigationId);
    expect(again.videoId).toBe('AAAAAAAAAAA');
    expect(ids).toEqual([1, 2, 3]);
  });

  it('merges duplicate events for the same navigation', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    c.advance(10_000);
    t.markNavigateStart();
    expect(t.observe(B, 'yt-navigate-finish')?.navigationId).toBe(2);
    expect(t.observe(B, 'yt-page-data-updated')).toBeNull();
    expect(t.observe(B, 'yt-navigate-finish')).toBeNull();
    expect(t.observe(B, 'poll')).toBeNull();
    expect(t.observe(B, 'popstate')).toBeNull();
    expect(t.current.navigationId).toBe(2);
  });

  it('lets a finish claim a navigation first detected by polling or popstate', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    c.advance(10_000);
    t.markNavigateStart();
    expect(t.observe(B, 'poll')?.navigationId).toBe(2);
    c.advance(200);
    expect(t.observe(B, 'yt-navigate-finish')).toBeNull();
    // popstate（后退）先改变 URL，随后 YouTube 才发 start/finish。
    c.advance(10_000);
    expect(t.observe(A, 'popstate')?.navigationId).toBe(3);
    t.markNavigateStart();
    c.advance(300);
    expect(t.observe(A, 'yt-navigate-finish')).toBeNull();
    expect(t.current.navigationId).toBe(3);
  });

  it('treats re-entering the same video (start + finish) as a new navigation, even right after a claimed one', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    c.advance(10_000);
    t.markNavigateStart();
    expect(t.observe(B, 'poll')?.navigationId).toBe(2);
    expect(t.observe(B, 'yt-navigate-finish')).toBeNull();
    c.advance(500);
    t.markNavigateStart();
    expect(t.observe(B, 'yt-navigate-finish')?.navigationId).toBe(3);
    c.advance(FINISH_CLAIM_WINDOW_MS + 1);
    t.markNavigateStart();
    expect(t.observe(B, 'yt-navigate-finish')?.navigationId).toBe(4);
  });

  it('still detects a real switch via polling when YouTube events are missing', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    expect(t.observe(B, 'poll')?.videoId).toBe('BBBBBBBBBBB');
    expect(t.observe(A, 'poll')?.navigationId).toBe(3);
    expect(t.observe('https://www.youtube.com/', 'poll')).toMatchObject({
      navigationId: 4,
      videoId: null,
      kind: 'other',
    });
    expect(t.observe('https://www.youtube.com/feed/subscriptions', 'poll')).toBeNull();
    expect(t.observe(A, 'poll')?.navigationId).toBe(5);
  });

  it('ignores an expired navigate-start', () => {
    const c = clock();
    const t = createNavigationTracker(A, c.now);
    t.markNavigateStart();
    c.advance(60_000);
    expect(t.observe(A, 'yt-navigate-finish')).toBeNull();
  });
});

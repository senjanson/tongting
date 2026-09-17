import { describe, expect, it } from 'vitest';
import { verifySender } from '@src/messaging/ports';
import { ContentToBackgroundSchema } from '@src/messaging/content-protocol';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const ORIGIN = `chrome-extension://${RUNTIME_ID}`;

describe('verifySender', () => {
  it('accepts top-frame YouTube content scripts and uses sender tab id', () => {
    const v = verifySender(
      {
        id: RUNTIME_ID,
        url: 'https://www.youtube.com/watch?v=abcdefghijk',
        tab: { id: 7 } as never,
        frameId: 0,
        documentId: 'doc',
      },
      'content',
      RUNTIME_ID,
      ORIGIN,
    );
    expect(v).toMatchObject({ kind: 'content', tabId: 7, documentId: 'doc' });
  });

  it('rejects other extensions, other origins, subframes and web pages posing as UI', () => {
    expect(
      verifySender(
        { id: 'other', url: 'https://www.youtube.com/', tab: { id: 1 } as never, frameId: 0 },
        'content',
        RUNTIME_ID,
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      verifySender(
        { id: RUNTIME_ID, url: 'https://evil.example/', tab: { id: 1 } as never, frameId: 0 },
        'content',
        RUNTIME_ID,
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      verifySender(
        {
          id: RUNTIME_ID,
          url: 'https://www.youtube.com/embed/x',
          tab: { id: 1 } as never,
          frameId: 3,
        },
        'content',
        RUNTIME_ID,
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      verifySender(
        {
          id: RUNTIME_ID,
          url: 'https://www.youtube.com/watch',
          tab: { id: 1 } as never,
          frameId: 0,
        },
        'ui',
        RUNTIME_ID,
        ORIGIN,
      ),
    ).toBeNull();
    expect(
      verifySender({ id: RUNTIME_ID, url: `${ORIGIN}/offscreen.html` }, 'ui', RUNTIME_ID, ORIGIN),
    ).toBeNull();
  });

  it('accepts trusted extension pages', () => {
    expect(
      verifySender({ id: RUNTIME_ID, url: `${ORIGIN}/sidepanel.html` }, 'ui', RUNTIME_ID, ORIGIN),
    ).toMatchObject({ kind: 'ui' });
    expect(
      verifySender(
        { id: RUNTIME_ID, url: `${ORIGIN}/offscreen.html` },
        'offscreen',
        RUNTIME_ID,
        ORIGIN,
      ),
    ).toMatchObject({ kind: 'offscreen' });
  });
});

describe('content protocol schema', () => {
  it('rejects oversize and malformed caption payloads', () => {
    const bad = ContentToBackgroundSchema.safeParse({
      type: 'captions/track-data',
      navigationId: 1,
      videoId: 'abcdefghijk',
      track: { trackKey: 'k', languageCode: 'en', label: 'English', kind: 'manual' },
      format: 'json3',
      complete: true,
      rejectedCount: 0,
      cues: [{ startMs: -5, endMs: 10, text: 'x' }],
    });
    expect(bad.success).toBe(false);
    const ok = ContentToBackgroundSchema.safeParse({
      type: 'captions/track-data',
      navigationId: 1,
      videoId: 'abcdefghijk',
      track: { trackKey: 'k', languageCode: 'en', label: 'English', kind: 'manual' },
      format: 'json3',
      complete: true,
      rejectedCount: 0,
      cues: [{ startMs: 0, endMs: 10, text: '<b>hi</b>' }],
    });
    expect(ok.success).toBe(true);
  });
});

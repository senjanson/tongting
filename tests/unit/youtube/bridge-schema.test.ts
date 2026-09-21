import { describe, expect, it } from 'vitest';
import { CaptionTrackInfoSchema } from '@src/domain/session';
import {
  BridgeCommandResultSchema,
  BridgePlayerResponseSchema,
  BridgeTimedtextSchema,
  inspectTimedtextUrl,
  toPlayerMetadata,
} from '@src/youtube/bridge-client';
import { extractPlayerResponse } from '@src/youtube/bridge/main-world';
import { BRIDGE_TAG } from '@src/youtube/bridge/protocol';

const env = { __tongting: BRIDGE_TAG, dir: 'to-isolated' } as const;
const ORIGIN = 'https://www.youtube.com';

describe('bridge message validation (MAIN world data is untrusted)', () => {
  it('accepts well-formed player responses and rejects oversize or malformed ones', () => {
    const ok = {
      ...env,
      type: 'player-response',
      videoId: 'AAAAAAAAAAA',
      isLive: false,
      tracks: [{ languageCode: 'en', kind: null, name: 'English', vssId: '.en' }],
    };
    expect(BridgePlayerResponseSchema.safeParse(ok).success).toBe(true);
    expect(BridgePlayerResponseSchema.safeParse({ ...ok, videoId: '../../x' }).success).toBe(false);
    // 非法可选字段只丢弃该字段。
    const longTitle = BridgePlayerResponseSchema.safeParse({
      ...ok,
      title: 'x'.repeat(301),
      defaultTrackIndex: -1,
    });
    expect(
      longTitle.success &&
        longTitle.data.title === undefined &&
        longTitle.data.defaultTrackIndex === undefined,
    ).toBe(true);
    expect(
      BridgePlayerResponseSchema.safeParse({
        ...ok,
        tracks: Array.from({ length: 101 }, () => ok.tracks[0]),
      }).success,
    ).toBe(false);
    // 单条非法轨道只丢弃该轨道。
    const badTrack = BridgePlayerResponseSchema.safeParse({
      ...ok,
      tracks: [{ ...ok.tracks[0], languageCode: 'en"><img' }, ok.tracks[0]],
    });
    expect(badTrack.success && badTrack.data.tracks.length === 1).toBe(true);
    expect(BridgePlayerResponseSchema.safeParse({ ...ok, __tongting: 'other' }).success).toBe(
      false,
    );
  });

  it('rejects timedtext bodies that are empty, too large or with invalid status', () => {
    const ok = {
      ...env,
      type: 'timedtext',
      url: `${ORIGIN}/api/timedtext?v=AAAAAAAAAAA&lang=en`,
      status: 200,
      body: '{}',
      via: 'xhr',
    };
    expect(BridgeTimedtextSchema.safeParse(ok).success).toBe(true);
    expect(BridgeTimedtextSchema.safeParse({ ...ok, body: '' }).success).toBe(false);
    expect(
      BridgeTimedtextSchema.safeParse({ ...ok, body: 'x'.repeat(8 * 1024 * 1024 + 1) }).success,
    ).toBe(false);
    expect(BridgeTimedtextSchema.safeParse({ ...ok, status: 99 }).success).toBe(false);
    expect(BridgeTimedtextSchema.safeParse({ ...ok, via: 'generic-fetch' }).success).toBe(false);
    expect(
      BridgeCommandResultSchema.safeParse({
        ...env,
        type: 'command-result',
        commandId: 'a b',
        ok: true,
      }).success,
    ).toBe(false);
  });

  it('inspects only same-origin /api/timedtext URLs and returns no URL', () => {
    const info = inspectTimedtextUrl(
      `${ORIGIN}/api/timedtext?v=AAAAAAAAAAA&lang=en&kind=asr&signature=SECRET&fmt=json3`,
      ORIGIN,
    );
    expect(info).toEqual({
      videoId: 'AAAAAAAAAAA',
      lang: 'en',
      kind: 'asr',
      tlang: null,
      name: null,
    });
    expect(JSON.stringify(info)).not.toContain('SECRET');
    expect(inspectTimedtextUrl('/api/timedtext?v=AAAAAAAAAAA&lang=en', ORIGIN)?.videoId).toBe(
      'AAAAAAAAAAA',
    );
    expect(
      inspectTimedtextUrl('https://evil.example/api/timedtext?v=AAAAAAAAAAA', ORIGIN),
    ).toBeNull();
    expect(inspectTimedtextUrl(`${ORIGIN}/api/other?v=AAAAAAAAAAA`, ORIGIN)).toBeNull();
    expect(inspectTimedtextUrl(`${ORIGIN}/api/timedtext?v=bad$id`, ORIGIN)?.videoId).toBeNull();
  });

  it('maps tracks to CaptionTrackInfo with URL-free, unique keys', () => {
    const meta = toPlayerMetadata({
      ...env,
      type: 'player-response',
      videoId: 'AAAAAAAAAAA',
      title: 'T',
      author: 'C',
      lengthSeconds: 90,
      isLive: false,
      defaultTrackIndex: 1,
      tracks: [
        { languageCode: 'en', kind: 'asr', name: 'English (auto-generated)', vssId: 'a.en' },
        { languageCode: 'en', kind: null, name: 'English', vssId: '.en' },
        { languageCode: 'en', kind: null, name: 'English 2', vssId: 'https://evil/' },
        { languageCode: 'en', kind: null, name: '', vssId: '' },
        { languageCode: 'ja', kind: 'forced', name: '日本語', vssId: '.ja.xyz' },
      ],
    });
    expect(meta.tracks.map((t) => [t.trackKey, t.kind, t.isDefault])).toEqual([
      ['a.en', 'asr', false],
      ['.en', 'manual', true],
      ['.en#2', 'manual', false],
      ['.en#3', 'manual', false],
      ['.ja.xyz', 'unknown', false],
    ]);
    expect(meta.tracks[3]!.label).toBe('en');
    expect(meta.durationMs).toBe(90_000);
    for (const t of meta.tracks) expect(CaptionTrackInfoSchema.safeParse(t).success).toBe(true);
  });
});

describe('extractPlayerResponse (MAIN world)', () => {
  const raw = {
    videoDetails: {
      videoId: 'AAAAAAAAAAA',
      title: 'Title',
      author: 'Channel',
      lengthSeconds: '213',
      isLive: false,
    },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA&lang=en&signature=SECRET',
            name: { simpleText: 'English' },
            vssId: '.en',
            languageCode: 'en',
          },
          {
            baseUrl: 'https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA&lang=en&kind=asr',
            name: { runs: [{ text: 'English ' }, { text: '(auto)' }] },
            vssId: 'a.en',
            languageCode: 'en',
            kind: 'asr',
          },
          { name: { simpleText: 'bad' }, languageCode: '<script>' },
        ],
        audioTracks: [{ defaultCaptionTrackIndex: 0 }],
      },
    },
  };

  it('extracts minimal fields and keeps baseUrl out of the posted payload', () => {
    const r = extractPlayerResponse(raw)!;
    expect(r.payload).toEqual({
      type: 'player-response',
      videoId: 'AAAAAAAAAAA',
      title: 'Title',
      author: 'Channel',
      lengthSeconds: 213,
      isLive: false,
      tracks: [
        { languageCode: 'en', kind: null, name: 'English', vssId: '.en', requestName: '' },
        { languageCode: 'en', kind: 'asr', name: 'English (auto)', vssId: 'a.en', requestName: '' },
      ],
      defaultTrackIndex: 0,
    });
    expect(JSON.stringify(r.payload)).not.toContain('SECRET');
    expect(r.tracks[0]!.baseUrl).toContain('/api/timedtext');
    expect(BridgePlayerResponseSchema.safeParse({ ...env, ...r.payload }).success).toBe(true);
  });

  it('returns null for missing or invalid video details and tolerates missing captions', () => {
    expect(extractPlayerResponse(null)).toBeNull();
    expect(extractPlayerResponse({ videoDetails: { videoId: 'x' } })).toBeNull();
    const noCaptions = extractPlayerResponse({
      videoDetails: { videoId: 'BBBBBBBBBBB', lengthSeconds: 'abc', isLive: true },
    })!;
    expect(noCaptions.payload.tracks).toEqual([]);
    expect(noCaptions.payload.lengthSeconds).toBeUndefined();
    expect(noCaptions.payload.isLive).toBe(true);
  });
});

describe('review B1–B3: MAIN filtering matches ISOLATED schema', () => {
  const raw = (renderer: Record<string, unknown>) => ({
    videoDetails: {
      videoId: 'AAAAAAAAAAA',
      title: 'T',
      author: 'C',
      lengthSeconds: '10',
      isLive: false,
    },
    captions: { playerCaptionsTracklistRenderer: renderer },
  });
  it('maps the default index to the filtered list, drops negative indexes and over-long language codes', () => {
    const r = extractPlayerResponse(
      raw({
        captionTracks: [
          { languageCode: '<bad>', vssId: '.bad' },
          { languageCode: 'en', vssId: '.en', name: { simpleText: 'English' } },
          { languageCode: 'sgn-abcdefgh-ijklmnop', vssId: '.x' },
          { languageCode: 'ja', vssId: '.ja', name: { simpleText: 'Japanese' } },
        ],
        audioTracks: [{ defaultCaptionTrackIndex: 1 }],
      }),
    )!;
    expect(r.payload.tracks.map((t) => t.languageCode)).toEqual(['en', 'ja']);
    expect(r.payload.tracks[r.payload.defaultTrackIndex!]!.languageCode).toBe('en');
    expect(BridgePlayerResponseSchema.safeParse({ ...env, ...r.payload }).success).toBe(true);
    const neg = extractPlayerResponse(
      raw({
        captionTracks: [{ languageCode: 'en', vssId: '.en' }],
        audioTracks: [{ defaultCaptionTrackIndex: -1 }],
      }),
    )!;
    expect(neg.payload.defaultTrackIndex).toBeUndefined();
  });
});

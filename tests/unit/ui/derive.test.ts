import { describe, expect, it } from 'vitest';
import {
  canStop,
  derivePrimaryAction,
  deriveServiceConfig,
  deriveStatus,
  deriveTabContext,
  deriveVoiceAvailability,
  describeSourceLanguage,
  errorNextStep,
  estimatePlayerTimeMs,
  filterVoicesForLanguage,
  sessionRecordId,
} from '@src/ui/state/derive';
import { checkLocalAsrUrl, checkServiceUrl, sameOrigin } from '@src/ui/state/permissions';
import { buildSettingsExport, sanitizeUrlForExport } from '@src/ui/options/export-settings';
import { validateGlossary } from '@src/ui/options/glossary';
import { applySettingsPatch, defaultSettings } from '@src/domain/settings';
import { makePage, makePlayer, makeSession, makeSnapshot, TAB_ID, VIDEO_ID } from './fixtures';

const tab = { tabId: TAB_ID, windowId: 1 };

describe('deriveTabContext', () => {
  it('distinguishes loading, non-YouTube, YouTube without video, and video pages', () => {
    const snapshot = makeSnapshot({ pages: [makePage()] });
    expect(deriveTabContext(snapshot, null, true).kind).toBe('loading');
    expect(deriveTabContext(snapshot, null, false).kind).toBe('no-tab');
    expect(deriveTabContext(snapshot, { tabId: 7, windowId: 1 }, false)).toMatchObject({
      kind: 'not-youtube',
      maybeYoutube: false,
    });
    expect(
      deriveTabContext(
        snapshot,
        { tabId: 7, windowId: 1, url: 'https://www.youtube.com/watch?v=x' },
        false,
      ),
    ).toMatchObject({ kind: 'not-youtube', maybeYoutube: true });
    expect(
      deriveTabContext(makeSnapshot({ pages: [makePage({ videoId: null })] }), tab, false).kind,
    ).toBe('youtube-no-video');
    expect(deriveTabContext(snapshot, tab, false)).toMatchObject({
      kind: 'video',
      session: undefined,
    });
  });

  it('picks the session for the current video and document, ignoring an old video in the same tab', () => {
    const old = makeSession({
      identity: {
        ...makeSession().identity,
        sessionId: 'session-old-0001',
        videoId: 'zzzzzzzzzzz',
      },
    });
    const staleDoc = makeSession({
      identity: { ...makeSession().identity, sessionId: 'session-doc-0000', documentId: 'doc-0' },
      updatedAt: 99,
    });
    const current = makeSession({ updatedAt: 5 });
    const snapshot = makeSnapshot({ pages: [makePage()], sessions: [old, staleDoc, current] });
    const context = deriveTabContext(snapshot, tab, false);
    expect(context.kind === 'video' && context.session?.identity.sessionId).toBe(
      'session-00000001',
    );
  });
});

describe('service config and status', () => {
  it('reports missing URL, key and permission separately', () => {
    const unconfigured = makeSnapshot(
      {
        credential: { configured: false, generation: 1, storage: 'none' },
        hostPermission: { granted: false },
      },
      {},
    );
    expect(deriveServiceConfig(unconfigured)).toMatchObject({
      ready: false,
      missingBaseUrl: true,
      missingKey: true,
    });
    expect(deriveServiceConfig(unconfigured).message).toContain('服务地址与API Key');
    const noPermission = makeSnapshot({
      hostPermission: { origin: 'https://api.example.com', granted: false },
    });
    expect(deriveServiceConfig(noPermission)).toMatchObject({
      ready: false,
      missingPermission: true,
    });
    expect(deriveServiceConfig(makeSnapshot()).ready).toBe(true);
  });

  it('never claims running/connected without a snapshot and maps session phases', () => {
    const config = deriveServiceConfig(makeSnapshot());
    expect(
      deriveStatus({
        connection: 'connecting',
        snapshot: null,
        tabContext: { kind: 'loading' },
        config,
      }).label,
    ).toBe('正在连接');
    const snapshot = makeSnapshot({ pages: [makePage()] });
    const ctx = (session = makeSession()) =>
      deriveTabContext(makeSnapshot({ pages: [makePage()], sessions: [session] }), tab, false);
    expect(deriveStatus({ connection: 'connected', snapshot, tabContext: ctx(), config })).toEqual({
      label: '运行中',
      tone: 'accent',
    });
    expect(
      deriveStatus({
        connection: 'connected',
        snapshot,
        tabContext: ctx(makeSession({ phase: 'paused', desiredState: 'paused' })),
        config,
      }).label,
    ).toBe('翻译已暂停');
    expect(
      deriveStatus({
        connection: 'connected',
        snapshot,
        tabContext: ctx(makeSession({ phase: 'stopping', desiredState: 'stopped' })),
        config,
      }).label,
    ).toBe('正在停止');
    expect(
      deriveStatus({
        connection: 'connected',
        snapshot,
        tabContext: ctx(makeSession({ phase: 'error', desiredState: 'stopped' })),
        config,
      }).tone,
    ).toBe('danger');
    expect(
      deriveStatus({
        connection: 'connected',
        snapshot,
        tabContext: { kind: 'not-youtube', tab, maybeYoutube: false },
        config,
      }).label,
    ).toBe('非视频页');
    const unconfigured = deriveServiceConfig(
      makeSnapshot({ credential: { configured: false, generation: 1, storage: 'none' } }),
    );
    expect(
      deriveStatus({
        connection: 'connected',
        snapshot,
        tabContext: deriveTabContext(snapshot, tab, false),
        config: unconfigured,
      }).label,
    ).toBe('未配置服务');
  });
});

describe('derivePrimaryAction', () => {
  const ready = deriveServiceConfig(makeSnapshot());

  it('follows the last user intent instead of the transient phase', () => {
    expect(derivePrimaryAction(undefined, ready, 'connected')).toMatchObject({
      kind: 'start',
      label: '开始翻译',
    });
    expect(
      derivePrimaryAction(
        makeSession({ phase: 'starting', desiredState: 'running' }),
        ready,
        'connected',
      ).kind,
    ).toBe('pause');
    expect(
      derivePrimaryAction(
        makeSession({ phase: 'starting', desiredState: 'paused' }),
        ready,
        'connected',
      ).kind,
    ).toBe('resume');
    expect(
      derivePrimaryAction(
        makeSession({ phase: 'pausing', desiredState: 'running' }),
        ready,
        'connected',
      ).kind,
    ).toBe('pause');
    expect(
      derivePrimaryAction(
        makeSession({ phase: 'stopping', desiredState: 'stopped' }),
        ready,
        'connected',
      ),
    ).toMatchObject({ kind: 'busy' });
    // 协调器启动失败：phase=error + desiredState=stopped → 可重新开始
    expect(
      derivePrimaryAction(
        makeSession({ phase: 'error', desiredState: 'stopped' }),
        ready,
        'connected',
      ),
    ).toMatchObject({
      kind: 'start',
      label: '重新开始翻译',
      disabledReason: undefined,
    });
  });

  it('is disabled with a reason when unconfigured or disconnected', () => {
    const unconfigured = deriveServiceConfig(
      makeSnapshot({ credential: { configured: false, generation: 1, storage: 'none' } }),
    );
    expect(derivePrimaryAction(undefined, unconfigured, 'connected').disabledReason).toContain(
      'API Key',
    );
    expect(derivePrimaryAction(makeSession(), ready, 'reconnecting').disabledReason).toContain(
      '正在连接后台',
    );
  });

  it('shows stop only while resources may be held', () => {
    expect(canStop(undefined)).toBe(false);
    expect(canStop(makeSession({ phase: 'idle', desiredState: 'stopped' }))).toBe(false);
    expect(canStop(makeSession({ phase: 'stopping', desiredState: 'stopped' }))).toBe(false);
    expect(canStop(makeSession({ phase: 'paused', desiredState: 'paused' }))).toBe(true);
    // 已结束的错误快照（phase=error + desiredState=stopped）不再持有资源
    expect(canStop(makeSession({ phase: 'error', desiredState: 'stopped' }))).toBe(false);
    expect(
      canStop(
        makeSession({
          phase: 'running',
          desiredState: 'running',
          error: { code: 'x', category: 'auth', retryable: false, message: 'm' },
        }),
      ),
    ).toBe(true);
  });

  it('maps error categories to executable next steps', () => {
    expect(errorNextStep({ category: 'auth', retryable: false }).action).toBe('open-settings');
    expect(errorNextStep({ category: 'captions', retryable: false }).label).toBe('配置语音识别');
    expect(
      errorNextStep({ code: 'captions-not-ready', category: 'captions', retryable: true }).action,
    ).toBe('retry');
    expect(errorNextStep({ category: 'youtube', retryable: true }).action).toBe('reload-tab');
    expect(errorNextStep({ category: 'network', retryable: true }).action).toBe('retry');
  });
});

describe('voices', () => {
  const voices = [
    { voiceName: 'Tingting', lang: 'zh-CN' },
    { voiceName: 'Meijia', lang: 'zh-TW' },
    { voiceName: 'Sinji', lang: 'zh_HK' },
    { voiceName: 'Plain zh', lang: 'zh' },
    { voiceName: 'Samantha', lang: 'en-US' },
    { voiceName: 'No lang' },
  ];

  it('filters voices with the same matching rule the worker uses (voiceLanguageRank), best match first', () => {
    // 普通话目标不接受粤语（zh-HK）声音；zh-TW 属于 zh 前缀的次优匹配，与 worker 选择声音一致。
    expect(filterVoicesForLanguage(voices, 'zh-CN').map((v) => v.voiceName)).toEqual([
      'Tingting',
      'Meijia',
      'Plain zh',
    ]);
    expect(filterVoicesForLanguage(voices, 'zh-TW').map((v) => v.voiceName)).toEqual([
      'Meijia',
      'Sinji',
    ]);
    expect(filterVoicesForLanguage(voices, 'en').map((v) => v.voiceName)).toEqual(['Samantha']);
    expect(filterVoicesForLanguage(voices, 'ko')).toEqual([]);
  });

  it('degrades to subtitles with a reason when no voice matches (T31)', () => {
    const snapshot = makeSnapshot(
      {},
      {
        targetLanguage: 'ko',
        outputMode: 'subtitle-voice',
        provider: { baseUrl: 'https://api.example.com' },
      },
    );
    const result = deriveVoiceAvailability(snapshot, { status: 'ready', voices });
    expect(result.state).toBe('unavailable');
    expect(result.reason).toContain('系统没有可用的「한국어」声音');
    expect(result.reason).toContain('仅字幕');
    expect(deriveVoiceAvailability(snapshot, { status: 'loading' }).state).toBe('unknown');
    const none = makeSnapshot({}, { tts: { backend: 'none' } });
    expect(deriveVoiceAvailability(none, { status: 'idle' }).reason).toContain('不使用');
    const cloudUnknown = makeSnapshot({}, { tts: { backend: 'sub2api', sub2apiModel: 'tts-x' } });
    expect(deriveVoiceAvailability(cloudUnknown, { status: 'idle' }).state).toBe('unknown');
    const cloudFailed = makeSnapshot(
      { capabilities: { tts: { status: 'failed', configRevision: 1, message: '404' } } },
      { tts: { backend: 'sub2api', sub2apiModel: 'tts-x' } },
    );
    expect(deriveVoiceAvailability(cloudFailed, { status: 'idle' })).toMatchObject({
      state: 'unavailable',
    });
  });
});

describe('player clock and language info', () => {
  it('extrapolates only while playing, and caps extrapolation', () => {
    const player = makePlayer({
      currentTimeMs: 10_000,
      sampledAtEpochMs: 1_000,
      playbackRate: 1.5,
    });
    expect(estimatePlayerTimeMs(player, 3_000)).toBe(13_000);
    expect(estimatePlayerTimeMs(player, 999_999)).toBe(17_500);
    expect(estimatePlayerTimeMs({ ...player, paused: true }, 3_000)).toBe(10_000);
    expect(estimatePlayerTimeMs({ ...player, ad: true }, 3_000)).toBe(10_000);
    expect(estimatePlayerTimeMs(undefined, 3_000)).toBeUndefined();
  });

  it('keeps the selected source language separate from the detected/track language', () => {
    const settings = defaultSettings();
    expect(describeSourceLanguage(settings, undefined)).toEqual({
      selected: '自动识别',
      actual: '尚未检测',
    });
    const info = describeSourceLanguage(
      applySettingsPatch(settings, { sourceLanguage: 'ja' }),
      makeSession({ detectedSourceLanguage: 'en' }),
    );
    expect(info.selected).toBe('日语');
    expect(info.actual).toBe('字幕轨道 English（en） · 检测为英语');
  });

  it('uses the worker-provided record id when present', () => {
    expect(sessionRecordId(makeSession({ recordId: `${VIDEO_ID}|zh-CN|track:en.manual` }))).toBe(
      `${VIDEO_ID}|zh-CN|track:en.manual`,
    );
  });

  it('never builds a fallback record id when the snapshot has none', () => {
    expect(sessionRecordId(makeSession({ recordId: undefined }))).toBeUndefined();
  });
});

describe('service URL permissions', () => {
  it('reuses the worker normalizeBaseUrl rules for the requested origin pattern', () => {
    expect(checkServiceUrl('https://api.example.com:8443/v1')).toEqual({
      ok: true,
      origin: 'https://api.example.com:8443',
      pattern: 'https://api.example.com:8443/*',
      baseUrl: 'https://api.example.com:8443',
    });
    expect(checkServiceUrl('http://api.example.com')).toMatchObject({ ok: false });
    expect(checkServiceUrl('https://user:pass@api.example.com')).toMatchObject({ ok: false });
    // worker 拒绝查询参数，UI 也必须拒绝
    expect(checkServiceUrl('https://api.example.com/v1?group=a')).toMatchObject({ ok: false });
    expect(checkServiceUrl('https://*.example.com/v1')).toMatchObject({ ok: false });
    expect(checkServiceUrl('not a url')).toMatchObject({ ok: false });
  });

  it('only allows http://127.0.0.1:<port> for the local ASR service', () => {
    expect(checkLocalAsrUrl('http://127.0.0.1:8765')).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:8765',
      pattern: 'http://127.0.0.1:8765/*',
      baseUrl: 'http://127.0.0.1:8765',
    });
    expect(checkLocalAsrUrl('http://localhost:8765').ok).toBe(false);
    expect(checkLocalAsrUrl('http://127.0.0.1').ok).toBe(false);
    expect(checkLocalAsrUrl('https://127.0.0.1:8765').ok).toBe(false);
    expect(checkLocalAsrUrl('http://127.0.0.1:8765/v1?x=1').ok).toBe(false);
    expect(sameOrigin('https://api.example.com', 'https://API.example.com:443/*')).toBe(true);
    expect(sameOrigin('https://a.example.com:8443', 'https://a.example.com')).toBe(false);
    expect(sameOrigin(undefined, 'https://a.example.com')).toBe(false);
  });

  it('reports an invalid saved address as 地址无效 rather than missing permission', () => {
    const snapshot = makeSnapshot(
      { hostPermission: { granted: false } },
      { provider: { baseUrl: 'https://api.example.com/v1?group=a' } },
    );
    const config = deriveServiceConfig(snapshot);
    expect(config).toMatchObject({ ready: false, invalidBaseUrl: true, missingPermission: false });
    expect(config.message).toContain('服务地址无效');
    expect(
      deriveStatus({ connection: 'connected', snapshot, tabContext: { kind: 'no-tab' }, config })
        .label,
    ).toBe('地址无效');
  });
});

describe('options helpers', () => {
  it('exports settings without credentials, query strings or embedded auth', () => {
    const settings = applySettingsPatch(defaultSettings(), {
      provider: { baseUrl: 'https://user:pw@api.example.com/v1?token=abc#x' },
    });
    const file = buildSettingsExport(settings, new Date('2026-09-16T00:00:00Z'));
    const text = JSON.stringify(file);
    expect(file.settings.provider.baseUrl).toBe('https://api.example.com/v1');
    expect(text).not.toContain('token=abc');
    expect(text).not.toContain('pw@');
    expect(text).not.toMatch(/apiKey|asrToken/);
    expect(sanitizeUrlForExport('https://api.example.com/')).toBe('https://api.example.com/');
    expect(sanitizeUrlForExport('https://api.example.com')).toBe('https://api.example.com');
  });

  it('validates glossary drafts', () => {
    expect(
      validateGlossary([
        { key: 1, source: ' OpenAI ', target: '开放人工智能' },
        { key: 2, source: '', target: '' },
      ]),
    ).toEqual({ ok: true, entries: [{ source: 'OpenAI', target: '开放人工智能' }] });
    const bad = validateGlossary([
      { key: 1, source: 'A', target: '' },
      { key: 2, source: 'b', target: 'x' },
      { key: 3, source: 'B', target: 'y' },
      { key: 4, source: 'x'.repeat(101), target: 'z' },
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect([...bad.errors.keys()]).toEqual([1, 3, 4]);
  });
});

describe('sub2api tts unknown is not treated as unavailable', () => {
  it('reports unknown honestly (probe not implemented), and system voices rely only on the actual list', () => {
    const cloud = makeSnapshot(
      { capabilities: { tts: { status: 'unknown', configRevision: 1, reasonCode: 'not-probed' } } },
      { tts: { backend: 'sub2api', sub2apiModel: 'tts-x' } },
    );
    const result = deriveVoiceAvailability(cloud, { status: 'idle' });
    expect(result.state).toBe('unknown');
    expect(result.reason).toContain('尚未实测');
    expect(result.reason).toContain('仍可选择配音');
    expect(result.reason).not.toContain('计费');
    const system = makeSnapshot({
      capabilities: { systemTts: { status: 'failed', configRevision: 1 } },
    });
    expect(
      deriveVoiceAvailability(system, {
        status: 'ready',
        voices: [{ voiceName: 'Tingting', lang: 'zh-CN' }],
      }).state,
    ).toBe('available');
  });
});

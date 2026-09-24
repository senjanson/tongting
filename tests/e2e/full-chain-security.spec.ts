/**
 * 全链路 E2E（T29 安全抽查）：真实扩展运行中，
 * - 页面 MAIN world 无法使用 chrome.runtime 连接扩展；
 * - 页面伪造 MAIN world 桥消息 / 端口形状消息 / 导航 CustomEvent，不能越权改变会话、设置或凭证；
 * - 页面 DOM（含开放 Shadow DOM）、window 全局、localStorage/sessionStorage/cookie、YouTube 域请求中不出现 API Key；
 * - 内容脚本（ISOLATED world）读取 chrome.storage 中凭证的实际结果（经 CDP 在该执行上下文求值）；
 * - 字幕与译文中的 HTML 不执行。
 *
 * 前置：TONGTING_E2E=1 pnpm exec wxt build
 */
import { expect, test, type Page } from '@playwright/test';
import {
  configureProvider,
  openWatch,
  setupFullChain,
  sleep,
  video,
  waitOverlay,
  type FullChain,
} from './helpers/full-chain';
import { E2E_API_KEY, mockTranslation } from './fixtures/full-chain/mock-sub2api';
import { ffmpegAvailable, silentVideo } from './fixtures/full-chain/media';
import {
  makeCaptionLines,
  type CaptionLine,
  type FixtureVideo,
} from './fixtures/full-chain/youtube';

test.describe.configure({ timeout: 180_000 });

const VIDEO_A = 'AAAAAAAAAAA';
const XSS_TEXT =
  'Alpha has <img src=x onerror="window.__ttXss=1"> and <script>window.__ttXss=2</script> inside.';
let videos: FixtureVideo[];
let lines: CaptionLine[];
let fc: FullChain | undefined;

test.beforeAll(async () => {
  test.skip(!(await ffmpegAvailable()), '需要 ffmpeg 生成长视频夹具');
  lines = makeCaptionLines('Alpha', 45);
  lines[1] = { ...lines[1]!, text: XSS_TEXT };
  videos = [
    {
      videoId: VIDEO_A,
      title: 'Full Chain Alpha',
      lengthSeconds: 150,
      captions: lines,
      media: await silentVideo(150),
    },
  ];
});

test.afterEach(async () => {
  await fc?.close();
  fc = undefined;
});

/** 页面可见的一切文本：DOM（含开放 shadow root）、window 自有属性、Web Storage、cookie、资源条目。 */
async function pageVisibleText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [];
    const walk = (root: Document | ShadowRoot | Element) => {
      const html =
        root instanceof Document
          ? root.documentElement.outerHTML
          : (root as Element | ShadowRoot).innerHTML;
      parts.push(html);
      const all = (root instanceof Document ? root : root).querySelectorAll('*');
      for (const el of all) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    for (const key of Object.getOwnPropertyNames(window)) {
      try {
        const v = (window as unknown as Record<string, unknown>)[key];
        if (typeof v === 'string') parts.push(v);
        else if (v && typeof v === 'object' && !(v instanceof Node) && v !== window) {
          try {
            parts.push(JSON.stringify(v).slice(0, 100_000));
          } catch {
            // 循环引用等
          }
        }
      } catch {
        // 访问受限
      }
    }
    for (const store of [localStorage, sessionStorage]) {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i)!;
        parts.push(k, store.getItem(k) ?? '');
      }
    }
    parts.push(document.cookie);
    parts.push(
      performance
        .getEntries()
        .map((e) => e.name)
        .join('\n'),
    );
    return parts.join('\n');
  });
}

/** 通过 CDP 在内容脚本的 ISOLATED world 中求值。 */
async function evaluateInContentWorld(
  fcx: FullChain,
  page: Page,
  expression: string,
): Promise<{ contexts: unknown[]; value: unknown }> {
  const cdp = await fcx.ext.context.newCDPSession(page);
  const contexts: Array<{
    id: number;
    origin: string;
    name: string;
    auxData?: { type?: string; isDefault?: boolean };
  }> = [];
  cdp.on('Runtime.executionContextCreated', (e: { context: (typeof contexts)[number] }) =>
    contexts.push(e.context),
  );
  await cdp.send('Runtime.enable');
  await sleep(300);
  const ctx = contexts.find(
    (c) =>
      c.origin === `chrome-extension://${fcx.ext.extensionId}` ||
      (c.auxData?.type === 'isolated' && c.name.includes('译听')),
  );
  let value: unknown = 'no-isolated-context';
  if (ctx) {
    const r = (await cdp.send('Runtime.evaluate', {
      expression,
      contextId: ctx.id,
      awaitPromise: true,
      returnByValue: true,
    })) as {
      result: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    value = r.exceptionDetails
      ? `EXCEPTION: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`
      : r.result.value;
  }
  await cdp.detach();
  return {
    contexts: contexts.map((c) => ({ origin: c.origin, name: c.name, type: c.auxData?.type })),
    value,
  };
}

test('T29 页面伪造消息与凭证可见范围', async () => {
  fc = await setupFullChain({ videos });
  const { ui, mock } = fc;
  await configureProvider(fc);
  const { page, tabId } = await openWatch(fc, VIDEO_A);
  const ytRequests: string[] = [];
  page.on('request', (r) => ytRequests.push(`${r.method()} ${r.url()} ${r.postData() ?? ''}`));
  expect(await video(page).play()).toBe(true);
  await ui.ok({ kind: 'session/start', tabId });
  const running = await ui.waitSession(
    tabId,
    (s) => s.phase === 'running' && s.translation.done > 0,
    {
      timeout: 30_000,
      message: '会话 running',
    },
  );
  await video(page).pause();
  await video(page).seek(3.8);
  await waitOverlay(
    page,
    (s) => s.main === mockTranslation('zh-CN', XSS_TEXT),
    20_000,
    '含 HTML 的译文',
  );
  const evidence: Record<string, unknown> = {};
  const snapBefore = (await ui.snapshot())!;

  // ---- 1. MAIN world 无法连接扩展 ----
  evidence.mainWorldRuntime = await page.evaluate((extId) => {
    const c = (
      window as unknown as {
        chrome?: {
          runtime?: { connect?: (id: string, info: unknown) => unknown; sendMessage?: unknown };
        };
      }
    ).chrome;
    const out: Record<string, unknown> = {
      hasChrome: !!c,
      hasRuntime: !!c?.runtime,
      connectType: typeof c?.runtime?.connect,
    };
    try {
      c!.runtime!.connect!(extId, { name: 'tongting:ui' });
      out.connect = 'no-throw';
    } catch (e) {
      out.connect = `threw: ${(e as Error).message.slice(0, 120)}`;
    }
    return out;
  }, fc.ext.extensionId);
  expect((evidence.mainWorldRuntime as { connect: string }).connect).not.toBe('no-throw');

  // ---- 2. 伪造 MAIN world 桥消息与端口形状消息、导航事件 ----
  await page.evaluate((videoId) => {
    const tag = 'tongting-bridge-v1';
    const post = (m: unknown) => window.postMessage(m, '*');
    // 非法形状：负时长、超量轨道、超长标题
    post({
      __tongting: tag,
      dir: 'to-isolated',
      type: 'player-response',
      videoId,
      isLive: false,
      lengthSeconds: -5,
      tracks: [],
    });
    post({
      __tongting: tag,
      dir: 'to-isolated',
      type: 'player-response',
      videoId,
      isLive: false,
      title: 'x'.repeat(5_000),
      tracks: [],
    });
    post({
      __tongting: tag,
      dir: 'to-isolated',
      type: 'player-response',
      videoId,
      isLive: false,
      tracks: Array.from({ length: 500 }, (_, i) => ({
        languageCode: 'en',
        kind: null,
        name: `t${i}`,
        vssId: `.e${i}`,
      })),
    });
    // 其他视频的字幕正文
    post({
      __tongting: tag,
      dir: 'to-isolated',
      type: 'timedtext',
      url: 'https://www.youtube.com/api/timedtext?v=ZZZZZZZZZZZ&lang=en&fmt=json3',
      status: 200,
      body: JSON.stringify({
        events: [{ tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: 'INJECTED OTHER VIDEO' }] }],
      }),
      via: 'xhr',
    });
    // 伪造命令结果与扩展端口形状消息
    post({
      __tongting: tag,
      dir: 'to-isolated',
      type: 'command-result',
      commandId: 'forged',
      ok: true,
      changedCaptions: true,
    });
    post({ type: 'session/state', session: null });
    post({
      type: 'command',
      requestId: 'x',
      command: { kind: 'credentials/set', apiKey: 'attacker-key', remember: true },
    });
    post({
      type: 'command',
      requestId: 'y',
      command: {
        kind: 'settings/update',
        patch: { provider: { baseUrl: 'https://attacker.example' } },
      },
    });
    // 导航事件风暴（URL 不变）
    const app = document.getElementById('app')!;
    for (let i = 0; i < 20; i++) {
      app.dispatchEvent(new CustomEvent('yt-navigate-finish', { bubbles: true }));
      document.dispatchEvent(new CustomEvent('yt-page-data-updated', { bubbles: true }));
    }
  }, VIDEO_A);
  await sleep(2_000);
  const snapAfter = (await ui.snapshot())!;
  expect(snapAfter.sessions).toHaveLength(1);
  expect(snapAfter.sessions[0]!.identity.sessionId).toBe(running.identity.sessionId);
  expect(snapAfter.settings.provider.baseUrl).toBe(fc.mock.baseUrl);
  expect(snapAfter.credential.masked).toBe(snapBefore.credential.masked);
  const pageInfo = snapAfter.pages.find((p) => p.tabId === tabId)!;
  expect(pageInfo.title).toBe('Full Chain Alpha');
  const ovAfter = await waitOverlay(page, (s) => s.hosts === 1, 5_000, '伪造后覆盖层仍在');
  expect(ovAfter.main).toBe(mockTranslation('zh-CN', XSS_TEXT));
  const cues = await (async () => {
    await ui.subscribeCues(running.identity.sessionId);
    await expect
      .poll(async () => (await ui.cues(running.identity.sessionId)).length)
      .toBeGreaterThan(0);
    return ui.cues(running.identity.sessionId);
  })();
  expect(cues.some((c) => c.sourceText.includes('INJECTED'))).toBe(false);
  expect(
    mock.translationRequests().some((r) => r.items.some((i) => i.text.includes('INJECTED'))),
  ).toBe(false);
  evidence.forged = {
    sessions: snapAfter.sessions.length,
    sameSession: true,
    title: pageInfo.title,
    tracks: pageInfo.tracks.length,
    overlayHosts: ovAfter.hosts,
    navigationEpoch: {
      before: running.identity.epoch,
      after: snapAfter.sessions[0]!.identity.epoch,
    },
  };

  // ---- 3. 字幕 HTML 不执行 ----
  expect(
    await page.evaluate(() => (window as unknown as { __ttXss?: number }).__ttXss),
  ).toBeUndefined();
  expect(ovAfter.shadowElements).toBe(0);

  // ---- 4. 页面可见范围内没有 API Key ----
  const visible = await pageVisibleText(page);
  expect(visible).not.toContain(E2E_API_KEY);
  expect(visible).not.toContain('NOT-A-SECRET');
  expect(visible).not.toContain(fc.mock.baseUrl);
  expect(ytRequests.join('\n')).not.toContain(E2E_API_KEY);
  expect(fc.route.timedtext.every((t) => t.videoId === VIDEO_A)).toBe(true);
  evidence.pageVisibleChars = visible.length;

  // ---- 5. 内容脚本 ISOLATED world 读取 chrome.storage ----
  const readStorage = `(async () => {
    const out = {};
    for (const area of ['session', 'local']) {
      try {
        const v = await chrome.storage[area].get(null);
        out[area] = JSON.stringify(v).includes(${JSON.stringify(E2E_API_KEY)}) ? 'KEY-VISIBLE' : 'readable-no-key:' + Object.keys(v).join(',');
      } catch (e) {
        out[area] = 'denied: ' + String(e && e.message).slice(0, 100);
      }
    }
    return out;
  })()`;
  const sessionKey = await evaluateInContentWorld(fc, page, readStorage);
  evidence.contentWorldStorageSessionKey = sessionKey;
  // 「记住在本机」：Key 写入 storage.local 后再次检查内容脚本可见性。
  await ui.ok({ kind: 'credentials/set', apiKey: E2E_API_KEY, remember: true });
  await ui.waitSnapshot((s) => s.credential.storage === 'local', { message: '凭证保存到 local' });
  const localKey = await evaluateInContentWorld(fc, page, readStorage);
  evidence.contentWorldStorageLocalKey = localKey;
  console.log('[T29 evidence]', JSON.stringify(evidence, null, 2));
  expect(sessionKey.value).not.toBe('no-isolated-context');
  expect(JSON.stringify(sessionKey.value)).not.toContain('KEY-VISIBLE');
  expect(JSON.stringify(localKey.value)).not.toContain('KEY-VISIBLE');
});

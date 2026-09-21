/**
 * 全链路 E2E 公共设施：加载 E2E 构建的真实扩展（真实 service worker 协调器 / 内容脚本 / offscreen / UI），
 * YouTube 指向本地夹具，sub2api 指向本地模拟服务，并以受信任扩展页面身份驱动。
 */
import { expect, type Page } from '@playwright/test';
import { launchExtension, prepareE2EExtension, type LaunchedExtension } from './extension';
import { UiDriver } from './ui-driver';
import {
  E2E_API_KEY,
  startE2eMockSub2api,
  type E2eMockSub2api,
} from '../fixtures/full-chain/mock-sub2api';
import {
  routeFullChainYoutube,
  type FixtureVideo,
  type PlayerOptions,
  type RouteStats,
} from '../fixtures/full-chain/youtube';
import type { SettingsPatch } from '../../../src/domain/settings';
import type { ConnectionReport } from '../../../src/messaging/ui-protocol';

export const MODEL = 'gpt-5.6-terra';

export interface FullChain {
  ext: LaunchedExtension;
  extensionDir: string;
  ui: UiDriver;
  mock: E2eMockSub2api;
  route: RouteStats;
  close(): Promise<void>;
}

export async function setupFullChain(options: {
  videos: FixtureVideo[];
  unmute?: boolean;
  extraArgs?: (extensionId: string) => string[];
  playerOptions?: PlayerOptions;
  /**
   * 驱动端口所在的扩展页面。侧栏/弹窗页面的产品代码会唤醒活动标签页的内容脚本；
   * 需要观察「空闲不连接」时用 /options.html 或 /workspace.html（不唤醒）。
   */
  uiPath?: '/sidepanel.html' | '/options.html' | '/workspace.html';
}): Promise<FullChain> {
  const prepared = await prepareE2EExtension();
  const mock = await startE2eMockSub2api();
  const ext = await launchExtension({
    extensionDir: prepared.dir,
    unmute: options.unmute,
    extraArgs: options.extraArgs?.(prepared.extensionId),
  });
  if (ext.extensionId !== prepared.extensionId) {
    await ext.close();
    await mock.close();
    throw new Error(`扩展 ID 计算不一致：预期 ${prepared.extensionId}，实际 ${ext.extensionId}`);
  }
  const route = await routeFullChainYoutube(ext.context, options.videos, options.playerOptions);
  const ui = await UiDriver.open(ext.context, ext.extensionId, options.uiPath);
  return {
    ext,
    extensionDir: prepared.dir,
    ui,
    mock,
    route,
    async close() {
      await ext.close();
      await mock.close();
    },
  };
}

/** 设置 sub2api（mock）并写入凭证；返回 settings/update 的持久化结果。 */
export async function configureProvider(
  fc: FullChain,
  patch: SettingsPatch = {},
  apiKey = E2E_API_KEY,
): Promise<void> {
  const r = await fc.ui.ok<{ persisted: boolean }>({
    kind: 'settings/update',
    patch: {
      playbackMode: 'continuous',
      ...patch,
      provider: {
        baseUrl: fc.mock.baseUrl,
        protocol: 'responses',
        model: MODEL,
        streaming: false,
        ...patch.provider,
      },
    },
  });
  expect(r.persisted).toBe(true);
  const c = await fc.ui.ok<{ persisted: boolean; storage: string }>({
    kind: 'credentials/set',
    apiKey,
    remember: false,
  });
  expect(c).toEqual({ persisted: true, storage: 'session' });
  await fc.ui.waitSnapshot((s) => s.credential.configured && s.hostPermission.granted, {
    message: '凭证与主机权限在快照中生效',
  });
}

export async function connectionCheck(fc: FullChain): Promise<ConnectionReport> {
  return fc.ui.ok<ConnectionReport>(
    { kind: 'connection/check', scope: 'text', allowBilledAudioProbe: false },
    60_000,
  );
}

export async function openWatch(
  fc: FullChain,
  videoId: string,
): Promise<{ page: Page; tabId: number }> {
  const page = await fc.ext.context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${videoId}`);
  // 内容脚本空闲时不主动连接：由驱动页（/sidepanel.html 的产品代码）唤醒活动标签页。
  await page.bringToFront();
  const info = await fc.ui.waitPage(videoId, (p) => p.captionsAvailability !== 'unknown', 20_000);
  return { page, tabId: info.tabId };
}

export function video(page: Page) {
  return {
    play: () =>
      page.evaluate(() =>
        document
          .querySelector<HTMLVideoElement>('#movie_player video')!
          .play()
          .then(
            () => true,
            (e: Error) => e.name,
          ),
      ),
    pause: () =>
      page.evaluate(() => document.querySelector<HTMLVideoElement>('#movie_player video')!.pause()),
    seek: (seconds: number) =>
      page.evaluate((t) => {
        document.querySelector<HTMLVideoElement>('#movie_player video')!.currentTime = t;
      }, seconds),
    state: () =>
      page.evaluate(() => {
        const v = document.querySelector<HTMLVideoElement>('#movie_player video')!;
        return {
          currentTimeMs: Math.round(v.currentTime * 1000),
          paused: v.paused,
          volume: v.volume,
          muted: v.muted,
          readyState: v.readyState,
        };
      }),
    navigate: (id: string) =>
      page.evaluate(
        (v) =>
          (window as unknown as { __fixture: { navigate(id: string): void } }).__fixture.navigate(
            v,
          ),
        id,
      ),
  };
}

export interface OverlayState {
  hosts: number;
  hidden: boolean | null;
  main: string | null;
  mainHidden: boolean | null;
  secondary: string | null;
  secondaryHidden: boolean | null;
  pending: string | null;
  badge: string | null;
  hideNative: boolean;
  shadowElements: number;
}

export async function overlayState(page: Page): Promise<OverlayState> {
  return page.evaluate(() => {
    const hosts = document.querySelectorAll('[data-tongting-overlay]');
    const host = hosts[0] as HTMLElement | undefined;
    const root = host?.shadowRoot;
    const main = root?.querySelector<HTMLElement>('.main');
    const secondary = root?.querySelector<HTMLElement>('.secondary');
    const badge = root?.querySelector<HTMLElement>('.badge');
    return {
      hosts: hosts.length,
      hidden: host ? host.hidden === true : null,
      main: main?.textContent ?? null,
      mainHidden: main ? main.hidden === true : null,
      secondary: secondary?.textContent ?? null,
      secondaryHidden: secondary ? secondary.hidden === true : null,
      pending: main?.dataset.pending ?? null,
      badge: badge?.textContent ?? null,
      hideNative:
        document.querySelector('#movie_player')?.hasAttribute('data-tongting-hide-native') ?? false,
      shadowElements: root ? root.querySelectorAll('img, script, iframe, a, svg').length : 0,
    };
  });
}

/** 轮询覆盖层直到满足条件。 */
export async function waitOverlay(
  page: Page,
  predicate: (s: OverlayState) => boolean,
  timeout = 15_000,
  message = '等待覆盖层状态',
): Promise<OverlayState> {
  const started = Date.now();
  let last: OverlayState | undefined;
  while (Date.now() - started < timeout) {
    last = await overlayState(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(100);
  }
  throw new Error(`${message}超时；最后状态：${JSON.stringify(last)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

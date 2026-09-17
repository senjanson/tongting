/**
 * 以受信任扩展页面的身份驱动真实 service worker 协调器。
 *
 * 在 chrome-extension://<id>/sidepanel.html（以普通标签页打开，页面路径属于协调器的受信任 UI 页面）中
 * 通过 chrome.runtime.connect({ name: 'tongting:ui' }) 建立与产品 UI 相同的端口，发送 UiCommand、读取快照与字幕。
 * 这里不绕过协调器的 sender 校验，也不直接调用内部对象。
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import type { Cue } from '../../../src/domain/cue';
import type { SessionSnapshot } from '../../../src/domain/session';
import type { AppSnapshot, UiCommand } from '../../../src/messaging/ui-protocol';

export type CommandResult<T = unknown> =
  { ok: true; data: T } | { ok: false; error: { code: string; category: string; message: string } };

interface DriverState {
  port: { postMessage(m: unknown): void; disconnect(): void };
  latest: AppSnapshot | null;
  snapshotCount: number;
  rejectedSnapshots: number;
  disconnected: boolean;
  cues: Record<string, { cueVersion: number; byId: Record<string, Cue> }>;
  cueEvents: Array<{
    at: number;
    sessionId: string;
    cues: Array<
      Pick<Cue, 'id' | 'translationState' | 'translatedText' | 'sourceText' | 'startMs' | 'endMs'>
    >;
  }>;
  pending: Record<string, (r: unknown) => void>;
  seq: number;
}

type DriverWindow = Window & { __e2eUi?: DriverState };

export class UiDriver {
  private constructor(
    readonly page: Page,
    readonly extensionId: string,
  ) {}

  /** 打开受信任扩展页面并建立 UI 端口（订阅快照）。 */
  static async open(
    context: BrowserContext,
    extensionId: string,
    path:
      '/sidepanel.html' | '/popup.html' | '/options.html' | '/workspace.html' = '/sidepanel.html',
  ): Promise<UiDriver> {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}${path}`);
    const driver = new UiDriver(page, extensionId);
    await driver.connect();
    return driver;
  }

  async connect(): Promise<void> {
    await this.page.evaluate(() => {
      const w = window as DriverWindow;
      const chromeApi = (
        globalThis as unknown as {
          chrome: {
            runtime: {
              connect(info: { name: string }): {
                postMessage(m: unknown): void;
                disconnect(): void;
                onMessage: { addListener(cb: (m: Record<string, unknown>) => void): void };
                onDisconnect: { addListener(cb: () => void): void };
              };
            };
          };
        }
      ).chrome;
      const port = chromeApi.runtime.connect({ name: 'tongting:ui' });
      const state: DriverState = {
        port,
        latest: null,
        snapshotCount: 0,
        rejectedSnapshots: 0,
        disconnected: false,
        cues: {},
        cueEvents: [],
        pending: {},
        seq: 0,
      };
      w.__e2eUi = state;
      port.onDisconnect.addListener(() => {
        state.disconnected = true;
      });
      port.onMessage.addListener((m) => {
        if (m.type === 'snapshot') {
          const snap = m.snapshot as AppSnapshot;
          if (state.latest && snap.snapshotVersion <= state.latest.snapshotVersion) {
            state.rejectedSnapshots++;
            return;
          }
          state.latest = snap;
          state.snapshotCount++;
        } else if (m.type === 'cues') {
          const sessionId = m.sessionId as string;
          const list = m.cues as Cue[];
          let entry = state.cues[sessionId];
          if (!entry || m.full) entry = state.cues[sessionId] = { cueVersion: 0, byId: {} };
          entry.cueVersion = m.cueVersion as number;
          for (const c of list) entry.byId[c.id] = c;
          for (const id of (m.removedIds as string[] | undefined) ?? []) delete entry.byId[id];
          state.cueEvents.push({
            at: Date.now(),
            sessionId,
            cues: list.map((c) => ({
              id: c.id,
              translationState: c.translationState,
              translatedText: c.translatedText,
              sourceText: c.sourceText,
              startMs: c.startMs,
              endMs: c.endMs,
            })),
          });
          if (state.cueEvents.length > 5_000) state.cueEvents.splice(0, 1_000);
        } else if (m.type === 'result') {
          const cb = state.pending[m.requestId as string];
          if (cb) {
            delete state.pending[m.requestId as string];
            cb(m);
          }
        }
      });
      port.postMessage({ type: 'subscribe', protocolVersion: 1, surface: 'sidepanel' });
    });
    await expect.poll(() => this.snapshot().then((s) => !!s), { timeout: 10_000 }).toBe(true);
  }

  async command<T = unknown>(command: UiCommand, timeoutMs = 30_000): Promise<CommandResult<T>> {
    return this.page.evaluate(
      ({ command, timeoutMs }) =>
        new Promise<CommandResult<T>>((resolve) => {
          const state = (window as DriverWindow).__e2eUi!;
          const requestId = `e2e-${Date.now()}-${++state.seq}`;
          const timer = setTimeout(() => {
            delete state.pending[requestId];
            resolve({
              ok: false,
              error: { code: 'e2e-timeout', category: 'internal', message: 'no result' },
            });
          }, timeoutMs);
          state.pending[requestId] = (m) => {
            clearTimeout(timer);
            const r = m as {
              ok: boolean;
              data?: unknown;
              error?: { code: string; category: string; message: string };
            };
            resolve(
              r.ok
                ? { ok: true, data: r.data as T }
                : {
                    ok: false,
                    error: r.error as { code: string; category: string; message: string },
                  },
            );
          };
          state.port.postMessage({ type: 'command', requestId, command });
        }),
      { command, timeoutMs },
    );
  }

  /** 发送命令并断言成功，返回 data。 */
  async ok<T = unknown>(command: UiCommand, timeoutMs?: number): Promise<T> {
    const r = await this.command<T>(command, timeoutMs);
    if (!r.ok) throw new Error(`命令 ${command.kind} 失败：${JSON.stringify(r.error)}`);
    return r.data;
  }

  /** 发送任意原始消息（用于验证 schema 拒绝）。 */
  async raw(message: unknown): Promise<void> {
    await this.page.evaluate((m) => (window as DriverWindow).__e2eUi!.port.postMessage(m), message);
  }

  async snapshot(): Promise<AppSnapshot | null> {
    return this.page.evaluate(() => (window as DriverWindow).__e2eUi?.latest ?? null);
  }

  async stats(): Promise<{
    snapshotCount: number;
    rejectedSnapshots: number;
    disconnected: boolean;
  }> {
    return this.page.evaluate(() => {
      const s = (window as DriverWindow).__e2eUi!;
      return {
        snapshotCount: s.snapshotCount,
        rejectedSnapshots: s.rejectedSnapshots,
        disconnected: s.disconnected,
      };
    });
  }

  /** 轮询直到快照满足条件，返回该快照。 */
  async waitSnapshot(
    predicate: (s: AppSnapshot) => boolean,
    options: { timeout?: number; message?: string } = {},
  ): Promise<AppSnapshot> {
    const timeout = options.timeout ?? 20_000;
    const started = Date.now();
    let last: AppSnapshot | null = null;
    while (Date.now() - started < timeout) {
      last = await this.snapshot();
      if (last && predicate(last)) return last;
      await this.page.waitForTimeout(100);
    }
    throw new Error(
      `${options.message ?? '等待快照条件超时'}；最后快照：${JSON.stringify(summarizeSnapshot(last))}`,
    );
  }

  /** YouTube 标签页（按 videoId）在快照 pages 中出现。 */
  async waitPage(
    videoId: string,
    extra?: (p: AppSnapshot['pages'][number]) => boolean,
    timeout = 20_000,
  ) {
    const snap = await this.waitSnapshot(
      (s) => s.pages.some((p) => p.videoId === videoId && (!extra || extra(p))),
      { timeout, message: `等待页面 ${videoId}` },
    );
    return snap.pages.find((p) => p.videoId === videoId && (!extra || extra(p)))!;
  }

  async session(tabId: number): Promise<SessionSnapshot | undefined> {
    const s = await this.snapshot();
    return s?.sessions.find((x) => x.identity.tabId === tabId);
  }

  async waitSession(
    tabId: number,
    predicate: (s: SessionSnapshot) => boolean,
    options: { timeout?: number; message?: string } = {},
  ): Promise<SessionSnapshot> {
    const snap = await this.waitSnapshot(
      (s) => s.sessions.some((x) => x.identity.tabId === tabId && predicate(x)),
      options,
    );
    return snap.sessions.find((x) => x.identity.tabId === tabId && predicate(x))!;
  }

  async subscribeCues(sessionId: string | null): Promise<void> {
    await this.raw({ type: 'cues/subscribe', sessionId });
  }

  async cues(sessionId: string): Promise<Cue[]> {
    return this.page.evaluate((id) => {
      const entry = (window as DriverWindow).__e2eUi!.cues[id];
      return entry ? Object.values(entry.byId).sort((a, b) => a.startMs - b.startMs) : [];
    }, sessionId);
  }

  async cueEvents(): Promise<DriverState['cueEvents']> {
    return this.page.evaluate(() => (window as DriverWindow).__e2eUi!.cueEvents);
  }

  /** 读取 IndexedDB tongting.transcripts 中的记录（扩展 origin 与 worker 共享）。 */
  async readTranscript(recordId: string): Promise<{
    recordId: string;
    videoId: string;
    lastSessionId: string;
    targetLanguage: string;
    sourceMode: string;
    cues: Cue[];
  } | null> {
    return this.page.evaluate(
      (id) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('tongting');
          req.onerror = () => reject(new Error('open failed'));
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('transcripts')) {
              db.close();
              resolve(null);
              return;
            }
            const get = db
              .transaction('transcripts', 'readonly')
              .objectStore('transcripts')
              .get(id);
            get.onsuccess = () => {
              db.close();
              resolve(get.result ?? null);
            };
            get.onerror = () => {
              db.close();
              reject(new Error('get failed'));
            };
          };
        }),
      recordId,
    );
  }

  async close(): Promise<void> {
    await this.page.close().catch(() => undefined);
  }
}

export function summarizeSnapshot(s: AppSnapshot | null): unknown {
  if (!s) return null;
  return {
    v: s.snapshotVersion,
    credential: s.credential,
    hostPermission: s.hostPermission,
    pages: s.pages.map((p) => ({
      tabId: p.tabId,
      videoId: p.videoId,
      caps: p.captionsAvailability,
    })),
    sessions: s.sessions.map((x) => ({
      sessionId: x.identity.sessionId,
      tabId: x.identity.tabId,
      videoId: x.identity.videoId,
      epoch: x.identity.epoch,
      phase: x.phase,
      desired: x.desiredState,
      sourceMode: x.sourceMode,
      translation: x.translation,
      resources: x.resources,
      notice: x.notice,
      error: x.error && {
        code: x.error.code,
        category: x.error.category,
        message: x.error.message,
      },
    })),
    audioOwner: s.audioOwner,
  };
}

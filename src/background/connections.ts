/**
 * 端口封装：内容脚本连接与 UI 连接。所有入站消息先经 zod 校验再交给协调器。
 */
import type { Browser } from 'wxt/browser';
import {
  ContentToBackgroundSchema,
  type BackgroundToContent,
  type ContentRequest,
  type ContentToBackground,
} from '../messaging/content-protocol';
import {
  UiToBackgroundSchema,
  type BackgroundToUi,
  type UiToBackground,
} from '../messaging/ui-protocol';
import type { VerifiedContentSender, VerifiedExtensionSender } from '../messaging/ports';
import { PendingRequests } from './port-rpc';

/** 测试可替换的最小端口接口。 */
export interface PortLike {
  name: string;
  sender?: Browser.runtime.MessageSender;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export class ContentConnection {
  readonly tabId: number;
  readonly documentId: string | undefined;
  private readonly pending: PendingRequests;
  private connected = true;
  private messageListener?: (message: Exclude<ContentToBackground, { type: 'reply' }>) => void;
  private disconnectListener?: () => void;
  /** 被拒绝的消息计数（不记录内容）。 */
  rejectedMessages = 0;

  constructor(
    private readonly port: PortLike,
    readonly sender: VerifiedContentSender,
    randomId: (prefix?: string) => string,
  ) {
    this.tabId = sender.tabId;
    this.documentId = sender.documentId;
    this.pending = new PendingRequests(randomId);
    port.onMessage.addListener((raw) => {
      const parsed = ContentToBackgroundSchema.safeParse(raw);
      if (!parsed.success) {
        this.rejectedMessages++;
        return;
      }
      const msg = parsed.data;
      if (msg.type === 'reply') {
        this.pending.settle(
          msg.requestId,
          msg.ok ? { ok: true, data: msg.data } : { ok: false, error: msg.error },
        );
        return;
      }
      this.messageListener?.(msg);
    });
    port.onDisconnect.addListener(() => {
      this.connected = false;
      this.pending.closeAll();
      this.disconnectListener?.();
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onMessage(listener: (message: Exclude<ContentToBackground, { type: 'reply' }>) => void): void {
    this.messageListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }

  send(message: BackgroundToContent): boolean {
    if (!this.connected) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }

  /** navigationId：发起时 worker 认为的页面导航序号；页面已导航则内容脚本回复 stale 且不执行。 */
  request(request: ContentRequest, timeoutMs = 10_000, navigationId?: number): Promise<unknown> {
    return this.pending.create(timeoutMs, (requestId) => {
      const message =
        navigationId === undefined
          ? { type: 'request' as const, requestId, request }
          : { type: 'request' as const, requestId, request, navigationId };
      if (!this.send(message)) throw new Error('disconnected');
    });
  }

  disconnect(): void {
    try {
      this.port.disconnect();
    } catch {
      // 已断开
    }
    this.connected = false;
    this.pending.closeAll();
  }
}

export class UiConnection {
  private connected = true;
  subscribed = false;
  cueSessionId: string | null = null;
  rejectedMessages = 0;
  private messageListener?: (message: UiToBackground) => void;
  private disconnectListener?: () => void;

  constructor(
    private readonly port: PortLike,
    readonly sender: VerifiedExtensionSender,
  ) {
    port.onMessage.addListener((raw) => {
      const parsed = UiToBackgroundSchema.safeParse(raw);
      if (!parsed.success) {
        this.rejectedMessages++;
        const requestId =
          raw &&
          typeof raw === 'object' &&
          typeof (raw as { requestId?: unknown }).requestId === 'string'
            ? (raw as { requestId: string }).requestId.slice(0, 64) || undefined
            : undefined;
        if (requestId) {
          // 让 UI 明确知道命令被拒绝，而不是静默忽略。
          this.send({
            type: 'result',
            requestId,
            ok: false,
            error: {
              code: 'invalid-command',
              category: 'internal',
              retryable: false,
              message: '命令格式无效，已拒绝',
              at: Date.now(),
            },
          });
        }
        return;
      }
      this.messageListener?.(parsed.data);
    });
    port.onDisconnect.addListener(() => {
      this.connected = false;
      this.disconnectListener?.();
    });
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onMessage(listener: (message: UiToBackground) => void): void {
    this.messageListener = listener;
  }

  onDisconnect(listener: () => void): void {
    this.disconnectListener = listener;
  }

  send(message: BackgroundToUi): boolean {
    if (!this.connected) return false;
    try {
      this.port.postMessage(message);
      return true;
    } catch {
      this.connected = false;
      return false;
    }
  }
}

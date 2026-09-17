/**
 * service worker 侧的 offscreen 客户端契约（由 src/audio/offscreen-client.ts 实现）。
 *
 * 职责：按需创建唯一 offscreen 文档（并发去重）、维护端口与请求/响应、续租、
 * worker 重启后的握手核对，以及在无资源时关闭文档。
 */
import type {
  MediaAnchor,
  MediaOwner,
  OffscreenEvent,
  OffscreenRequest,
  OffscreenStatus,
} from '../messaging/offscreen-protocol';

export type OffscreenRequestOf<K extends OffscreenRequest['kind']> = Extract<
  OffscreenRequest,
  { kind: K }
>;

export interface OffscreenClient {
  /** 确保文档存在并完成握手；返回 offscreen 当前真实状态。 */
  ensure(): Promise<OffscreenStatus>;
  /** 仅查询；文档不存在时返回 null，不创建文档。 */
  queryStatus(): Promise<OffscreenStatus | null>;
  request<K extends OffscreenRequest['kind']>(
    request: OffscreenRequestOf<K>,
    timeoutMs?: number,
  ): Promise<unknown>;
  onEvent(listener: (event: OffscreenEvent) => void): () => void;
  /** offscreen 在 worker 启动后首次连接（含 worker 重启后的重连）时回调，用于核对孤立资源。 */
  onHello(listener: (status: OffscreenStatus) => void): () => void;
  /** 无捕获、无播放时关闭文档；有资源时不关闭。 */
  closeIfIdle(): Promise<boolean>;
}

export interface CaptureStartParams {
  owner: MediaOwner;
  streamId: string;
  anchor: MediaAnchor;
}

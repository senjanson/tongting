/**
 * 内容脚本生命周期与唤醒的安全判定（纯函数，便于测试）。
 */
import { isContentWakeMessage } from '../messaging/wake';

export interface WakeSenderLike {
  id?: string;
  tab?: unknown;
}

/** 只接受来自本扩展页面或 worker（无 sender.tab）的、形状严格的唤醒消息。 */
export function isTrustedWake(
  message: unknown,
  sender: WakeSenderLike | undefined,
  runtimeId: string | undefined,
): boolean {
  return (
    !!runtimeId &&
    !!sender &&
    sender.id === runtimeId &&
    sender.tab === undefined &&
    isContentWakeMessage(message)
  );
}

/**
 * WXT 的 ctx.onInvalidated 也会被页面伪造的 `…:wxt:content-script-started` 事件触发。
 * 只有扩展运行时真正失效（runtime.id 消失）时才执行清理。
 */
export function guardInvalidation(
  register: (cb: () => void) => void,
  isRuntimeAlive: () => boolean,
  cleanup: () => void,
): void {
  register(() => {
    if (!isRuntimeAlive()) cleanup();
  });
}

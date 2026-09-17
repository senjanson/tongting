/**
 * 快照接收规则（纯函数）。
 *
 * - 同一 worker 实例内只接受 snapshotVersion 更大的快照，避免乱序覆盖。
 * - workerInstanceId 变化表示 service worker 已重启，版本序列重新开始，接受新序列。
 * - 所有入站消息先经 zod 校验；不合法的消息丢弃。
 */
import {
  BackgroundToUiSchema,
  type AppSnapshot,
  type BackgroundToUi,
} from '../../messaging/ui-protocol';

export function shouldAcceptSnapshot(current: AppSnapshot | null, incoming: AppSnapshot): boolean {
  if (!current) return true;
  if (incoming.workerInstanceId !== current.workerInstanceId) return true;
  return incoming.snapshotVersion > current.snapshotVersion;
}

export function reduceSnapshot(
  current: AppSnapshot | null,
  incoming: AppSnapshot,
): AppSnapshot | null {
  return shouldAcceptSnapshot(current, incoming) ? incoming : current;
}

/** 校验来自 worker 的消息；不合法返回 null。 */
export function parseBackgroundMessage(raw: unknown): BackgroundToUi | null {
  const parsed = BackgroundToUiSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export type CuesMessage = Extract<BackgroundToUi, { type: 'cues' }>;
export type ResultMessage = Extract<BackgroundToUi, { type: 'result' }>;

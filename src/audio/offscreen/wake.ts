/**
 * worker → offscreen 的一次性唤醒消息（runtime.sendMessage）。
 *
 * offscreen 空闲时端口断开后不会主动重连（避免反复唤醒 worker 形成空保活）；
 * worker 需要与已存在的 offscreen 文档通信时发送该消息，offscreen 收到后重新连接 PORT_OFFSCREEN。
 * 消息不携带任何数据，offscreen 仍通过端口 hello/welcome 握手。
 */
import { z } from 'zod';

export const OFFSCREEN_WAKE_TYPE = 'tongting:offscreen-wake';

export const OffscreenWakeSchema = z.object({ type: z.literal(OFFSCREEN_WAKE_TYPE) }).strict();
export type OffscreenWake = z.infer<typeof OffscreenWakeSchema>;

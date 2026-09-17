/**
 * 模拟 worker 端口：收到 subscribe 后推送快照，收到 command 后按 handler 返回 result。
 */
import type { Cue } from '@src/domain/cue';
import type { AppSnapshot, UiCommand, UiToBackground } from '@src/messaging/ui-protocol';

export interface FakeWorker {
  port: unknown;
  received: UiToBackground[];
  commands(): UiCommand[];
  emit(message: unknown): void;
}

export function createFakeWorker(
  snapshot: AppSnapshot,
  handlers: Partial<Record<UiCommand['kind'], (command: UiCommand) => unknown>> = {},
  /** 订阅字幕时推送的全量字幕。 */
  cuesBySession: ReadonlyMap<string, Cue[]> = new Map(),
): FakeWorker {
  const listeners = new Set<(m: unknown) => void>();
  const received: UiToBackground[] = [];
  const emit = (message: unknown) => {
    for (const l of [...listeners]) l(message);
  };
  const port = {
    name: 'tongting:ui',
    postMessage(message: UiToBackground) {
      received.push(message);
      if (message.type === 'subscribe') queueMicrotask(() => emit({ type: 'snapshot', snapshot }));
      if (message.type === 'cues/subscribe' && message.sessionId) {
        const sessionId = message.sessionId;
        const cues = cuesBySession.get(sessionId);
        if (cues)
          queueMicrotask(() => emit({ type: 'cues', sessionId, cueVersion: 1, full: true, cues }));
      }
      if (message.type === 'command') {
        const handler = handlers[message.command.kind];
        queueMicrotask(() => {
          try {
            emit({
              type: 'result',
              requestId: message.requestId,
              ok: true,
              data: handler ? handler(message.command) : { accepted: true },
            });
          } catch (error) {
            emit({
              type: 'result',
              requestId: message.requestId,
              ok: false,
              error: {
                code: 'test',
                category: 'internal',
                retryable: false,
                message: String((error as Error).message),
              },
            });
          }
        });
      }
    },
    disconnect() {},
    onMessage: {
      addListener: (l: (m: unknown) => void) => listeners.add(l),
      removeListener: (l: (m: unknown) => void) => listeners.delete(l),
    },
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
  };
  return {
    port,
    received,
    emit,
    commands: () =>
      received
        .filter((m): m is Extract<UiToBackground, { type: 'command' }> => m.type === 'command')
        .map((m) => m.command),
  };
}

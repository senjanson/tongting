/**
 * 组件测试用的静态客户端：记录发出的命令，按 kind 返回预设结果。
 */
import type { Cue } from '@src/domain/cue';
import type { UiCommand } from '@src/messaging/ui-protocol';
import type { ClientState, ResultOf, UiClient } from '@src/ui/state/client';
import { IDLE_CUES_STATE, type CuesState } from '@src/ui/state/cues';

type Handler = (command: UiCommand) => unknown;

export class StaticClient implements UiClient {
  readonly mode = 'real' as const;
  readonly sent: UiCommand[] = [];
  readonly cueSubscriptions: string[] = [];
  private listeners = new Set<() => void>();
  private cueListeners = new Set<() => void>();
  cuesState: CuesState = IDLE_CUES_STATE;
  /** 预设各会话的全量字幕：acquireCues 时立即提供（模拟 worker 订阅后推送全量）。 */
  readonly cuesBySession = new Map<string, Cue[]>();

  constructor(
    public state: ClientState,
    private readonly handlers: Partial<Record<UiCommand['kind'], Handler>> = {},
  ) {}

  getState = () => this.state;
  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getCuesState = () => this.cuesState;
  subscribeCues = (l: () => void) => {
    this.cueListeners.add(l);
    return () => this.cueListeners.delete(l);
  };
  acquireCues(sessionId: string) {
    this.cueSubscriptions.push(sessionId);
    const cues = this.cuesBySession.get(sessionId);
    if (cues) this.setCues({ sessionId, status: 'ready', cueVersion: 1, cues });
    return () => undefined;
  }
  setState(state: ClientState) {
    this.state = state;
    for (const l of [...this.listeners]) l();
  }
  setCues(state: CuesState) {
    this.cuesState = state;
    for (const l of [...this.cueListeners]) l();
  }
  sendCommand<C extends UiCommand>(command: C): Promise<ResultOf<C>> {
    this.sent.push(command);
    const handler = this.handlers[command.kind];
    if (!handler) return Promise.resolve({ accepted: true } as ResultOf<C>);
    try {
      return Promise.resolve(handler(command) as ResultOf<C>);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

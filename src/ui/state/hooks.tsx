/**
 * React 绑定：客户端上下文、快照订阅、字幕订阅。
 */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { browser } from 'wxt/browser';
import type { UiSurface } from '../../messaging/ui-protocol';
import { BackgroundClient, type ClientState, type PortLike, type UiClient } from './client';
import { IDLE_CUES_STATE, type CuesState } from './cues';

export function createBrowserBackgroundClient(surface: UiSurface): BackgroundClient {
  return new BackgroundClient({
    surface,
    connect: (name) => {
      const port = browser.runtime.connect({ name });
      // 读取 lastError 表示已处理断开原因（例如 worker 尚未注册监听），避免控制台出现未检查错误。
      port.onDisconnect.addListener(() => void browser.runtime.lastError);
      return port as unknown as PortLike;
    },
  });
}

/**
 * 创建并维持与 worker 的真实连接（每个页面一个）。
 * 组件卸载时断开；React 严格模式下的重复挂载会先 stop 再 start。
 */
export function useBackground(
  surface: UiSurface,
  factory = createBrowserBackgroundClient,
): {
  client: BackgroundClient;
  state: ClientState;
} {
  const [client] = useState(() => factory(surface));
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const state = useSyncExternalStore(client.subscribe, client.getState, client.getState);
  return { client, state };
}

const UiClientContext = createContext<UiClient | null>(null);

export function UiClientProvider({ client, children }: { client: UiClient; children: ReactNode }) {
  return <UiClientContext.Provider value={client}>{children}</UiClientContext.Provider>;
}

export function useUiClient(): UiClient {
  const client = useContext(UiClientContext);
  if (!client) throw new Error('UiClientProvider 缺失');
  return client;
}

export function useClientState(): ClientState {
  const client = useUiClient();
  return useSyncExternalStore(client.subscribe, client.getState, client.getState);
}

const LOADING_BY_SESSION = new Map<string, CuesState>();

function loadingState(sessionId: string): CuesState {
  let state = LOADING_BY_SESSION.get(sessionId);
  if (!state) {
    state = { sessionId, status: 'loading', cueVersion: 0, cues: [] };
    if (LOADING_BY_SESSION.size > 50) LOADING_BY_SESSION.clear();
    LOADING_BY_SESSION.set(sessionId, state);
  }
  return state;
}

/** 订阅会话字幕（full + 增量）。sessionId 为空时返回 idle。 */
export function useCues(sessionId: string | null | undefined): CuesState {
  const client = useUiClient();
  useEffect(() => {
    if (!sessionId) return undefined;
    return client.acquireCues(sessionId);
  }, [client, sessionId]);
  const state = useSyncExternalStore(
    client.subscribeCues,
    client.getCuesState,
    client.getCuesState,
  );
  if (!sessionId) return IDLE_CUES_STATE;
  return state.sessionId === sessionId ? state : loadingState(sessionId);
}

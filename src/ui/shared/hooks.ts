/**
 * 页面共用的业务 hooks：命令执行、设置更新、滑块草稿、播放时钟、声音列表。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import type { PlayerState } from '../../domain/session';
import type { SettingsPatch } from '../../domain/settings';
import type { UiCommand } from '../../messaging/ui-protocol';
import { useToast } from '../components/toast';
import { errorInfoOf, errorMessageOf, type ResultOf } from '../state/client';
import { estimatePlayerTimeMs, type VoiceListState } from '../state/derive';
import { useClientState, useUiClient } from '../state/hooks';

/**
 * 发送命令并统一处理失败提示。返回结果或 undefined（失败时）。
 * busy 按 key 记录，用于按钮的「处理中」状态；不会阻止用户发出新的意图。
 */
export function useCommandRunner() {
  const client = useUiClient();
  const notify = useToast();
  const [busy, setBusy] = useState<Record<string, number>>({});

  const run = useCallback(
    async <C extends UiCommand>(
      command: C,
      options: { key?: string; errorPrefix?: string; quiet?: boolean } = {},
    ): Promise<ResultOf<C> | undefined> => {
      const key = options.key ?? command.kind;
      setBusy((b) => ({ ...b, [key]: (b[key] ?? 0) + 1 }));
      try {
        return await client.sendCommand(command);
      } catch (error) {
        if (errorInfoOf(error)?.code === 'stale-session') {
          // 命令针对的会话已被替换（例如换视频）：快照会随之刷新，不当作错误弹窗。
          notify('状态已变化，已刷新。', 'info');
          return undefined;
        }
        if (!options.quiet) {
          notify(
            options.errorPrefix
              ? `${options.errorPrefix}：${errorMessageOf(error)}`
              : errorMessageOf(error),
            'danger',
          );
        }
        return undefined;
      } finally {
        setBusy((b) => {
          const count = (b[key] ?? 1) - 1;
          const next = { ...b };
          if (count <= 0) delete next[key];
          else next[key] = count;
          return next;
        });
      }
    },
    [client, notify],
  );

  const isBusy = useCallback((key: string) => (busy[key] ?? 0) > 0, [busy]);
  return { run, isBusy };
}

/** 设置更新：persisted=false 时提示「仅本次生效，保存失败」。返回是否被 worker 接受。 */
export function useSettingsUpdater() {
  const client = useUiClient();
  const notify = useToast();
  return useCallback(
    async (patch: SettingsPatch): Promise<boolean> => {
      try {
        const result = await client.sendCommand({ kind: 'settings/update', patch });
        if (!result.persisted)
          notify('仅本次生效，保存失败。设置将在浏览器重启后丢失。', 'warning');
        return true;
      } catch (error) {
        notify(`设置未生效：${errorMessageOf(error)}`, 'danger');
        return false;
      }
    },
    [client, notify],
  );
}

/**
 * 滑块等连续输入的草稿值：拖动时立即显示本地值，停顿后提交；
 * 提交完成后短暂保留草稿，等待快照带回新值，避免闪回旧值。
 */
export function useDraftValue<T>(
  external: T,
  commit: (value: T) => Promise<unknown>,
  delayMs = 250,
) {
  const [draft, setDraft] = useState<{ value: T; active: boolean }>({
    value: external,
    active: false,
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ value: external, pending: false, revision: 0 });
  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!latest.current.pending) return;
    latest.current.pending = false;
    const value = latest.current.value;
    const revision = latest.current.revision;
    void commitRef.current(value).then(
      () => {
        if (latest.current.revision !== revision) return;
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => {
          setDraft((d) =>
            latest.current.revision === revision && !latest.current.pending
              ? { value, active: false }
              : d,
          );
        }, 800);
      },
      () => {
        setDraft((d) => (latest.current.revision === revision ? { value, active: false } : d));
      },
    );
  }, []);

  const onChange = useCallback(
    (value: T) => {
      latest.current = { value, pending: true, revision: latest.current.revision + 1 };
      setDraft({ value, active: true });
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, delayMs);
    },
    [delayMs, flush],
  );

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
      flush();
    },
    [flush],
  );

  return [draft.active ? draft.value : external, onChange] as const;
}

/** 按快照采样时间推算当前播放时间，每 250ms 刷新。 */
export function usePlayerClock(player: PlayerState | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  const moving =
    !!player &&
    !player.paused &&
    !player.buffering &&
    !player.seeking &&
    !player.ended &&
    !player.ad;
  useEffect(() => {
    if (!moving) return undefined;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [moving]);
  return estimatePlayerTimeMs(player, moving ? now : (player?.sampledAtEpochMs ?? now));
}

/** 读取 worker 提供的实际声音列表（tts/voices）；依赖变化时重新读取。 */
export function useVoiceList(
  enabled: boolean,
  reloadKey: string,
): { state: VoiceListState; reload(): void } {
  const client = useUiClient();
  const { connection } = useClientState();
  const [state, setState] = useState<VoiceListState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);
  const connected = connection === 'connected';

  useEffect(() => {
    if (!enabled || !connected) return undefined;
    let cancelled = false;
    // 异步读取：先置 loading，结果回来时若已切换依赖则丢弃。
    queueMicrotask(() => {
      if (!cancelled) setState({ status: 'loading' });
    });
    client.sendCommand({ kind: 'tts/voices' }).then(
      (result) => {
        if (!cancelled) setState({ status: 'ready', voices: result.voices });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: errorMessageOf(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, enabled, connected, reloadKey, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!enabled || !connected || client.mode === 'demo') return undefined;
    // 系统安装/移除声音后及时更新；从系统设置返回时也重新读取。
    const changed = browser.tts?.onVoicesChanged;
    changed?.addListener(reload);
    window.addEventListener('focus', reload);
    return () => {
      changed?.removeListener(reload);
      window.removeEventListener('focus', reload);
    };
  }, [client, enabled, connected, reload]);
  return { state, reload };
}

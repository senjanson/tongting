/**
 * 某字幕记录的收藏状态。
 *
 * - 列表读取完成前收藏按钮不可用，避免读取结果覆盖在此期间的修改。
 * - 写入使用期望状态（设置/取消），不做盲目切换；同一条在途时忽略重复点击。
 * - recordId 变化时重置在途状态；旧记录的迟到结果不会写入新记录的显示。
 * - recordId 缺失（快照尚未确定字幕记录）时收藏不可用。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Cue } from '../../domain/cue';
import { useT } from '../../i18n/react';
import { useToast } from '../components/toast';
import { useRepos } from '../state/repos';

export interface FavoritesState {
  ids: ReadonlySet<string>;
  /** 收藏是否可操作（recordId 已知且列表已加载）。 */
  ready: boolean;
  loading: boolean;
  loadFailed: boolean;
  pending: ReadonlySet<string>;
  toggle(cue: Cue): Promise<void>;
}

const EMPTY: ReadonlySet<string> = new Set<string>();

export function useFavorites(
  recordId: string | undefined,
  videoId: string | undefined,
): FavoritesState {
  const { favorites } = useRepos();
  const notify = useToast();
  const t = useT();
  const [loaded, setLoaded] = useState<{
    recordId: string;
    ids: Set<string>;
    failed: boolean;
  } | null>(null);
  const [pending, setPending] = useState<{ recordId: string | undefined; ids: Set<string> }>({
    recordId,
    ids: new Set(),
  });
  // 在途写入以 `${recordId}|${cueId}` 记录，recordId 变化后旧条目自然失效。
  const inFlight = useRef(new Set<string>());
  const currentRecord = useRef(recordId);
  const loadedRef = useRef(loaded);
  useEffect(() => {
    currentRecord.current = recordId;
    loadedRef.current = loaded;
  });

  useEffect(() => {
    if (!recordId) return undefined;
    let cancelled = false;
    favorites.listByRecord(recordId).then(
      (records) => {
        if (!cancelled)
          setLoaded({ recordId, ids: new Set(records.map((r) => r.cueId)), failed: false });
      },
      () => {
        if (!cancelled) setLoaded({ recordId, ids: new Set(), failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [favorites, recordId]);

  const current = recordId && loaded && loaded.recordId === recordId ? loaded : null;
  const pendingIds = pending.recordId === recordId ? pending.ids : EMPTY;

  const toggle = useCallback(
    async (cue: Cue) => {
      const loadedNow = loadedRef.current;
      if (
        !recordId ||
        !videoId ||
        !loadedNow ||
        loadedNow.recordId !== recordId ||
        loadedNow.failed
      )
        return;
      const key = `${recordId}|${cue.id}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      const desired = !loadedNow.ids.has(cue.id);
      setPending((p) => ({
        recordId,
        ids: new Set(p.recordId === recordId ? p.ids : []).add(cue.id),
      }));
      try {
        const favorited = await favorites.set(
          {
            recordId,
            videoId,
            cueId: cue.id,
            startMs: cue.startMs,
            endMs: cue.endMs,
            sourceText: cue.sourceText,
            ...(cue.translatedText !== undefined && cue.translationState === 'done'
              ? { translatedText: cue.translatedText }
              : {}),
          },
          desired,
        );
        setLoaded((l) => {
          if (!l || l.recordId !== recordId) return l;
          const ids = new Set(l.ids);
          if (favorited) ids.add(cue.id);
          else ids.delete(cue.id);
          loadedRef.current = { ...l, ids };
          return { ...l, ids };
        });
      } catch {
        if (currentRecord.current === recordId)
          notify(t('options.transcript.favoriteSaveFailed'), 'danger');
      } finally {
        inFlight.current.delete(key);
        setPending((p) => {
          if (p.recordId !== recordId) return p;
          const ids = new Set(p.ids);
          ids.delete(cue.id);
          return { recordId, ids };
        });
      }
    },
    [favorites, notify, recordId, t, videoId],
  );

  return {
    ids: current?.ids ?? EMPTY,
    ready: !!current && !current.failed,
    loading: !!recordId && !current,
    loadFailed: current?.failed ?? false,
    pending: pendingIds,
    toggle,
  };
}

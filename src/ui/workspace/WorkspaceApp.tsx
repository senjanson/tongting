/**
 * 字幕工作台（workspace.html）：左侧本地字幕记录（含尚未落库的实时会话），中间字幕，右侧该视频笔记。
 *
 * - 源标签页仍在快照 pages 中时可点击时间跳转；否则提示播放控制不可用。
 * - 与会话匹配（快照 recordId）时显示实时字幕；会话结束、点「刷新记录」或窗口获得焦点时重新读取记录。
 * - 实时会话出现、结束或 recordId 变化时（去抖后）重新读取记录列表；刚结束的会话在重新读取完成前保留条目，
 *   之后由它写入的本地记录取代。
 * - 属于未结束会话的记录不能删除：worker 在防抖保存与停止时会写回完整记录。
 * - 未显式选择时，首次隐式选中的记录会被固定，重新读取列表不会跳到别的记录。
 * - 笔记按 videoId 保存，与字幕记录独立；保存按 updatedAt 检测冲突，保存失败的内容保留为草稿。
 * - 界面语言取自快照中的 settings.uiLocale；快照到达前按浏览器界面语言显示。
 */
import { ExternalLink, MonitorPlay, Quote, RefreshCw, Trash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findActiveCue, type Cue } from '../../domain/cue';
import type { PageInfo, SessionSnapshot } from '../../domain/session';
import { describeCoverage, isCompleteCoverage } from '../../export';
import type { MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { getNote, NoteConflictError, saveNoteChecked } from '../../storage/notes';
import {
  deleteTranscript,
  listTranscriptSummaries,
  loadTranscript,
  type LoadedTranscript,
  type TranscriptSummary,
} from '../../storage/transcripts';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, Hint, IconButton, Spinner, TextArea } from '../components/controls';
import { Brand, Callout, EmptyState, ReconnectBanner } from '../components/layout';
import { ToastProvider, useToast } from '../components/toast';
import { formatDateTime, languageLabel, sourceLanguageLabel } from '../format';
import { useCommandRunner, usePlayerClock } from '../shared/hooks';
import { SnapshotI18nProvider } from '../shared/LocaleRoot';
import { focusTab } from '../shared/navigation';
import { isSessionEnded, sourceModeShortLabel } from '../state/derive';
import { UiClientProvider, useBackground, useClientState, useCues } from '../state/hooks';
import { cueQuote } from '../transcript/text';
import { TranscriptView, type TranscriptSource } from '../transcript/TranscriptView';
import { NoteAutosaver, type NoteSaveStatus } from './note-autosaver';
import {
  clearNoteDraft,
  readNoteDraft,
  readNoteDrafts,
  writeNoteDraft,
  type NoteDraft,
} from './note-drafts';
import styles from './workspace.module.css';

const RECORD_LIST_LIMIT = 200;
/** 实时会话变化后，重新读取记录列表前的去抖时间。 */
const LIVE_RELOAD_DEBOUNCE_MS = 300;
const NOTES_CHANNEL = 'tongting:notes';

function initialVideoId(): string | null {
  try {
    const value = new URLSearchParams(window.location.search).get('videoId');
    return value && /^[A-Za-z0-9_-]{6,20}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function WorkspaceApp() {
  const { client } = useBackground('workspace');
  return (
    <UiClientProvider client={client}>
      <LocalizedWorkspace />
    </UiClientProvider>
  );
}

function LocalizedWorkspace() {
  return (
    <SnapshotI18nProvider>
      <ToastProvider>
        <WorkspaceView />
      </ToastProvider>
    </SnapshotI18nProvider>
  );
}

type RecordsState =
  | { status: 'loading' }
  | {
      status: 'ready';
      records: TranscriptSummary[];
      /** 开始读取时的实时会话变化代数（见 LiveRecords.generation）。 */
      generation: number;
    }
  | { status: 'error' };

/** 离开实时状态（结束，或通常直接从快照中移除）的会话。 */
interface EndedLive {
  /** 离开时的变化代数：此后开始的列表读取才一定包含它最后写入的记录。 */
  generation: number;
  /** 最后已知的会话快照，用于在重新读取完成前暂时保留列表条目。 */
  session: SessionSnapshot;
}

/** 快照中未结束的会话及其变化历史。 */
interface LiveRecords {
  /** 未结束会话的 recordId 与 sessionId（排序后序列化），用于判断是否变化。 */
  key: string;
  /** recordId → 未结束的会话（上次变化时的快照）。 */
  sessions: ReadonlyMap<string, SessionSnapshot>;
  /** 变化代数：会话出现、结束或 recordId 变化时加一（按次数计，A→B→A 也会重新读取）。 */
  generation: number;
  ended: ReadonlyMap<string, EndedLive>;
}

function liveSessionsKey(snapshot: AppSnapshot | null): string {
  const pairs: string[] = [];
  for (const session of snapshot?.sessions ?? []) {
    if (session.recordId && !isSessionEnded(session))
      pairs.push(`${session.recordId}\n${session.identity.sessionId}`);
  }
  return JSON.stringify(pairs.sort());
}

/** recordId → 未结束的会话（同一记录有多个时取最近更新的）。 */
function liveSessionsByRecord(snapshot: AppSnapshot | null): Map<string, SessionSnapshot> {
  const sessions = new Map<string, SessionSnapshot>();
  for (const session of snapshot?.sessions ?? []) {
    if (!session.recordId || isSessionEnded(session)) continue;
    const current = sessions.get(session.recordId);
    if (!current || session.updatedAt > current.updatedAt) sessions.set(session.recordId, session);
  }
  return sessions;
}

/** 记录是否属于未结束的会话：worker 在防抖保存与停止时会写回完整记录，此时删除会被写回。 */
export function isRecordInUse(snapshot: AppSnapshot | null, recordId: string): boolean {
  return !!snapshot?.sessions.some((s) => s.recordId === recordId && !isSessionEnded(s));
}

/** 列表条目：本地记录，或尚未写入本地记录的实时会话。 */
interface ListEntry {
  recordId: string;
  videoId: string;
  title?: string;
  sourceLanguage: string;
  targetLanguage: string;
  sourceMode: TranscriptSummary['sourceMode'];
  complete: boolean;
  cueCount?: number;
  updatedAt: number;
  liveOnly: boolean;
  /** 仅 liveOnly：会话已结束，正在等待重新读取它写入的本地记录。 */
  ended: boolean;
}

/** 与记录匹配的会话：只按快照 recordId 匹配，优先未出错、最近更新的。 */
export function findLiveSession(
  snapshot: AppSnapshot | null,
  recordId: string,
): SessionSnapshot | undefined {
  if (!snapshot) return undefined;
  return snapshot.sessions
    .filter((s) => s.recordId === recordId)
    .sort((a, b) => {
      const errA = a.phase === 'error' ? 1 : 0;
      const errB = b.phase === 'error' ? 1 : 0;
      return errA - errB || b.updatedAt - a.updatedAt;
    })[0];
}

function sessionEntry(
  recordId: string,
  session: SessionSnapshot,
  snapshot: AppSnapshot | null,
  ended: boolean,
): ListEntry {
  const page = snapshot?.pages.find(
    (p) => p.tabId === session.identity.tabId && p.videoId === session.identity.videoId,
  );
  return {
    recordId,
    videoId: session.identity.videoId,
    title: page?.title ?? session.player?.title,
    sourceLanguage: session.sourceTrack?.languageCode ?? session.detectedSourceLanguage ?? 'und',
    targetLanguage: session.targetLanguage,
    sourceMode: session.sourceMode,
    complete: isCompleteCoverage(session.coverage, session.sourceMode),
    updatedAt: session.updatedAt,
    liveOnly: true,
    ended,
  };
}

function buildEntries(
  records: TranscriptSummary[],
  readGeneration: number,
  ended: ReadonlyMap<string, EndedLive>,
  snapshot: AppSnapshot | null,
): ListEntry[] {
  const entries: ListEntry[] = records.map((r) => ({
    recordId: r.recordId,
    videoId: r.videoId,
    title: r.title,
    sourceLanguage: r.sourceLanguage,
    targetLanguage: r.targetLanguage,
    sourceMode: r.sourceMode,
    complete: isCompleteCoverage(r.coverage, r.sourceMode),
    cueCount: r.cueCount,
    updatedAt: r.updatedAt,
    liveOnly: false,
    ended: false,
  }));
  const known = new Set(entries.map((e) => e.recordId));
  for (const session of snapshot?.sessions ?? []) {
    if (!session.recordId || known.has(session.recordId) || isSessionEnded(session)) continue;
    known.add(session.recordId);
    entries.unshift(sessionEntry(session.recordId, session, snapshot, false));
  }
  // 刚结束的会话（正常停止后会从快照中移除）：在本次列表读取开始之后才结束时暂时保留条目——
  // 它最后写入的记录可能不在读取结果中；会话变化触发的重新读取完成后由本地记录取代，从未写入时随之消失。
  for (const [recordId, { generation, session }] of ended) {
    if (known.has(recordId) || generation <= readGeneration) continue;
    known.add(recordId);
    const latest = findLiveSession(snapshot, recordId) ?? session;
    entries.unshift(sessionEntry(recordId, latest, snapshot, true));
  }
  return entries;
}

function WorkspaceView() {
  const { connection, snapshot } = useClientState();
  const t = useT();
  const notify = useToast();
  const locale = useLocale();
  const documentTitle = t('options.workspace.documentTitle');
  useEffect(() => {
    document.title = documentTitle;
    document.documentElement.lang = locale;
  }, [documentTitle, locale]);
  const [records, setRecords] = useState<RecordsState>({ status: 'loading' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selection, setSelection] = useState<{ recordId: string | null; videoId: string | null }>(
    () => ({ recordId: null, videoId: initialVideoId() }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  // 记录实时会话的变化与刚结束的会话（渲染期间按条件更新，React 推荐的派生方式）。
  const liveKey = liveSessionsKey(snapshot);
  const [live, setLive] = useState<LiveRecords>(() => ({
    key: liveKey,
    sessions: liveSessionsByRecord(snapshot),
    generation: 0,
    ended: new Map(),
  }));
  if (live.key !== liveKey) {
    const sessions = liveSessionsByRecord(snapshot);
    const generation = live.generation + 1;
    const readGeneration = records.status === 'ready' ? records.generation : -1;
    // 已被某次读取覆盖的结束会话不再需要保留。
    const ended = new Map([...live.ended].filter(([, e]) => e.generation > readGeneration));
    for (const [recordId, session] of live.sessions) {
      if (!sessions.has(recordId)) ended.set(recordId, { generation, session });
    }
    for (const recordId of sessions.keys()) ended.delete(recordId);
    setLive({ key: liveKey, sessions, generation, ended });
  }
  // 列表读取开始时记录当前代数；在读取的 effect 之前更新（同一次提交中按声明顺序执行）。
  const liveGeneration = useRef(live.generation);
  useEffect(() => {
    liveGeneration.current = live.generation;
  }, [live.generation]);
  // 会话变化后去抖再重新读取：同一时刻多个会话开始/结束只读取一次。
  const [listGeneration, setListGeneration] = useState(live.generation);
  useEffect(() => {
    if (listGeneration === live.generation) return undefined;
    const target = live.generation;
    const timer = setTimeout(() => setListGeneration(target), LIVE_RELOAD_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [live.generation, listGeneration]);

  useEffect(() => {
    let cancelled = false;
    const generation = liveGeneration.current;
    // 依赖变化时取消上一次读取：迟到的旧结果不会覆盖更新的列表。
    listTranscriptSummaries({ limit: RECORD_LIST_LIMIT }).then(
      (list) => {
        if (cancelled) return;
        setRecords({ status: 'ready', records: list, generation });
        // 首次隐式选择后固定 recordId，后续重新读取不再跳到别的记录。
        setSelection((prev) => {
          if (prev.recordId) return prev;
          const implicit = list.find((r) => (prev.videoId ? r.videoId === prev.videoId : true));
          return implicit ? { recordId: implicit.recordId, videoId: implicit.videoId } : prev;
        });
      },
      () => {
        if (!cancelled) setRecords({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [reloadNonce, listGeneration]);

  useEffect(() => {
    const onFocus = () => setReloadNonce((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const ended = live.ended;
  const entries = useMemo(
    () =>
      records.status === 'ready'
        ? buildEntries(records.records, records.generation, ended, snapshot)
        : [],
    [records, ended, snapshot],
  );
  const selected = selection.recordId
    ? entries.find((e) => e.recordId === selection.recordId)
    : undefined;
  const videoId = selected?.videoId ?? selection.videoId;

  const onDelete = async () => {
    if (!selected) return;
    if (isRecordInUse(snapshot, selected.recordId)) {
      // 确认期间开始了翻译：删除会被 worker 写回，不执行。
      notify(t('options.workspace.deleteInUse'), 'warning');
      setConfirmDelete(false);
      return;
    }
    try {
      await deleteTranscript(selected.recordId);
      notify(t('options.workspace.deleted'), 'success');
      setSelection({ recordId: null, videoId: selected.videoId });
      setReloadNonce((n) => n + 1);
    } catch {
      notify(t('options.workspace.deleteFailed'), 'danger');
    } finally {
      setConfirmDelete(false);
    }
  };

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Brand />
          <h1>{t('options.workspace.title')}</h1>
        </div>
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      <div className={styles.layout}>
        <section
          className={`${styles.panel} ${styles.recordsPanel}`}
          aria-label={t('options.workspace.records')}
        >
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>
              {t('options.workspace.records')}
              {records.status === 'ready' && entries.length > 0 && (
                <span className={styles.panelCount}>{entries.length}</span>
              )}
            </span>
            <IconButton
              bare
              label={t('options.workspace.refresh')}
              icon={<RefreshCw size={15} aria-hidden="true" />}
              onClick={() => setReloadNonce((n) => n + 1)}
            />
          </div>
          <RecordList
            state={records}
            entries={entries}
            selectedId={selected?.recordId}
            onSelect={(e) => setSelection({ recordId: e.recordId, videoId: e.videoId })}
          />
        </section>

        <section
          className={`${styles.panel} ${styles.mainPanel}`}
          aria-label={t('options.workspace.subtitles')}
        >
          {selected ? (
            <RecordDetail
              key={selected.recordId}
              entry={selected}
              snapshot={snapshot}
              reloadNonce={reloadNonce}
              onDelete={() => setConfirmDelete(true)}
            />
          ) : (
            <EmptyState
              icon={<MonitorPlay size={20} aria-hidden="true" />}
              title={t(
                records.status === 'loading'
                  ? 'options.workspace.loadingRecords'
                  : 'options.workspace.noneSelected',
              )}
            >
              {t(
                records.status === 'error'
                  ? 'options.workspace.readFailed'
                  : videoId
                    ? 'options.workspace.noRecordForVideo'
                    : entries.length === 0
                      ? 'options.workspace.emptyList'
                      : 'options.workspace.pickOne',
              )}
            </EmptyState>
          )}
        </section>

        <section
          className={`${styles.panel} ${styles.notesPanel}`}
          aria-label={t('options.workspace.notes')}
        >
          {videoId ? (
            <NotesPanel
              key={videoId}
              videoId={videoId}
              snapshot={snapshot}
              recordId={selected?.recordId}
              reloadNonce={reloadNonce}
            />
          ) : (
            <EmptyState title={t('options.workspace.notes')}>
              {t('options.workspace.notesEmpty')}
            </EmptyState>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title={t('options.workspace.deleteTitle')}
        confirmLabel={t('options.workspace.deleteRecord')}
        danger
        onConfirm={() => void onDelete()}
        onCancel={() => setConfirmDelete(false)}
      >
        {t('options.workspace.deleteBody')}
      </ConfirmDialog>
    </div>
  );
}

function RecordList({
  state,
  entries,
  selectedId,
  onSelect,
}: {
  state: RecordsState;
  entries: ListEntry[];
  selectedId: string | undefined;
  onSelect(entry: ListEntry): void;
}) {
  const t = useT();
  const locale = useLocale();
  if (state.status === 'loading')
    return <EmptyState icon={<Spinner />} title={t('options.workspace.loading')} />;
  if (state.status === 'error')
    return <Callout tone="danger">{t('options.workspace.listFailed')}</Callout>;
  if (entries.length === 0) return <EmptyState title={t('options.workspace.noRecords')} />;
  return (
    <ul className={styles.records}>
      {entries.map((entry) => (
        <li key={entry.recordId}>
          <button
            type="button"
            className={styles.record}
            aria-current={entry.recordId === selectedId ? 'true' : undefined}
            onClick={() => onSelect(entry)}
          >
            <span className={styles.recordTitle}>{entry.title || entry.videoId}</span>
            <span className={styles.recordMeta}>
              {sourceLanguageLabel(entry.sourceLanguage, locale)} →{' '}
              {languageLabel(entry.targetLanguage, locale)} ·{' '}
              {sourceModeShortLabel(entry.sourceMode, locale)}
            </span>
            <span className={styles.recordMeta}>
              {entry.liveOnly
                ? t(
                    entry.ended
                      ? 'options.workspace.endedLoading'
                      : 'options.workspace.liveUnsaved',
                  )
                : `${t(entry.complete ? 'options.workspace.completeTrack' : 'options.workspace.partial')} · ${t('options.workspace.cueCount', { count: entry.cueCount ?? 0 })} · ${formatDateTime(entry.updatedAt, locale)}`}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function findSourcePage(
  snapshot: AppSnapshot | null,
  videoId: string,
  session: SessionSnapshot | undefined,
): PageInfo | undefined {
  if (!snapshot) return undefined;
  const pages = snapshot.pages.filter((p) => p.videoId === videoId);
  return pages.find((p) => p.tabId === session?.identity.tabId) ?? pages[0];
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; loaded: LoadedTranscript | undefined }
  | { status: 'error' };

/**
 * 读取记录；会话结束/消失、「刷新记录」、窗口获得焦点（reloadNonce）时重新读取。
 */
function useRecord(recordId: string | undefined, reloadKey: string): LoadState {
  const [state, setState] = useState<{ key: string; value: LoadState } | null>(null);
  const key = `${recordId}|${reloadKey}`;
  useEffect(() => {
    if (!recordId) return undefined;
    let cancelled = false;
    loadTranscript(recordId).then(
      (loaded) => {
        if (!cancelled) setState({ key, value: { status: 'ready', loaded } });
      },
      () => {
        if (!cancelled) setState({ key, value: { status: 'error' } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [recordId, key]);
  // 重新读取期间保留上一次结果，避免闪烁；但不沿用「记录不存在」：会话刚结束时，
  // 它最后写入的记录正在读取，不能先显示「已不存在」。
  if (!state) return { status: 'loading' };
  if (state.key !== key && state.value.status === 'ready' && !state.value.loaded) {
    return { status: 'loading' };
  }
  return state.value;
}

function sessionReloadKey(session: SessionSnapshot | undefined, reloadNonce: number): string {
  if (!session) return `none|${reloadNonce}`;
  return `${session.identity.sessionId}|${isSessionEnded(session) ? 'ended' : 'live'}|${reloadNonce}`;
}

function RecordDetail({
  entry,
  snapshot,
  reloadNonce,
  onDelete,
}: {
  entry: ListEntry;
  snapshot: AppSnapshot | null;
  reloadNonce: number;
  onDelete(): void;
}) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const { run } = useCommandRunner();
  const session = findLiveSession(snapshot, entry.recordId);
  const liveSession = session && !isSessionEnded(session) ? session : undefined;
  const loadState = useRecord(entry.recordId, sessionReloadKey(liveSession, reloadNonce));
  const liveCues = useCues(liveSession?.identity.sessionId);
  const loaded = loadState.status === 'ready' ? loadState.loaded : undefined;
  const record = loaded?.record;
  const page = findSourcePage(snapshot, entry.videoId, session);
  const time = usePlayerClock(page?.player);
  const useLive = !!liveSession && liveCues.status === 'ready';
  const inUse = isRecordInUse(snapshot, entry.recordId);

  const source: TranscriptSource = useMemo(
    () => ({
      kind: useLive ? 'live' : 'record',
      recordId: entry.recordId,
      videoId: entry.videoId,
      title: record?.title ?? entry.title,
      targetLanguage: record?.targetLanguage ?? entry.targetLanguage,
      sourceLanguage: record?.sourceLanguage ?? entry.sourceLanguage,
      sourceMode: liveSession?.sourceMode ?? record?.sourceMode ?? entry.sourceMode,
      coverage: liveSession?.coverage ?? record?.coverage,
    }),
    [entry, record, liveSession, useLive],
  );

  const onSeek = useCallback(
    (timeMs: number) => {
      if (!page) return;
      void run(
        { kind: 'player/seek', tabId: page.tabId, timeMs },
        { errorPrefix: t('options.workspace.seekFailed') },
      );
    },
    [page, run, t],
  );

  if (loadState.status === 'loading' && !liveSession) {
    return <EmptyState icon={<Spinner />} title={t('options.workspace.loadingSubtitles')} />;
  }
  if (loadState.status === 'error' && !liveSession) {
    return <Callout tone="danger">{t('options.workspace.recordReadFailed')}</Callout>;
  }
  if (!record && !liveSession) {
    return (
      <EmptyState title={t('options.workspace.recordGone')}>
        {t('options.workspace.recordGoneBody')}
      </EmptyState>
    );
  }

  const cues = useLive ? liveCues.cues : (record?.cues ?? []);

  return (
    <div className={styles.main}>
      <div className={styles.mainHead}>
        <div className={styles.mainHeadText}>
          <div className={styles.mainTitle}>{source.title || entry.videoId}</div>
          <div className={styles.mainMeta}>
            {sourceLanguageLabel(source.sourceLanguage, locale)} →{' '}
            {languageLabel(source.targetLanguage, locale)} ·{' '}
            {sourceModeShortLabel(source.sourceMode, locale)}
            {record?.sourceLabel
              ? t('options.workspace.sourceLabel', { label: record.sourceLabel })
              : ''}
            {record
              ? t('options.workspace.updatedAt', { time: formatDateTime(record.updatedAt, locale) })
              : t('options.workspace.notSaved')}
          </div>
          <div className={styles.mainMeta}>
            {describeCoverage(source.coverage, source.sourceMode, locale)}
          </div>
        </div>
        <div className={styles.mainActions}>
          {page && (
            <Button
              size="sm"
              icon={<ExternalLink size={14} aria-hidden="true" />}
              onClick={() =>
                focusTab(page.tabId).catch(() =>
                  notify(t('options.workspace.focusFailed'), 'danger'),
                )
              }
            >
              {t('options.workspace.focusTab')}
            </Button>
          )}
          {record && (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash size={14} aria-hidden="true" />}
              disabled={loaded?.readOnly || inUse}
              title={inUse ? t('options.workspace.deleteInUse') : undefined}
              onClick={onDelete}
            >
              {t('options.workspace.deleteRecord')}
            </Button>
          )}
        </div>
      </div>
      {record && inUse && <Hint>{t('options.workspace.deleteInUse')}</Hint>}
      {loaded?.readOnly && <Callout tone="warning">{t('options.workspace.readOnly')}</Callout>}
      {!!loaded?.invalidCueCount && !useLive && (
        <Hint>{t('options.workspace.invalidCues', { count: loaded.invalidCueCount })}</Hint>
      )}
      <div className={styles.transcript}>
        <TranscriptView
          cues={cues}
          loading={!!liveSession && liveCues.status === 'loading' && !record}
          source={source}
          currentTimeMs={page ? time : undefined}
          captionOffsetMs={snapshot?.settings.captions.offsetMs ?? 0}
          onSeek={page ? onSeek : undefined}
          seekUnavailableReason={t('options.workspace.seekUnavailable')}
          onQuote={(cue) =>
            window.dispatchEvent(new CustomEvent<Cue>(QUOTE_EVENT, { detail: cue }))
          }
        />
      </div>
    </div>
  );
}

/** 字幕列表与笔记面板之间的「引用」事件（同一页面内）。 */
const QUOTE_EVENT = 'tongting:quote-cue';

const STATUS_TEXT: Record<NoteSaveStatus, MessageKey> = {
  idle: 'options.workspace.noteStatus.idle',
  pending: 'options.workspace.noteStatus.pending',
  saving: 'options.workspace.noteStatus.saving',
  saved: 'options.workspace.noteStatus.saved',
  error: 'options.workspace.noteStatus.error',
  conflict: 'options.workspace.noteStatus.conflict',
};

function isConflict(error: unknown): boolean {
  return error instanceof NoteConflictError;
}

/** 本页在一次读取中写入的草稿（关闭页面或切换视频时仍有未保存内容）；text 为 null 表示尚未写入。 */
interface OwnDraft {
  id: string;
  text: string | null;
}

function NotesPanel({
  videoId,
  snapshot,
  recordId,
  reloadNonce,
}: {
  videoId: string;
  snapshot: AppSnapshot | null;
  recordId: string | undefined;
  reloadNonce: number;
}) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const [load, setLoad] = useState<{ status: 'loading' | 'ready' | 'error'; nonce: number }>({
    status: 'loading',
    nonce: 0,
  });
  const [text, setText] = useState('');
  const [saveStatus, setSaveStatus] = useState<NoteSaveStatus>('idle');
  const [loadNonce, setLoadNonce] = useState(0);
  // A refresh immediately stops editing, including the render before its effect runs.
  const loadStatus = load.nonce === loadNonce ? load.status : 'loading';
  const [draft, setDraft] = useState<NoteDraft | undefined>(undefined);
  const saverRef = useRef<NoteAutosaver | null>(null);
  /** 与 saverRef 同时设置：beforeunload 写入的草稿与卸载时写入的是同一份。 */
  const ownDraftRef = useRef<OwnDraft | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef('');
  /** 本页读取或上次成功保存时的 updatedAt，用于冲突检测。 */
  const baseUpdatedAt = useRef(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  /** 用户选择「载入最新版本」时放弃本页修改，不写入草稿。 */
  const discardUnsaved = useRef(false);

  const liveSession = recordId ? findLiveSession(snapshot, recordId) : undefined;
  const activeLive = liveSession && !isSessionEnded(liveSession) ? liveSession : undefined;
  const page = snapshot?.pages.find(
    (p) => p.videoId === videoId && (!liveSession || p.tabId === liveSession.identity.tabId),
  );
  const time = usePlayerClock(page?.player);
  const liveCues = useCues(activeLive?.identity.sessionId);
  const recordState = useRecord(recordId, sessionReloadKey(activeLive, reloadNonce));
  const recordCues = recordState.status === 'ready' ? (recordState.loaded?.record.cues ?? []) : [];

  // 读取笔记；读取失败时禁止编辑，避免空内容覆盖已有笔记。
  // 草稿只删除内容已保存的、与笔记相同的、本页写入且已保存的，或用户丢弃的那份；
  // 用户尚未处理的旧草稿在切换视频、重新读取、另行编辑保存后都保留。
  useEffect(() => {
    let cancelled = false;
    const own: OwnDraft = { id: crypto.randomUUID(), text: null };
    getNote(videoId).then(
      (note) => {
        if (cancelled) return;
        const baseline = note?.text ?? '';
        baseUpdatedAt.current = note?.updatedAt ?? 0;
        textRef.current = baseline;
        setText(baseline);
        setLoad({ status: 'ready', nonce: loadNonce });
        setSaveStatus('idle');
        // 与已保存笔记相同的草稿是多余的。
        clearNoteDraft(videoId, { text: baseline });
        setDraft(readNoteDraft(videoId));
        ownDraftRef.current = own;
        saverRef.current = new NoteAutosaver({
          videoId,
          baseline,
          save: async (id, value) => {
            const saved = await saveNoteChecked(id, value, baseUpdatedAt.current);
            baseUpdatedAt.current = saved.updatedAt;
            // 内容已保存的草稿（例如恢复后保存的那份）不再需要。
            clearNoteDraft(id, { text: value });
            // 本页写入的草稿是输入框较早的内容：仍在编辑且输入框当前内容已保存时一并删除
            // （卸载后由上一行按内容、或 dispose 成功后按 id 删除）。
            if (ownDraftRef.current === own && own.text !== null && value === textRef.current) {
              clearNoteDraft(id, { id: own.id });
              own.text = null;
            }
            channelRef.current?.postMessage({ videoId: id, updatedAt: saved.updatedAt });
          },
          isConflict,
          onStatus: setSaveStatus,
        });
      },
      () => {
        if (!cancelled) setLoad({ status: 'error', nonce: loadNonce });
      },
    );
    return () => {
      cancelled = true;
      const saver = saverRef.current;
      saverRef.current = null;
      ownDraftRef.current = null;
      if (!saver) return;
      const unsaved = textRef.current;
      const base = baseUpdatedAt.current;
      if (discardUnsaved.current) {
        discardUnsaved.current = false;
        // 用户放弃本页修改：只删除本页写入的草稿。
        clearNoteDraft(videoId, { id: own.id });
        saver.discard();
        return;
      }
      if (saver.hasUnsaved) {
        // 先同步写入本页草稿（与尚未处理的旧草稿并存），保存成功后再删除；失败时保留，下次打开提示恢复。
        own.text = unsaved;
        writeNoteDraft(videoId, {
          id: own.id,
          text: unsaved,
          savedAt: Date.now(),
          baseUpdatedAt: base,
        });
      }
      void saver.dispose().then((ok) => {
        if (ok) clearNoteDraft(videoId, { id: own.id });
      });
    };
  }, [videoId, loadNonce]);

  // 其他页面保存了同一视频的笔记：本页无未保存修改时静默重新读取，否则提示冲突。
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(NOTES_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (event: MessageEvent<{ videoId?: string; updatedAt?: number }>) => {
      if (event.data?.videoId !== videoId || event.data.updatedAt === baseUpdatedAt.current) return;
      if (saverRef.current?.hasUnsaved) {
        notify(t('options.workspace.noteConflict'), 'warning');
      } else {
        setLoadNonce((n) => n + 1);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [videoId, notify, t]);

  // 窗口重新获得焦点：没有未保存修改时重新读取，获取其他页面的最新内容。
  useEffect(() => {
    const onFocus = () => {
      if (saverRef.current && !saverRef.current.hasUnsaved) {
        void getNote(videoId).then(
          (note) => {
            if ((note?.updatedAt ?? 0) !== baseUpdatedAt.current && !saverRef.current?.hasUnsaved) {
              setLoadNonce((n) => n + 1);
            }
          },
          () => undefined,
        );
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [videoId]);

  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      const saver = saverRef.current;
      if (saver?.hasUnsaved) {
        const own = ownDraftRef.current;
        if (own) {
          own.text = textRef.current;
          writeNoteDraft(videoId, {
            id: own.id,
            text: own.text,
            savedAt: Date.now(),
            baseUpdatedAt: baseUpdatedAt.current,
          });
        }
        void saver.flush();
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [videoId]);

  const onChange = (value: string) => {
    textRef.current = value;
    setText(value);
    saverRef.current?.change(value);
  };

  const overwrite = async () => {
    const latest = await getNote(videoId).catch(() => undefined);
    baseUpdatedAt.current = latest?.updatedAt ?? 0;
    await saverRef.current?.retry();
  };

  // 恢复后草稿保留到内容保存成功（save 回调按内容删除）；其他草稿下次打开时提示。
  const restoreDraft = () => {
    if (!draft) return;
    onChange(draft.text);
    setDraft(undefined);
  };

  // 用户明确丢弃这份草稿（内容相同的副本一并删除）；还有其他草稿时接着提示。
  const discardDraft = () => {
    if (!draft) return;
    clearNoteDraft(videoId, { text: draft.text });
    const ownId = ownDraftRef.current?.id;
    setDraft(readNoteDrafts(videoId).find((d) => d.id !== ownId && d.text !== textRef.current));
  };

  const insertQuote = useCallback((cue: Cue) => {
    const area = textareaRef.current;
    if (!area || !saverRef.current) return;
    const current = textRef.current;
    const start = area.selectionStart ?? current.length;
    const end = area.selectionEnd ?? current.length;
    const before = current.slice(0, start);
    const after = current.slice(end);
    const prefix =
      before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
    const quote = `${prefix}${cueQuote(cue)}\n`;
    const next = `${before}${quote}${after}`;
    textRef.current = next;
    setText(next);
    saverRef.current.change(next);
    const caret = before.length + quote.length;
    requestAnimationFrame(() => {
      area.focus();
      area.setSelectionRange(caret, caret);
    });
  }, []);

  useEffect(() => {
    const onQuote = (event: Event) => {
      const cue = (event as CustomEvent<Cue>).detail;
      if (cue) insertQuote(cue);
    };
    window.addEventListener(QUOTE_EVENT, onQuote);
    return () => window.removeEventListener(QUOTE_EVENT, onQuote);
  }, [insertQuote]);

  const cues = activeLive && liveCues.status === 'ready' ? liveCues.cues : recordCues;
  const offset = snapshot?.settings.captions.offsetMs ?? 0;
  const activeCue = page && time !== undefined ? findActiveCue(cues, time - offset) : undefined;

  return (
    <div className={styles.notes}>
      <div className={styles.notesHead}>
        <span className={styles.panelTitle}>{t('options.workspace.notes')}</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Quote size={14} aria-hidden="true" />}
          disabled={!activeCue || loadStatus !== 'ready'}
          title={t(activeCue ? 'options.workspace.quoteActive' : 'options.workspace.quoteNone')}
          onClick={() => activeCue && insertQuote(activeCue)}
        >
          {t('options.workspace.quote')}
        </Button>
      </div>
      {loadStatus === 'loading' && (
        <EmptyState icon={<Spinner />} title={t('options.workspace.loadingNote')} />
      )}
      {loadStatus === 'error' && (
        <Callout
          tone="danger"
          actions={
            <Button size="sm" onClick={() => setLoadNonce((n) => n + 1)}>
              {t('options.workspace.retryLoad')}
            </Button>
          }
        >
          {t('options.workspace.noteLoadFailed')}
        </Callout>
      )}
      {loadStatus === 'ready' && (
        <>
          {draft && (
            <Callout
              tone="warning"
              title={t('options.workspace.draftTitle')}
              actions={
                <>
                  <Button size="sm" onClick={restoreDraft}>
                    {t('options.workspace.restoreDraft')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={discardDraft}>
                    {t('options.workspace.discardDraft')}
                  </Button>
                </>
              }
            >
              {t('options.workspace.draftBody', { time: formatDateTime(draft.savedAt, locale) })}
            </Callout>
          )}
          <TextArea
            ref={textareaRef}
            className={styles.noteArea}
            aria-label={t('options.workspace.noteAria')}
            placeholder={t('options.workspace.notePlaceholder')}
            value={text}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          <div
            className={`${styles.noteStatus} ${saveStatus === 'error' || saveStatus === 'conflict' ? styles.noteError : ''}`}
            role="status"
            aria-live="polite"
          >
            {saveStatus === 'saving' && <Spinner />}
            <span>{t(STATUS_TEXT[saveStatus])}</span>
            {saveStatus === 'error' && (
              <Button size="sm" onClick={() => void saverRef.current?.retry()}>
                {t('options.workspace.retrySave')}
              </Button>
            )}
            {saveStatus === 'conflict' && (
              <>
                <Button size="sm" onClick={() => void overwrite()}>
                  {t('options.workspace.overwrite')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    discardUnsaved.current = true;
                    setLoadNonce((n) => n + 1);
                  }}
                >
                  {t('options.workspace.loadLatest')}
                </Button>
              </>
            )}
          </div>
          <Hint>{t('options.workspace.notesHint')}</Hint>
        </>
      )}
    </div>
  );
}

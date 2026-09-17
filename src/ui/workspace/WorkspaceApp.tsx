/**
 * 字幕工作台（workspace.html）：左侧本地字幕记录（含尚未落库的实时会话），中间字幕，右侧该视频笔记。
 *
 * - 源标签页仍在快照 pages 中时可点击时间跳转；否则提示播放控制不可用。
 * - 与会话匹配（快照 recordId）时显示实时字幕；会话结束、点「刷新记录」或窗口获得焦点时重新读取记录。
 * - 未显式选择时，首次隐式选中的记录会被固定，重新读取列表不会跳到别的记录。
 * - 笔记按 videoId 保存，与字幕记录独立；保存按 updatedAt 检测冲突，保存失败的内容保留为草稿。
 */
import { ExternalLink, MonitorPlay, Quote, RefreshCw, Trash } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { findActiveCue, type Cue } from '../../domain/cue';
import type { PageInfo, SessionSnapshot } from '../../domain/session';
import { describeCoverage, isCompleteCoverage } from '../../export';
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
import { focusTab } from '../shared/navigation';
import { isSessionEnded, sourceModeShortLabel } from '../state/derive';
import { UiClientProvider, useBackground, useClientState, useCues } from '../state/hooks';
import { cueQuote } from '../transcript/text';
import { TranscriptView, type TranscriptSource } from '../transcript/TranscriptView';
import { NoteAutosaver, type NoteSaveStatus } from './note-autosaver';
import { clearNoteDraft, readNoteDraft, writeNoteDraft, type NoteDraft } from './note-drafts';
import styles from './workspace.module.css';

const RECORD_LIST_LIMIT = 200;
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
    <ToastProvider>
      <UiClientProvider client={client}>
        <WorkspaceView />
      </UiClientProvider>
    </ToastProvider>
  );
}

type RecordsState =
  { status: 'loading' } | { status: 'ready'; records: TranscriptSummary[] } | { status: 'error' };

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

function buildEntries(records: TranscriptSummary[], snapshot: AppSnapshot | null): ListEntry[] {
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
  }));
  const known = new Set(entries.map((e) => e.recordId));
  for (const session of snapshot?.sessions ?? []) {
    if (!session.recordId || known.has(session.recordId) || isSessionEnded(session)) continue;
    known.add(session.recordId);
    const page = snapshot?.pages.find((p) => p.tabId === session.identity.tabId);
    entries.unshift({
      recordId: session.recordId,
      videoId: session.identity.videoId,
      title: page?.title ?? session.player?.title,
      sourceLanguage: session.sourceTrack?.languageCode ?? session.detectedSourceLanguage ?? 'und',
      targetLanguage: session.targetLanguage,
      sourceMode: session.sourceMode,
      complete: isCompleteCoverage(session.coverage, session.sourceMode),
      updatedAt: session.updatedAt,
      liveOnly: true,
    });
  }
  return entries;
}

function WorkspaceView() {
  const { connection, snapshot } = useClientState();
  const notify = useToast();
  const [records, setRecords] = useState<RecordsState>({ status: 'loading' });
  const [reloadNonce, setReloadNonce] = useState(0);
  const [selection, setSelection] = useState<{ recordId: string | null; videoId: string | null }>(
    () => ({ recordId: null, videoId: initialVideoId() }),
  );
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listTranscriptSummaries({ limit: RECORD_LIST_LIMIT }).then(
      (list) => {
        if (cancelled) return;
        setRecords({ status: 'ready', records: list });
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
  }, [reloadNonce]);

  useEffect(() => {
    const onFocus = () => setReloadNonce((n) => n + 1);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const entries = useMemo(
    () => (records.status === 'ready' ? buildEntries(records.records, snapshot) : []),
    [records, snapshot],
  );
  const selected = selection.recordId
    ? entries.find((e) => e.recordId === selection.recordId)
    : undefined;
  const videoId = selected?.videoId ?? selection.videoId;

  const onDelete = async () => {
    if (!selected) return;
    try {
      await deleteTranscript(selected.recordId);
      notify('已删除字幕记录。该视频的笔记与收藏已保留。', 'success');
      setSelection({ recordId: null, videoId: selected.videoId });
      setReloadNonce((n) => n + 1);
    } catch {
      notify('删除字幕记录失败。', 'danger');
    } finally {
      setConfirmDelete(false);
    }
  };

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Brand />
          <h1>字幕工作台</h1>
        </div>
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      <div className={styles.layout}>
        <section className={`${styles.panel} ${styles.recordsPanel}`} aria-label="字幕记录">
          <div className={styles.panelHead}>
            <span className={styles.panelTitle}>字幕记录</span>
            <IconButton
              bare
              label="刷新记录"
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

        <section className={`${styles.panel} ${styles.mainPanel}`} aria-label="字幕">
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
              title={records.status === 'loading' ? '正在读取字幕记录…' : '没有选中的字幕记录'}
            >
              {records.status === 'error'
                ? '读取本地字幕记录失败。'
                : videoId
                  ? '这个视频还没有保存的字幕记录。开始翻译后会自动保存；右侧笔记仍可使用。'
                  : entries.length === 0
                    ? '在 YouTube 视频上开始翻译后，字幕会保存为本地记录并出现在这里。'
                    : '从左侧选择一条字幕记录。'}
            </EmptyState>
          )}
        </section>

        <section className={`${styles.panel} ${styles.notesPanel}`} aria-label="笔记">
          {videoId ? (
            <NotesPanel
              key={videoId}
              videoId={videoId}
              snapshot={snapshot}
              recordId={selected?.recordId}
              reloadNonce={reloadNonce}
            />
          ) : (
            <EmptyState title="笔记">选择字幕记录后，可以为该视频记录笔记。</EmptyState>
          )}
        </section>
      </div>
      <ConfirmDialog
        open={confirmDelete}
        title="删除字幕记录"
        confirmLabel="删除记录"
        danger
        onConfirm={() => void onDelete()}
        onCancel={() => setConfirmDelete(false)}
      >
        只删除这条本地字幕记录。该视频的笔记与收藏会保留；重新翻译会产生新的记录。
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
  if (state.status === 'loading') return <EmptyState icon={<Spinner />} title="正在读取…" />;
  if (state.status === 'error')
    return <Callout tone="danger">读取字幕记录失败，请稍后刷新。</Callout>;
  if (entries.length === 0) return <EmptyState title="暂无字幕记录" />;
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
              {sourceLanguageLabel(entry.sourceLanguage)} → {languageLabel(entry.targetLanguage)} ·{' '}
              {sourceModeShortLabel(entry.sourceMode)}
            </span>
            <span className={styles.recordMeta}>
              {entry.liveOnly
                ? '实时会话 · 尚未保存为本地记录'
                : `${entry.complete ? '完整轨道' : '部分字幕'} · ${entry.cueCount ?? 0} 条 · ${formatDateTime(entry.updatedAt)}`}
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
  // 重新读取期间保留上一次结果，避免闪烁。
  return state?.value ?? { status: 'loading' };
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
      void run({ kind: 'player/seek', tabId: page.tabId, timeMs }, { errorPrefix: '跳转失败' });
    },
    [page, run],
  );

  if (loadState.status === 'loading' && !liveSession) {
    return <EmptyState icon={<Spinner />} title="正在读取字幕…" />;
  }
  if (loadState.status === 'error' && !liveSession) {
    return <Callout tone="danger">读取字幕记录失败。笔记不受影响。</Callout>;
  }
  if (!record && !liveSession) {
    return <EmptyState title="这条字幕记录已不存在">可能已被删除。该视频的笔记仍保留。</EmptyState>;
  }

  const cues = useLive ? liveCues.cues : (record?.cues ?? []);

  return (
    <div className={styles.main}>
      <div className={styles.mainHead}>
        <div>
          <div className={styles.mainTitle}>{source.title || entry.videoId}</div>
          <div className={styles.mainMeta}>
            {sourceLanguageLabel(source.sourceLanguage)} → {languageLabel(source.targetLanguage)} ·{' '}
            {sourceModeShortLabel(source.sourceMode)}
            {record?.sourceLabel ? `（${record.sourceLabel}）` : ''}
            {record ? ` · 更新于 ${formatDateTime(record.updatedAt)}` : ' · 尚未保存为本地记录'}
          </div>
          <div className={styles.mainMeta}>
            {describeCoverage(source.coverage, source.sourceMode)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {page && (
            <Button
              size="sm"
              icon={<ExternalLink size={14} aria-hidden="true" />}
              onClick={() =>
                focusTab(page.tabId).catch(() => notify('无法切换到源标签页。', 'danger'))
              }
            >
              切换到源标签页
            </Button>
          )}
          {record && (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash size={14} aria-hidden="true" />}
              disabled={loaded?.readOnly}
              onClick={onDelete}
            >
              删除记录
            </Button>
          )}
        </div>
      </div>
      {loaded?.readOnly && (
        <Callout tone="warning">
          这条记录由更新版本的同听创建，当前只读显示，部分内容可能无法识别。
        </Callout>
      )}
      {!!loaded?.invalidCueCount && !useLive && (
        <Hint>有 {loaded.invalidCueCount} 条字幕数据损坏或格式无法识别，已跳过显示与导出。</Hint>
      )}
      <div className={styles.transcript}>
        <TranscriptView
          cues={cues}
          loading={!!liveSession && liveCues.status === 'loading' && !record}
          source={source}
          currentTimeMs={page ? time : undefined}
          captionOffsetMs={snapshot?.settings.captions.offsetMs ?? 0}
          onSeek={page ? onSeek : undefined}
          seekUnavailableReason="源标签页已关闭，播放控制不可用。"
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

const STATUS_TEXT: Record<NoteSaveStatus, string> = {
  idle: '笔记会自动保存在本机',
  pending: '有未保存的修改',
  saving: '保存中…',
  saved: '已保存',
  error: '保存失败，内容仍在输入框中',
  conflict: '笔记已在其他页面修改，未保存本页内容',
};

function isConflict(error: unknown): boolean {
  return error instanceof NoteConflictError;
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
  const notify = useToast();
  const [load, setLoad] = useState<{ status: 'loading' | 'ready' | 'error' }>({
    status: 'loading',
  });
  const [text, setText] = useState('');
  const [saveStatus, setSaveStatus] = useState<NoteSaveStatus>('idle');
  const [loadNonce, setLoadNonce] = useState(0);
  const [draft, setDraft] = useState<NoteDraft | undefined>(undefined);
  const saverRef = useRef<NoteAutosaver | null>(null);
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
  useEffect(() => {
    let cancelled = false;
    getNote(videoId).then(
      (note) => {
        if (cancelled) return;
        const baseline = note?.text ?? '';
        baseUpdatedAt.current = note?.updatedAt ?? 0;
        textRef.current = baseline;
        setText(baseline);
        setLoad({ status: 'ready' });
        setSaveStatus('idle');
        const pendingDraft = readNoteDraft(videoId);
        setDraft(pendingDraft && pendingDraft.text !== baseline ? pendingDraft : undefined);
        saverRef.current = new NoteAutosaver({
          videoId,
          baseline,
          save: async (id, value) => {
            const saved = await saveNoteChecked(id, value, baseUpdatedAt.current);
            baseUpdatedAt.current = saved.updatedAt;
            clearNoteDraft(id);
            channelRef.current?.postMessage({ videoId: id, updatedAt: saved.updatedAt });
          },
          isConflict,
          onStatus: setSaveStatus,
        });
      },
      () => {
        if (!cancelled) setLoad({ status: 'error' });
      },
    );
    return () => {
      cancelled = true;
      const saver = saverRef.current;
      saverRef.current = null;
      if (!saver) return;
      const unsaved = textRef.current;
      const base = baseUpdatedAt.current;
      if (discardUnsaved.current) {
        discardUnsaved.current = false;
        clearNoteDraft(videoId);
        saver.discard();
        return;
      }
      if (saver.hasUnsaved) {
        // 先同步写入草稿，保存成功后再清除；失败时保留，下次打开提示恢复。
        writeNoteDraft(videoId, { text: unsaved, savedAt: Date.now(), baseUpdatedAt: base });
      }
      void saver.dispose().then((ok) => {
        if (ok) clearNoteDraft(videoId);
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
        notify('这条笔记已在其他页面修改。保存本页内容前请先决定保留哪一份。', 'warning');
      } else {
        setLoadNonce((n) => n + 1);
      }
    };
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [videoId, notify]);

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
        writeNoteDraft(videoId, {
          text: textRef.current,
          savedAt: Date.now(),
          baseUpdatedAt: baseUpdatedAt.current,
        });
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

  const restoreDraft = () => {
    if (!draft) return;
    onChange(draft.text);
    setDraft(undefined);
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
      <div className={styles.panelHead} style={{ padding: 0, border: 0 }}>
        <span className={styles.panelTitle}>笔记</span>
        <Button
          size="sm"
          variant="ghost"
          icon={<Quote size={14} aria-hidden="true" />}
          disabled={!activeCue || load.status !== 'ready'}
          title={
            activeCue
              ? '插入当前播放的字幕'
              : '没有正在播放的字幕；可使用字幕列表中每条字幕的引用按钮'
          }
          onClick={() => activeCue && insertQuote(activeCue)}
        >
          引用当前字幕
        </Button>
      </div>
      {load.status === 'loading' && <EmptyState icon={<Spinner />} title="正在读取笔记…" />}
      {load.status === 'error' && (
        <Callout
          tone="danger"
          actions={
            <Button size="sm" onClick={() => setLoadNonce((n) => n + 1)}>
              重试读取
            </Button>
          }
        >
          读取笔记失败。为避免覆盖已有笔记，暂时不能编辑。
        </Callout>
      )}
      {load.status === 'ready' && (
        <>
          {draft && (
            <Callout
              tone="warning"
              title="发现未保存的笔记草稿"
              actions={
                <>
                  <Button size="sm" onClick={restoreDraft}>
                    恢复草稿
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      clearNoteDraft(videoId);
                      setDraft(undefined);
                    }}
                  >
                    丢弃草稿
                  </Button>
                </>
              }
            >
              {formatDateTime(draft.savedAt)} 有一份笔记没能保存。恢复后会替换输入框内容并尝试保存。
            </Callout>
          )}
          <TextArea
            ref={textareaRef}
            className={styles.noteArea}
            aria-label="视频笔记"
            placeholder="记下这个视频里值得记住的内容。可以用字幕旁的引用按钮插入带时间的字幕。"
            value={text}
            onChange={(e) => onChange(e.currentTarget.value)}
          />
          <div
            className={`${styles.noteStatus} ${saveStatus === 'error' || saveStatus === 'conflict' ? styles.noteError : ''}`}
            role="status"
            aria-live="polite"
          >
            {saveStatus === 'saving' && <Spinner />}
            <span>{STATUS_TEXT[saveStatus]}</span>
            {saveStatus === 'error' && (
              <Button size="sm" onClick={() => void saverRef.current?.retry()}>
                重试保存
              </Button>
            )}
            {saveStatus === 'conflict' && (
              <>
                <Button size="sm" onClick={() => void overwrite()}>
                  用本页内容覆盖
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    discardUnsaved.current = true;
                    setLoadNonce((n) => n + 1);
                  }}
                >
                  载入最新版本（放弃本页修改）
                </Button>
              </>
            )}
          </div>
          <Hint>笔记按视频保存在本机，删除字幕记录或字幕获取失败不会清空笔记。</Hint>
        </>
      )}
    </div>
  );
}

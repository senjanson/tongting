/**
 * 侧栏「字幕」标签：有会话时显示实时字幕（useCues），否则读取本地保存的该视频字幕记录。
 */
import { useEffect, useMemo, useState } from 'react';
import type { PageInfo, SessionSnapshot } from '../../domain/session';
import type { TranscriptRecord } from '../../storage/db';
import { useLocale, useT } from '../../i18n/react';
import { SelectField } from '../components/controls';
import { Callout, EmptyState } from '../components/layout';
import { formatDateTime, languageLabel } from '../format';
import { useCommandRunner, usePlayerClock } from '../shared/hooks';
import { isSessionEnded, sessionRecordId, sourceModeShortLabel } from '../state/derive';
import { useCues, useUiClient } from '../state/hooks';
import { useRepos } from '../state/repos';
import { TranscriptView } from '../transcript/TranscriptView';
import styles from './sidepanel.module.css';

export interface TranscriptTabProps {
  page: PageInfo;
  session: SessionSnapshot | undefined;
  targetLanguage: string;
  captionOffsetMs: number;
}

export function TranscriptTab({
  page,
  session,
  targetLanguage,
  captionOffsetMs,
}: TranscriptTabProps) {
  const client = useUiClient();
  const demo = client.mode === 'demo';

  return (
    <div className={styles.transcriptPane}>
      {session && !isSessionEnded(session) ? (
        <LiveTranscript
          page={page}
          session={session}
          captionOffsetMs={captionOffsetMs}
          demo={demo}
        />
      ) : (
        <SavedTranscript
          key={session?.identity.sessionId ?? 'saved'}
          page={page}
          targetLanguage={targetLanguage}
          preferredRecordId={session?.recordId}
          captionOffsetMs={captionOffsetMs}
        />
      )}
    </div>
  );
}

function LiveTranscript({
  page,
  session,
  captionOffsetMs,
  demo,
}: {
  page: PageInfo;
  session: SessionSnapshot;
  captionOffsetMs: number;
  demo: boolean;
}) {
  const cues = useCues(session.identity.sessionId);
  const { run } = useCommandRunner();
  const t = useT();
  const time = usePlayerClock(page.player ?? session.player);
  const source = useMemo(
    () => ({
      kind: 'live' as const,
      recordId: sessionRecordId(session),
      videoId: session.identity.videoId,
      title: page.title ?? session.player?.title,
      targetLanguage: session.targetLanguage,
      sourceLanguage: session.sourceTrack?.languageCode ?? session.detectedSourceLanguage ?? 'und',
      sourceMode: session.sourceMode,
      coverage: session.coverage,
    }),
    [session, page.title],
  );
  return (
    <TranscriptView
      compact
      key={session.identity.sessionId}
      cues={cues.cues}
      loading={cues.status === 'loading'}
      source={source}
      currentTimeMs={time}
      captionOffsetMs={captionOffsetMs}
      demo={demo}
      onSeek={(timeMs) =>
        void run(
          { kind: 'player/seek', tabId: page.tabId, timeMs },
          { errorPrefix: t('sidepanel.transcript.seekFailed') },
        )
      }
      backfill={
        session.sourceMode === 'full-track' && !demo
          ? {
              enabled: !!session.backfill,
              done: session.translation.done,
              total: session.translation.total,
              onToggle: (enabled) =>
                void run(
                  {
                    kind: 'session/backfill',
                    tabId: page.tabId,
                    sessionId: session.identity.sessionId,
                    enabled,
                  },
                  {
                    errorPrefix: enabled
                      ? t('sidepanel.transcript.backfillStartFailed')
                      : t('sidepanel.transcript.backfillStopFailed'),
                  },
                ),
            }
          : undefined
      }
    />
  );
}

function SavedTranscript({
  page,
  targetLanguage,
  preferredRecordId,
  captionOffsetMs,
}: {
  page: PageInfo;
  targetLanguage: string;
  /** 已结束会话的快照 recordId：优先显示这条记录。 */
  preferredRecordId?: string;
  captionOffsetMs: number;
}) {
  const { transcripts } = useRepos();
  const { run } = useCommandRunner();
  const locale = useLocale();
  const t = useT();
  const time = usePlayerClock(page.player);
  const videoId = page.videoId;
  const [loaded, setLoaded] = useState<{
    videoId: string;
    records: TranscriptRecord[];
    failed: boolean;
  } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if (!videoId) return undefined;
    let cancelled = false;
    transcripts.listByVideo(videoId).then(
      (records) => {
        if (!cancelled) setLoaded({ videoId, records, failed: false });
      },
      () => {
        if (!cancelled) setLoaded({ videoId, records: [], failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [transcripts, videoId]);

  const current = loaded && loaded.videoId === videoId ? loaded : null;
  const records = current?.records ?? [];
  const selected =
    records.find((r) => r.recordId === selectedId) ??
    (preferredRecordId ? records.find((r) => r.recordId === preferredRecordId) : undefined) ??
    records.find((r) => r.targetLanguage === targetLanguage) ??
    records[0];

  const source = useMemo(
    () =>
      selected
        ? {
            kind: 'record' as const,
            recordId: selected.recordId,
            videoId: selected.videoId,
            title: selected.title ?? page.title,
            targetLanguage: selected.targetLanguage,
            sourceLanguage: selected.sourceLanguage,
            sourceMode: selected.sourceMode,
            coverage: selected.coverage,
          }
        : undefined,
    [selected, page.title],
  );

  if (!current) return <EmptyState title={t('sidepanel.transcript.loading')} />;
  if (current.failed) {
    return <Callout tone="danger">{t('sidepanel.transcript.loadFailed')}</Callout>;
  }
  if (!selected || !source) {
    return (
      <EmptyState title={t('sidepanel.transcript.emptyTitle')}>
        {t('sidepanel.transcript.emptyBody')}
      </EmptyState>
    );
  }
  return (
    <>
      {records.length > 1 && (
        <div style={{ marginBottom: 8 }}>
          <SelectField
            label={t('sidepanel.transcript.records')}
            value={selected.recordId}
            onChange={setSelectedId}
            options={records.map((r) => ({
              value: r.recordId,
              label: `${languageLabel(r.targetLanguage, locale)} · ${sourceModeShortLabel(r.sourceMode, locale)} · ${formatDateTime(r.updatedAt, locale)}`,
            }))}
          />
        </div>
      )}
      <TranscriptView
        compact
        key={selected.recordId}
        cues={selected.cues}
        source={source}
        currentTimeMs={time}
        captionOffsetMs={captionOffsetMs}
        onSeek={(timeMs) =>
          void run(
            { kind: 'player/seek', tabId: page.tabId, timeMs },
            { errorPrefix: t('sidepanel.transcript.seekFailed') },
          )
        }
      />
    </>
  );
}

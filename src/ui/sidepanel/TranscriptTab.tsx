/**
 * 侧栏「字幕」标签：有会话时显示实时字幕（useCues），否则读取本地保存的该视频字幕记录。
 */
import { useEffect, useMemo, useState } from 'react';
import type { PageInfo, SessionSnapshot } from '../../domain/session';
import type { TranscriptRecord } from '../../storage/db';
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
        void run({ kind: 'player/seek', tabId: page.tabId, timeMs }, { errorPrefix: '跳转失败' })
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
                  { errorPrefix: enabled ? '无法开始全片翻译' : '无法停止全片翻译' },
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

  if (!current) return <EmptyState title="正在读取本地字幕记录…" />;
  if (current.failed) {
    return <Callout tone="danger">读取本地字幕记录失败。开始翻译后仍会显示实时字幕。</Callout>;
  }
  if (!selected || !source) {
    return (
      <EmptyState title="还没有这个视频的字幕">
        在「翻译」标签开始翻译后，已获得的字幕会实时显示在这里，并保存为本地记录。
      </EmptyState>
    );
  }
  return (
    <>
      {records.length > 1 && (
        <div style={{ marginBottom: 8 }}>
          <SelectField
            label="本地记录"
            value={selected.recordId}
            onChange={setSelectedId}
            options={records.map((r) => ({
              value: r.recordId,
              label: `${languageLabel(r.targetLanguage)} · ${sourceModeShortLabel(r.sourceMode)} · ${formatDateTime(r.updatedAt)}`,
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
          void run({ kind: 'player/seek', tabId: page.tabId, timeMs }, { errorPrefix: '跳转失败' })
        }
      />
    </>
  );
}

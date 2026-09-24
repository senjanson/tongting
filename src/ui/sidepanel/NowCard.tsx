/**
 * 翻译标签顶部的「当前字幕」卡片：按播放时间显示正在播放的这句译文与原文，以及真实的翻译进度。
 *
 * - 只在会话未结束时订阅字幕（useCues 负责订阅与释放；会话切换时先释放旧会话）。
 * - 当前句按播放器时间减去字幕时间微调查找，与字幕标签、画面覆盖层一致。
 * - 没有最终译文时只显示原文和状态提示，不把原文或未完成的译文当成译文展示。
 */
import type { ReactNode } from 'react';
import { findActiveCue, type Cue } from '../../domain/cue';
import type { PageInfo, SessionSnapshot } from '../../domain/session';
import { translate, type Locale } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import { cx } from '../components/cx';
import { formatMediaTime } from '../format';
import { usePlayerClock } from '../shared/hooks';
import {
  isSessionEnded,
  sessionPhaseStatus,
  sourceModeShortLabel,
  type StatusInfo,
} from '../state/derive';
import { useCues } from '../state/hooks';
import { translationOf } from '../transcript/text';
import styles from './translate.module.css';

/** 进度条最多显示的段数；句数不超过该值时一句一段。 */
export const MAX_PROGRESS_SEGMENTS = 12;

/** 分段进度：句数 ≤ 12 时一句一段，否则 12 段按比例填充（向下取整，全部完成才填满）。 */
export function progressSegments(done: number, total: number): { count: number; filled: number } {
  if (!(total > 0)) return { count: MAX_PROGRESS_SEGMENTS, filled: 0 };
  const finished = Math.min(Math.max(Math.floor(done), 0), total);
  if (total <= MAX_PROGRESS_SEGMENTS) return { count: total, filled: finished };
  return {
    count: MAX_PROGRESS_SEGMENTS,
    filled: Math.floor((finished * MAX_PROGRESS_SEGMENTS) / total),
  };
}

/** 卡片顶部的状态：正常运行显示「正在翻译」，其余沿用会话阶段标签；没有会话时为「未开始」。 */
export function nowStatus(session: SessionSnapshot | undefined, locale: Locale): StatusInfo {
  const phase = session && sessionPhaseStatus(session, locale);
  if (!session || !phase)
    return { label: translate(locale, 'sidepanel.status.notStarted'), tone: 'neutral' };
  if (session.phase === 'running' && phase.tone === 'accent')
    return { label: translate(locale, 'sidepanel.now.translating'), tone: 'accent' };
  return phase;
}

export function NowCard({
  session,
  page,
  captionOffsetMs,
}: {
  session: SessionSnapshot | undefined;
  page: PageInfo | undefined;
  captionOffsetMs: number;
}) {
  const t = useT();
  const locale = useLocale();
  const live = !!session && !isSessionEnded(session);
  const cues = useCues(live ? session.identity.sessionId : undefined);
  const player = page?.player ?? session?.player;
  const time = usePlayerClock(player);
  const title = page?.title || player?.title || t('sidepanel.video.noTitle');
  const status = nowStatus(session, locale);

  let body: ReactNode;
  if (!live) {
    body = <p className={styles.nowHint}>{t('sidepanel.now.idleHint')}</p>;
  } else if (cues.cues.length === 0) {
    body = (
      <p className={styles.nowHint}>
        {cues.status === 'ready' ? t('sidepanel.now.noCues') : t('sidepanel.now.syncing')}
      </p>
    );
  } else if (player?.ad) {
    // 与画面覆盖层一致：广告期间不显示字幕（此时的播放时间属于广告）。
    body = <p className={styles.nowHint}>{t('common.player.ad')}</p>;
  } else if (time === undefined) {
    body = <p className={styles.nowHint}>{t('sidepanel.now.noTime')}</p>;
  } else {
    const active = findActiveCue(cues.cues, time - captionOffsetMs);
    body = active ? (
      <CueText key={active.id} cue={active} />
    ) : (
      <p className={styles.nowHint}>{t('sidepanel.now.gap')}</p>
    );
  }

  return (
    <section className={cx(styles.card, styles.now)} aria-label={t('sidepanel.now.aria')}>
      <div className={styles.nowHead}>
        <span className={styles.nowStatus}>
          <span className={styles.dot} data-tone={status.tone} aria-hidden="true" />
          <span className={styles.nowLine} title={title}>
            {t('sidepanel.now.line', { status: status.label, title })}
          </span>
        </span>
        {player && <span className={styles.nowTime}>{formatMediaTime(time)}</span>}
      </div>
      <div className={styles.nowBody}>{body}</div>
      {session && <Progress session={session} />}
    </section>
  );
}

function CueText({ cue }: { cue: Cue }) {
  const t = useT();
  const translated = translationOf(cue);
  const interim = cue.stability === 'interim';
  if (translated) {
    return (
      <>
        <p className={styles.hero}>{translated}</p>
        {translated !== cue.sourceText && <p className={styles.nowSource}>{cue.sourceText}</p>}
        {interim && <span className={styles.chip}>{t('options.transcript.chipInterim')}</span>}
      </>
    );
  }
  const failed = cue.translationState === 'failed';
  let hint: string;
  if (failed) {
    hint = cue.translationError?.message
      ? t('options.transcript.chipFailedWith', { message: cue.translationError.message })
      : t('options.transcript.chipFailed');
  } else if (cue.translationState === 'running') {
    const partial = cue.translatedText?.trim();
    hint = partial
      ? t('options.transcript.partialTranslation', { text: partial })
      : t('options.transcript.running');
  } else if (cue.translationState === 'pending') {
    hint = t('options.transcript.pending');
  } else {
    hint = t('options.transcript.noTranslation');
  }
  return (
    <>
      <p className={cx(styles.pendingHint, failed && styles.pendingFailed)}>{hint}</p>
      <p className={styles.nowSource}>{cue.sourceText}</p>
      {interim && <span className={styles.chip}>{t('options.transcript.chipInterim')}</span>}
    </>
  );
}

function Progress({ session }: { session: SessionSnapshot }) {
  const t = useT();
  const locale = useLocale();
  const { done, total } = session.translation;
  const { count, filled } = progressSegments(done, total);
  const source = sourceModeShortLabel(session.sourceMode, locale);
  return (
    <div className={styles.progress}>
      <div
        className={styles.segments}
        style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {Array.from({ length: count }, (_, i) => (
          <span key={i} className={styles.segment} data-filled={i < filled || undefined} />
        ))}
      </div>
      <span className={styles.progressText}>
        {total > 0
          ? t('sidepanel.now.progress', { done: Math.min(done, total), total, source })
          : t('sidepanel.now.progressNone', { source })}
      </span>
    </div>
  );
}

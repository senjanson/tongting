/**
 * 字幕列表（侧栏字幕标签与工作台共用）。
 *
 * - 按播放时间高亮；用户手动滚动后停止自动跟随，显示「跟随播放」。
 * - 搜索、只看收藏、原文/译文/双语切换、复制单句/全部、收藏、导出。
 * - 时间可点击跳转仅在提供 onSeek 时启用；否则显示不可用原因。
 * - 字幕文本一律以文本节点渲染。
 */
import { Bookmark, Copy, Download, Locate, Quote, Search } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { findActiveCue, type Cue } from '../../domain/cue';
import { describeCoverage } from '../../export';
import type { MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import { Button, controlStyles, Hint, IconButton, Segmented } from '../components/controls';
import { cx } from '../components/cx';
import { EmptyState } from '../components/layout';
import { useToast } from '../components/toast';
import { formatMediaTime } from '../format';
import { copyText } from '../shared/clipboard';
import { ExportDialog, type ExportSource } from './ExportDialog';
import { cueCopyText, cuesCopyText, matchesQuery, translationOf, type CueViewMode } from './text';
import styles from './transcript.module.css';
import { useFavorites } from './useFavorites';

export interface TranscriptSource extends ExportSource {
  /** 收藏所属的字幕记录（以 worker 快照下发的为准）；缺失时收藏不可用。 */
  recordId: string | undefined;
  /** live：当前会话实时字幕；record：本地保存的记录。 */
  kind: 'live' | 'record';
}

export interface TranscriptViewProps {
  cues: readonly Cue[];
  loading?: boolean;
  source: TranscriptSource;
  currentTimeMs?: number;
  /** 字幕显示偏移（正数延后），高亮与覆盖层保持一致。 */
  captionOffsetMs?: number;
  onSeek?: (timeMs: number) => void;
  seekUnavailableReason?: string;
  onQuote?: (cue: Cue) => void;
  demo?: boolean;
  /** 侧栏沿用原型密度，显示选项折叠到详情。 */
  compact?: boolean;
  /** 初始视图（默认双语）。 */
  initialView?: CueViewMode;
  /** 全片补译（仅实时会话且来源为完整字幕轨道时提供）。 */
  backfill?: {
    enabled: boolean;
    done: number;
    total: number;
    onToggle: (enabled: boolean) => void;
  };
}

const USER_SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
]);

export function TranscriptView({
  cues,
  loading,
  source,
  currentTimeMs,
  captionOffsetMs = 0,
  onSeek,
  seekUnavailableReason,
  onQuote,
  demo,
  compact = false,
  initialView = 'bilingual',
  backfill,
}: TranscriptViewProps) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const [query, setQuery] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [view, setView] = useState<CueViewMode>(initialView);
  const [following, setFollowing] = useState(true);
  const [exportOpen, setExportOpen] = useState(false);
  const favorites = useFavorites(source.recordId, source.videoId);
  const listRef = useRef<HTMLDivElement>(null);

  const visible = useMemo(
    () => cues.filter((c) => (!favoritesOnly || favorites.ids.has(c.id)) && matchesQuery(c, query)),
    [cues, favoritesOnly, favorites.ids, query],
  );

  const activeCue = useMemo(
    () =>
      currentTimeMs === undefined
        ? undefined
        : findActiveCue(cues, currentTimeMs - captionOffsetMs),
    [cues, currentTimeMs, captionOffsetMs],
  );
  const activeId = activeCue?.id;

  // 自动跟随：仅在用户没有手动滚动时滚动到当前字幕。
  useEffect(() => {
    if (!following || !activeId) return;
    const list = listRef.current;
    // 字符串属性选择器只需转义引号与反斜杠。
    const row = list?.querySelector<HTMLElement>(
      `[data-cue-id="${activeId.replace(/["\\]/g, '\\$&')}"]`,
    );
    if (!list || !row) return;
    const target = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2;
    if (Math.abs(list.scrollTop - target) > 4) {
      const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (typeof list.scrollTo === 'function')
        list.scrollTo({ top: Math.max(0, target), behavior: reduced ? 'auto' : 'smooth' });
      else list.scrollTop = Math.max(0, target);
    }
  }, [activeId, following]);

  const stopFollowing = useCallback(() => setFollowing(false), []);
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget && USER_SCROLL_KEYS.has(event.key))
      setFollowing(false);
  };

  const handleSeek = useCallback(
    (cue: Cue) => {
      if (!onSeek) return;
      setFollowing(true);
      onSeek(cue.startMs);
    },
    [onSeek],
  );

  const handleCopy = useCallback(
    async (cue: Cue) => {
      const ok = await copyText(cueCopyText(cue, view, locale));
      notify(
        t(ok ? 'options.transcript.copied' : 'options.transcript.copyFailed'),
        ok ? 'success' : 'danger',
      );
    },
    [locale, notify, t, view],
  );

  const copyAll = async () => {
    if (visible.length === 0) return;
    const ok = await copyText(cuesCopyText(visible, view, locale));
    notify(
      ok
        ? t('options.transcript.copiedCount', { count: visible.length })
        : t('options.transcript.copyAllFailed'),
      ok ? 'success' : 'danger',
    );
  };

  const canFollow = currentTimeMs !== undefined;
  const coverageText = describeCoverage(source.coverage, source.sourceMode, locale);
  const partial = !(source.coverage?.complete && source.sourceMode === 'full-track');

  return (
    <div className={cx(styles.root, compact && styles.compact)}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            className={controlStyles.input}
            placeholder={t('options.transcript.searchPlaceholder')}
            aria-label={t('options.transcript.searchAria')}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <IconButton
          label={t(
            favoritesOnly ? 'options.transcript.showAll' : 'options.transcript.favoritesOnly',
          )}
          icon={<Bookmark size={16} aria-hidden="true" />}
          pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((v) => !v)}
        />
        {compact && (
          <IconButton
            label={t('options.transcript.follow')}
            icon={<Locate size={16} aria-hidden="true" />}
            pressed={following}
            disabled={!canFollow}
            onClick={() => setFollowing(true)}
          />
        )}
      </div>
      <details className={styles.displayOptions} open={!compact || undefined}>
        <summary hidden={!compact}>{t('options.transcript.displayDetails')}</summary>
        <div className={styles.viewRow}>
          <Segmented<CueViewMode>
            label={t('options.transcript.viewLabel')}
            value={view}
            onChange={setView}
            options={[
              { value: 'bilingual', label: t('options.transcript.viewBilingual') },
              { value: 'translation', label: t('options.transcript.viewTranslation') },
              { value: 'original', label: t('options.transcript.viewOriginal') },
            ]}
          />
        </div>
        <div className={styles.coverage} data-partial={partial || undefined}>
          {coverageText}
        </div>
      </details>
      <div className={styles.meta}>
        <span>
          {loading
            ? t('options.transcript.syncing')
            : t('options.transcript.count', { visible: visible.length, total: cues.length })}
          {t(
            source.kind === 'record'
              ? 'options.transcript.kindRecord'
              : 'options.transcript.kindLive',
          )}
        </span>
        <span>
          {!source.recordId
            ? t('options.transcript.favoritesUnavailable')
            : favorites.loadFailed
              ? t('options.transcript.favoritesLoadFailed')
              : favorites.loading
                ? t('options.transcript.favoritesLoading')
                : t('options.transcript.favoritesCount', { count: favorites.ids.size })}
        </span>
      </div>
      {backfill && backfill.total > 0 && (backfill.enabled || backfill.done < backfill.total) && (
        <div className={styles.meta}>
          <span>
            {backfill.enabled
              ? t('options.transcript.backfillRunning', {
                  done: backfill.done,
                  total: backfill.total,
                })
              : t('options.transcript.backfillIdle', {
                  done: backfill.done,
                  total: backfill.total,
                })}
          </span>
          <Button
            size="sm"
            onClick={() => backfill.onToggle(!backfill.enabled)}
            title={t('options.transcript.backfillTitle')}
          >
            {t(
              backfill.enabled
                ? 'options.transcript.backfillStop'
                : 'options.transcript.backfillStart',
            )}
          </Button>
        </div>
      )}
      {!onSeek && seekUnavailableReason && <Hint>{seekUnavailableReason}</Hint>}

      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={styles.list}
          role="list"
          aria-label={t('options.transcript.listAria')}
          aria-busy={loading || undefined}
          tabIndex={0}
          onWheel={stopFollowing}
          onTouchMove={stopFollowing}
          onPointerDown={(e) => {
            // 拖动滚动条（点击在列表容器本身）视为手动滚动
            if (e.target === e.currentTarget) stopFollowing();
          }}
          onKeyDown={onListKeyDown}
        >
          {visible.length === 0 ? (
            <EmptyState
              title={t(emptyTitle({ loading, total: cues.length, favoritesOnly, query }))}
            >
              {cues.length === 0 && !loading ? t('options.transcript.emptyBody') : undefined}
            </EmptyState>
          ) : (
            visible.map((cue) => (
              <CueRow
                key={cue.id}
                cue={cue}
                view={view}
                active={cue.id === activeId}
                favorite={favorites.ids.has(cue.id)}
                favoriteDisabled={!favorites.ready || favorites.pending.has(cue.id)}
                seekable={!!onSeek}
                onSeek={handleSeek}
                onToggleFavorite={favorites.toggle}
                onCopy={handleCopy}
                onQuote={onQuote}
              />
            ))
          )}
        </div>
        {canFollow && !following && (
          <Button
            size="sm"
            variant="primary"
            className={styles.follow}
            icon={<Locate size={14} aria-hidden="true" />}
            onClick={() => setFollowing(true)}
          >
            {t('options.transcript.follow')}
          </Button>
        )}
      </div>

      <div className={styles.footer}>
        <Button
          icon={<Copy size={15} aria-hidden="true" />}
          onClick={copyAll}
          disabled={visible.length === 0}
        >
          {t(
            favoritesOnly || query
              ? 'options.transcript.copyFiltered'
              : 'options.transcript.copyAll',
          )}
        </Button>
        <Button
          variant="primary"
          icon={<Download size={15} aria-hidden="true" />}
          onClick={() => setExportOpen(true)}
          disabled={cues.length === 0}
        >
          {t('options.transcript.export')}
        </Button>
      </div>

      <ExportDialog
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        cues={cues}
        favoriteIds={favorites.ids}
        source={source}
        initialContent={
          view === 'original' ? 'original' : view === 'translation' ? 'translation' : 'bilingual'
        }
        initialScope={favoritesOnly ? 'favorites' : 'all'}
        demo={demo}
      />
    </div>
  );
}

function emptyTitle(args: {
  loading?: boolean;
  total: number;
  favoritesOnly: boolean;
  query: string;
}): MessageKey {
  if (args.loading && args.total === 0) return 'options.transcript.syncing';
  if (args.total === 0) return 'options.transcript.emptyNone';
  if (args.favoritesOnly && !args.query) return 'options.transcript.emptyFavorites';
  return 'options.transcript.emptyNoMatch';
}

interface CueRowProps {
  cue: Cue;
  view: CueViewMode;
  active: boolean;
  favorite: boolean;
  favoriteDisabled: boolean;
  seekable: boolean;
  onSeek(cue: Cue): void;
  onToggleFavorite(cue: Cue): Promise<void>;
  onCopy(cue: Cue): void;
  onQuote?: (cue: Cue) => void;
}

const CueRow = memo(function CueRow({
  cue,
  view,
  active,
  favorite,
  favoriteDisabled,
  seekable,
  onSeek,
  onToggleFavorite,
  onCopy,
  onQuote,
}: CueRowProps) {
  const t = useT();
  const translated = translationOf(cue);
  const time = formatMediaTime(cue.startMs);
  const partialTranslation =
    !translated && cue.translationState === 'running' && cue.translatedText?.trim();

  let primary: string | undefined;
  let secondary: string | undefined;
  let placeholder: string | undefined;
  if (view === 'original') {
    primary = cue.sourceText;
  } else if (translated) {
    primary = translated;
    if (view === 'bilingual' && translated !== cue.sourceText) secondary = cue.sourceText;
  } else {
    placeholder = partialTranslation
      ? t('options.transcript.partialTranslation', { text: cue.translatedText ?? '' })
      : t(translationPlaceholder(cue));
    secondary = cue.sourceText;
  }

  return (
    <article
      className={cx(styles.row, active && styles.rowActive)}
      data-cue-id={cue.id}
      role="listitem"
      aria-current={active ? 'true' : undefined}
    >
      {seekable ? (
        <button
          type="button"
          className={styles.time}
          onClick={() => onSeek(cue)}
          aria-label={t('options.transcript.seekTo', { time })}
        >
          {time}
        </button>
      ) : (
        <span className={cx(styles.time, styles.timeStatic)}>{time}</span>
      )}
      <div className={styles.body}>
        {primary !== undefined && (
          <div className={cx(styles.primaryText, view !== 'original' && styles.translatedText)}>
            {primary}
          </div>
        )}
        {placeholder && <div className={styles.placeholder}>{placeholder}</div>}
        {secondary !== undefined && <div className={styles.secondaryText}>{secondary}</div>}
        <CueChips cue={cue} />
      </div>
      <div className={styles.actions}>
        <IconButton
          bare
          className={styles.favorite}
          label={t(favorite ? 'options.transcript.unfavorite' : 'options.transcript.favorite', {
            time,
          })}
          pressed={favorite}
          disabled={favoriteDisabled}
          icon={<Bookmark size={15} aria-hidden="true" />}
          onClick={() => void onToggleFavorite(cue)}
        />
        <IconButton
          bare
          label={t('options.transcript.copyCue', { time })}
          icon={<Copy size={15} aria-hidden="true" />}
          onClick={() => onCopy(cue)}
        />
        {onQuote && (
          <IconButton
            bare
            label={t('options.transcript.quoteCue', { time })}
            icon={<Quote size={15} aria-hidden="true" />}
            onClick={() => onQuote(cue)}
          />
        )}
      </div>
    </article>
  );
});

function translationPlaceholder(cue: Cue): MessageKey {
  switch (cue.translationState) {
    case 'pending':
      return 'options.transcript.pending';
    case 'running':
      return 'options.transcript.running';
    default:
      return 'options.transcript.noTranslation';
  }
}

function CueChips({ cue }: { cue: Cue }) {
  const t = useT();
  const chips: Array<{ label: string; tone?: 'danger' | 'warning' }> = [];
  if (cue.stability === 'interim')
    chips.push({ label: t('options.transcript.chipInterim'), tone: 'warning' });
  if (cue.translationState === 'failed') {
    // 错误信息由 worker 按当前界面语言生成，原样显示。
    chips.push({
      label: cue.translationError?.message
        ? t('options.transcript.chipFailedWith', { message: cue.translationError.message })
        : t('options.transcript.chipFailed'),
      tone: 'danger',
    });
  }
  if (cue.endEstimated) chips.push({ label: t('options.transcript.chipEstimated') });
  if (chips.length === 0) return null;
  return (
    <div className={styles.chips}>
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={cx(
            styles.chip,
            chip.tone === 'danger' && styles.chipDanger,
            chip.tone === 'warning' && styles.chipWarning,
          )}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
}

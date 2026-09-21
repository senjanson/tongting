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
      const ok = await copyText(cueCopyText(cue, view));
      notify(ok ? '已复制这句字幕。' : '复制失败，请手动选择文本。', ok ? 'success' : 'danger');
    },
    [notify, view],
  );

  const copyAll = async () => {
    if (visible.length === 0) return;
    const ok = await copyText(cuesCopyText(visible, view));
    notify(
      ok ? `已复制 ${visible.length} 条字幕。` : '复制失败，请改用导出。',
      ok ? 'success' : 'danger',
    );
  };

  const canFollow = currentTimeMs !== undefined;
  const coverageText = describeCoverage(source.coverage, source.sourceMode);
  const partial = !(source.coverage?.complete && source.sourceMode === 'full-track');

  return (
    <div className={cx(styles.root, compact && styles.compact)}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            className={controlStyles.input}
            placeholder="搜索原文或译文"
            aria-label="搜索字幕"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <IconButton
          label={favoritesOnly ? '显示全部字幕' : '只看收藏'}
          icon={<Bookmark size={16} aria-hidden="true" />}
          pressed={favoritesOnly}
          onClick={() => setFavoritesOnly((v) => !v)}
        />
        {compact && (
          <IconButton
            label="跟随播放"
            icon={<Locate size={16} aria-hidden="true" />}
            pressed={following}
            disabled={!canFollow}
            onClick={() => setFollowing(true)}
          />
        )}
      </div>
      <details className={styles.displayOptions} open={!compact || undefined}>
        <summary hidden={!compact}>显示与覆盖详情</summary>
        <div className={styles.viewRow}>
          <Segmented<CueViewMode>
            label="字幕显示内容"
            value={view}
            onChange={setView}
            options={[
              { value: 'bilingual', label: '双语' },
              { value: 'translation', label: '译文' },
              { value: 'original', label: '原文' },
            ]}
          />
        </div>
        <div className={styles.coverage} data-partial={partial || undefined}>
          {coverageText}
        </div>
      </details>
      <div className={styles.meta}>
        <span>
          {loading ? '正在同步字幕…' : `${visible.length} / ${cues.length} 条字幕`}
          {source.kind === 'record' ? ' · 本地记录' : ' · 实时'}
        </span>
        <span>
          {!source.recordId
            ? '字幕记录尚未确定，暂不能收藏'
            : favorites.loadFailed
              ? '收藏读取失败'
              : favorites.loading
                ? '正在读取收藏…'
                : `${favorites.ids.size} 条收藏`}
        </span>
      </div>
      {backfill && backfill.total > 0 && (backfill.enabled || backfill.done < backfill.total) && (
        <div className={styles.meta}>
          <span>
            {backfill.enabled
              ? `正在翻译全片：${backfill.done} / ${backfill.total}`
              : `已翻译 ${backfill.done} / ${backfill.total} 条；翻译全片后可导出完整译文`}
          </span>
          <Button
            size="sm"
            onClick={() => backfill.onToggle(!backfill.enabled)}
            title="播放位置附近的翻译优先；全片翻译每次只发一个请求，会产生额外调用"
          >
            {backfill.enabled ? '停止翻译全片' : '翻译全片'}
          </Button>
        </div>
      )}
      {!onSeek && seekUnavailableReason && <Hint>{seekUnavailableReason}</Hint>}

      <div className={styles.listWrap}>
        <div
          ref={listRef}
          className={styles.list}
          role="list"
          aria-label="字幕列表"
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
            <EmptyState title={emptyTitle({ loading, total: cues.length, favoritesOnly, query })}>
              {cues.length === 0 && !loading ? '开始翻译后，已获得的字幕会显示在这里。' : undefined}
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
            跟随播放
          </Button>
        )}
      </div>

      <div className={styles.footer}>
        <Button
          icon={<Copy size={15} aria-hidden="true" />}
          onClick={copyAll}
          disabled={visible.length === 0}
        >
          复制{favoritesOnly || query ? '筛选结果' : '全部'}
        </Button>
        <Button
          variant="primary"
          icon={<Download size={15} aria-hidden="true" />}
          onClick={() => setExportOpen(true)}
          disabled={cues.length === 0}
        >
          导出字幕
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
}): string {
  if (args.loading && args.total === 0) return '正在同步字幕…';
  if (args.total === 0) return '还没有字幕';
  if (args.favoritesOnly && !args.query) return '还没有收藏的字幕';
  return '没有匹配的字幕';
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
      ? `译文生成中：${cue.translatedText}`
      : translationPlaceholder(cue);
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
          aria-label={`跳转到 ${time}`}
        >
          {time}
        </button>
      ) : (
        <span className={cx(styles.time, styles.timeStatic)}>{time}</span>
      )}
      <div className={styles.body}>
        {primary !== undefined && <div className={styles.primaryText}>{primary}</div>}
        {placeholder && <div className={styles.placeholder}>{placeholder}</div>}
        {secondary !== undefined && <div className={styles.secondaryText}>{secondary}</div>}
        <CueChips cue={cue} />
      </div>
      <div className={styles.actions}>
        <IconButton
          bare
          className={styles.favorite}
          label={favorite ? `取消收藏 ${time} 字幕` : `收藏 ${time} 字幕`}
          pressed={favorite}
          disabled={favoriteDisabled}
          icon={<Bookmark size={15} aria-hidden="true" />}
          onClick={() => void onToggleFavorite(cue)}
        />
        <IconButton
          bare
          label={`复制 ${time} 字幕`}
          icon={<Copy size={15} aria-hidden="true" />}
          onClick={() => onCopy(cue)}
        />
        {onQuote && (
          <IconButton
            bare
            label={`把 ${time} 字幕引用到笔记`}
            icon={<Quote size={15} aria-hidden="true" />}
            onClick={() => onQuote(cue)}
          />
        )}
      </div>
    </article>
  );
});

function translationPlaceholder(cue: Cue): string {
  switch (cue.translationState) {
    case 'pending':
      return '等待翻译';
    case 'running':
      return '正在翻译';
    default:
      return '暂无译文';
  }
}

function CueChips({ cue }: { cue: Cue }) {
  const chips: Array<{ label: string; tone?: 'danger' | 'warning' }> = [];
  if (cue.stability === 'interim') chips.push({ label: '临时识别', tone: 'warning' });
  if (cue.translationState === 'failed') {
    chips.push({
      label: cue.translationError?.message
        ? `翻译失败：${cue.translationError.message}`
        : '翻译失败',
      tone: 'danger',
    });
  }
  if (cue.endEstimated) chips.push({ label: '结束时间为估计' });
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

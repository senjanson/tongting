/**
 * 导出对话框：格式、范围、内容、未翻译处理、临时结果；显示预览、实际覆盖范围与各类计数。
 * 文件头说明、覆盖统计与文件名标签按当前界面语言生成，字幕正文不变。
 */
import { Copy, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Cue, SubtitleCoverage } from '../../domain/cue';
import type { SourceMode } from '../../domain/session';
import {
  downloadExport,
  formatExport,
  interimMark,
  untranslatedMark,
  type ExportContent,
  type ExportFormat,
  type ExportScope,
  type UntranslatedPolicy,
} from '../../export';
import type { MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import { Button, Checkbox, Hint, Segmented, SelectField, TextArea } from '../components/controls';
import { Callout, Dialog } from '../components/layout';
import { useToast } from '../components/toast';
import { copyText } from '../shared/clipboard';
import styles from './transcript.module.css';

const PREVIEW_LIMIT = 20_000;

/** 统计列表中按需显示的计数（大于 0 时显示）。 */
const STAT_KEYS: ReadonlyArray<
  readonly [
    (
      | 'skippedUntranslated'
      | 'markedUntranslated'
      | 'skippedInterim'
      | 'markedInterim'
      | 'skippedInvalid'
      | 'fixedTimings'
    ),
    MessageKey,
  ]
> = [
  ['skippedUntranslated', 'options.export.stats.skippedUntranslated'],
  ['markedUntranslated', 'options.export.stats.markedUntranslated'],
  ['skippedInterim', 'options.export.stats.skippedInterim'],
  ['markedInterim', 'options.export.stats.markedInterim'],
  ['skippedInvalid', 'options.export.stats.skippedInvalid'],
  ['fixedTimings', 'options.export.stats.fixedTimings'],
];

export interface ExportSource {
  videoId: string;
  title?: string;
  targetLanguage: string;
  sourceLanguage: string;
  sourceMode: SourceMode;
  coverage?: SubtitleCoverage;
}

export interface ExportDialogProps {
  open: boolean;
  onClose(): void;
  cues: readonly Cue[];
  favoriteIds: ReadonlySet<string>;
  source: ExportSource;
  initialContent: ExportContent;
  initialScope: ExportScope;
  demo?: boolean;
}

export function ExportDialog(props: ExportDialogProps) {
  if (!props.open) return null;
  return <ExportDialogBody {...props} />;
}

function ExportDialogBody({
  onClose,
  cues,
  favoriteIds,
  source,
  initialContent,
  initialScope,
  demo,
}: ExportDialogProps) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const [format, setFormat] = useState<ExportFormat>('srt');
  const [content, setContent] = useState<ExportContent>(initialContent);
  const [scope, setScope] = useState<ExportScope>(initialScope);
  const [includeInterim, setIncludeInterim] = useState(false);
  const [untranslated, setUntranslated] = useState<UntranslatedPolicy>(
    initialContent === 'bilingual' ? 'mark' : 'skip',
  );
  const [bom, setBom] = useState(false);
  const hasInterim = useMemo(() => cues.some((c) => c.stability === 'interim'), [cues]);
  // 只统计当前记录中实际存在的收藏；其余（例如旧会话或已修订的字幕）单独提示。
  const presentFavorites = useMemo(() => {
    const ids = new Set(cues.map((c) => c.id));
    let count = 0;
    for (const id of favoriteIds) if (ids.has(id)) count++;
    return count;
  }, [cues, favoriteIds]);
  const missingFavorites = favoriteIds.size - presentFavorites;

  const result = useMemo(
    () =>
      formatExport(format, {
        cues,
        content,
        scope,
        favoriteCueIds: favoriteIds,
        includeInterim,
        untranslated,
        coverage: source.coverage,
        sourceMode: source.sourceMode,
        title: demo ? t('options.export.demoTitle', { title: source.title ?? '' }) : source.title,
        videoId: source.videoId,
        targetLanguage: source.targetLanguage,
        sourceLanguage: source.sourceLanguage,
        locale,
      }),
    [
      format,
      cues,
      content,
      scope,
      favoriteIds,
      includeInterim,
      untranslated,
      source,
      demo,
      locale,
      t,
    ],
  );

  const preview =
    result.text.length > PREVIEW_LIMIT
      ? `${result.text.slice(0, PREVIEW_LIMIT)}\n${t('options.export.previewTruncated')}`
      : result.text;
  const empty = result.includedCount === 0;

  const onCopy = async () => {
    const ok = await copyText(result.text);
    notify(
      ok
        ? t('options.export.copied', { count: result.includedCount })
        : t('options.export.copyFailed'),
      ok ? 'success' : 'danger',
    );
  };

  const onDownload = () => {
    try {
      downloadExport(format, result.text, result.filename, { bom });
      notify(t('options.export.downloadStarted', { filename: result.filename }), 'success');
    } catch {
      notify(t('options.export.downloadFailed'), 'danger');
    }
  };

  return (
    <Dialog
      open
      title={t('options.transcript.export')}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t('options.action.cancel')}</Button>
          <Button icon={<Copy size={15} aria-hidden="true" />} onClick={onCopy} disabled={empty}>
            {t('options.action.copy')}
          </Button>
          <Button
            variant="primary"
            icon={<Download size={15} aria-hidden="true" />}
            onClick={onDownload}
            disabled={empty}
          >
            {t('options.export.download', { format: format.toUpperCase() })}
          </Button>
        </>
      }
    >
      {demo && <Callout tone="demo">{t('options.export.demoCallout')}</Callout>}
      <Segmented<ExportFormat>
        label={t('options.export.format')}
        value={format}
        onChange={setFormat}
        options={[
          { value: 'srt', label: 'SRT' },
          { value: 'vtt', label: 'VTT' },
          { value: 'txt', label: 'TXT' },
        ]}
      />
      <div className={styles.exportGrid}>
        <SelectField<ExportScope>
          label={t('options.export.scope')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: t('options.export.scopeAll') },
            {
              value: 'favorites',
              label: t('options.export.scopeFavorites', { count: presentFavorites }),
            },
          ]}
        />
        <SelectField<ExportContent>
          label={t('options.export.content')}
          value={content}
          onChange={(value) => {
            setContent(value);
            setUntranslated(value === 'bilingual' ? 'mark' : 'skip');
          }}
          options={[
            { value: 'bilingual', label: t('options.export.contentBilingual') },
            { value: 'translation', label: t('options.export.contentTranslation') },
            { value: 'original', label: t('options.export.contentOriginal') },
          ]}
        />
        {content !== 'original' && (
          <SelectField<UntranslatedPolicy>
            label={t('options.export.untranslated')}
            value={untranslated}
            onChange={setUntranslated}
            options={[
              { value: 'skip', label: t('options.export.untranslatedSkip') },
              {
                value: 'mark',
                label: t('options.export.untranslatedMark', { mark: untranslatedMark(locale) }),
              },
            ]}
          />
        )}
      </div>
      {missingFavorites > 0 && (
        <Hint>{t('options.export.missingFavorites', { count: missingFavorites })}</Hint>
      )}
      {hasInterim && (
        <Checkbox
          label={t('options.export.includeInterim', { mark: interimMark(locale) })}
          checked={includeInterim}
          onChange={setIncludeInterim}
        />
      )}
      <Callout
        tone={source.coverage?.complete && source.sourceMode === 'full-track' ? 'info' : 'warning'}
        title={t('options.export.coverageTitle')}
      >
        {result.coverageSummary}
      </Callout>
      <ul className={styles.statsList} aria-label={t('options.export.statsAria')}>
        <li>{t('options.export.stats.included', { count: result.includedCount })}</li>
        {STAT_KEYS.map(([field, key]) =>
          result[field] > 0 ? <li key={field}>{t(key, { count: result[field] })}</li> : null,
        )}
      </ul>
      <Checkbox label={t('options.export.bom')} checked={bom} onChange={setBom} />
      <TextArea
        className={styles.preview}
        readOnly
        value={preview}
        aria-label={t('options.export.previewAria')}
        spellCheck={false}
      />
      <Hint>
        {t('options.export.filename')}
        <span className={styles.filename}>{result.filename}</span>
        {t('options.export.encoding', {
          encoding: bom ? t('options.export.encodingBom') : 'UTF-8',
        })}
      </Hint>
      {empty && <Hint tone="error">{t('options.export.nothing')}</Hint>}
    </Dialog>
  );
}

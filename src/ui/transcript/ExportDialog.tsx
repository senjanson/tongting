/**
 * 导出对话框：格式、范围、内容、未翻译处理、临时结果；显示预览、实际覆盖范围与各类计数。
 */
import { Copy, Download } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { Cue, SubtitleCoverage } from '../../domain/cue';
import type { SourceMode } from '../../domain/session';
import {
  downloadExport,
  formatExport,
  INTERIM_MARK,
  UNTRANSLATED_MARK,
  type ExportContent,
  type ExportFormat,
  type ExportScope,
  type UntranslatedPolicy,
} from '../../export';
import { Button, Checkbox, Hint, Segmented, SelectField, TextArea } from '../components/controls';
import { Callout, Dialog } from '../components/layout';
import { useToast } from '../components/toast';
import { copyText } from '../shared/clipboard';
import styles from './transcript.module.css';

const PREVIEW_LIMIT = 20_000;

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
        title: demo ? `演示-${source.title ?? ''}` : source.title,
        videoId: source.videoId,
        targetLanguage: source.targetLanguage,
        sourceLanguage: source.sourceLanguage,
      }),
    [format, cues, content, scope, favoriteIds, includeInterim, untranslated, source, demo],
  );

  const preview =
    result.text.length > PREVIEW_LIMIT
      ? `${result.text.slice(0, PREVIEW_LIMIT)}\n…（预览已截断，复制或下载会包含全部内容）`
      : result.text;
  const empty = result.includedCount === 0;

  const onCopy = async () => {
    const ok = await copyText(result.text);
    notify(
      ok ? `已复制 ${result.includedCount} 条字幕。` : '复制失败，请在预览框中手动选择文本复制。',
      ok ? 'success' : 'danger',
    );
  };

  const onDownload = () => {
    try {
      downloadExport(format, result.text, result.filename, { bom });
      notify(`已开始下载 ${result.filename}`, 'success');
    } catch {
      notify('下载失败，请改用复制。', 'danger');
    }
  };

  return (
    <Dialog
      open
      title="导出字幕"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button icon={<Copy size={15} aria-hidden="true" />} onClick={onCopy} disabled={empty}>
            复制
          </Button>
          <Button
            variant="primary"
            icon={<Download size={15} aria-hidden="true" />}
            onClick={onDownload}
            disabled={empty}
          >
            下载 {format.toUpperCase()}
          </Button>
        </>
      }
    >
      {demo && <Callout tone="demo">演示模式：导出内容为示例字幕。</Callout>}
      <Segmented<ExportFormat>
        label="导出格式"
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
          label="范围"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: '全部已获得的字幕' },
            { value: 'favorites', label: `仅收藏（${presentFavorites} 条）` },
          ]}
        />
        <SelectField<ExportContent>
          label="内容"
          value={content}
          onChange={(value) => {
            setContent(value);
            setUntranslated(value === 'bilingual' ? 'mark' : 'skip');
          }}
          options={[
            { value: 'bilingual', label: '译文 + 原文' },
            { value: 'translation', label: '仅译文' },
            { value: 'original', label: '仅原文' },
          ]}
        />
        {content !== 'original' && (
          <SelectField<UntranslatedPolicy>
            label="未完成翻译的条目"
            value={untranslated}
            onChange={setUntranslated}
            options={[
              { value: 'skip', label: '排除' },
              { value: 'mark', label: `以原文输出并标记${UNTRANSLATED_MARK}` },
            ]}
          />
        )}
      </div>
      {missingFavorites > 0 && (
        <Hint>收藏中 {missingFavorites} 条已不在当前记录，导出时不会包含。</Hint>
      )}
      {hasInterim && (
        <Checkbox
          label={`包含临时识别结果（会标记${INTERIM_MARK}；默认只导出已确认的句子）`}
          checked={includeInterim}
          onChange={setIncludeInterim}
        />
      )}
      <Callout
        tone={source.coverage?.complete && source.sourceMode === 'full-track' ? 'info' : 'warning'}
        title="实际覆盖范围"
      >
        {result.coverageSummary}
      </Callout>
      <ul className={styles.statsList} aria-label="导出统计">
        <li>导出 {result.includedCount} 条</li>
        {result.skippedUntranslated > 0 && (
          <li>未完成翻译已排除 {result.skippedUntranslated} 条</li>
        )}
        {result.markedUntranslated > 0 && <li>未完成翻译已标记 {result.markedUntranslated} 条</li>}
        {result.skippedInterim > 0 && <li>临时识别结果已排除 {result.skippedInterim} 条</li>}
        {result.markedInterim > 0 && <li>临时识别结果已包含并标记 {result.markedInterim} 条</li>}
        {result.skippedInvalid > 0 && <li>空白或无效条目已跳过 {result.skippedInvalid} 条</li>}
        {result.fixedTimings > 0 && <li>结束时间无效已修正 {result.fixedTimings} 条</li>}
      </ul>
      <Checkbox label="UTF-8 带 BOM（兼容部分 Windows 播放器）" checked={bom} onChange={setBom} />
      <TextArea
        className={styles.preview}
        readOnly
        value={preview}
        aria-label="导出内容预览"
        spellCheck={false}
      />
      <Hint>
        文件名：<span className={styles.filename}>{result.filename}</span>（
        {bom ? 'UTF-8 带 BOM' : 'UTF-8'}）
      </Hint>
      {empty && <Hint tone="error">当前选择没有可导出的字幕。</Hint>}
    </Dialog>
  );
}

/**
 * 诊断日志：复制 / 下载 / 清空。日志由 worker 生成并脱敏（不含 Key、令牌、字幕原文、音频与带授权参数的 URL）。
 */
import { ClipboardCopy, Download, Trash } from 'lucide-react';
import { useT } from '../../i18n/react';
import { downloadTextFile } from '../../export';
import { Button, Hint } from '../components/controls';
import { useToast } from '../components/toast';
import { copyText } from '../shared/clipboard';
import { useCommandRunner } from '../shared/hooks';
import { Section } from './common';
import styles from './options.module.css';

function fileStamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function DiagnosticsSection() {
  const t = useT();
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();

  const load = () =>
    run(
      { kind: 'diagnostics/export' },
      { key: 'diagnostics', errorPrefix: t('options.diagnostics.exportFailed') },
    );

  const copy = async () => {
    const result = await load();
    if (!result) return;
    if (await copyText(result.text))
      notify(t('options.diagnostics.copied', { count: result.entries }), 'success');
    else notify(t('options.diagnostics.copyFailed'), 'warning');
  };

  const download = async () => {
    const result = await load();
    if (!result) return;
    downloadTextFile(
      result.text,
      `vocasub-diagnostics-${fileStamp(new Date())}.txt`,
      'text/plain;charset=utf-8',
    );
    notify(t('options.diagnostics.downloaded', { count: result.entries }), 'success');
  };

  const clear = async () => {
    const result = await run(
      { kind: 'diagnostics/clear' },
      { errorPrefix: t('options.diagnostics.clearFailed') },
    );
    if (result) notify(t('options.diagnostics.cleared'), 'success');
  };

  const busy = isBusy('diagnostics') || isBusy('diagnostics/clear');
  return (
    <Section
      id="diagnostics"
      title={t('options.section.diagnostics')}
      description={t('options.diagnostics.description')}
    >
      <Hint>{t('options.diagnostics.steps')}</Hint>
      <div className={styles.row}>
        <Button
          variant="primary"
          icon={<ClipboardCopy size={15} aria-hidden="true" />}
          disabled={busy}
          onClick={() => void copy()}
        >
          {t('options.diagnostics.copy')}
        </Button>
        <Button
          icon={<Download size={15} aria-hidden="true" />}
          disabled={busy}
          onClick={() => void download()}
        >
          {t('options.diagnostics.download')}
        </Button>
        <Button
          variant="ghost"
          icon={<Trash size={15} aria-hidden="true" />}
          disabled={busy}
          onClick={() => void clear()}
        >
          {t('options.diagnostics.clear')}
        </Button>
      </div>
      <Hint>{t('options.diagnostics.privacy')}</Hint>
    </Section>
  );
}

/**
 * 数据与隐私：清空翻译缓存、删除 Key、导出非敏感设置、恢复默认设置、快捷键、演示模式入口。
 */
import { Download, ExternalLink, FlaskConical, Keyboard, RotateCcw, Trash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import type { MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { downloadTextFile } from '../../export';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button, Hint, Kbd } from '../components/controls';
import { useToast } from '../components/toast';
import { useCommandRunner } from '../shared/hooks';
import { openShortcutSettings, openSidepanelDemoTab } from '../shared/navigation';
import { Section } from './common';
import { buildSettingsExport } from './export-settings';
import styles from './options.module.css';

type Pending = 'cache' | 'key' | 'reset' | null;

export function DataSection({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();
  const [confirm, setConfirm] = useState<Pending>(null);

  const exportSettings = () => {
    try {
      const file = buildSettingsExport(snapshot.settings, new Date(), locale);
      downloadTextFile(
        `${JSON.stringify(file, null, 2)}\n`,
        'tongting-settings.json',
        'application/json',
      );
      notify(t('options.data.exported'), 'success');
    } catch {
      notify(t('options.data.exportFailed'), 'danger');
    }
  };

  return (
    <Section
      id="data"
      title={t('options.section.data')}
      description={t('options.data.description')}
    >
      <div className={styles.row}>
        <Button icon={<Trash size={15} aria-hidden="true" />} onClick={() => setConfirm('cache')}>
          {t('options.data.clearCache')}
        </Button>
        <Button
          variant="danger"
          icon={<Trash size={15} aria-hidden="true" />}
          disabled={!snapshot.credential.configured && !snapshot.credential.cleanupPending}
          onClick={() => setConfirm('key')}
        >
          {t('options.connection.deleteKey')}
        </Button>
        <Button icon={<Download size={15} aria-hidden="true" />} onClick={exportSettings}>
          {t('options.data.exportSettings')}
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw size={15} aria-hidden="true" />}
          onClick={() => setConfirm('reset')}
        >
          {t('options.data.reset')}
        </Button>
      </div>
      <Hint>{t('options.data.exportHint')}</Hint>

      <ConfirmDialog
        open={confirm === 'cache'}
        title={t('options.data.clearCache')}
        confirmLabel={t('options.data.clearConfirm')}
        danger
        busy={isBusy('cache/clear')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run(
            { kind: 'cache/clear' },
            { errorPrefix: t('options.data.clearCacheFailed') },
          );
          setConfirm(null);
          if (result) notify(t('options.data.cacheCleared'), 'success');
        }}
      >
        {t('options.data.clearCacheBody')}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'key'}
        title={t('options.connection.deleteKeyTitle')}
        confirmLabel={t('options.action.delete')}
        danger
        busy={isBusy('credentials/clear')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run(
            { kind: 'credentials/clear' },
            { errorPrefix: t('options.connection.deleteKeyFailed') },
          );
          setConfirm(null);
          if (result) notify(t('options.connection.keyDeleted'), 'success');
        }}
      >
        {t('options.data.deleteKeyBody')}
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'reset'}
        title={t('options.data.reset')}
        confirmLabel={t('options.data.resetConfirm')}
        busy={isBusy('settings/reset')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run(
            { kind: 'settings/reset' },
            { errorPrefix: t('options.data.resetFailed') },
          );
          setConfirm(null);
          if (result)
            notify(
              t(result.persisted ? 'options.data.resetDone' : 'options.data.resetNotPersisted'),
              result.persisted ? 'success' : 'warning',
            );
        }}
      >
        {t('options.data.resetBody')}
        {snapshot.settingsRecovery === 'unreadable' && t('options.data.resetUnreadable')}
      </ConfirmDialog>
    </Section>
  );
}

interface ShortcutInfo {
  name: string;
  description: MessageKey;
  /** null：浏览器中未设置快捷键。 */
  shortcut: string | null;
}

const FALLBACK_SHORTCUTS: ShortcutInfo[] = [
  {
    name: 'toggle-translation',
    description: 'options.shortcuts.toggleTranslation',
    shortcut: 'Alt+T',
  },
  { name: 'toggle-captions', description: 'options.shortcuts.toggleCaptions', shortcut: 'Alt+C' },
];

export function ShortcutsSection() {
  const t = useT();
  const notify = useToast();
  const [shortcuts, setShortcuts] = useState<ShortcutInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // 包一层 Promise：部分环境中 API 缺失时会同步抛错。
    Promise.resolve()
      .then(() => browser.commands.getAll())
      .then((commands) => {
        if (cancelled) return;
        const known = FALLBACK_SHORTCUTS.map((fallback) => {
          const actual = commands.find((c) => c.name === fallback.name);
          return {
            ...fallback,
            shortcut: actual ? actual.shortcut || null : fallback.shortcut,
          };
        });
        setShortcuts(known);
      })
      .catch(() => {
        if (!cancelled) setShortcuts(FALLBACK_SHORTCUTS);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Section
      id="shortcuts"
      title={t('options.section.shortcuts')}
      description={t('options.shortcuts.description')}
    >
      <div>
        {(shortcuts ?? FALLBACK_SHORTCUTS).map((s) => (
          <div key={s.name} className={styles.shortcut}>
            <span>{t(s.description)}</span>
            <Kbd>{s.shortcut ?? t('options.shortcuts.unset')}</Kbd>
          </div>
        ))}
      </div>
      <div className={styles.row}>
        <Button
          icon={<Keyboard size={15} aria-hidden="true" />}
          onClick={() =>
            openShortcutSettings().catch(() =>
              notify(t('options.shortcuts.openManually'), 'warning'),
            )
          }
        >
          {t('options.shortcuts.change')}
        </Button>
      </div>
      <Hint>{t('options.shortcuts.hint')}</Hint>
    </Section>
  );
}

export function DemoSection() {
  const t = useT();
  const notify = useToast();
  return (
    <Section
      id="demo"
      title={t('options.section.demo')}
      description={t('options.demo.description')}
    >
      <div className={styles.row}>
        <Button
          icon={<FlaskConical size={15} aria-hidden="true" />}
          onClick={() =>
            openSidepanelDemoTab().catch(() => notify(t('options.demo.openFailed'), 'danger'))
          }
        >
          {t('options.demo.open')}
          <ExternalLink size={13} aria-hidden="true" />
        </Button>
      </div>
    </Section>
  );
}

/**
 * 数据与隐私：清空翻译缓存、删除 Key、导出非敏感设置、恢复默认设置、快捷键、演示模式入口。
 */
import { Download, ExternalLink, FlaskConical, Keyboard, RotateCcw, Trash } from 'lucide-react';
import { useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
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
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();
  const [confirm, setConfirm] = useState<Pending>(null);

  const exportSettings = () => {
    try {
      const file = buildSettingsExport(snapshot.settings);
      downloadTextFile(
        `${JSON.stringify(file, null, 2)}\n`,
        'tongting-settings.json',
        'application/json',
      );
      notify('已导出非敏感设置（不含 Key 与令牌）。', 'success');
    } catch {
      notify('导出设置失败。', 'danger');
    }
  };

  return (
    <Section
      id="data"
      title="数据与隐私"
      description="字幕记录、收藏与笔记保存在本机浏览器中，清空翻译缓存不会删除它们。"
    >
      <div className={styles.row}>
        <Button icon={<Trash size={15} aria-hidden="true" />} onClick={() => setConfirm('cache')}>
          清空翻译缓存
        </Button>
        <Button
          variant="danger"
          icon={<Trash size={15} aria-hidden="true" />}
          disabled={!snapshot.credential.configured && !snapshot.credential.cleanupPending}
          onClick={() => setConfirm('key')}
        >
          删除 Key
        </Button>
        <Button icon={<Download size={15} aria-hidden="true" />} onClick={exportSettings}>
          导出非敏感设置
        </Button>
        <Button
          variant="ghost"
          icon={<RotateCcw size={15} aria-hidden="true" />}
          onClick={() => setConfirm('reset')}
        >
          恢复默认设置
        </Button>
      </div>
      <Hint>导出的设置文件不包含 API Key 与本地识别服务配对令牌，地址中的查询参数也会被去除。</Hint>

      <ConfirmDialog
        open={confirm === 'cache'}
        title="清空翻译缓存"
        confirmLabel="清空"
        danger
        busy={isBusy('cache/clear')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run({ kind: 'cache/clear' }, { errorPrefix: '清空缓存失败' });
          setConfirm(null);
          if (result) notify('已清空翻译缓存。之后的翻译会重新请求服务。', 'success');
        }}
      >
        清空后，已缓存的译文需要重新请求翻译服务（可能产生费用）。字幕记录、收藏与笔记不受影响。
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'key'}
        title="删除 API Key"
        confirmLabel="删除"
        danger
        busy={isBusy('credentials/clear')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run({ kind: 'credentials/clear' }, { errorPrefix: '删除 Key 失败' });
          setConfirm(null);
          if (result) notify('已删除 Key。使用旧 Key 的请求会被中止。', 'success');
        }}
      >
        删除后翻译会停止使用该 Key，正在进行的请求会被中止。
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === 'reset'}
        title="恢复默认设置"
        confirmLabel="恢复默认"
        busy={isBusy('settings/reset')}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          const result = await run({ kind: 'settings/reset' }, { errorPrefix: '恢复默认失败' });
          setConfirm(null);
          if (result)
            notify(
              result.persisted ? '已恢复默认设置。' : '已恢复默认设置，但仅本次生效，保存失败。',
              result.persisted ? 'success' : 'warning',
            );
        }}
      >
        服务地址、模型、目标语言（按浏览器界面语言选择）、字幕与声音等设置会恢复为默认值，不再使用的服务地址的访问权限会被移除。API
        Key、本地识别配对令牌及「记住在本机」的选择保持不变；字幕记录、收藏与笔记不受影响。
        {snapshot.settingsRecovery === 'unreadable' && ' 暂时无法读取的原设置也会被默认值覆盖。'}
      </ConfirmDialog>
    </Section>
  );
}

interface ShortcutInfo {
  name: string;
  description: string;
  shortcut: string;
}

const FALLBACK_SHORTCUTS: ShortcutInfo[] = [
  { name: 'toggle-translation', description: '暂停 / 继续翻译', shortcut: 'Alt+T' },
  { name: 'toggle-captions', description: '显示 / 隐藏翻译字幕', shortcut: 'Alt+C' },
];

export function ShortcutsSection() {
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
            shortcut: actual ? actual.shortcut || '未设置' : fallback.shortcut,
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
      title="快捷键"
      description="默认 Alt+T 暂停/继续翻译，Alt+C 显示/隐藏翻译字幕。"
    >
      {(shortcuts ?? FALLBACK_SHORTCUTS).map((s) => (
        <div key={s.name} className={styles.row} style={{ justifyContent: 'space-between' }}>
          <span>{s.description}</span>
          <Kbd>{s.shortcut}</Kbd>
        </div>
      ))}
      <div className={styles.row}>
        <Button
          icon={<Keyboard size={15} aria-hidden="true" />}
          onClick={() =>
            openShortcutSettings().catch(() =>
              notify('请手动打开 chrome://extensions/shortcuts。', 'warning'),
            )
          }
        >
          修改快捷键
        </Button>
      </div>
      <Hint>可在 chrome://extensions/shortcuts 修改；与其他扩展冲突时浏览器可能不会生效。</Hint>
    </Section>
  );
}

export function DemoSection() {
  const notify = useToast();
  return (
    <Section
      id="demo"
      title="演示模式"
      description="用示例数据预览界面与操作流程。演示模式不连接视频与服务，也不会发送任何请求。"
    >
      <div className={styles.row}>
        <Button
          icon={<FlaskConical size={15} aria-hidden="true" />}
          onClick={() => openSidepanelDemoTab().catch(() => notify('无法打开演示页面。', 'danger'))}
        >
          打开演示模式
          <ExternalLink size={13} aria-hidden="true" />
        </Button>
      </div>
    </Section>
  );
}

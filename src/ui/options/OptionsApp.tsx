/**
 * 设置页（在新标签页中打开）。
 */
import { Spinner } from '../components/controls';
import { Brand, Callout, EmptyState, ReconnectBanner } from '../components/layout';
import { ToastProvider } from '../components/toast';
import { UiClientProvider, useBackground, useClientState } from '../state/hooks';
import { ConnectionSection } from './ConnectionSection';
import { DataSection, DemoSection, ShortcutsSection } from './DataSection';
import { GlossarySection } from './GlossarySection';
import styles from './options.module.css';
import { ProcessingSection } from './ProcessingSection';

const NAV = [
  { id: 'connection', label: '模型连接' },
  { id: 'processing', label: '识别与播放' },
  { id: 'glossary', label: '术语表' },
  { id: 'data', label: '数据与隐私' },
  { id: 'shortcuts', label: '快捷键' },
  { id: 'demo', label: '演示模式' },
];

export function OptionsApp() {
  const { client } = useBackground('options');
  return (
    <ToastProvider>
      <UiClientProvider client={client}>
        <OptionsView />
      </UiClientProvider>
    </ToastProvider>
  );
}

function OptionsView() {
  const { connection, snapshot } = useClientState();
  return (
    <div className={styles.app}>
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <Brand />
          <h1>设置</h1>
        </div>
      </header>
      {connection !== 'connected' && <ReconnectBanner hasSnapshot={!!snapshot} />}
      {!snapshot ? (
        <EmptyState icon={<Spinner />} title="正在连接后台服务…">
          如果长时间停留在这里，请在 chrome://extensions 中重新加载同听。
        </EmptyState>
      ) : (
        <div className={styles.layout}>
          <nav className={styles.nav} aria-label="设置分区">
            {NAV.map((item) => (
              <a key={item.id} href={`#${item.id}`}>
                {item.label}
              </a>
            ))}
          </nav>
          <main className={styles.main}>
            {snapshot.settingsRecovery === 'recovered' && (
              <Callout tone="warning" title="设置已恢复为默认值">
                已保存的设置无法识别（可能来自更新版本的同听，或数据已损坏），当前使用默认设置。原设置已在本机备份，不会被删除。保存任一设置后此提示消失。
              </Callout>
            )}
            {snapshot.settingsRecovery === 'unreadable' ? (
              <Callout tone="warning" title="暂时无法读取已保存的设置">
                当前显示的是默认设置。为避免覆盖原设置，修改只在本次生效、不会保存；每次修改时会重新读取，读取成功后会在原设置上应用这些修改。
              </Callout>
            ) : (
              !snapshot.settingsPersisted && (
                <Callout tone="warning" title="设置未能保存">
                  最近的设置修改仅本次生效，浏览器重启后会丢失。
                </Callout>
              )
            )}
            <ConnectionSection snapshot={snapshot} />
            <ProcessingSection snapshot={snapshot} />
            <GlossarySection glossary={snapshot.settings.glossary} />
            <DataSection snapshot={snapshot} />
            <ShortcutsSection />
            <DemoSection />
          </main>
        </div>
      )}
    </div>
  );
}

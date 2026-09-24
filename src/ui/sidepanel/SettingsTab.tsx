/**
 * 侧栏「设置」标签：常用项与服务状态摘要；完整设置在设置页。
 * 按卡片分组：界面、外观主题、模型连接、识别与播放、配音声音（系统语音时）、更多设置。
 */
import { ExternalLink, FlaskConical, PanelsTopLeft, SlidersHorizontal } from 'lucide-react';
import { LOCALE_PREFERENCES, type LocalePreference } from '../../i18n';
import { useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Hint, Kbd, RangeField, SelectField, SwitchRow } from '../components/controls';
import { Card, Group, List, ListRow } from '../components/layout';
import { useToast } from '../components/toast';
import { percent } from '../format';
import { useDraftValue, useSettingsUpdater } from '../shared/hooks';
import { openOptionsPage, openWorkspace } from '../shared/navigation';
import { ThemePicker } from '../shared/ThemePicker';
import type { ServiceConfigState } from '../state/derive';
import { useUiClient } from '../state/hooks';
import styles from './sidepanel.module.css';
import { ConnectionControls } from './ConnectionControls';
import { SystemVoiceSettings } from '../shared/SystemVoicePicker';

export interface SettingsTabProps {
  snapshot: AppSnapshot;
  config: ServiceConfigState;
  onEnterDemo?: () => void;
  onExitDemo?: () => void;
}

export function SettingsTab({ snapshot, onEnterDemo, onExitDemo }: SettingsTabProps) {
  const client = useUiClient();
  const notify = useToast();
  const update = useSettingsUpdater();
  const t = useT();
  const demo = client.mode === 'demo';
  const { settings } = snapshot;
  const [opacity, setOpacity] = useDraftValue(
    settings.captions.backgroundOpacity,
    (backgroundOpacity) => update({ captions: { backgroundOpacity } }),
  );
  const external = <ExternalLink size={14} aria-hidden="true" className={styles.external} />;

  return (
    <div className={styles.pane}>
      <Card>
        <Group title={t('sidepanel.group.interface')}>
          <List>
            <SelectField<LocalePreference>
              inline
              label={t('common.localePreference.label')}
              value={settings.uiLocale ?? 'auto'}
              options={LOCALE_PREFERENCES.map((value) => ({
                value,
                label: t(`common.localePreference.${value}`),
              }))}
              onChange={(uiLocale) => void update({ uiLocale })}
            />
          </List>
        </Group>
      </Card>

      <Card>
        <ThemePicker value={settings.uiTheme} />
      </Card>

      <Card>
        <ConnectionControls snapshot={snapshot} />
      </Card>

      <Card>
        <Group title={t('sidepanel.group.processing')}>
          <List>
            <SelectField
              inline
              label={t('sidepanel.settings.sourceStrategy')}
              value={settings.sourceStrategy}
              onChange={(sourceStrategy) => void update({ sourceStrategy })}
              options={[
                { value: 'captions-first', label: t('sidepanel.settings.captionsFirst') },
                { value: 'captions-only', label: t('sidepanel.settings.captionsOnly') },
                { value: 'asr-only', label: t('sidepanel.settings.asrOnly') },
              ]}
              hint={
                settings.asr.backend === 'none' ? t('sidepanel.settings.asrMissingHint') : undefined
              }
            />
            <SelectField
              inline
              label={t('sidepanel.settings.asrBackend')}
              value={settings.asr.backend}
              onChange={(backend) => void update({ asr: { backend } })}
              options={[
                { value: 'none', label: t('sidepanel.settings.asrNone') },
                { value: 'local', label: t('sidepanel.settings.asrLocal') },
                { value: 'sub2api', label: t('sidepanel.settings.sub2apiAudio') },
              ]}
            />
            <SelectField
              inline
              label={t('sidepanel.settings.ttsBackend')}
              value={settings.tts.backend}
              onChange={(backend) => void update({ tts: { backend } })}
              options={[
                { value: 'system', label: t('sidepanel.settings.ttsSystem') },
                { value: 'sub2api', label: t('sidepanel.settings.sub2apiAudio') },
                { value: 'none', label: t('sidepanel.settings.ttsNone') },
              ]}
            />
            <SwitchRow
              label={t('sidepanel.settings.prefetch')}
              description={
                settings.playbackMode === 'buffered'
                  ? t('sidepanel.settings.prefetchBuffered')
                  : undefined
              }
              checked={settings.playbackMode === 'buffered' || settings.prefetch}
              disabled={settings.playbackMode === 'buffered'}
              onChange={(prefetch) => void update({ prefetch })}
            />
            <SwitchRow
              label={t('sidepanel.settings.pauseDub')}
              checked={settings.pauseDubWithVideo}
              onChange={(pauseDubWithVideo) => void update({ pauseDubWithVideo })}
            />
            <SwitchRow
              label={t('sidepanel.settings.cache')}
              checked={settings.cacheTranslations}
              onChange={(cacheTranslations) => void update({ cacheTranslations })}
            />
          </List>
        </Group>
      </Card>

      {settings.tts.backend === 'system' && (
        <Card>
          <SystemVoiceSettings snapshot={snapshot} />
        </Card>
      )}

      <Card>
        <Group title={t('sidepanel.group.more')}>
          <RangeField
            label={t('sidepanel.settings.opacity')}
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={setOpacity}
            format={percent}
          />
          <List>
            <ListRow
              icon={<SlidersHorizontal size={16} aria-hidden="true" />}
              label={t('sidepanel.settings.openFull')}
              trailing={external}
              onClick={() =>
                openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'))
              }
            />
            <ListRow
              icon={<PanelsTopLeft size={16} aria-hidden="true" />}
              label={t('sidepanel.settings.openWorkspace')}
              trailing={external}
              disabled={demo}
              onClick={() =>
                openWorkspace().catch(() => notify(t('common.openWorkspaceFailed'), 'danger'))
              }
            />
            {demo ? (
              <ListRow
                icon={<FlaskConical size={16} aria-hidden="true" />}
                label={t('sidepanel.settings.exitDemo')}
                onClick={onExitDemo}
              />
            ) : (
              onEnterDemo && (
                <ListRow
                  icon={<FlaskConical size={16} aria-hidden="true" />}
                  label={t('sidepanel.settings.enterDemo')}
                  onClick={onEnterDemo}
                />
              )
            )}
            <div className={styles.shortcut}>
              <span>{t('sidepanel.settings.shortcutToggle')}</span>
              <Kbd>Alt + T</Kbd>
            </div>
            <div className={styles.shortcut}>
              <span>{t('sidepanel.settings.shortcutCaptions')}</span>
              <Kbd>Alt + C</Kbd>
            </div>
          </List>
          <Hint>{t('sidepanel.settings.shortcutHint')}</Hint>
        </Group>
      </Card>
    </div>
  );
}

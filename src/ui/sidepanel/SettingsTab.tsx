/**
 * 侧栏「设置」标签：常用项与服务状态摘要；完整设置在设置页。
 */
import { ExternalLink, FlaskConical, PanelsTopLeft } from 'lucide-react';
import { LOCALE_PREFERENCES, type LocalePreference } from '../../i18n';
import { useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, Kbd, RangeField, SelectField, SwitchRow } from '../components/controls';
import { Group } from '../components/layout';
import { useToast } from '../components/toast';
import { percent } from '../format';
import { useDraftValue, useSettingsUpdater } from '../shared/hooks';
import { openOptionsPage, openWorkspace } from '../shared/navigation';
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

  return (
    <div className={styles.pane}>
      <Group title={t('sidepanel.group.interface')}>
        <SelectField<LocalePreference>
          label={t('common.localePreference.label')}
          value={settings.uiLocale ?? 'auto'}
          options={LOCALE_PREFERENCES.map((value) => ({
            value,
            label: t(`common.localePreference.${value}`),
          }))}
          onChange={(uiLocale) => void update({ uiLocale })}
        />
      </Group>

      <ConnectionControls snapshot={snapshot} />

      <Group title={t('sidepanel.group.processing')}>
        <SelectField
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
      </Group>

      {settings.tts.backend === 'system' && <SystemVoiceSettings snapshot={snapshot} />}

      <Group title={t('sidepanel.group.more')}>
        <Button
          block
          variant="primary"
          icon={<ExternalLink size={15} aria-hidden="true" />}
          onClick={() =>
            openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'))
          }
        >
          {t('sidepanel.settings.openFull')}
        </Button>
        <RangeField
          label={t('sidepanel.settings.opacity')}
          min={0}
          max={1}
          step={0.05}
          value={opacity}
          onChange={setOpacity}
          format={percent}
        />
        <Button
          block
          icon={<PanelsTopLeft size={15} aria-hidden="true" />}
          disabled={demo}
          onClick={() =>
            openWorkspace().catch(() => notify(t('common.openWorkspaceFailed'), 'danger'))
          }
        >
          {t('sidepanel.settings.openWorkspace')}
        </Button>
        {demo ? (
          <Button block icon={<FlaskConical size={15} aria-hidden="true" />} onClick={onExitDemo}>
            {t('sidepanel.settings.exitDemo')}
          </Button>
        ) : (
          onEnterDemo && (
            <Button
              block
              variant="ghost"
              icon={<FlaskConical size={15} aria-hidden="true" />}
              onClick={onEnterDemo}
            >
              {t('sidepanel.settings.enterDemo')}
            </Button>
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
        <Hint>{t('sidepanel.settings.shortcutHint')}</Hint>
      </Group>
    </div>
  );
}

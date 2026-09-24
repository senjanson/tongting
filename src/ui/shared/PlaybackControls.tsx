import type { SessionSnapshot } from '../../domain/session';
import type { Settings } from '../../domain/settings';
import { useT } from '../../i18n/react';
import { Button, Hint, Segmented, SelectField } from '../components/controls';
import { Callout } from '../components/layout';
import { useSettingsUpdater } from './hooks';
import styles from './playback.module.css';

/** 侧栏与完整设置共用。这里只更新播放策略，不改变用户选择的字幕/配音输出。 */
export function PlaybackControls({
  settings,
  session,
}: {
  settings: Settings;
  session?: SessionSnapshot;
}) {
  const update = useSettingsUpdater();
  const t = useT();
  const buffered = settings.playbackMode === 'buffered';
  const buffer = session?.desiredState === 'running' ? session.playbackBuffer : undefined;
  const blocked = buffer?.state === 'blocked' || buffer?.state === 'unavailable';

  return (
    <>
      <Segmented
        label={t('common.playback.mode')}
        value={settings.playbackMode}
        options={[
          { value: 'buffered', label: t('common.playback.buffered') },
          { value: 'continuous', label: t('common.playback.continuous') },
        ]}
        onChange={(playbackMode) => void update({ playbackMode })}
      />
      {buffered ? (
        <>
          <SelectField
            inline
            label={t('common.playback.buffer')}
            value={String(settings.bufferSeconds)}
            options={[
              { value: '5', label: t('common.playback.seconds', { count: 5 }) },
              { value: '10', label: t('common.playback.secondsRecommended', { count: 10 }) },
              { value: '20', label: t('common.playback.seconds', { count: 20 }) },
            ]}
            onChange={(value) =>
              void update({ bufferSeconds: Number(value) as Settings['bufferSeconds'] })
            }
          />
          <Hint>{t('common.playback.bufferedHint')}</Hint>
          {buffer && (
            <div className={styles.buffer}>
              <Callout
                tone={blocked ? 'warning' : 'info'}
                title={
                  buffer.state === 'ready'
                    ? t('common.playback.ready')
                    : buffer.state === 'preparing'
                      ? t('common.playback.preparing')
                      : buffer.state === 'unavailable'
                        ? t('common.playback.unavailable')
                        : t('common.playback.blocked')
                }
                live
                actions={
                  blocked ? (
                    <Button size="sm" onClick={() => void update({ playbackMode: 'continuous' })}>
                      {t('common.playback.switchContinuous')}
                    </Button>
                  ) : undefined
                }
              >
                <span className={styles.progressLabel}>
                  {t('common.playback.progress', {
                    ready: seconds(buffer.readyAheadMs),
                    target: seconds(buffer.targetMs),
                  })}
                </span>
                <progress
                  className={styles.progress}
                  aria-label={t('common.playback.progressAria')}
                  value={Math.min(buffer.readyAheadMs, buffer.targetMs)}
                  max={buffer.targetMs}
                />
                {buffer.message && <span>{buffer.message}</span>}
                {blocked && <span>{t('common.playback.blockedHint')}</span>}
              </Callout>
            </div>
          )}
          {settings.outputMode === 'subtitle-voice' && settings.tts.backend === 'system' && (
            <Hint>{t('common.playback.systemVoiceHint')}</Hint>
          )}
        </>
      ) : (
        <Hint>{t('common.playback.continuousHint')}</Hint>
      )}
    </>
  );
}

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(1)));
}

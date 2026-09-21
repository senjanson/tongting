import type { SessionSnapshot } from '../../domain/session';
import type { Settings } from '../../domain/settings';
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
  const buffered = settings.playbackMode === 'buffered';
  const buffer = session?.desiredState === 'running' ? session.playbackBuffer : undefined;
  const blocked = buffer?.state === 'blocked' || buffer?.state === 'unavailable';

  return (
    <>
      <Segmented
        label="播放方式"
        value={settings.playbackMode}
        options={[
          { value: 'buffered', label: '同步优先' },
          { value: 'continuous', label: '连续播放' },
        ]}
        onChange={(playbackMode) => void update({ playbackMode })}
      />
      {buffered ? (
        <>
          <SelectField
            inline
            label="翻译缓冲"
            value={String(settings.bufferSeconds)}
            options={[
              { value: '5', label: '5 秒' },
              { value: '10', label: '10 秒（推荐）' },
              { value: '20', label: '20 秒' },
            ]}
            onChange={(value) =>
              void update({ bufferSeconds: Number(value) as Settings['bufferSeconds'] })
            }
          />
          <Hint>先缓冲译文再播放，后台持续预读；翻译跟不上时会暂停等待。</Hint>
          {buffer && (
            <div className={styles.buffer}>
              <Callout
                tone={blocked ? 'warning' : 'info'}
                title={
                  buffer.state === 'ready'
                    ? '翻译缓冲就绪'
                    : buffer.state === 'preparing'
                      ? '正在缓冲翻译'
                      : buffer.state === 'unavailable'
                        ? '当前视频无法预读'
                        : '翻译缓冲受阻'
                }
                live
                actions={
                  blocked ? (
                    <Button size="sm" onClick={() => void update({ playbackMode: 'continuous' })}>
                      切换连续播放
                    </Button>
                  ) : undefined
                }
              >
                <span className={styles.progressLabel}>
                  已准备 {seconds(buffer.readyAheadMs)} 秒 / 目标 {seconds(buffer.targetMs)} 秒
                </span>
                <progress
                  className={styles.progress}
                  aria-label="翻译缓冲进度"
                  value={Math.min(buffer.readyAheadMs, buffer.targetMs)}
                  max={buffer.targetMs}
                />
                {buffer.message && <span>{buffer.message}</span>}
                {blocked && <span>可切换连续播放，再点击视频继续；译文和配音可能晚于画面。</span>}
              </Callout>
            </div>
          )}
          {settings.outputMode === 'subtitle-voice' && settings.tts.backend === 'system' && (
            <Hint>系统配音在字幕时间到达时朗读，缓冲进度表示已准备的译文。</Hint>
          )}
        </>
      ) : (
        <Hint>视频连续播放，边播边译；字幕和配音可能晚于画面。</Hint>
      )}
    </>
  );
}

function seconds(ms: number): string {
  return String(Number((ms / 1000).toFixed(1)));
}

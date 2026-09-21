/**
 * 侧栏「设置」标签：常用项与服务状态摘要；完整设置在设置页。
 */
import { ExternalLink, FlaskConical, PanelsTopLeft } from 'lucide-react';
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
  const demo = client.mode === 'demo';
  const { settings } = snapshot;
  const [opacity, setOpacity] = useDraftValue(
    settings.captions.backgroundOpacity,
    (backgroundOpacity) => update({ captions: { backgroundOpacity } }),
  );

  return (
    <div className={styles.pane}>
      <ConnectionControls snapshot={snapshot} />

      <Group title="PROCESSING / 识别与播放">
        <SelectField
          label="字幕来源"
          value={settings.sourceStrategy}
          onChange={(sourceStrategy) => void update({ sourceStrategy })}
          options={[
            { value: 'captions-first', label: '优先视频字幕，缺失时识别语音' },
            { value: 'captions-only', label: '仅使用视频已有字幕' },
            { value: 'asr-only', label: '始终识别视频声音' },
          ]}
          hint={
            settings.asr.backend === 'none'
              ? '尚未配置语音识别服务，没有可读字幕的视频无法翻译。'
              : undefined
          }
        />
        <SelectField
          label="语音识别服务"
          value={settings.asr.backend}
          onChange={(backend) => void update({ asr: { backend } })}
          options={[
            { value: 'none', label: '不使用（未配置）' },
            { value: 'local', label: '本地识别服务' },
            { value: 'sub2api', label: 'sub2api 语音接口（需检测）' },
          ]}
        />
        <SelectField
          label="语音合成服务"
          value={settings.tts.backend}
          onChange={(backend) => void update({ tts: { backend } })}
          options={[
            { value: 'system', label: '系统语音' },
            { value: 'sub2api', label: 'sub2api 语音接口（需检测）' },
            { value: 'none', label: '不使用' },
          ]}
        />
        <SwitchRow
          label="预翻译后续字幕"
          description={settings.playbackMode === 'buffered' ? '同步优先会持续预读。' : undefined}
          checked={settings.playbackMode === 'buffered' || settings.prefetch}
          disabled={settings.playbackMode === 'buffered'}
          onChange={(prefetch) => void update({ prefetch })}
        />
        <SwitchRow
          label="暂停视频时暂停配音"
          checked={settings.pauseDubWithVideo}
          onChange={(pauseDubWithVideo) => void update({ pauseDubWithVideo })}
        />
        <SwitchRow
          label="缓存翻译结果"
          checked={settings.cacheTranslations}
          onChange={(cacheTranslations) => void update({ cacheTranslations })}
        />
      </Group>

      {settings.tts.backend === 'system' && <SystemVoiceSettings snapshot={snapshot} />}

      <Group title="更多设置">
        <Button
          block
          variant="primary"
          icon={<ExternalLink size={15} aria-hidden="true" />}
          onClick={() => openOptionsPage().catch(() => notify('无法打开设置页。', 'danger'))}
        >
          打开完整设置
        </Button>
        <RangeField
          label="背景不透明度"
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
          onClick={() => openWorkspace().catch(() => notify('无法打开字幕工作台。', 'danger'))}
        >
          打开字幕工作台
        </Button>
        {demo ? (
          <Button block icon={<FlaskConical size={15} aria-hidden="true" />} onClick={onExitDemo}>
            退出演示模式
          </Button>
        ) : (
          onEnterDemo && (
            <Button
              block
              variant="ghost"
              icon={<FlaskConical size={15} aria-hidden="true" />}
              onClick={onEnterDemo}
            >
              查看演示模式（示例数据）
            </Button>
          )
        )}
        <div className={styles.shortcut}>
          <span>暂停 / 继续翻译</span>
          <Kbd>Alt + T</Kbd>
        </div>
        <div className={styles.shortcut}>
          <span>显示 / 隐藏翻译字幕</span>
          <Kbd>Alt + C</Kbd>
        </div>
        <Hint>快捷键可在 chrome://extensions/shortcuts 修改。</Hint>
      </Group>
    </div>
  );
}

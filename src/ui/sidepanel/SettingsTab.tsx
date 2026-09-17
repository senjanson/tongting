/**
 * 侧栏「设置」标签：常用项与服务状态摘要；完整设置在设置页。
 */
import { ExternalLink, FlaskConical, PanelsTopLeft } from 'lucide-react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, Kbd, SelectField, SwitchRow } from '../components/controls';
import { Group } from '../components/layout';
import { useToast } from '../components/toast';
import { capabilityStatusLabel, formatDateTime } from '../format';
import { GrantPermissionButton } from '../shared/GrantPermissionButton';
import { useSettingsUpdater } from '../shared/hooks';
import { openOptionsPage, openWorkspace } from '../shared/navigation';
import type { ServiceConfigState } from '../state/derive';
import { credentialStorageText } from '../options/common';
import { useUiClient } from '../state/hooks';
import styles from './sidepanel.module.css';

export interface SettingsTabProps {
  snapshot: AppSnapshot;
  config: ServiceConfigState;
  onEnterDemo?: () => void;
  onExitDemo?: () => void;
}

export function SettingsTab({ snapshot, config, onEnterDemo, onExitDemo }: SettingsTabProps) {
  const client = useUiClient();
  const notify = useToast();
  const update = useSettingsUpdater();
  const demo = client.mode === 'demo';
  const { settings, credential, capabilities, hostPermission } = snapshot;
  const translationCap = capabilities.translation;

  return (
    <div className={styles.pane}>
      <Group title="服务连接">
        <dl className={styles.kv}>
          <dt>服务地址</dt>
          <dd>{settings.provider.baseUrl || '未填写'}</dd>
          <dt>API Key</dt>
          <dd>
            {credential.configured
              ? `已配置 ${credential.masked ?? ''}（${credentialStorageText(credential.storage)}）`
              : '未配置'}
          </dd>
          <dt>访问权限</dt>
          <dd>{config.missingBaseUrl ? '—' : hostPermission.granted ? '已授予' : '未授予'}</dd>
          <dt>翻译模型</dt>
          <dd>{settings.provider.model || '未填写'}</dd>
          <dt>翻译检查</dt>
          <dd>
            {capabilityStatusLabel(translationCap?.status)}
            {translationCap?.checkedAt
              ? `（${formatDateTime(Date.parse(translationCap.checkedAt))}）`
              : ''}
            {translationCap?.status === 'failed' && translationCap.message
              ? `：${translationCap.message}`
              : ''}
          </dd>
        </dl>
        {config.missingPermission && (
          <GrantPermissionButton url={settings.provider.baseUrl} block />
        )}
        <Hint>「已验证」只表示最近一次连接检查中实际请求成功；未检查时显示「未检测」。</Hint>
        <Button
          variant="primary"
          block
          icon={<ExternalLink size={15} aria-hidden="true" />}
          onClick={() => openOptionsPage().catch(() => notify('无法打开设置页。', 'danger'))}
        >
          打开完整设置
        </Button>
      </Group>

      <Group title="字幕来源与配音">
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
          label="语音合成"
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
          checked={settings.prefetch}
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

      <Group title="更多">
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

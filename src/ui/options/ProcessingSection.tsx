/**
 * 识别与播放：字幕来源策略、语音识别服务、语音合成服务、预翻译/暂停配音/缓存开关。
 */
import { KeyRound, Save, Trash } from 'lucide-react';
import { useState } from 'react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, SelectField, SwitchRow, TextField } from '../components/controls';
import { useToast } from '../components/toast';
import { GrantPermissionButton } from '../shared/GrantPermissionButton';
import { PlaybackControls } from '../shared/PlaybackControls';
import { useCommandRunner, useSettingsUpdater, useVoiceList } from '../shared/hooks';
import { Callout } from '../components/layout';
import { checkLocalAsrUrl } from '../state/permissions';
import { deriveVoiceAvailability } from '../state/derive';
import { languageLabel } from '../format';
import { ASR_CHECK_KEYS, CheckRunner, TTS_CHECK_KEYS } from './CheckRunner';
import { CapabilityStatusText, draftValue, Section, type Draft } from './common';
import styles from './options.module.css';

export function ProcessingSection({ snapshot }: { snapshot: AppSnapshot }) {
  const update = useSettingsUpdater();
  const { settings, capabilities } = snapshot;

  return (
    <Section
      id="processing"
      title="识别与播放"
      description="语音识别与语音合成是独立能力，需要分别配置和检查。"
    >
      <SelectField
        label="字幕来源"
        value={settings.sourceStrategy}
        onChange={(sourceStrategy) => void update({ sourceStrategy })}
        options={[
          { value: 'captions-first', label: '优先视频字幕，缺失时识别语音' },
          { value: 'captions-only', label: '仅使用视频已有字幕' },
          { value: 'asr-only', label: '始终识别视频声音' },
        ]}
        hint="视频画面中烧录的文字不算可读字幕；没有可读字幕时需要语音识别服务。"
      />

      <Callout tone="info">
        sub2api 语音识别 /
        语音合成的检查需要一次实际调用，可能产生少量费用，只在你勾选「允许实际调用」后执行；
        未检查时显示「未检测」，不代表不可用。本地识别服务与系统语音的检查不产生计费。
      </Callout>

      <div className={styles.subhead}>语音识别</div>
      <SelectField
        label="语音识别服务"
        value={settings.asr.backend}
        onChange={(backend) => void update({ asr: { backend } })}
        options={[
          { value: 'none', label: '不使用' },
          { value: 'local', label: '本地识别服务' },
          { value: 'sub2api', label: 'sub2api 语音接口（需检测）' },
        ]}
        hint={
          settings.asr.backend === 'none' ? (
            '未配置语音识别时，没有可读字幕的视频无法翻译。'
          ) : settings.asr.backend === 'local' ? (
            <CapabilityStatusText
              status={capabilities.localAsr?.status}
              message={capabilities.localAsr?.message}
            />
          ) : (
            <CapabilityStatusText
              status={capabilities.asr?.status}
              message={capabilities.asr?.message}
            />
          )
        }
      />
      {settings.asr.backend === 'local' && <LocalAsrFields snapshot={snapshot} />}
      {settings.asr.backend === 'sub2api' && (
        <ModelField
          label="sub2api 识别模型"
          saved={settings.asr.sub2apiModel}
          placeholder="填写服务提供的语音识别模型 ID"
          onSave={(sub2apiModel) => update({ asr: { sub2apiModel } })}
          hint="是否支持语音识别取决于你的 sub2api 部署；可在下方勾选「允许实际调用」后检查。"
        />
      )}

      <CheckRunner
        snapshot={snapshot}
        scope="asr"
        keys={ASR_CHECK_KEYS}
        buttonLabel="检查语音识别"
        resultLabel="语音识别检查结果"
        disabledReason={settings.asr.backend === 'none' ? '未选择语音识别服务。' : undefined}
        billable={settings.asr.backend === 'sub2api'}
        emptyHint={
          settings.asr.backend === 'sub2api'
            ? '尚未检查。sub2api 语音识别需要勾选「允许实际调用」后才会实际检查。'
            : '尚未检查。'
        }
      />

      <div className={styles.subhead}>语音合成（配音）</div>
      <SelectField
        label="语音合成服务"
        value={settings.tts.backend}
        onChange={(backend) => void update({ tts: { backend } })}
        options={[
          { value: 'system', label: '系统语音' },
          { value: 'sub2api', label: 'sub2api 语音接口（需检测）' },
          { value: 'none', label: '不使用' },
        ]}
        hint={
          settings.tts.backend === 'system' ? (
            <SystemVoicesStatus snapshot={snapshot} />
          ) : settings.tts.backend === 'sub2api' ? (
            <>
              <CapabilityStatusText
                status={capabilities.tts?.status}
                message={capabilities.tts?.message}
              />
              {(capabilities.tts?.status ?? 'unknown') === 'unknown'
                ? ' · 尚未实际检查；未检测时仍可选择配音，调用失败会提示并降级为仅字幕。'
                : ''}
            </>
          ) : (
            '不使用语音合成时只显示字幕。'
          )
        }
      />
      {settings.tts.backend === 'sub2api' && (
        <div className={styles.grid2}>
          <ModelField
            label="sub2api 合成模型"
            saved={settings.tts.sub2apiModel}
            placeholder="语音合成模型 ID"
            onSave={(sub2apiModel) => update({ tts: { sub2apiModel } })}
          />
          <ModelField
            label="sub2api 声音"
            saved={settings.tts.sub2apiVoice}
            placeholder="留空使用服务默认"
            allowEmpty
            onSave={(sub2apiVoice) => update({ tts: { sub2apiVoice } })}
          />
        </div>
      )}

      <CheckRunner
        snapshot={snapshot}
        scope="tts"
        keys={TTS_CHECK_KEYS}
        buttonLabel="检查语音合成"
        resultLabel="语音合成检查结果"
        disabledReason={settings.tts.backend === 'none' ? '语音合成设置为「不使用」。' : undefined}
        billable={settings.tts.backend === 'sub2api'}
        emptyHint={
          settings.tts.backend === 'sub2api'
            ? '尚未检查。sub2api 语音合成需要勾选「允许实际调用」后才会实际检查；未检测时仍可选择配音。'
            : '尚未检查。系统语音以当前目标语言的实际可用声音为准。'
        }
      />

      <div className={styles.subhead}>播放与缓存</div>
      <PlaybackControls settings={settings} />
      <SwitchRow
        label="预翻译后续字幕"
        description={
          settings.playbackMode === 'buffered'
            ? '同步优先会持续预读；切换连续播放后使用你保存的预翻译设置。'
            : '只在能读取完整字幕轨道时生效，会提前产生翻译请求。'
        }
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
        description="相同视频、字幕、语言、模型与术语时复用译文，减少重复调用。"
        checked={settings.cacheTranslations}
        onChange={(cacheTranslations) => void update({ cacheTranslations })}
      />
    </Section>
  );
}

function ModelField({
  label,
  saved,
  placeholder,
  hint,
  allowEmpty,
  onSave,
}: {
  label: string;
  saved: string;
  placeholder: string;
  hint?: string;
  allowEmpty?: boolean;
  onSave(value: string): Promise<boolean>;
}) {
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const save = async () => {
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) return;
    if (await onSave(trimmed))
      setDraft((current) => (current === draft ? { value: trimmed, dirty: false } : current));
  };
  return (
    <div className={styles.row}>
      <TextField
        className={styles.grow}
        label={label}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(v) => setDraft({ value: v, dirty: true })}
        hint={hint}
      />
      <Button
        icon={<Save size={15} aria-hidden="true" />}
        disabled={!draft.dirty || (!allowEmpty && !value.trim())}
        onClick={() => void save()}
      >
        保存
      </Button>
    </div>
  );
}

function LocalAsrFields({ snapshot }: { snapshot: AppSnapshot }) {
  const notify = useToast();
  const update = useSettingsUpdater();
  const { run, isBusy } = useCommandRunner();
  const saved = snapshot.settings.asr.localUrl;
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const check = checkLocalAsrUrl(value);
  const [tokenDraft, setTokenDraft] = useState({ value: '' });
  const token = tokenDraft.value;
  const tokenState = snapshot.asrToken;

  const saveUrl = async () => {
    if (!check.ok) return;
    if (await update({ asr: { localUrl: value.trim() } }))
      setDraft((current) => (current === draft ? { value: value.trim(), dirty: false } : current));
  };

  const saveToken = async () => {
    const trimmed = token.trim();
    if (!trimmed) return;
    const result = await run(
      { kind: 'asr/set-token', token: trimmed },
      { errorPrefix: '保存配对令牌失败' },
    );
    if (!result) return;
    setTokenDraft((current) => (current === tokenDraft ? { value: '' } : current));
    notify(
      result.persisted ? '配对令牌已保存。尚未验证本地服务。' : '配对令牌仅本次生效，保存失败。',
      result.persisted ? 'success' : 'warning',
    );
  };

  return (
    <>
      <Hint>
        本地识别服务需要你先在本机手动启动（参见项目文档中的本地识别服务说明）。扩展不会自动安装或启动它，服务只应监听
        127.0.0.1。
      </Hint>
      <div className={styles.row}>
        <TextField
          className={styles.grow}
          label="本地服务地址"
          placeholder="http://127.0.0.1:8765"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(v) => setDraft({ value: v, dirty: true })}
          error={check.ok ? undefined : check.reason}
        />
        <Button
          icon={<Save size={15} aria-hidden="true" />}
          disabled={!draft.dirty || !check.ok}
          onClick={() => void saveUrl()}
        >
          保存地址
        </Button>
        {check.ok && (
          <GrantPermissionButton
            url={value}
            target="local-asr"
            label="授予本机服务访问权限"
            disabled={draft.dirty}
          />
        )}
      </div>
      <div className={styles.row}>
        <TextField
          className={styles.grow}
          label="配对令牌"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={tokenState.configured ? '输入新令牌以替换' : '本地服务启动时显示的配对令牌'}
          value={token}
          onChange={(value) => setTokenDraft({ value })}
          error={
            tokenState.cleanupPending
              ? '旧令牌存储清理失败，请重试清理。已撤销的令牌不会再用于请求。'
              : undefined
          }
          hint={
            tokenState.configured
              ? `已保存：${tokenState.masked ?? '（已隐藏）'}`
              : '尚未保存配对令牌。'
          }
        />
        <Button
          icon={<KeyRound size={15} aria-hidden="true" />}
          busy={isBusy('asr/set-token')}
          disabled={!token.trim()}
          onClick={() => void saveToken()}
        >
          保存令牌
        </Button>
        {(tokenState.configured || tokenState.cleanupPending) && (
          <Button
            variant="danger"
            icon={<Trash size={15} aria-hidden="true" />}
            busy={isBusy('asr/clear-token')}
            onClick={async () => {
              const result = await run(
                { kind: 'asr/clear-token' },
                { errorPrefix: '删除令牌失败' },
              );
              if (result) notify('已删除配对令牌。', 'success');
            }}
          >
            {tokenState.cleanupPending ? '重试清理令牌' : '删除令牌'}
          </Button>
        )}
      </div>
    </>
  );
}

/** 系统语音：按当前目标语言统计实际可用声音（与 worker 使用相同的匹配规则），不使用笼统的「已验证」。 */
function SystemVoicesStatus({ snapshot }: { snapshot: AppSnapshot }) {
  const { state } = useVoiceList(true, `system|${snapshot.settings.targetLanguage}`);
  const availability = deriveVoiceAvailability(snapshot, state);
  const language = languageLabel(snapshot.settings.targetLanguage);
  if (availability.state === 'available') {
    return (
      <>
        当前目标语言（{language}）有 {availability.voices.length}{' '}
        个可用系统声音。系统语音不一定完全离线。
      </>
    );
  }
  return <>{availability.reason}</>;
}

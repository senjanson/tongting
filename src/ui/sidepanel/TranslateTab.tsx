/**
 * 侧栏「翻译」标签：会话控制、真实进度、语言、输出方式、字幕显示与声音设置。
 *
 * 「暂停视频」由 YouTube 播放器负责（这里只显示状态）；「暂停翻译」「停止并释放音频」是两个独立命令。
 */
import {
  ArrowRight,
  Captions,
  Pause,
  Play,
  RefreshCw,
  Settings,
  Speech,
  Square,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../../domain/languages';
import type { SessionSnapshot } from '../../domain/session';
import type { Settings as AppSettings, TranslationStyle } from '../../domain/settings';
import { describeCoverage } from '../../export';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import {
  Button,
  Hint,
  RangeField,
  Segmented,
  SelectField,
  SwitchRow,
} from '../components/controls';
import { Callout, Group, Stat, StatGrid } from '../components/layout';
import { useToast } from '../components/toast';
import { formatLatency, languageLabel, percent } from '../format';
import { useCommandRunner, useDraftValue, useSettingsUpdater, useVoiceList } from '../shared/hooks';
import { openOptionsPage, reloadTab } from '../shared/navigation';
import type { ConnectionStatus } from '../state/client';
import {
  canRetryFailed,
  canStop,
  derivePrimaryAction,
  deriveVoiceAvailability,
  describeSourceLanguage,
  noticeHasSettingsAction,
  type NextStepAction,
  sessionPhaseStatus,
  sourceModeShortLabel,
  type ServiceConfigState,
  type VoiceAvailability,
} from '../state/derive';
import { useUiClient } from '../state/hooks';
import { SessionProblemCallout } from '../shared/SessionProblemCallout';
import { PlaybackControls } from '../shared/PlaybackControls';
import { hasActiveDubbing, SystemVoicePicker } from '../shared/SystemVoicePicker';
import styles from './sidepanel.module.css';

const STYLE_OPTIONS: { value: TranslationStyle; label: string }[] = [
  { value: 'natural', label: '自然流畅' },
  { value: 'faithful', label: '忠实原文' },
  { value: 'concise', label: '简洁易读' },
  { value: 'terminology', label: '专业术语优先' },
];

export interface TranslateTabProps {
  snapshot: AppSnapshot;
  connection: ConnectionStatus;
  tabId: number;
  session: SessionSnapshot | undefined;
  config: ServiceConfigState;
  videoDetails?: ReactNode;
}

export function TranslateTab({
  snapshot,
  connection,
  tabId,
  session,
  config,
  videoDetails,
}: TranslateTabProps) {
  const client = useUiClient();
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();
  const { settings } = snapshot;
  const action = derivePrimaryAction(session, config, connection);
  const disabledCommands = connection !== 'connected';
  const sessionId = session?.identity.sessionId;
  const voiceEnabled = settings.outputMode === 'subtitle-voice';
  const voices = useVoiceList(
    voiceEnabled && settings.tts.backend === 'system',
    settings.tts.backend,
  );
  const availability = deriveVoiceAvailability(snapshot, voices.state);

  const onPrimary = () => {
    switch (action.kind) {
      case 'start':
        void run({ kind: 'session/start', tabId }, { key: 'primary', errorPrefix: '无法开始翻译' });
        break;
      case 'pause':
        void run(
          { kind: 'session/pause', tabId, sessionId },
          { key: 'primary', errorPrefix: '无法暂停翻译' },
        );
        break;
      case 'resume':
        void run(
          { kind: 'session/resume', tabId, sessionId },
          { key: 'primary', errorPrefix: '无法继续翻译' },
        );
        break;
      case 'busy':
        break;
    }
  };

  const onNextStep = (nextAction: NextStepAction) => {
    switch (nextAction) {
      case 'open-settings':
        openOptionsPage().catch(() => notify('无法打开设置页。', 'danger'));
        break;
      case 'reload-tab':
        if (client.mode === 'demo') return;
        reloadTab(tabId).catch(() => notify('无法刷新标签页，请手动刷新。', 'danger'));
        break;
      case 'retry':
        void run({ kind: 'session/start', tabId }, { key: 'primary', errorPrefix: '重试失败' });
        break;
      case 'none':
        break;
    }
  };

  const primaryIcon =
    action.kind === 'pause' ? (
      <Pause size={16} aria-hidden="true" />
    ) : (
      <Play size={16} aria-hidden="true" />
    );
  const otherOwner =
    snapshot.audioOwner && snapshot.audioOwner.tabId !== tabId ? snapshot.audioOwner : null;

  return (
    <div className={styles.pane}>
      {!config.ready && (
        <Callout
          tone="warning"
          title="未配置翻译服务"
          actions={
            <Button
              size="sm"
              icon={<Settings size={14} aria-hidden="true" />}
              onClick={() => void openOptionsPage()}
            >
              打开设置
            </Button>
          }
        >
          {config.message}
        </Callout>
      )}
      {!snapshot.settingsPersisted && (
        <Callout tone="warning" title="设置未能保存">
          最近的设置修改仅本次生效，浏览器重启后会丢失。
        </Callout>
      )}
      <SessionProblemCallout session={session} onNextStep={onNextStep} />
      {session?.notice && (
        <Callout
          tone={
            session.notice.level === 'error'
              ? 'danger'
              : session.notice.level === 'warning'
                ? 'warning'
                : 'info'
          }
          live
          actions={
            noticeHasSettingsAction(session.notice.code) ? (
              <Button size="sm" onClick={() => void openOptionsPage()}>
                打开设置
              </Button>
            ) : undefined
          }
        >
          {session.notice.message}
        </Callout>
      )}
      {otherOwner && (
        <Callout tone="info">
          另一个标签页正在翻译。在这里开始会先停止那边的翻译并释放音频资源，再启动本页。
        </Callout>
      )}

      <LanguageGroup settings={settings} session={session} />
      <OutputGroup settings={settings} availability={availability} />
      <Group title="PLAYBACK / 播放">
        <PlaybackControls settings={settings} session={session} />
      </Group>
      <CaptionGroup settings={settings} />
      <AudioGroup
        settings={settings}
        availability={availability}
        reloadVoices={voices.reload}
        dubbingActive={hasActiveDubbing(snapshot)}
      />
      <div className={styles.primaryAction}>
        <Button
          variant="primary"
          block
          icon={primaryIcon}
          busy={isBusy('primary') || action.kind === 'busy'}
          disabled={!!action.disabledReason}
          onClick={onPrimary}
        >
          {action.label}
        </Button>
        {action.disabledReason && action.kind !== 'busy' && <Hint>{action.disabledReason}</Hint>}
      </div>
      {session?.resources.capture === 'active' && (
        <p className={styles.captureStatus} role="status">
          正在采集本标签页音频
        </p>
      )}
      {(session || videoDetails) && (
        <details className={styles.sessionDetails}>
          <summary>播放与翻译详情</summary>
          {videoDetails}
          {session && <SessionStatus session={session} />}
          {(canStop(session) || canRetryFailed(session)) && (
            <div className={styles.actionsRow}>
              {canStop(session) && (
                <Button
                  icon={<Square size={14} aria-hidden="true" />}
                  busy={isBusy('session/stop')}
                  disabled={disabledCommands}
                  onClick={() =>
                    void run(
                      { kind: 'session/stop', tabId, sessionId },
                      { errorPrefix: '停止失败' },
                    )
                  }
                >
                  停止并释放音频
                </Button>
              )}
              {session && canRetryFailed(session) && (
                <Button
                  icon={<RefreshCw size={14} aria-hidden="true" />}
                  busy={isBusy('session/retry-failed')}
                  disabled={disabledCommands}
                  onClick={async () => {
                    const result = await run(
                      { kind: 'session/retry-failed', tabId, sessionId },
                      { errorPrefix: '重试失败' },
                    );
                    if (result) notify(`已重新排队 ${result.retried} 条失败的字幕。`, 'success');
                  }}
                >
                  重试失败的 {session.translation.failed} 条
                </Button>
              )}
            </div>
          )}
          {session?.phase === 'stopping' && (
            <Hint>正在停止：会中止请求、停止配音并释放音频采集，完成后状态才会更新。</Hint>
          )}
        </details>
      )}
    </div>
  );
}

function SessionStatus({ session }: { session: SessionSnapshot }) {
  const phase = sessionPhaseStatus(session);
  const stats = session.translation;
  const progress = stats.total > 0 ? `${stats.done} / ${stats.total}` : '未知';
  const resources: string[] = [];
  if (session.resources.capture === 'active') resources.push('正在采集本标签页音频');
  if (session.resources.capture === 'requesting') resources.push('正在请求音频采集');
  if (session.resources.asr === 'backlogged') {
    resources.push(
      session.resources.asrBacklogMs !== undefined
        ? `识别积压约 ${Math.round(session.resources.asrBacklogMs / 1000)} 秒`
        : '识别积压',
    );
  }
  if (session.resources.asr === 'loading') resources.push('识别服务加载中');
  if (session.resources.tts === 'speaking') resources.push('正在配音');
  if (session.resources.dubBacklog) resources.push(`待配音 ${session.resources.dubBacklog} 句`);
  // 以快照更新时间判断，避免渲染中读取当前时间。
  if (stats.rateLimitedUntil && stats.rateLimitedUntil > session.updatedAt)
    resources.push('服务限流中，稍后自动继续');
  if (stats.cacheWriteFailures)
    resources.push(`翻译缓存写入失败 ${stats.cacheWriteFailures} 次（不影响翻译）`);

  return (
    <Group title="翻译状态">
      <StatGrid>
        <Stat label="状态" value={phase?.label ?? '未开始'} />
        <Stat label="字幕来源" value={sourceModeShortLabel(session.sourceMode)} />
        <Stat label="已翻译" value={progress} />
        <Stat label="失败" value={stats.total > 0 ? String(stats.failed) : '未知'} />
        <Stat label="最近一次请求往返" value={formatLatency(stats.lastLatencyMs)} />
        <Stat label="模型" value={stats.model ?? '未知'} />
      </StatGrid>
      <Hint>覆盖：{describeCoverage(session.coverage, session.sourceMode)}</Hint>
      {resources.length > 0 && <Hint>{resources.join(' · ')}</Hint>}
    </Group>
  );
}

function LanguageGroup({
  settings,
  session,
}: {
  settings: AppSettings;
  session: SessionSnapshot | undefined;
}) {
  const update = useSettingsUpdater();
  const sourceInfo = describeSourceLanguage(settings, session);
  const sourceOptions = useMemo(() => {
    const options = SOURCE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
    if (!options.some((o) => o.value === settings.sourceLanguage)) {
      options.push({ value: settings.sourceLanguage, label: settings.sourceLanguage });
    }
    return options;
  }, [settings.sourceLanguage]);
  const targetOptions = useMemo(() => {
    const options = TARGET_LANGUAGES.map((l) => ({ value: l.code, label: l.label }));
    if (!options.some((o) => o.value === settings.targetLanguage)) {
      options.push({ value: settings.targetLanguage, label: settings.targetLanguage });
    }
    return options;
  }, [settings.targetLanguage]);

  return (
    <Group title="LANGUAGE / 语言">
      <div className={styles.languages}>
        <SelectField
          label="视频语言"
          value={settings.sourceLanguage}
          options={sourceOptions}
          onChange={(sourceLanguage) => void update({ sourceLanguage })}
        />
        <span className={styles.arrow} aria-hidden="true">
          <ArrowRight size={15} />
        </span>
        <SelectField
          label="翻译为"
          value={settings.targetLanguage}
          options={targetOptions}
          onChange={(targetLanguage) => void update({ targetLanguage })}
        />
      </div>
      <div
        className={styles.detectedLanguage}
        title={`你的选择：${sourceInfo.selected} · 实际：${sourceInfo.actual}`}
      >
        {session?.detectedSourceLanguage
          ? `已识别为${languageLabel(session.detectedSourceLanguage)}`
          : session?.sourceTrack
            ? `字幕语言：${languageLabel(session.sourceTrack.languageCode)}`
            : '等待识别视频语言'}
      </div>
      {session && session.targetLanguage !== settings.targetLanguage && (
        <Hint>目标语言已修改，当前会话仍在使用旧语言，worker 切换完成后会更新。</Hint>
      )}
    </Group>
  );
}

function OutputGroup({
  settings,
  availability,
}: {
  settings: AppSettings;
  availability: VoiceAvailability;
}) {
  const update = useSettingsUpdater();
  const voiceEnabled = settings.outputMode === 'subtitle-voice';

  return (
    <Group title="翻译方式" className={styles.outputGroup}>
      <Segmented
        label="输出方式"
        value={settings.outputMode}
        onChange={(outputMode) => void update({ outputMode })}
        options={[
          { value: 'subtitle', label: '仅字幕', icon: <Captions size={15} aria-hidden="true" /> },
          {
            value: 'subtitle-voice',
            label: '字幕 + 配音',
            icon: <Speech size={15} aria-hidden="true" />,
          },
        ]}
      />
      {voiceEnabled && availability.state !== 'available' && availability.reason && (
        <Callout tone={availability.state === 'unavailable' ? 'warning' : 'info'}>
          {availability.reason}
        </Callout>
      )}
      <SelectField
        inline
        label="翻译风格"
        value={settings.style}
        options={STYLE_OPTIONS}
        onChange={(style) => void update({ style })}
      />
    </Group>
  );
}

function formatOffset(ms: number): string {
  const s = ms / 1000;
  return `${s > 0 ? '+' : ''}${s.toFixed(1)} s`;
}

function CaptionGroup({ settings }: { settings: AppSettings }) {
  const update = useSettingsUpdater();
  const captions = settings.captions;
  const [fontSize, setFontSize] = useDraftValue(captions.fontSizePx, (fontSizePx) =>
    update({ captions: { fontSizePx } }),
  );
  const [offset, setOffset] = useDraftValue(captions.offsetMs, (offsetMs) =>
    update({ captions: { offsetMs } }),
  );

  return (
    <Group title="CAPTIONS / 字幕">
      <SwitchRow
        label="显示双语字幕"
        checked={captions.bilingual}
        onChange={(bilingual) => void update({ captions: { bilingual } })}
      />
      <SwitchRow
        label="显示翻译字幕"
        checked={captions.enabled}
        onChange={(enabled) => void update({ captions: { enabled } })}
      />
      <SelectField
        inline
        label="字幕位置"
        value={captions.position}
        onChange={(position) => void update({ captions: { position } })}
        options={[
          { value: 'bottom', label: '画面底部' },
          { value: 'middle', label: '画面居中' },
          { value: 'top', label: '画面上方' },
        ]}
      />
      <RangeField
        label="字幕大小"
        min={12}
        max={48}
        step={1}
        value={fontSize}
        onChange={setFontSize}
        format={(v) => `${v} px`}
      />
      <RangeField
        label="字幕时间微调"
        min={-10_000}
        max={10_000}
        step={100}
        value={offset}
        onChange={setOffset}
        format={formatOffset}
      />
    </Group>
  );
}

function AudioGroup({
  settings,
  availability,
  reloadVoices,
  dubbingActive,
}: {
  settings: AppSettings;
  availability: VoiceAvailability;
  reloadVoices(): void;
  dubbingActive: boolean;
}) {
  const update = useSettingsUpdater();
  const audio = settings.audio;
  const voiceEnabled = settings.outputMode === 'subtitle-voice';

  const [originalVolume, setOriginalVolume] = useDraftValue(audio.originalVolume, (v) =>
    update({ audio: { originalVolume: v } }),
  );
  const [dubVolume, setDubVolume] = useDraftValue(audio.dubVolume, (v) =>
    update({ audio: { dubVolume: v } }),
  );
  const [rate, setRate] = useDraftValue(audio.rate, (v) => update({ audio: { rate: v } }));
  const [duckLevel, setDuckLevel] = useDraftValue(audio.duckLevel, (v) =>
    update({ audio: { duckLevel: v } }),
  );

  return (
    <Group
      title="AUDIO / 声音"
      aside={
        voiceEnabled && settings.tts.backend === 'system' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} aria-hidden="true" />}
            onClick={reloadVoices}
          >
            刷新声音
          </Button>
        ) : (
          <span className={styles.audioTag}>{voiceEnabled ? '配音播放' : '原声播放'}</span>
        )
      }
    >
      {voiceEnabled && (
        <Segmented
          label="原声处理"
          value={audio.originalMode}
          options={[
            { value: 'mute', label: '全程静音' },
            { value: 'mix', label: '保留原声' },
          ]}
          onChange={(originalMode) => void update({ audio: { originalMode } })}
        />
      )}
      {(!voiceEnabled || audio.originalMode === 'mix') && (
        <RangeField
          label="原声音量"
          min={0}
          max={1}
          step={0.05}
          value={originalVolume}
          onChange={setOriginalVolume}
          format={percent}
        />
      )}
      {voiceEnabled ? (
        <>
          <RangeField
            label="配音音量"
            min={0}
            max={1}
            step={0.05}
            value={dubVolume}
            onChange={setDubVolume}
            format={percent}
          />
          {settings.tts.backend === 'system' ? (
            <SystemVoicePicker
              settings={settings}
              availability={availability}
              dubbingActive={dubbingActive}
              rate={rate}
            />
          ) : (
            <Hint>
              {settings.tts.backend === 'sub2api'
                ? `sub2api 语音合成：模型 ${settings.tts.sub2apiModel || '未填写'}，声音 ${settings.tts.sub2apiVoice || '服务默认'}（在完整设置中修改）。`
                : '语音合成已设置为「不使用」。'}
            </Hint>
          )}
          <RangeField
            label="配音语速"
            min={0.5}
            max={2}
            step={0.05}
            value={rate}
            onChange={setRate}
            format={(v) => `${v.toFixed(2)}×`}
          />
          {audio.originalMode === 'mix' && audio.duckOriginal && (
            <RangeField
              label="配音时原声降至"
              min={0}
              max={1}
              step={0.05}
              value={duckLevel}
              onChange={setDuckLevel}
              format={percent}
            />
          )}
        </>
      ) : null}
      {voiceEnabled && audio.originalMode === 'mix' && (
        <SwitchRow
          label="配音时自动降低原声"
          checked={audio.duckOriginal}
          onChange={(duckOriginal) => void update({ audio: { duckOriginal } })}
        />
      )}
      <Hint>
        {voiceEnabled
          ? audio.originalMode === 'mute'
            ? '同声传译期间全程静音原声，配音停顿时也不恢复；暂停或停止翻译后恢复。不影响语音识别。'
            : '原声音量只影响收听，不影响语音识别。'
          : '开启配音后，可选择声音并调整音量。'}
      </Hint>
    </Group>
  );
}

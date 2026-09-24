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
import type { MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
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
import { formatLatency, languageLabel, percent, sourceLanguageLabel } from '../format';
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

const STYLE_OPTIONS: { value: TranslationStyle; label: MessageKey }[] = [
  { value: 'natural', label: 'sidepanel.style.natural' },
  { value: 'faithful', label: 'sidepanel.style.faithful' },
  { value: 'concise', label: 'sidepanel.style.concise' },
  { value: 'terminology', label: 'sidepanel.style.terminology' },
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
  const locale = useLocale();
  const t = useT();
  const { settings } = snapshot;
  const action = derivePrimaryAction(session, config, connection, locale);
  const disabledCommands = connection !== 'connected';
  const sessionId = session?.identity.sessionId;
  const voiceEnabled = settings.outputMode === 'subtitle-voice';
  const voices = useVoiceList(
    voiceEnabled && settings.tts.backend === 'system',
    settings.tts.backend,
  );
  const availability = deriveVoiceAvailability(snapshot, voices.state, locale);

  const onPrimary = () => {
    switch (action.kind) {
      case 'start':
        void run(
          { kind: 'session/start', tabId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.startFailed') },
        );
        break;
      case 'pause':
        void run(
          { kind: 'session/pause', tabId, sessionId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.pauseFailed') },
        );
        break;
      case 'resume':
        void run(
          { kind: 'session/resume', tabId, sessionId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.resumeFailed') },
        );
        break;
      case 'busy':
        break;
    }
  };

  const onNextStep = (nextAction: NextStepAction) => {
    switch (nextAction) {
      case 'open-settings':
        openOptionsPage().catch(() => notify(t('common.openSettingsFailed'), 'danger'));
        break;
      case 'reload-tab':
        if (client.mode === 'demo') return;
        reloadTab(tabId).catch(() => notify(t('common.reloadTabFailed'), 'danger'));
        break;
      case 'retry':
        void run(
          { kind: 'session/start', tabId },
          { key: 'primary', errorPrefix: t('sidepanel.translate.retryFailed') },
        );
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
          title={t('sidepanel.translate.notConfigured')}
          actions={
            <Button
              size="sm"
              icon={<Settings size={14} aria-hidden="true" />}
              onClick={() => void openOptionsPage()}
            >
              {t('common.openSettings')}
            </Button>
          }
        >
          {config.message}
        </Callout>
      )}
      {!snapshot.settingsPersisted && (
        <Callout tone="warning" title={t('sidepanel.translate.notPersistedTitle')}>
          {t('sidepanel.translate.notPersistedBody')}
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
                {t('common.openSettings')}
              </Button>
            ) : undefined
          }
        >
          {session.notice.message}
        </Callout>
      )}
      {otherOwner && <Callout tone="info">{t('sidepanel.translate.otherOwner')}</Callout>}

      <LanguageGroup settings={settings} session={session} />
      <OutputGroup settings={settings} availability={availability} />
      <Group title={t('sidepanel.group.playback')}>
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
          {t('sidepanel.translate.capturing')}
        </p>
      )}
      {(session || videoDetails) && (
        <details className={styles.sessionDetails}>
          <summary>{t('sidepanel.translate.details')}</summary>
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
                      { errorPrefix: t('sidepanel.translate.stopFailed') },
                    )
                  }
                >
                  {t('sidepanel.translate.stopRelease')}
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
                      { errorPrefix: t('sidepanel.translate.retryFailed') },
                    );
                    if (result)
                      notify(
                        t('sidepanel.translate.retried', { count: result.retried }),
                        'success',
                      );
                  }}
                >
                  {t('sidepanel.translate.retryCount', { count: session.translation.failed })}
                </Button>
              )}
            </div>
          )}
          {session?.phase === 'stopping' && <Hint>{t('sidepanel.translate.stoppingHint')}</Hint>}
        </details>
      )}
    </div>
  );
}

function SessionStatus({ session }: { session: SessionSnapshot }) {
  const locale = useLocale();
  const t = useT();
  const phase = sessionPhaseStatus(session, locale);
  const stats = session.translation;
  const unknown = t('common.unknown');
  const progress = stats.total > 0 ? `${stats.done} / ${stats.total}` : unknown;
  const resources: string[] = [];
  if (session.resources.capture === 'active') resources.push(t('sidepanel.translate.capturing'));
  if (session.resources.capture === 'requesting')
    resources.push(t('sidepanel.res.requestingCapture'));
  if (session.resources.asr === 'backlogged') {
    resources.push(
      session.resources.asrBacklogMs !== undefined
        ? t('sidepanel.res.asrBacklog', {
            seconds: Math.round(session.resources.asrBacklogMs / 1000),
          })
        : t('sidepanel.res.asrBacklogged'),
    );
  }
  if (session.resources.asr === 'loading') resources.push(t('sidepanel.res.asrLoading'));
  if (session.resources.tts === 'speaking') resources.push(t('sidepanel.res.speaking'));
  if (session.resources.dubBacklog)
    resources.push(t('sidepanel.res.dubBacklog', { count: session.resources.dubBacklog }));
  // 以快照更新时间判断，避免渲染中读取当前时间。
  if (stats.rateLimitedUntil && stats.rateLimitedUntil > session.updatedAt)
    resources.push(t('sidepanel.res.rateLimited'));
  if (stats.cacheWriteFailures)
    resources.push(t('sidepanel.res.cacheWriteFailures', { count: stats.cacheWriteFailures }));

  return (
    <Group title={t('sidepanel.status.title')}>
      <StatGrid>
        <Stat
          label={t('sidepanel.status.state')}
          value={phase?.label ?? t('sidepanel.status.notStarted')}
        />
        <Stat
          label={t('sidepanel.status.source')}
          value={sourceModeShortLabel(session.sourceMode, locale)}
        />
        <Stat label={t('sidepanel.status.translated')} value={progress} />
        <Stat
          label={t('sidepanel.status.failed')}
          value={stats.total > 0 ? String(stats.failed) : unknown}
        />
        <Stat
          label={t('sidepanel.status.latency')}
          value={formatLatency(stats.lastLatencyMs, locale)}
        />
        <Stat label={t('sidepanel.status.model')} value={stats.model ?? unknown} />
      </StatGrid>
      <Hint>
        {t('sidepanel.status.coverage', {
          detail: describeCoverage(session.coverage, session.sourceMode, locale),
        })}
      </Hint>
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
  const locale = useLocale();
  const t = useT();
  const sourceInfo = describeSourceLanguage(settings, session, locale);
  const sourceOptions = useMemo(() => {
    const options = SOURCE_LANGUAGES.map((l) => ({
      value: l.code,
      label: sourceLanguageLabel(l.code, locale),
    }));
    if (!options.some((o) => o.value === settings.sourceLanguage)) {
      options.push({ value: settings.sourceLanguage, label: settings.sourceLanguage });
    }
    return options;
  }, [settings.sourceLanguage, locale]);
  const targetOptions = useMemo(() => {
    const options = TARGET_LANGUAGES.map((l) => ({
      value: l.code,
      label: languageLabel(l.code, locale),
    }));
    if (!options.some((o) => o.value === settings.targetLanguage)) {
      options.push({ value: settings.targetLanguage, label: settings.targetLanguage });
    }
    return options;
  }, [settings.targetLanguage, locale]);

  return (
    <Group title={t('sidepanel.group.language')}>
      <div className={styles.languages}>
        <SelectField
          label={t('sidepanel.language.source')}
          value={settings.sourceLanguage}
          options={sourceOptions}
          onChange={(sourceLanguage) => void update({ sourceLanguage })}
        />
        <span className={styles.arrow} aria-hidden="true">
          <ArrowRight size={15} />
        </span>
        <SelectField
          label={t('sidepanel.language.target')}
          value={settings.targetLanguage}
          options={targetOptions}
          onChange={(targetLanguage) => void update({ targetLanguage })}
        />
      </div>
      <div
        className={styles.detectedLanguage}
        title={t('sidepanel.language.choice', {
          selected: sourceInfo.selected,
          actual: sourceInfo.actual,
        })}
      >
        {session?.detectedSourceLanguage
          ? t('sidepanel.language.detected', {
              name: languageLabel(session.detectedSourceLanguage, locale),
            })
          : session?.sourceTrack
            ? t('sidepanel.language.track', {
                name: languageLabel(session.sourceTrack.languageCode, locale),
              })
            : t('sidepanel.language.waiting')}
      </div>
      {session && session.targetLanguage !== settings.targetLanguage && (
        <Hint>{t('sidepanel.language.targetChanged')}</Hint>
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
  const t = useT();
  const voiceEnabled = settings.outputMode === 'subtitle-voice';
  const styleOptions = STYLE_OPTIONS.map((o) => ({ value: o.value, label: t(o.label) }));

  return (
    <Group title={t('sidepanel.group.output')} className={styles.outputGroup}>
      <Segmented
        label={t('sidepanel.output.mode')}
        value={settings.outputMode}
        onChange={(outputMode) => void update({ outputMode })}
        options={[
          {
            value: 'subtitle',
            label: t('sidepanel.output.subtitle'),
            icon: <Captions size={15} aria-hidden="true" />,
          },
          {
            value: 'subtitle-voice',
            label: t('sidepanel.output.subtitleVoice'),
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
        label={t('sidepanel.output.style')}
        value={settings.style}
        options={styleOptions}
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
  const t = useT();
  const captions = settings.captions;
  const [fontSize, setFontSize] = useDraftValue(captions.fontSizePx, (fontSizePx) =>
    update({ captions: { fontSizePx } }),
  );
  const [offset, setOffset] = useDraftValue(captions.offsetMs, (offsetMs) =>
    update({ captions: { offsetMs } }),
  );

  return (
    <Group title={t('sidepanel.group.captions')}>
      <SwitchRow
        label={t('sidepanel.captions.bilingual')}
        checked={captions.bilingual}
        onChange={(bilingual) => void update({ captions: { bilingual } })}
      />
      <SwitchRow
        label={t('sidepanel.captions.enabled')}
        checked={captions.enabled}
        onChange={(enabled) => void update({ captions: { enabled } })}
      />
      <SelectField
        inline
        label={t('sidepanel.captions.position')}
        value={captions.position}
        onChange={(position) => void update({ captions: { position } })}
        options={[
          { value: 'bottom', label: t('sidepanel.captions.bottom') },
          { value: 'middle', label: t('sidepanel.captions.middle') },
          { value: 'top', label: t('sidepanel.captions.top') },
        ]}
      />
      <RangeField
        label={t('sidepanel.captions.size')}
        min={12}
        max={48}
        step={1}
        value={fontSize}
        onChange={setFontSize}
        format={(v) => `${v} px`}
      />
      <RangeField
        label={t('sidepanel.captions.offset')}
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
  const t = useT();
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
      title={t('sidepanel.group.audio')}
      aside={
        voiceEnabled && settings.tts.backend === 'system' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<RefreshCw size={13} aria-hidden="true" />}
            onClick={reloadVoices}
          >
            {t('common.voice.refresh')}
          </Button>
        ) : (
          <span className={styles.audioTag}>
            {voiceEnabled ? t('sidepanel.audio.tagDub') : t('sidepanel.audio.tagOriginal')}
          </span>
        )
      }
    >
      {voiceEnabled && (
        <Segmented
          label={t('sidepanel.audio.originalMode')}
          value={audio.originalMode}
          options={[
            { value: 'mute', label: t('sidepanel.audio.mute') },
            { value: 'mix', label: t('sidepanel.audio.mix') },
          ]}
          onChange={(originalMode) => void update({ audio: { originalMode } })}
        />
      )}
      {(!voiceEnabled || audio.originalMode === 'mix') && (
        <RangeField
          label={t('sidepanel.audio.originalVolume')}
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
            label={t('sidepanel.audio.dubVolume')}
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
                ? t('sidepanel.audio.sub2apiHint', {
                    model: settings.tts.sub2apiModel || t('sidepanel.audio.notSet'),
                    voice: settings.tts.sub2apiVoice || t('sidepanel.audio.serviceDefault'),
                  })
                : t('sidepanel.audio.ttsNone')}
            </Hint>
          )}
          <RangeField
            label={t('sidepanel.audio.rate')}
            min={0.5}
            max={2}
            step={0.05}
            value={rate}
            onChange={setRate}
            format={(v) => `${v.toFixed(2)}×`}
          />
          {audio.originalMode === 'mix' && audio.duckOriginal && (
            <RangeField
              label={t('sidepanel.audio.duckLevel')}
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
          label={t('sidepanel.audio.duck')}
          checked={audio.duckOriginal}
          onChange={(duckOriginal) => void update({ audio: { duckOriginal } })}
        />
      )}
      <Hint>
        {voiceEnabled
          ? audio.originalMode === 'mute'
            ? t('sidepanel.audio.hintMute')
            : t('sidepanel.audio.hintMix')
          : t('sidepanel.audio.hintOff')}
      </Hint>
    </Group>
  );
}

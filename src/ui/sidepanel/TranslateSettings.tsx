/**
 * 翻译标签的设置区：语言对、输出方式，以及可展开的设置列表（翻译风格、播放方式、字幕样式、声音）。
 *
 * 每一行是带 aria-expanded / aria-controls 的真实按钮，右侧摘要只取快照中已生效的设置；
 * 展开后显示原有控件（可访问名称不变）。多行可同时展开。
 */
import { ArrowRight, ChevronRight, RefreshCw } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';
import { SOURCE_LANGUAGES, TARGET_LANGUAGES } from '../../domain/languages';
import type { SessionSnapshot } from '../../domain/session';
import type { Settings as AppSettings, TranslationStyle } from '../../domain/settings';
import { translate, type Locale, type MessageKey } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import {
  Button,
  Hint,
  RangeField,
  Segmented,
  SelectField,
  SwitchRow,
} from '../components/controls';
import { cx } from '../components/cx';
import { Callout } from '../components/layout';
import { languageLabel, percent, sourceLanguageLabel } from '../format';
import { PlaybackControls } from '../shared/PlaybackControls';
import { SystemVoicePicker } from '../shared/SystemVoicePicker';
import { useDraftValue, useSettingsUpdater } from '../shared/hooks';
import { describeSourceLanguage, type VoiceAvailability } from '../state/derive';
import styles from './translate.module.css';

const STYLE_LABELS: Record<TranslationStyle, MessageKey> = {
  natural: 'sidepanel.style.natural',
  faithful: 'sidepanel.style.faithful',
  concise: 'sidepanel.style.concise',
  terminology: 'sidepanel.style.terminology',
};

const STYLE_ORDER: readonly TranslationStyle[] = ['natural', 'faithful', 'concise', 'terminology'];

const POSITION_SHORT: Record<AppSettings['captions']['position'], MessageKey> = {
  bottom: 'sidepanel.summary.bottom',
  middle: 'sidepanel.summary.middle',
  top: 'sidepanel.summary.top',
};

/** 播放方式摘要：同步优先 · 缓冲 10 秒 / 连续播放；缓冲受阻时注明。 */
export function playbackSummary(
  settings: AppSettings,
  session: SessionSnapshot | undefined,
  locale: Locale,
): { text: string; alert: boolean } {
  if (settings.playbackMode !== 'buffered')
    return { text: translate(locale, 'common.playback.continuous'), alert: false };
  const mode = translate(locale, 'common.playback.buffered');
  const state = session?.desiredState === 'running' ? session.playbackBuffer?.state : undefined;
  if (state === 'blocked')
    return { text: `${mode} · ${translate(locale, 'common.status.bufferBlocked')}`, alert: true };
  if (state === 'unavailable')
    return {
      text: `${mode} · ${translate(locale, 'common.status.preloadUnavailable')}`,
      alert: true,
    };
  return {
    text: `${mode} · ${translate(locale, 'sidepanel.summary.buffer', { count: settings.bufferSeconds })}`,
    alert: false,
  };
}

/** 字幕样式摘要：双语 · 底部 · 21 px；关闭翻译字幕时只说明已隐藏。 */
export function captionSummary(settings: AppSettings, locale: Locale): string {
  const captions = settings.captions;
  if (!captions.enabled) return translate(locale, 'sidepanel.summary.captionsHidden');
  return [
    translate(
      locale,
      captions.bilingual ? 'sidepanel.summary.bilingual' : 'sidepanel.summary.translationOnly',
    ),
    translate(locale, POSITION_SHORT[captions.position]),
    `${captions.fontSizePx} px`,
  ].join(' · ');
}

/** 声音摘要：仅字幕时为原声音量；配音时为配音音量与原声处理。 */
export function audioSummary(settings: AppSettings, locale: Locale): string {
  const audio = settings.audio;
  const original = translate(locale, 'sidepanel.summary.original', {
    value: percent(audio.originalVolume),
  });
  if (settings.outputMode !== 'subtitle-voice') return original;
  return [
    translate(locale, 'sidepanel.summary.dub', { value: percent(audio.dubVolume) }),
    audio.originalMode === 'mute' ? translate(locale, 'sidepanel.summary.originalMuted') : original,
  ].join(' · ');
}

export function LanguageCard({
  settings,
  session,
}: {
  settings: AppSettings;
  session: SessionSnapshot | undefined;
}) {
  const update = useSettingsUpdater();
  const locale = useLocale();
  const t = useT();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const sourceInfo = describeSourceLanguage(settings, session, locale);
  const auto = settings.sourceLanguage === 'auto';
  const detected =
    session?.detectedSourceLanguage && session.detectedSourceLanguage !== 'und'
      ? session.detectedSourceLanguage
      : session?.sourceTrack?.languageCode;
  const sourceName = auto
    ? detected
      ? sourceLanguageLabel(detected, locale)
      : t('common.language.auto')
    : sourceLanguageLabel(settings.sourceLanguage, locale);
  const targetName = languageLabel(settings.targetLanguage, locale);
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
    <div className={styles.card}>
      <button
        type="button"
        className={styles.pairButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={styles.pair}>
          <span>{sourceName}</span>
          <ArrowRight size={16} className={styles.pairArrow} aria-hidden="true" />
          <span className="tt-sr-only">{t('sidepanel.language.pairTo')}</span>
          <span>{targetName}</span>
        </span>
        <span className={styles.pairMeta}>
          {auto && detected
            ? `${t('common.language.auto')} · ${t('sidepanel.language.change')}`
            : t('sidepanel.language.change')}
          <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
        </span>
      </button>
      <div id={panelId} className={styles.panel} hidden={!open}>
        {open && (
          <>
            <div className={styles.languages}>
              <SelectField
                label={t('sidepanel.language.source')}
                value={settings.sourceLanguage}
                options={sourceOptions}
                onChange={(sourceLanguage) => void update({ sourceLanguage })}
              />
              <span className={styles.languagesArrow} aria-hidden="true">
                <ArrowRight size={15} />
              </span>
              <SelectField
                label={t('sidepanel.language.target')}
                value={settings.targetLanguage}
                options={targetOptions}
                onChange={(targetLanguage) => void update({ targetLanguage })}
              />
            </div>
            <p
              className={styles.detected}
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
            </p>
          </>
        )}
      </div>
      {session && session.targetLanguage !== settings.targetLanguage && (
        <div className={styles.cardNote}>
          <Hint>{t('sidepanel.language.targetChanged')}</Hint>
        </div>
      )}
    </div>
  );
}

export function OutputMode({
  settings,
  availability,
}: {
  settings: AppSettings;
  availability: VoiceAvailability;
}) {
  const update = useSettingsUpdater();
  const t = useT();
  const voiceEnabled = settings.outputMode === 'subtitle-voice';
  return (
    <div className={styles.output}>
      <Segmented
        label={t('sidepanel.output.mode')}
        value={settings.outputMode}
        onChange={(outputMode) => void update({ outputMode })}
        options={[
          { value: 'subtitle', label: t('sidepanel.output.subtitle') },
          { value: 'subtitle-voice', label: t('sidepanel.output.subtitleVoice') },
        ]}
      />
      {voiceEnabled && availability.state !== 'available' && availability.reason && (
        <Callout tone={availability.state === 'unavailable' ? 'warning' : 'info'}>
          {availability.reason}
        </Callout>
      )}
    </div>
  );
}

type RowId = 'style' | 'playback' | 'captions' | 'audio';

export function SettingsList({
  settings,
  session,
  availability,
  reloadVoices,
  dubbingActive,
}: {
  settings: AppSettings;
  session: SessionSnapshot | undefined;
  availability: VoiceAvailability;
  reloadVoices(): void;
  dubbingActive: boolean;
}) {
  const update = useSettingsUpdater();
  const locale = useLocale();
  const t = useT();
  const playback = playbackSummary(settings, session, locale);
  const [open, setOpen] = useState<ReadonlySet<RowId>>(
    () => new Set<RowId>(playback.alert ? ['playback'] : []),
  );
  // 缓冲受阻或无法预读时自动展开「播放方式」，让「切换连续播放」直接可见；之后用户可自行收起。
  const [alertShown, setAlertShown] = useState(playback.alert);
  if (alertShown !== playback.alert) {
    setAlertShown(playback.alert);
    if (playback.alert) setOpen((prev) => new Set(prev).add('playback'));
  }
  const toggle = (id: RowId) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section
      className={cx(styles.card, styles.list)}
      aria-label={t('sidepanel.translate.settingsAria')}
    >
      <DisclosureRow
        label={t('sidepanel.output.style')}
        value={t(STYLE_LABELS[settings.style])}
        open={open.has('style')}
        onToggle={() => toggle('style')}
      >
        <SelectField
          inline
          label={t('sidepanel.output.style')}
          value={settings.style}
          options={STYLE_ORDER.map((value) => ({ value, label: t(STYLE_LABELS[value]) }))}
          onChange={(style) => void update({ style })}
        />
      </DisclosureRow>
      <DisclosureRow
        label={t('common.playback.mode')}
        value={playback.text}
        alert={playback.alert}
        open={open.has('playback')}
        onToggle={() => toggle('playback')}
      >
        <PlaybackControls settings={settings} session={session} />
      </DisclosureRow>
      <DisclosureRow
        label={t('sidepanel.row.captions')}
        value={captionSummary(settings, locale)}
        open={open.has('captions')}
        onToggle={() => toggle('captions')}
      >
        <CaptionControls settings={settings} />
      </DisclosureRow>
      <DisclosureRow
        label={t('sidepanel.row.audio')}
        value={audioSummary(settings, locale)}
        open={open.has('audio')}
        onToggle={() => toggle('audio')}
      >
        <AudioControls
          settings={settings}
          availability={availability}
          reloadVoices={reloadVoices}
          dubbingActive={dubbingActive}
        />
      </DisclosureRow>
    </section>
  );
}

function DisclosureRow({
  label,
  value,
  alert,
  open,
  onToggle,
  children,
}: {
  label: string;
  value: string;
  alert?: boolean;
  open: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const panelId = useId();
  return (
    <div className={styles.row}>
      <button
        type="button"
        className={styles.rowButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <span className={styles.rowLabel}>{label}</span>
        <span className={styles.rowValue} data-alert={alert || undefined}>
          <span className={styles.rowValueText}>{value}</span>
          <ChevronRight size={14} className={styles.chevron} aria-hidden="true" />
        </span>
      </button>
      <div id={panelId} className={styles.panel} hidden={!open}>
        {open ? children : null}
      </div>
    </div>
  );
}

function formatOffset(ms: number): string {
  const s = ms / 1000;
  return `${s > 0 ? '+' : ''}${s.toFixed(1)} s`;
}

function CaptionControls({ settings }: { settings: AppSettings }) {
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
    <>
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
    </>
  );
}

function AudioControls({
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
    <>
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
      {voiceEnabled && (
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
            <>
              <div className={styles.panelActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RefreshCw size={13} aria-hidden="true" />}
                  onClick={reloadVoices}
                >
                  {t('common.voice.refresh')}
                </Button>
              </div>
              <SystemVoicePicker
                settings={settings}
                availability={availability}
                dubbingActive={dubbingActive}
                rate={rate}
              />
            </>
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
      )}
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
    </>
  );
}

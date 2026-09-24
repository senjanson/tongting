import { Check, RefreshCw, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../domain/settings';
import { getLocale, translate, type Locale } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot, TtsVoiceInfo } from '../../messaging/ui-protocol';
import { normalizeLangTag, selectVoice } from '../../providers/tts/voices';
import { Button, Hint, SelectField } from '../components/controls';
import { useToast } from '../components/toast';
import { Group } from '../components/layout';
import { languageLabel } from '../format';
import { errorInfoOf, errorMessageOf } from '../state/client';
import { deriveVoiceAvailability, type VoiceAvailability } from '../state/derive';
import { useUiClient } from '../state/hooks';
import { useSettingsUpdater, useVoiceList } from './hooks';
import styles from './voices.module.css';

/** 只简化显示名，保存与朗读始终使用 Chrome 返回的原始名称。 */
export function systemVoiceLabel(voice: TtsVoiceInfo, locale: Locale = getLocale()): string {
  const name = voice.voiceName.replace(/ \(Chinese \((China mainland|Taiwan)\)\)$/, '');
  const lang = normalizeLangTag(voice.lang);
  const language =
    lang === 'zh-cn' || lang === 'zh-hans'
      ? translate(locale, 'common.voice.mandarin')
      : lang === 'zh-tw' || lang === 'zh-hant'
        ? translate(locale, 'common.voice.mandarinTaiwan')
        : languageLabel(voice.lang, locale);
  return `${name} · ${language}`;
}

function voiceSource(voice: TtsVoiceInfo, locale: Locale): string {
  return translate(
    locale,
    voice.remote === true
      ? 'common.voice.remote'
      : voice.remote === false
        ? 'common.voice.local'
        : 'common.voice.system',
  );
}

const APPLE_VOICE_HELP: Record<Locale, string> = {
  'zh-CN': 'https://support.apple.com/zh-cn/guide/mac-help-cn/mh27448/mac',
  en: 'https://support.apple.com/guide/mac-help/mh27448/mac',
};

export function hasActiveDubbing(snapshot: AppSnapshot): boolean {
  return snapshot.sessions.some(
    (s) =>
      s.outputMode === 'subtitle-voice' &&
      s.desiredState === 'running' &&
      s.phase !== 'stopping' &&
      s.phase !== 'error',
  );
}

/** 设置页也可选声音，无需先打开视频或填写 API Key。 */
export function SystemVoiceSettings({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings } = snapshot;
  const voices = useVoiceList(settings.tts.backend === 'system', settings.tts.backend);
  const locale = useLocale();
  const t = useT();
  return (
    <Group
      title={t('common.voice.groupTitle')}
      aside={
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} aria-hidden="true" />}
          onClick={voices.reload}
        >
          {t('common.voice.refresh')}
        </Button>
      }
    >
      <SystemVoicePicker
        settings={settings}
        availability={deriveVoiceAvailability(snapshot, voices.state, locale)}
        dubbingActive={hasActiveDubbing(snapshot)}
        rate={settings.audio.rate}
      />
    </Group>
  );
}

export function SystemVoicePicker({
  settings,
  availability,
  dubbingActive,
  rate,
}: {
  settings: Settings;
  availability: VoiceAvailability;
  dubbingActive: boolean;
  rate: number;
}) {
  const client = useUiClient();
  const notify = useToast();
  const update = useSettingsUpdater();
  const locale = useLocale();
  const t = useT();
  const attempt = useRef(0);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(
    () => () => {
      attempt.current++;
    },
    [],
  );
  const { voices } = availability;
  const selected = selectVoice(voices, settings.targetLanguage, settings.audio.voiceName);
  const effective = selected.ok ? selected.voice : undefined;
  const missing =
    availability.state === 'available' &&
    !!settings.audio.voiceName &&
    !voices.some((voice) => voice.voiceName === settings.audio.voiceName);
  const options = [
    { value: '', label: t('common.voice.auto') },
    ...voices.map((voice) => ({
      value: voice.voiceName,
      label: `${systemVoiceLabel(voice, locale)} · ${voiceSource(voice, locale)}`,
    })),
  ];
  if (settings.audio.voiceName && !voices.some((v) => v.voiceName === settings.audio.voiceName)) {
    options.push({
      value: settings.audio.voiceName,
      label: t('common.voice.unavailableName', { name: settings.audio.voiceName }),
    });
  }

  const preview = async (voice: TtsVoiceInfo) => {
    const id = ++attempt.current;
    setPending(voice.voiceName);
    try {
      await client.sendCommand({ kind: 'tts/preview', voiceName: voice.voiceName, rate });
      if (id === attempt.current && client.mode === 'demo')
        notify(t('common.voice.demoPreview'), 'info');
    } catch (error) {
      if (id === attempt.current && errorInfoOf(error)?.category !== 'cancelled') {
        notify(t('common.voice.previewFailed', { detail: errorMessageOf(error) }), 'danger');
      }
    } finally {
      if (id === attempt.current) setPending(null);
    }
  };
  const stop = async () => {
    attempt.current++;
    setPending(null);
    try {
      await client.sendCommand({ kind: 'tts/stop-preview' });
    } catch (error) {
      notify(t('common.voice.stopFailed', { detail: errorMessageOf(error) }), 'danger');
    }
  };

  return (
    <div className={styles.picker}>
      <SelectField
        label={t('common.voice.label')}
        value={settings.audio.voiceName}
        options={options}
        disabled={availability.state !== 'available'}
        onChange={(voiceName) => void update({ audio: { voiceName } })}
        hint={
          availability.state === 'available'
            ? t('common.voice.count', { count: voices.length })
            : availability.reason
        }
      />
      {effective && (
        <p className={styles.current}>
          {missing ? t('common.voice.fallbackCurrent') : t('common.voice.current')}
          <strong>{systemVoiceLabel(effective, locale)}</strong>
        </p>
      )}
      <div className={styles.actions}>
        <Button
          icon={<Volume2 size={14} aria-hidden="true" />}
          disabled={!effective || dubbingActive}
          busy={pending !== null}
          onClick={() => effective && void preview(effective)}
        >
          {t('common.voice.preview')}
        </Button>
        <Button icon={<Square size={13} aria-hidden="true" />} onClick={() => void stop()}>
          {t('common.voice.stopPreview')}
        </Button>
      </div>
      {dubbingActive && <Hint>{t('common.voice.dubbingActive')}</Hint>}
      {voices.length > 0 && (
        <details className={styles.details}>
          <summary>{t('common.voice.browseAll', { count: voices.length })}</summary>
          <ul className={styles.list} aria-label={t('common.voice.listAria')}>
            {voices.map((voice) => {
              const label = systemVoiceLabel(voice, locale);
              const chosen = settings.audio.voiceName === voice.voiceName;
              return (
                <li
                  key={voice.voiceName}
                  className={styles.voice}
                  data-selected={chosen || undefined}
                >
                  <button
                    type="button"
                    className={styles.choose}
                    aria-label={t('common.voice.use', { name: label })}
                    aria-pressed={chosen}
                    onClick={() => void update({ audio: { voiceName: voice.voiceName } })}
                  >
                    <span className={styles.name}>{label}</span>
                    <span className={styles.meta}>
                      {voiceSource(voice, locale)}
                      {chosen ? ` · ${t('common.voice.selected')}` : ''}
                    </span>
                    {chosen && <Check size={14} aria-hidden="true" className={styles.check} />}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('common.voice.previewNamed', { name: label })}
                    disabled={dubbingActive}
                    busy={pending === voice.voiceName}
                    icon={<Volume2 size={14} aria-hidden="true" />}
                    onClick={() => void preview(voice)}
                  >
                    {t('common.voice.preview')}
                  </Button>
                </li>
              );
            })}
          </ul>
          <Hint>{t('common.voice.previewHint')}</Hint>
        </details>
      )}
      <Hint>{t('common.voice.quotaHint')}</Hint>
      {availability.state !== 'unknown' && voices.length <= 1 && (
        <Hint>
          {voices.length === 1 ? t('common.voice.onlyOne') : t('common.voice.noneForTarget')}
        </Hint>
      )}
      <details className={styles.details}>
        <summary>{t('common.voice.howTo')}</summary>
        <p>{t('common.voice.howToMac')}</p>
        <p>{t('common.voice.howToRefresh')}</p>
        <a href={APPLE_VOICE_HELP[locale]} target="_blank" rel="noreferrer">
          {t('common.voice.appleLink')}
        </a>
      </details>
    </div>
  );
}

import { Check, RefreshCw, Square, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../domain/settings';
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
export function systemVoiceLabel(voice: TtsVoiceInfo): string {
  const name = voice.voiceName.replace(/ \(Chinese \((China mainland|Taiwan)\)\)$/, '');
  const lang = normalizeLangTag(voice.lang);
  const language =
    lang === 'zh-cn' || lang === 'zh-hans'
      ? '普通话'
      : lang === 'zh-tw' || lang === 'zh-hant'
        ? '国语（台湾）'
        : languageLabel(voice.lang);
  return `${name} · ${language}`;
}

function voiceSource(voice: TtsVoiceInfo): string {
  return voice.remote === true ? '联网声音' : voice.remote === false ? '本机声音' : '系统声音';
}

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
  return (
    <Group
      title="VOICE / 配音声音"
      aside={
        <Button
          size="sm"
          variant="ghost"
          icon={<RefreshCw size={13} aria-hidden="true" />}
          onClick={voices.reload}
        >
          刷新声音
        </Button>
      }
    >
      <SystemVoicePicker
        settings={settings}
        availability={deriveVoiceAvailability(snapshot, voices.state)}
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
    { value: '', label: '自动选择（优先本机声音）' },
    ...voices.map((voice) => ({
      value: voice.voiceName,
      label: `${systemVoiceLabel(voice)} · ${voiceSource(voice)}`,
    })),
  ];
  if (settings.audio.voiceName && !voices.some((v) => v.voiceName === settings.audio.voiceName)) {
    options.push({
      value: settings.audio.voiceName,
      label: `${settings.audio.voiceName}（暂不可用）`,
    });
  }

  const preview = async (voice: TtsVoiceInfo) => {
    const id = ++attempt.current;
    setPending(voice.voiceName);
    try {
      await client.sendCommand({ kind: 'tts/preview', voiceName: voice.voiceName, rate });
      if (id === attempt.current && client.mode === 'demo')
        notify('演示模式不会播放声音。', 'info');
    } catch (error) {
      if (id === attempt.current && errorInfoOf(error)?.category !== 'cancelled') {
        notify(`试听失败：${errorMessageOf(error)}`, 'danger');
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
      notify(`停止试听失败：${errorMessageOf(error)}`, 'danger');
    }
  };

  return (
    <div className={styles.picker}>
      <SelectField
        label="配音声音"
        value={settings.audio.voiceName}
        options={options}
        disabled={availability.state !== 'available'}
        onChange={(voiceName) => void update({ audio: { voiceName } })}
        hint={
          availability.state === 'available'
            ? `${voices.length} 个可用声音 · 选择会自动保存到本机`
            : availability.reason
        }
      />
      {effective && (
        <p className={styles.current}>
          {missing ? '原声音暂不可用，自动使用：' : '当前使用：'}
          <strong>{systemVoiceLabel(effective)}</strong>
        </p>
      )}
      <div className={styles.actions}>
        <Button
          icon={<Volume2 size={14} aria-hidden="true" />}
          disabled={!effective || dubbingActive}
          busy={pending !== null}
          onClick={() => effective && void preview(effective)}
        >
          试听
        </Button>
        <Button icon={<Square size={13} aria-hidden="true" />} onClick={() => void stop()}>
          停止试听
        </Button>
      </div>
      {dubbingActive && <Hint>配音进行中。请先暂停翻译，再试听其他声音。</Hint>}
      {voices.length > 0 && (
        <details className={styles.details}>
          <summary>浏览并试听全部 {voices.length} 个声音</summary>
          <ul className={styles.list} aria-label="可用配音声音">
            {voices.map((voice) => {
              const label = systemVoiceLabel(voice);
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
                    aria-label={`使用 ${label}`}
                    aria-pressed={chosen}
                    onClick={() => void update({ audio: { voiceName: voice.voiceName } })}
                  >
                    <span className={styles.name}>{label}</span>
                    <span className={styles.meta}>
                      {voiceSource(voice)}
                      {chosen ? ' · 已选用' : ''}
                    </span>
                    {chosen && <Check size={14} aria-hidden="true" className={styles.check} />}
                  </button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`试听 ${label}`}
                    disabled={dubbingActive}
                    busy={pending === voice.voiceName}
                    icon={<Volume2 size={14} aria-hidden="true" />}
                    onClick={() => void preview(voice)}
                  >
                    试听
                  </Button>
                </li>
              );
            })}
          </ul>
          <Hint>试听不会改变选择；点击声音名称可选用。</Hint>
        </details>
      )}
      <Hint>系统配音不消耗 sub2api 额度；字幕翻译仍使用模型额度。联网声音需要网络。</Hint>
      {availability.state !== 'unknown' && voices.length <= 1 && (
        <Hint>
          当前浏览器{voices.length === 1 ? '只提供一个' : '未提供'}
          适用于目标语言的声音，可在系统中添加。
        </Hint>
      )}
      <details className={styles.details}>
        <summary>如何添加更多声音？</summary>
        <p>
          Mac：系统设置 → 辅助功能 → 阅读与朗读（旧版为“朗读内容”）→ 系统声音 →
          管理声音，下载目标语言的声音。
        </p>
        <p>
          安装完成后点击“刷新声音”。若仍未出现，请重新打开
          Chrome。可用声音取决于系统和浏览器，部分系统音色可能不会提供给扩展。
        </p>
        <a
          href="https://support.apple.com/zh-cn/guide/mac-help-cn/mh27448/mac"
          target="_blank"
          rel="noreferrer"
        >
          查看 Apple 声音设置说明 ↗
        </a>
      </details>
    </div>
  );
}

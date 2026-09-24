/**
 * 识别与播放：字幕来源策略、语音识别服务、语音合成服务、预翻译/暂停配音/缓存开关。
 */
import { KeyRound, Save, Trash } from 'lucide-react';
import { useState } from 'react';
import { useLocale, useT } from '../../i18n/react';
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
  const t = useT();
  const update = useSettingsUpdater();
  const { settings, capabilities } = snapshot;

  return (
    <Section
      id="processing"
      title={t('options.section.processing')}
      description={t('options.processing.description')}
    >
      <SelectField
        label={t('options.processing.source')}
        value={settings.sourceStrategy}
        onChange={(sourceStrategy) => void update({ sourceStrategy })}
        options={[
          { value: 'captions-first', label: t('options.processing.sourceCaptionsFirst') },
          { value: 'captions-only', label: t('options.processing.sourceCaptionsOnly') },
          { value: 'asr-only', label: t('options.processing.sourceAsrOnly') },
        ]}
        hint={t('options.processing.sourceHint')}
      />

      <Callout tone="info">{t('options.processing.billingNote')}</Callout>

      <div className={styles.subhead}>{t('options.processing.asrHeading')}</div>
      <SelectField
        label={t('options.processing.asrService')}
        value={settings.asr.backend}
        onChange={(backend) => void update({ asr: { backend } })}
        options={[
          { value: 'none', label: t('options.processing.backendNone') },
          { value: 'local', label: t('options.processing.backendLocal') },
          { value: 'sub2api', label: t('options.processing.backendSub2api') },
        ]}
        hint={
          settings.asr.backend === 'none' ? (
            t('options.processing.asrNoneHint')
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
          label={t('options.processing.asrModel')}
          saved={settings.asr.sub2apiModel}
          placeholder={t('options.processing.asrModelPlaceholder')}
          onSave={(sub2apiModel) => update({ asr: { sub2apiModel } })}
          hint={t('options.processing.asrModelHint')}
        />
      )}

      <CheckRunner
        snapshot={snapshot}
        scope="asr"
        keys={ASR_CHECK_KEYS}
        buttonLabel={t('options.processing.checkAsr')}
        resultLabel={t('options.processing.asrResult')}
        disabledReason={
          settings.asr.backend === 'none' ? t('options.processing.asrDisabled') : undefined
        }
        billable={settings.asr.backend === 'sub2api'}
        emptyHint={
          settings.asr.backend === 'sub2api'
            ? t('options.processing.asrEmptySub2api')
            : t('options.processing.notChecked')
        }
      />

      <div className={styles.subhead}>{t('options.processing.ttsHeading')}</div>
      <SelectField
        label={t('options.processing.ttsService')}
        value={settings.tts.backend}
        onChange={(backend) => void update({ tts: { backend } })}
        options={[
          { value: 'system', label: t('options.processing.backendSystem') },
          { value: 'sub2api', label: t('options.processing.backendSub2api') },
          { value: 'none', label: t('options.processing.backendNone') },
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
                ? t('options.processing.ttsUnknown')
                : ''}
            </>
          ) : (
            t('options.processing.ttsNoneHint')
          )
        }
      />
      {settings.tts.backend === 'sub2api' && (
        <div className={styles.grid2}>
          <ModelField
            label={t('options.processing.ttsModel')}
            saved={settings.tts.sub2apiModel}
            placeholder={t('options.processing.ttsModelPlaceholder')}
            onSave={(sub2apiModel) => update({ tts: { sub2apiModel } })}
          />
          <ModelField
            label={t('options.processing.ttsVoice')}
            saved={settings.tts.sub2apiVoice}
            placeholder={t('options.processing.ttsVoicePlaceholder')}
            allowEmpty
            onSave={(sub2apiVoice) => update({ tts: { sub2apiVoice } })}
          />
        </div>
      )}

      <CheckRunner
        snapshot={snapshot}
        scope="tts"
        keys={TTS_CHECK_KEYS}
        buttonLabel={t('options.processing.checkTts')}
        resultLabel={t('options.processing.ttsResult')}
        disabledReason={
          settings.tts.backend === 'none' ? t('options.processing.ttsDisabled') : undefined
        }
        billable={settings.tts.backend === 'sub2api'}
        emptyHint={
          settings.tts.backend === 'sub2api'
            ? t('options.processing.ttsEmptySub2api')
            : t('options.processing.ttsEmptySystem')
        }
      />

      <div className={styles.subhead}>{t('options.processing.playbackHeading')}</div>
      <PlaybackControls settings={settings} />
      <SwitchRow
        label={t('options.processing.prefetch')}
        description={
          settings.playbackMode === 'buffered'
            ? t('options.processing.prefetchBuffered')
            : t('options.processing.prefetchDescription')
        }
        checked={settings.playbackMode === 'buffered' || settings.prefetch}
        disabled={settings.playbackMode === 'buffered'}
        onChange={(prefetch) => void update({ prefetch })}
      />
      <SwitchRow
        label={t('options.processing.pauseDub')}
        checked={settings.pauseDubWithVideo}
        onChange={(pauseDubWithVideo) => void update({ pauseDubWithVideo })}
      />
      <SwitchRow
        label={t('options.processing.cache')}
        description={t('options.processing.cacheDescription')}
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
  const t = useT();
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const save = async () => {
    const trimmed = value.trim();
    if (!allowEmpty && !trimmed) return;
    if (await onSave(trimmed))
      setDraft((current) => (current === draft ? { value: trimmed, dirty: false } : current));
  };
  return (
    <div className={styles.fieldRow}>
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
        {t('options.action.save')}
      </Button>
    </div>
  );
}

function LocalAsrFields({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const update = useSettingsUpdater();
  const { run, isBusy } = useCommandRunner();
  const saved = snapshot.settings.asr.localUrl;
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const check = checkLocalAsrUrl(value, locale);
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
      { errorPrefix: t('options.processing.saveTokenFailed') },
    );
    if (!result) return;
    setTokenDraft((current) => (current === tokenDraft ? { value: '' } : current));
    notify(
      t(
        result.persisted ? 'options.processing.tokenSaved' : 'options.processing.tokenNotPersisted',
      ),
      result.persisted ? 'success' : 'warning',
    );
  };

  return (
    <>
      <Hint>{t('options.processing.localHint')}</Hint>
      <div className={styles.fieldRow}>
        <TextField
          className={styles.grow}
          label={t('options.processing.localUrl')}
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
          {t('options.connection.saveAddress')}
        </Button>
        {check.ok && (
          <GrantPermissionButton
            url={value}
            target="local-asr"
            label={t('options.processing.grantLocal')}
            disabled={draft.dirty}
          />
        )}
      </div>
      <div className={styles.fieldRow}>
        <TextField
          className={styles.grow}
          label={t('options.processing.token')}
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            tokenState.configured
              ? t('options.processing.tokenPlaceholderReplace')
              : t('options.processing.tokenPlaceholderNew')
          }
          value={token}
          onChange={(value) => setTokenDraft({ value })}
          error={
            tokenState.cleanupPending ? t('options.processing.tokenCleanupPending') : undefined
          }
          hint={
            tokenState.configured
              ? t('options.processing.tokenCurrent', {
                  masked: tokenState.masked ?? t('options.connection.keyHidden'),
                })
              : t('options.processing.tokenNone')
          }
        />
        <Button
          icon={<KeyRound size={15} aria-hidden="true" />}
          busy={isBusy('asr/set-token')}
          disabled={!token.trim()}
          onClick={() => void saveToken()}
        >
          {t('options.processing.saveToken')}
        </Button>
        {(tokenState.configured || tokenState.cleanupPending) && (
          <Button
            variant="danger"
            icon={<Trash size={15} aria-hidden="true" />}
            busy={isBusy('asr/clear-token')}
            onClick={async () => {
              const result = await run(
                { kind: 'asr/clear-token' },
                { errorPrefix: t('options.processing.deleteTokenFailed') },
              );
              if (result) notify(t('options.processing.tokenDeleted'), 'success');
            }}
          >
            {t(
              tokenState.cleanupPending
                ? 'options.processing.retryTokenCleanup'
                : 'options.processing.deleteToken',
            )}
          </Button>
        )}
      </div>
    </>
  );
}

/** 系统语音：按当前目标语言统计实际可用声音（与 worker 使用相同的匹配规则），不使用笼统的「已验证」。 */
function SystemVoicesStatus({ snapshot }: { snapshot: AppSnapshot }) {
  const t = useT();
  const locale = useLocale();
  const { state } = useVoiceList(true, `system|${snapshot.settings.targetLanguage}`);
  const availability = deriveVoiceAvailability(snapshot, state, locale);
  const language = languageLabel(snapshot.settings.targetLanguage, locale);
  if (availability.state === 'available') {
    return (
      <>
        {t('options.processing.systemVoices', {
          language,
          count: availability.voices.length,
        })}
      </>
    );
  }
  return <>{availability.reason}</>;
}

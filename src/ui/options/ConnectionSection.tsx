/**
 * 模型连接设置：服务地址与访问权限、API Key、协议、模型、推理参数、流式、超时、分项连接检查。
 *
 * 保存 Key 不等于连接成功；只有「检查连接」中实际请求成功的项目才显示「已验证」。
 */
import { Eye, EyeOff, Save, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProviderSettings, TextProtocol } from '../../domain/settings';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  Button,
  Checkbox,
  Hint,
  IconButton,
  RangeField,
  SelectField,
  SwitchRow,
  TextField,
} from '../components/controls';
import { useToast } from '../components/toast';
import { ModelSelector } from '../shared/ModelSelector';
import { GrantPermissionButton } from '../shared/GrantPermissionButton';
import { useCommandRunner, useDraftValue, useSettingsUpdater } from '../shared/hooks';
import { checkServiceUrl, sameOrigin } from '../state/permissions';
import { credentialStorageText } from './common';
import { CheckRunner, TEXT_CHECK_KEYS } from './CheckRunner';
import { CapabilityStatusText, draftValue, Section, type Draft } from './common';
import styles from './options.module.css';

export function ConnectionSection({ snapshot }: { snapshot: AppSnapshot }) {
  const provider = snapshot.settings.provider;
  const [addressDirty, setAddressDirty] = useState(false);
  const [keyDirty, setKeyDirty] = useState(false);
  const t = useT();
  return (
    <Section
      id="connection"
      title={t('options.section.connection')}
      description={t('options.connection.description')}
    >
      <AddressFields snapshot={snapshot} onDirtyChange={setAddressDirty} />
      <KeyFields snapshot={snapshot} onDirtyChange={setKeyDirty} />
      <ProtocolAndModel
        snapshot={snapshot}
        provider={provider}
        routeDirty={addressDirty || keyDirty}
      />
      <div className={styles.subhead}>{t('options.connection.check')}</div>
      <CheckRunner
        snapshot={snapshot}
        scope="text"
        keys={TEXT_CHECK_KEYS}
        buttonLabel={t('options.connection.check')}
        resultLabel={t('options.connection.checkResult')}
        disabledReason={
          !snapshot.settings.provider.baseUrl.trim() || !snapshot.credential.configured
            ? t('options.connection.checkDisabled')
            : undefined
        }
        emptyHint={t('options.connection.checkEmpty')}
      />
    </Section>
  );
}

function AddressFields({
  snapshot,
  onDirtyChange,
}: {
  snapshot: AppSnapshot;
  onDirtyChange(dirty: boolean): void;
}) {
  const t = useT();
  const locale = useLocale();
  const update = useSettingsUpdater();
  const saved = snapshot.settings.provider.baseUrl;
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const check = value.trim() ? checkServiceUrl(value, locale) : undefined;
  const dirty = draft.dirty && draft.value.trim() !== saved;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const savedCheck = saved.trim() ? checkServiceUrl(saved, locale) : undefined;
  const permission = snapshot.hostPermission;
  const granted =
    !!savedCheck?.ok &&
    permission.granted &&
    (!permission.origin || sameOrigin(permission.origin, savedCheck.origin));

  const save = async () => {
    const trimmed = value.trim();
    if (trimmed && !checkServiceUrl(trimmed, locale).ok) return;
    if (await update({ provider: { baseUrl: trimmed } }))
      setDraft((current) => (current === draft ? { value: trimmed, dirty: false } : current));
  };

  let hint: string;
  if (!check) hint = t('options.connection.addressHintEmpty');
  else if (!check.ok) hint = '';
  else if (dirty)
    hint = `${t('options.connection.addressHintSaveFirst', { pattern: check.pattern })}${
      granted && savedCheck?.ok && !sameOrigin(savedCheck.origin, check.origin)
        ? t('options.connection.addressHintOldRevoked', { origin: savedCheck.origin })
        : ''
    }`;
  else if (granted) hint = t('options.connection.addressHintGranted', { origin: check.origin });
  else hint = t('options.connection.addressHintNotGranted', { pattern: check.pattern });

  return (
    <div className={styles.row}>
      <TextField
        className={styles.grow}
        label={t('options.connection.addressLabel')}
        placeholder="https://your-sub2api.example.com/v1"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(v) => setDraft({ value: v, dirty: true })}
        error={
          check && !check.ok
            ? t('options.connection.addressInvalid', { reason: check.reason })
            : undefined
        }
        hint={hint || undefined}
      />
      <Button
        icon={<Save size={15} aria-hidden="true" />}
        onClick={() => void save()}
        disabled={!dirty || (check && !check.ok)}
      >
        {t('options.connection.saveAddress')}
      </Button>
      {/* 先保存成功再申请权限：申请必须在点击中同步发起，不能先等待保存。 */}
      {check?.ok && !granted && <GrantPermissionButton url={value} disabled={dirty} />}
    </div>
  );
}

function KeyFields({
  snapshot,
  onDirtyChange,
}: {
  snapshot: AppSnapshot;
  onDirtyChange(dirty: boolean): void;
}) {
  const t = useT();
  const locale = useLocale();
  const notify = useToast();
  const { run, isBusy } = useCommandRunner();
  const credential = snapshot.credential;
  const [keyDraft, setKeyDraft] = useState({ value: '' });
  const key = keyDraft.value;
  useEffect(() => onDirtyChange(!!key), [key, onDirtyChange]);
  const [visible, setVisible] = useState(false);
  const [remember, setRemember] = useState<boolean | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const rememberValue =
    remember ?? (credential.storage === 'local' || snapshot.settings.rememberCredentials);

  const save = async () => {
    const apiKey = key.trim();
    if (!apiKey) return;
    const result = await run(
      { kind: 'credentials/set', apiKey, remember: rememberValue },
      { errorPrefix: t('options.connection.saveKeyFailed') },
    );
    if (!result) return;
    if (!result.persisted) {
      notify(t('options.connection.keyNotPersisted'), 'warning');
    } else {
      setKeyDraft((current) => (current === keyDraft ? { value: '' } : current));
      setVisible(false);
      notify(
        t('options.connection.keySaved', {
          where: t(
            result.storage === 'local'
              ? 'options.connection.keyWhereLocal'
              : 'options.connection.keyWhereSession',
          ),
        }),
        'success',
      );
    }
  };

  const clear = async () => {
    const result = await run(
      { kind: 'credentials/clear' },
      { errorPrefix: t('options.connection.deleteKeyFailed') },
    );
    setConfirmClear(false);
    if (result) notify(t('options.connection.keyDeleted'), 'success');
  };

  return (
    <div className={styles.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className={styles.row}>
        <TextField
          className={styles.grow}
          label={t('options.connection.keyLabel')}
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            credential.configured
              ? t('options.connection.keyPlaceholderReplace')
              : t('options.connection.keyPlaceholderNew')
          }
          value={key}
          onChange={(value) => setKeyDraft({ value })}
          hint={
            credential.configured
              ? t('options.connection.keyCurrent', {
                  masked: credential.masked ?? t('options.connection.keyHidden'),
                  storage: credentialStorageText(credential.storage, locale),
                })
              : t('options.connection.keyNone')
          }
          error={
            credential.cleanupPending
              ? t('options.connection.keyCleanupPending')
              : credential.configured && credential.storage === 'none'
                ? t('options.connection.keyNotStored')
                : undefined
          }
          trailing={
            <IconButton
              label={t(visible ? 'options.connection.hideKey' : 'options.connection.showKey')}
              pressed={visible}
              icon={
                visible ? (
                  <EyeOff size={15} aria-hidden="true" />
                ) : (
                  <Eye size={15} aria-hidden="true" />
                )
              }
              onClick={() => setVisible((v) => !v)}
            />
          }
        />
        <Button
          variant="primary"
          icon={<Save size={15} aria-hidden="true" />}
          busy={isBusy('credentials/set')}
          disabled={!key.trim()}
          onClick={() => void save()}
        >
          {t('options.connection.saveKey')}
        </Button>
        {(credential.configured || credential.cleanupPending) && (
          <Button
            variant="danger"
            icon={<Trash size={15} aria-hidden="true" />}
            onClick={() => setConfirmClear(true)}
          >
            {t(
              credential.cleanupPending
                ? 'options.connection.retryKeyCleanup'
                : 'options.connection.deleteKey',
            )}
          </Button>
        )}
      </div>
      <Checkbox
        label={t('options.connection.remember')}
        checked={rememberValue}
        onChange={setRemember}
      />
      <Hint>
        {t('options.connection.rememberHint')}
        {credential.configured && rememberValue !== (credential.storage === 'local')
          ? t('options.connection.rememberChange')
          : ''}
      </Hint>
      <ConfirmDialog
        open={confirmClear}
        title={t('options.connection.deleteKeyTitle')}
        confirmLabel={t('options.action.delete')}
        danger
        busy={isBusy('credentials/clear')}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      >
        {t('options.connection.deleteKeyBody')}
      </ConfirmDialog>
    </div>
  );
}

function ProtocolAndModel({
  snapshot,
  provider,
  routeDirty,
}: {
  snapshot: AppSnapshot;
  provider: ProviderSettings;
  routeDirty: boolean;
}) {
  const t = useT();
  const update = useSettingsUpdater();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [modelDraft, setModelDraft] = useState<Draft>({ value: provider.model, dirty: false });
  const modelValue = draftValue(modelDraft, provider.model);
  const [timeout, setTimeoutMs] = useDraftValue(
    provider.timeoutMs,
    (timeoutMs) => update({ provider: { timeoutMs } }),
    400,
  );
  const saveModel = async (model: string) => {
    const trimmed = model.trim();
    if (!trimmed || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (await update({ provider: { model: trimmed } }))
        setModelDraft((current) =>
          current === modelDraft ? { value: trimmed, dirty: false } : current,
        );
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const modelCap = snapshot.capabilities.model;

  return (
    <>
      <div className={styles.grid2}>
        <SelectField<TextProtocol>
          label={t('options.connection.protocol')}
          value={provider.protocol}
          onChange={(protocol) => void update({ provider: { protocol } })}
          options={[
            { value: 'auto', label: t('options.connection.protocolAuto') },
            { value: 'responses', label: 'Responses' },
            { value: 'chat', label: 'Chat Completions' },
          ]}
          hint={
            provider.protocol === 'auto'
              ? provider.detectedProtocol
                ? t('options.connection.protocolDetected', {
                    protocol:
                      provider.detectedProtocol === 'responses' ? 'Responses' : 'Chat Completions',
                  })
                : t('options.connection.protocolNotDetected')
              : undefined
          }
        />
        <SelectField
          label={t('options.connection.reasoning')}
          value={provider.reasoningEffort}
          onChange={(reasoningEffort) => void update({ provider: { reasoningEffort } })}
          options={[
            { value: 'omit', label: t('options.connection.reasoningOmit') },
            { value: 'none', label: 'none' },
            { value: 'low', label: 'low' },
          ]}
          hint={t('options.connection.reasoningHint')}
        />
      </div>

      <div className={styles.subhead}>{t('options.connection.modelHeading')}</div>
      <ModelSelector
        snapshot={snapshot}
        value={modelValue}
        onChange={(value) => setModelDraft({ value, dirty: true })}
        disabledReason={routeDirty ? t('options.connection.modelDisabled') : undefined}
      />
      <Hint>
        {t('options.connection.modelCurrent')}
        <span className={styles.mono}>
          {provider.model || t('options.connection.modelUnset')}
        </span>{' '}
        · <CapabilityStatusText status={modelCap?.status} message={modelCap?.message} />
      </Hint>
      <Button
        icon={<Save size={15} aria-hidden="true" />}
        busy={saving}
        disabled={saving || !modelDraft.dirty || !modelValue.trim()}
        onClick={() => void saveModel(modelValue)}
      >
        {t('options.connection.saveModel')}
      </Button>

      <div className={styles.grid2}>
        <SwitchRow
          label={t('options.connection.streaming')}
          description={t('options.connection.streamingDescription')}
          checked={provider.streaming}
          onChange={(streaming) => void update({ provider: { streaming } })}
        />
        <RangeField
          label={t('options.connection.timeout')}
          min={3_000}
          max={120_000}
          step={1_000}
          value={timeout}
          onChange={setTimeoutMs}
          format={(v) => t('options.connection.seconds', { n: Math.round(v / 1000) })}
        />
      </div>
    </>
  );
}

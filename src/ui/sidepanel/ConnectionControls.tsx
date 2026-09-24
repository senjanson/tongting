import { Eye, EyeOff, Save } from 'lucide-react';
import { useRef, useState } from 'react';
import { useLocale, useT } from '../../i18n/react';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Checkbox, Hint, IconButton, TextField } from '../components/controls';
import { Group } from '../components/layout';
import { useToast } from '../components/toast';
import { CheckRunner, TEXT_CHECK_KEYS } from '../options/CheckRunner';
import { ModelSelector } from '../shared/ModelSelector';
import { credentialStorageText } from '../options/common';
import { GrantPermissionButton } from '../shared/GrantPermissionButton';
import { useCommandRunner, useSettingsUpdater } from '../shared/hooks';
import { useUiClient } from '../state/hooks';
import { checkServiceUrl } from '../state/permissions';
import styles from './sidepanel.module.css';

/** The prototype's connection form, backed by the same commands as full settings. */
export function ConnectionControls({ snapshot }: { snapshot: AppSnapshot }) {
  const { settings, credential } = snapshot;
  const demo = useUiClient().mode === 'demo';
  const update = useSettingsUpdater();
  const { run } = useCommandRunner();
  const notify = useToast();
  const locale = useLocale();
  const t = useT();
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<{
    url?: string;
    model?: string;
    key?: string;
    remember?: boolean;
  } | null>(null);
  const [showKey, setShowKey] = useState(false);
  const url = draft?.url ?? settings.provider.baseUrl;
  const model = draft?.model ?? settings.provider.model;
  const apiKey = draft?.key ?? '';
  const remember = draft?.remember ?? settings.rememberCredentials;
  const check = checkServiceUrl(url, locale);

  const save = async () => {
    if (!draft || !check.ok || !model.trim() || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    const submitted = draft;
    try {
      if (
        draft.url !== undefined ||
        draft.model !== undefined ||
        (draft.remember !== undefined && !apiKey.trim())
      ) {
        const accepted = await update({
          provider: {
            ...(draft.url !== undefined ? { baseUrl: url.trim() } : {}),
            ...(draft.model !== undefined ? { model: model.trim() } : {}),
          },
          ...(draft.remember !== undefined && !apiKey.trim()
            ? { rememberCredentials: remember }
            : {}),
        });
        if (!accepted) return;
      }
      if (apiKey.trim() && !demo) {
        const result = await run(
          {
            kind: 'credentials/set',
            apiKey: apiKey.trim(),
            remember,
          },
          { key: 'connection-save', errorPrefix: t('sidepanel.connection.saveKeyFailed') },
        );
        if (!result) return;
        if (!result.persisted) {
          notify(t('sidepanel.connection.keyNotPersisted'), 'warning');
          return;
        }
        notify(
          result.storage === 'local'
            ? t('sidepanel.connection.keySavedLocal')
            : t('sidepanel.connection.keySavedSession'),
          'success',
        );
      }
      // A late response must never discard edits made after clicking Save.
      setDraft((current) => (current === submitted ? null : current));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <Group title={t('sidepanel.group.connection')}>
      <TextField
        label={t('sidepanel.connection.url')}
        placeholder="https://your-service.com/v1"
        value={url}
        autoComplete="off"
        spellCheck={false}
        onChange={(value) => setDraft((current) => ({ ...current, url: value }))}
        error={url && !check.ok ? check.reason : undefined}
      />
      <div className={styles.keyField}>
        <TextField
          label="API Key"
          type={showKey ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          disabled={demo}
          placeholder={
            demo
              ? t('sidepanel.connection.keyDemo')
              : credential.configured
                ? t('sidepanel.connection.keySaved')
                : t('sidepanel.connection.keyEmpty')
          }
          value={apiKey}
          onChange={(value) => setDraft((current) => ({ ...current, key: value }))}
        />
        <IconButton
          label={showKey ? t('sidepanel.connection.hideKey') : t('sidepanel.connection.showKey')}
          icon={showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          onClick={() => setShowKey((value) => !value)}
        />
      </div>
      <Checkbox
        label={t('sidepanel.connection.remember')}
        checked={remember}
        disabled={demo}
        onChange={(value) => setDraft((current) => ({ ...current, remember: value }))}
      />
      <Hint>
        {remember ? t('sidepanel.connection.rememberHint') : t('sidepanel.connection.tempHint')}
      </Hint>
      <ModelSelector
        snapshot={snapshot}
        value={model}
        onChange={(value) => setDraft((current) => ({ ...current, model: value }))}
        disabledReason={
          draft?.url !== undefined || !!draft?.key
            ? t('sidepanel.connection.modelBlocked')
            : undefined
        }
      />
      {draft && (
        <Button
          block
          icon={<Save size={14} />}
          busy={saving}
          disabled={saving || !check.ok || !model.trim()}
          onClick={() => void save()}
        >
          {t('sidepanel.connection.save')}
        </Button>
      )}
      {!demo && !snapshot.hostPermission.granted && settings.provider.baseUrl && (
        <GrantPermissionButton
          url={settings.provider.baseUrl}
          disabled={draft?.url !== undefined}
          block
        />
      )}
      <CheckRunner
        snapshot={snapshot}
        scope="text"
        keys={TEXT_CHECK_KEYS}
        buttonLabel={t('sidepanel.connection.check')}
        resultLabel={t('sidepanel.connection.checkResult')}
        disabledReason={
          draft
            ? t('sidepanel.connection.checkNeedSave')
            : !settings.provider.baseUrl || !credential.configured
              ? t('sidepanel.connection.checkNeedCredentials')
              : undefined
        }
        emptyHint={demo ? t('sidepanel.connection.checkDemo') : t('sidepanel.connection.checkHint')}
      />
      {!demo && credential.configured && (
        <Hint>
          {credential.masked} · {credentialStorageText(credential.storage, locale)}
        </Hint>
      )}
      {credential.cleanupPending && <Hint>{t('sidepanel.connection.cleanupPending')}</Hint>}
    </Group>
  );
}

import { Eye, EyeOff, Save } from 'lucide-react';
import { useRef, useState } from 'react';
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
  const check = checkServiceUrl(url);

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
          { key: 'connection-save', errorPrefix: '保存 Key 失败' },
        );
        if (!result) return;
        if (!result.persisted) {
          notify('Key 未能完整保存，请重试保存后再重新加载扩展。', 'warning');
          return;
        }
        notify(
          result.storage === 'local'
            ? 'Key 已保存在本机，重新加载扩展或重启浏览器后仍可使用。'
            : 'Key 仅临时保存，重新加载扩展或重启浏览器后会清除。',
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
    <Group title="CONNECTION / 模型连接">
      <TextField
        label="sub2api 服务地址"
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
              ? '演示中请勿填写真实密钥'
              : credential.configured
                ? '已保存，填写新 Key 可替换'
                : '填写 sub2api API Key'
          }
          value={apiKey}
          onChange={(value) => setDraft((current) => ({ ...current, key: value }))}
        />
        <IconButton
          label={showKey ? '隐藏密钥' : '显示密钥'}
          icon={showKey ? <EyeOff size={15} /> : <Eye size={15} />}
          onClick={() => setShowKey((value) => !value)}
        />
      </div>
      <Checkbox
        label="记住在本机"
        checked={remember}
        disabled={demo}
        onChange={(value) => setDraft((current) => ({ ...current, remember: value }))}
      />
      <Hint>
        {remember
          ? '保存成功后，Key 会保留在本机；重新加载扩展或重启浏览器不会清除。'
          : '临时保存：重新加载扩展或重启浏览器后需要重新输入 Key。'}
      </Hint>
      <ModelSelector
        snapshot={snapshot}
        value={model}
        onChange={(value) => setDraft((current) => ({ ...current, model: value }))}
        disabledReason={
          draft?.url !== undefined || !!draft?.key
            ? '请先保存服务地址与 Key，再获取模型列表。'
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
          保存连接设置
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
        buttonLabel="检查连接"
        resultLabel="连接检查结果"
        disabledReason={
          draft
            ? '请先保存连接设置。'
            : !settings.provider.baseUrl || !credential.configured
              ? '请先填写服务地址与 Key。'
              : undefined
        }
        emptyHint={
          demo ? '演示模式不连接服务。' : '模型列表不代表实际调用成功，请选择模型后检查连接。'
        }
      />
      {!demo && credential.configured && (
        <Hint>
          {credential.masked} · {credentialStorageText(credential.storage)}
        </Hint>
      )}
      {credential.cleanupPending && <Hint>旧密钥存储清理失败，请在完整设置中重试清理。</Hint>}
    </Group>
  );
}

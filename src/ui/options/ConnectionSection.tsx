/**
 * 模型连接设置：服务地址与访问权限、API Key、协议、模型、推理参数、流式、超时、分项连接检查。
 *
 * 保存 Key 不等于连接成功；只有「检查连接」中实际请求成功的项目才显示「已验证」。
 */
import { Eye, EyeOff, Save, Trash } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProviderSettings, TextProtocol } from '../../domain/settings';
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
  return (
    <Section
      id="connection"
      title="模型连接"
      description="填写你自己的 sub2api 服务。所有能力以「检查连接」的实际请求结果为准。"
    >
      <AddressFields snapshot={snapshot} onDirtyChange={setAddressDirty} />
      <KeyFields snapshot={snapshot} onDirtyChange={setKeyDirty} />
      <ProtocolAndModel
        snapshot={snapshot}
        provider={provider}
        routeDirty={addressDirty || keyDirty}
      />
      <div className={styles.subhead}>检查连接</div>
      <CheckRunner
        snapshot={snapshot}
        scope="text"
        keys={TEXT_CHECK_KEYS}
        buttonLabel="检查连接"
        resultLabel="连接检查结果"
        disabledReason={
          !snapshot.settings.provider.baseUrl.trim() || !snapshot.credential.configured
            ? '请先保存服务地址与 API Key。'
            : undefined
        }
        emptyHint="尚未检查。检查会依次验证地址/权限、认证、模型列表、选定模型、小规模翻译与流式返回。语音识别与语音合成在「识别与播放」中单独检查。"
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
  const update = useSettingsUpdater();
  const saved = snapshot.settings.provider.baseUrl;
  const [draft, setDraft] = useState<Draft>({ value: saved, dirty: false });
  const value = draftValue(draft, saved);
  const check = value.trim() ? checkServiceUrl(value) : undefined;
  const dirty = draft.dirty && draft.value.trim() !== saved;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const savedCheck = saved.trim() ? checkServiceUrl(saved) : undefined;
  const permission = snapshot.hostPermission;
  const granted =
    !!savedCheck?.ok &&
    permission.granted &&
    (!permission.origin || sameOrigin(permission.origin, savedCheck.origin));

  const save = async () => {
    const trimmed = value.trim();
    if (trimmed && !checkServiceUrl(trimmed).ok) return;
    if (await update({ provider: { baseUrl: trimmed } }))
      setDraft((current) => (current === draft ? { value: trimmed, dirty: false } : current));
  };

  let hint: string;
  if (!check) hint = '只支持 https；本机调试服务可用 http://127.0.0.1:<端口>。';
  else if (!check.ok) hint = '';
  else if (dirty)
    hint = `请先保存地址，保存成功后再授予访问 ${check.pattern} 的权限。${
      granted && savedCheck?.ok && !sameOrigin(savedCheck.origin, check.origin)
        ? `保存后，不再使用的旧地址 ${savedCheck.origin} 的访问权限会被移除。`
        : ''
    }`;
  else if (granted) hint = `已授予访问 ${check.origin} 的权限。`;
  else hint = `尚未授予访问 ${check.pattern} 的权限，扩展无法向该地址发送请求。`;

  return (
    <div className={styles.row}>
      <TextField
        className={styles.grow}
        label="sub2api 服务地址（Base URL）"
        placeholder="https://your-sub2api.example.com/v1"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(v) => setDraft({ value: v, dirty: true })}
        error={check && !check.ok ? `地址无效：${check.reason}` : undefined}
        hint={hint || undefined}
      />
      <Button
        icon={<Save size={15} aria-hidden="true" />}
        onClick={() => void save()}
        disabled={!dirty || (check && !check.ok)}
      >
        保存地址
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
      { errorPrefix: '保存 Key 失败' },
    );
    if (!result) return;
    if (!result.persisted) {
      notify('Key 未能完整保存，请重试保存后再重新加载扩展。', 'warning');
    } else {
      setKeyDraft((current) => (current === keyDraft ? { value: '' } : current));
      setVisible(false);
      notify(
        `Key 已保存（${result.storage === 'local' ? '本机扩展存储' : '仅本次浏览器会话'}）。尚未验证，请点击「检查连接」。`,
        'success',
      );
    }
  };

  const clear = async () => {
    const result = await run({ kind: 'credentials/clear' }, { errorPrefix: '删除 Key 失败' });
    setConfirmClear(false);
    if (result) notify('已删除 Key。使用旧 Key 的请求会被中止。', 'success');
  };

  return (
    <div className={styles.row} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div className={styles.row}>
        <TextField
          className={styles.grow}
          label="API Key"
          type={visible ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            credential.configured ? '输入新 Key 以替换当前 Key' : '在此粘贴你的 sub2api Key'
          }
          value={key}
          onChange={(value) => setKeyDraft({ value })}
          hint={
            credential.configured
              ? `当前 Key：${credential.masked ?? '（已隐藏）'}，${credentialStorageText(credential.storage)}。`
              : '尚未保存 Key。'
          }
          error={
            credential.cleanupPending
              ? '旧存储清理失败，请重试清理。已撤销的 Key 不会再用于请求。'
              : credential.configured && credential.storage === 'none'
                ? '未保存：Key 仅在本次后台运行期间有效，可能随时丢失，请重新保存。'
                : undefined
          }
          trailing={
            <IconButton
              label={visible ? '隐藏 Key' : '显示 Key'}
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
          保存 Key
        </Button>
        {(credential.configured || credential.cleanupPending) && (
          <Button
            variant="danger"
            icon={<Trash size={15} aria-hidden="true" />}
            onClick={() => setConfirmClear(true)}
          >
            {credential.cleanupPending ? '重试清理 Key' : '删除 Key'}
          </Button>
        )}
      </div>
      <Checkbox label="记住在本机" checked={rememberValue} onChange={setRemember} />
      <Hint>
        默认勾选「记住在本机」，重新加载扩展或重启浏览器后仍保留。主动取消后仅临时保存，重新加载或关闭浏览器会清空。不会同步到其他设备；
        它不是安全保险箱，能访问这台电脑浏览器配置的人或程序可能读取。Key
        不会出现在页面、字幕消息或导出的设置中。
        {credential.configured && rememberValue !== (credential.storage === 'local')
          ? ' 修改保存位置需要重新输入并保存 Key。'
          : ''}
      </Hint>
      <ConfirmDialog
        open={confirmClear}
        title="删除 API Key"
        confirmLabel="删除"
        danger
        busy={isBusy('credentials/clear')}
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      >
        删除后翻译会停止使用该 Key，正在进行的请求会被中止。需要时可重新输入。
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
          label="接口协议"
          value={provider.protocol}
          onChange={(protocol) => void update({ provider: { protocol } })}
          options={[
            { value: 'auto', label: '自动检测' },
            { value: 'responses', label: 'Responses' },
            { value: 'chat', label: 'Chat Completions' },
          ]}
          hint={
            provider.protocol === 'auto'
              ? provider.detectedProtocol
                ? `已检测为 ${provider.detectedProtocol === 'responses' ? 'Responses' : 'Chat Completions'}。`
                : '尚未检测，检查连接时会确定。'
              : undefined
          }
        />
        <SelectField
          label="推理参数"
          value={provider.reasoningEffort}
          onChange={(reasoningEffort) => void update({ provider: { reasoningEffort } })}
          options={[
            { value: 'omit', label: '不发送（默认）' },
            { value: 'none', label: 'none' },
            { value: 'low', label: 'low' },
          ]}
          hint="服务或模型可能不接受该参数，需检查连接实测。"
        />
      </div>

      <div className={styles.subhead}>翻译模型</div>
      <ModelSelector
        snapshot={snapshot}
        value={modelValue}
        onChange={(value) => setModelDraft({ value, dirty: true })}
        disabledReason={routeDirty ? '请先保存服务地址与 Key，再获取模型列表。' : undefined}
      />
      <Hint>
        当前使用：<span className={styles.mono}>{provider.model || '未填写'}</span> ·{' '}
        <CapabilityStatusText status={modelCap?.status} message={modelCap?.message} />
      </Hint>
      <Button
        icon={<Save size={15} aria-hidden="true" />}
        busy={saving}
        disabled={saving || !modelDraft.dirty || !modelValue.trim()}
        onClick={() => void saveModel(modelValue)}
      >
        保存模型
      </Button>

      <div className={styles.grid2}>
        <SwitchRow
          label="流式返回"
          description="需服务支持；检查连接会单独验证流式结果。"
          checked={provider.streaming}
          onChange={(streaming) => void update({ provider: { streaming } })}
        />
        <RangeField
          label="单次请求超时"
          min={3_000}
          max={120_000}
          step={1_000}
          value={timeout}
          onChange={setTimeoutMs}
          format={(v) => `${Math.round(v / 1000)} 秒`}
        />
      </div>
    </>
  );
}

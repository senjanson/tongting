import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recommendedTranslationModel,
  translationModelCandidates,
} from '../../domain/translation-models';
import type { AppSnapshot } from '../../messaging/ui-protocol';
import { Button, Hint, SelectField, TextField } from '../components/controls';
import { Callout } from '../components/layout';
import { errorInfoOf, errorMessageOf } from '../state/client';
import { useClientState, useUiClient } from '../state/hooks';

/** 不使用 Key 本身；worker 重启、服务变化、凭证代数和撤回权限都会使列表过期。 */
function sourceIdentity(snapshot: AppSnapshot | null): string {
  return snapshot
    ? JSON.stringify([
        snapshot.workerInstanceId,
        snapshot.settings.provider.baseUrl,
        snapshot.credential.generation,
        snapshot.credential.configured,
        snapshot.hostPermission.origin,
        snapshot.hostPermission.granted,
      ])
    : '';
}

interface Discovery {
  source: string;
  models?: string[];
  error?: string;
  busy?: boolean;
}

interface ModelSelectorProps {
  snapshot: AppSnapshot;
  value: string;
  onChange(value: string): void;
  onSelect?(value: string): void;
  disabledReason?: string;
}

export function ModelSelector(props: ModelSelectorProps) {
  const client = useUiClient();
  const { connection } = useClientState();
  const { snapshot, disabledReason } = props;
  const source = sourceIdentity(snapshot);
  const blocked =
    disabledReason ??
    (client.mode === 'demo'
      ? '演示模式不连接真实服务，可手动填写示例模型。'
      : connection !== 'connected'
        ? '正在连接后台服务，请稍后重试。'
        : !snapshot.settings.provider.baseUrl || !snapshot.credential.configured
          ? '先保存服务地址与 API Key，再获取模型列表。'
          : !snapshot.hostPermission.granted
            ? '先授予服务地址访问权限，再获取模型列表。'
            : undefined);
  // 连接草稿、权限或服务变化时重建发现状态；手填草稿由调用方持有，不会被重置。
  return (
    <ModelSelectorFields
      key={JSON.stringify([source, blocked])}
      {...props}
      source={source}
      blocked={blocked}
    />
  );
}

function ModelSelectorFields({
  value,
  onChange,
  onSelect = onChange,
  source,
  blocked,
}: ModelSelectorProps & { source: string; blocked?: string }) {
  const client = useUiClient();
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const request = useRef<{ id: number; source: string } | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(false);

  useEffect(() => {
    let active = true;
    mounted.current = true;
    let observed = sourceIdentity(client.getState().snapshot);
    let connected = client.getState().connection;
    const unsubscribe = client.subscribe(() => {
      if (!active) return;
      const state = client.getState();
      const next = sourceIdentity(state.snapshot);
      if (observed !== next || connected !== state.connection) {
        observed = next;
        connected = state.connection;
        sequence.current++;
        request.current = null;
        setDiscovery(null);
      }
    });
    const invalidate = () => {
      sequence.current++;
    };
    return () => {
      active = false;
      mounted.current = false;
      invalidate();
      request.current = null;
      unsubscribe();
    };
  }, [client]);

  const discover = useCallback(async () => {
    const current = client.getState();
    if (
      blocked ||
      request.current ||
      current.connection !== 'connected' ||
      sourceIdentity(current.snapshot) !== source
    )
      return;
    const id = ++sequence.current;
    request.current = { id, source };
    setDiscovery({ source, busy: true });
    const isCurrent = () =>
      mounted.current &&
      sequence.current === id &&
      request.current?.id === id &&
      client.getState().connection === 'connected' &&
      sourceIdentity(client.getState().snapshot) === source;
    try {
      const result = await client.sendCommand({ kind: 'models/discover' });
      if (isCurrent()) setDiscovery({ source, models: result.models });
    } catch (error) {
      if (!isCurrent()) return;
      // 另一页面发起的获取取代了本次：不是失败，回到可重新获取的状态。
      if (errorInfoOf(error)?.code === 'discovery-replaced') setDiscovery(null);
      else setDiscovery({ source, error: errorMessageOf(error) });
    } finally {
      if (request.current?.id === id) request.current = null;
    }
  }, [blocked, client, source]);

  const current = discovery?.source === source && !blocked ? discovery : null;
  const models = translationModelCandidates(current?.models ?? []);
  const recommended = recommendedTranslationModel(models);
  const sorted = recommended
    ? [recommended, ...models.filter((model) => model !== recommended)]
    : models;
  const options = sorted.map((model) => ({
    value: model,
    label: model === recommended ? `${model} · 字幕翻译推荐` : model,
  }));
  if (!models.includes(value))
    options.unshift({ value, label: value ? '手动输入（当前设置）' : '— 选择模型 —' });

  return (
    <>
      <SelectField
        label="翻译模型"
        value={value}
        options={options}
        disabled={!models.length || !!blocked}
        onChange={onSelect}
        hint={
          current?.models
            ? `服务返回 ${current.models.length} 个模型，显示 ${models.length} 个 GPT 5.6 及以上文本候选。选择后仍需检查连接验证调用。`
            : '仅列出服务返回的 GPT 5.6 及以上文本模型；也可手动填写模型 ID。'
        }
      />
      <Button
        icon={<RefreshCw size={14} aria-hidden="true" />}
        busy={!!current?.busy}
        disabled={!!blocked || !!current?.busy}
        onClick={() => void discover()}
      >
        {current?.models ? '刷新模型列表' : '获取模型列表'}
      </Button>
      {blocked && <Hint>{blocked}</Hint>}
      {current?.error && (
        <Callout tone="warning">模型发现失败：{current.error} 可重试或手动填写模型 ID。</Callout>
      )}
      {current?.models && !models.length && (
        <Hint>服务未返回 GPT 5.6 及以上文本模型，请确认账号权限或手动填写模型 ID。</Hint>
      )}
      <TextField
        label="模型 ID（可手动填写）"
        value={value}
        onChange={onChange}
        autoComplete="off"
        spellCheck={false}
      />
    </>
  );
}

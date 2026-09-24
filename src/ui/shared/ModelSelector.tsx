import { RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  recommendedTranslationModel,
  translationModelCandidates,
} from '../../domain/translation-models';
import { useT } from '../../i18n/react';
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
  const t = useT();
  const { snapshot, disabledReason } = props;
  const source = sourceIdentity(snapshot);
  const blocked =
    disabledReason ??
    (client.mode === 'demo'
      ? t('common.model.demoBlocked')
      : connection !== 'connected'
        ? t('common.client.notConnected')
        : !snapshot.settings.provider.baseUrl || !snapshot.credential.configured
          ? t('common.model.needCredentials')
          : !snapshot.hostPermission.granted
            ? t('common.model.needPermission')
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
  const t = useT();
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
    label: model === recommended ? t('common.model.recommended', { model }) : model,
  }));
  if (!models.includes(value))
    options.unshift({
      value,
      label: value ? t('common.model.manualCurrent') : t('common.model.choose'),
    });

  return (
    <>
      <SelectField
        label={t('common.model.label')}
        value={value}
        options={options}
        disabled={!models.length || !!blocked}
        onChange={onSelect}
        hint={
          current?.models
            ? t('common.model.hintFound', {
                total: current.models.length,
                shown: models.length,
              })
            : t('common.model.hintDefault')
        }
      />
      <Button
        icon={<RefreshCw size={14} aria-hidden="true" />}
        busy={!!current?.busy}
        disabled={!!blocked || !!current?.busy}
        onClick={() => void discover()}
      >
        {current?.models ? t('common.model.refresh') : t('common.model.fetch')}
      </Button>
      {blocked && <Hint>{blocked}</Hint>}
      {current?.error && (
        <Callout tone="warning">
          {t('common.model.discoveryFailed', { detail: current.error })}
        </Callout>
      )}
      {current?.models && !models.length && <Hint>{t('common.model.noneFound')}</Hint>}
      <TextField
        label={t('common.model.idLabel')}
        value={value}
        onChange={onChange}
        autoComplete="off"
        spellCheck={false}
      />
    </>
  );
}

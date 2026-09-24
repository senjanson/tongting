/**
 * 分项连接检查：按 scope 发送 connection/check，只展示与本区块相关的检查项。
 *
 * - sub2api 语音识别/合成的检查需要一次实际调用（可能计费）：只有用户勾选「允许实际调用」时才发送
 *   allowBilledAudioProbe: true；勾选在点击检查时即清空（本次请求仍带点击时的值），只对本次有效；
 *   未探测的项目显示「未检测」。
 * - 同一页面同一时刻只进行一项检查：任一检查进行中时，本页所有检查按钮都不可用，避免双击等重复触发
 *   发出多次（可能计费的）检查。
 * - worker 用更新的检查取代本次检查时（错误码 check-replaced），静默结束：不提示失败，不覆盖已有结果。
 * - 配置版本、凭证代数或主机权限变化后，结果标为过期，不再显示「通过」。
 */
import { PlugZap } from 'lucide-react';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { CapabilityKey } from '../../domain/capability';
import type {
  AppSnapshot,
  ConnectionCheckItem,
  ConnectionReport,
} from '../../messaging/ui-protocol';
import { Button, Checkbox, Hint } from '../components/controls';
import { Callout } from '../components/layout';
import { useToast } from '../components/toast';
import { formatDateTime, formatLatency } from '../format';
import { errorInfoOf, errorMessageOf, type UiClient } from '../state/client';
import { useUiClient } from '../state/hooks';
import { StatusIcon } from './common';
import styles from './options.module.css';

export const CHECK_LABELS: Record<CapabilityKey, string> = {
  reachability: '地址可达',
  hostPermission: '访问权限',
  auth: '认证',
  modelList: '模型列表',
  model: '选定模型',
  translation: '小规模翻译',
  streaming: '流式返回',
  asr: 'sub2api 语音识别',
  tts: 'sub2api 语音合成',
  realtimeTranslate: '实时翻译',
  localAsr: '本地识别服务',
  systemTts: '系统语音',
};

export const TEXT_CHECK_KEYS: readonly CapabilityKey[] = [
  'reachability',
  'hostPermission',
  'auth',
  'modelList',
  'model',
  'translation',
  'streaming',
  'realtimeTranslate',
];
export const ASR_CHECK_KEYS: readonly CapabilityKey[] = ['localAsr', 'asr'];
export const TTS_CHECK_KEYS: readonly CapabilityKey[] = ['systemTts', 'tts'];

export function checkItemText(item: ConnectionCheckItem): string {
  let word: string;
  switch (item.status) {
    case 'verified':
      word = '通过';
      break;
    case 'failed':
      word = '失败';
      break;
    case 'unsupported':
      word = '不支持';
      break;
    default:
      word = item.reasonCode === 'not-probed' ? '未检测（需要允许实际调用）' : '未检测';
  }
  const parts = [word];
  if (item.message) parts.push(item.message);
  if (item.latencyMs !== undefined) parts.push(`往返 ${formatLatency(item.latencyMs)}`);
  return parts.join(' · ');
}

export interface ReportContext {
  configRevision: number;
  credentialGeneration: number;
  hostPermissionGranted: boolean;
}

/**
 * 检查结果是否已过期：配置版本或凭证代数变化，或检查后主机权限状态发生变化。
 * @param grantedAtCheck 检查结果到达时记录的主机权限状态（未知时不比较）。
 */
export function isReportStale(
  report: Pick<ConnectionReport, 'configRevision' | 'credentialGeneration'>,
  current: ReportContext,
  grantedAtCheck: boolean | undefined,
): boolean {
  return (
    report.configRevision !== current.configRevision ||
    report.credentialGeneration !== current.credentialGeneration ||
    (grantedAtCheck !== undefined && grantedAtCheck !== current.hostPermissionGranted)
  );
}

/** worker 以同 scope（或 all）的新检查取代旧检查时，旧请求的错误码（category: cancelled）。 */
export const CHECK_REPLACED_CODE = 'check-replaced';

export type CheckScope = 'text' | 'asr' | 'tts';

/**
 * 一个页面（同一 UI 客户端）正在进行的检查。放在组件之外，以便同页的多个 CheckRunner 共享，
 * 并在点击时同步判断（不依赖重新渲染后按钮才变为不可用）。
 */
class ActiveCheck {
  private scope: CheckScope | null = null;
  private readonly listeners = new Set<() => void>();

  readonly get = (): CheckScope | null => this.scope;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** 开始一项检查；已有检查进行中时返回 null（不应发送）。返回的函数结束本项检查，可重复调用。 */
  begin(scope: CheckScope): (() => void) | null {
    if (this.scope) return null;
    this.scope = scope;
    this.emit();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.scope = null;
      this.emit();
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

const ACTIVE_CHECKS = new WeakMap<UiClient, ActiveCheck>();

function activeCheckOf(client: UiClient): ActiveCheck {
  let active = ACTIVE_CHECKS.get(client);
  if (!active) {
    active = new ActiveCheck();
    ACTIVE_CHECKS.set(client, active);
  }
  return active;
}

export interface CheckRunnerProps {
  snapshot: AppSnapshot;
  scope: CheckScope;
  keys: readonly CapabilityKey[];
  buttonLabel: string;
  resultLabel: string;
  disabledReason?: string;
  emptyHint: ReactNode;
  /** 检查会调用 sub2api 音频接口（可能计费）：显示需用户勾选的确认项。 */
  billable?: boolean;
}

interface Observed {
  report: ConnectionReport;
  grantedAtCheck: boolean;
}

export function CheckRunner({
  snapshot,
  scope,
  keys,
  buttonLabel,
  resultLabel,
  disabledReason,
  emptyHint,
  billable = false,
}: CheckRunnerProps) {
  const [allowBilled, setAllowBilled] = useState(false);
  const client = useUiClient();
  const notify = useToast();
  const active = activeCheckOf(client);
  const activeScope = useSyncExternalStore(active.subscribe, active.get, active.get);
  const checking = activeScope === scope;
  const otherChecking = activeScope !== null && !checking;
  const granted = snapshot.hostPermission.granted;
  const snapshotReport = snapshot.lastConnectionReport;
  const [local, setLocal] = useState<Observed | null>(null);
  const [seen, setSeen] = useState<Observed | null>(
    snapshotReport ? { report: snapshotReport, grantedAtCheck: granted } : null,
  );
  const [hadSnapshotReport, setHadSnapshotReport] = useState(!!snapshotReport);

  // 根据快照变化调整本地状态（渲染期间按条件更新，React 推荐的派生方式）。
  if (hadSnapshotReport !== !!snapshotReport) {
    setHadSnapshotReport(!!snapshotReport);
    // worker 清空了检查结果（例如更换 Key 或地址）：本页保留的结果也一并丢弃。
    if (!snapshotReport) setLocal(null);
  }
  if (
    snapshotReport &&
    seen?.report !== snapshotReport &&
    seen?.report.checkedAt !== snapshotReport.checkedAt
  ) {
    setSeen({ report: snapshotReport, grantedAtCheck: granted });
  }

  const context: ReportContext = {
    configRevision: snapshot.configRevision,
    credentialGeneration: snapshot.credential.generation,
    hostPermissionGranted: granted,
  };
  const candidates = [
    local,
    snapshotReport ? (seen ?? { report: snapshotReport, grantedAtCheck: granted }) : null,
  ]
    .filter((o): o is Observed => !!o && o.report.items.some((i) => keys.includes(i.key)))
    .sort((a, b) => b.report.checkedAt - a.report.checkedAt);
  const observed = candidates[0];
  const report = observed?.report;
  const items = report?.items.filter((i) => keys.includes(i.key)) ?? [];
  const stale = !!observed && isReportStale(observed.report, context, observed.grantedAtCheck);

  const check = async () => {
    const finish = active.begin(scope);
    // 本页已有检查进行中：按钮已不可用，这里再挡住同一帧内的重复点击（例如双击）。
    if (!finish) return;
    // 计费确认只对本次检查有效：点击时同步取值并清空；检查进行中再勾选属于下一次检查。
    const allowBilledAudioProbe = billable && allowBilled;
    setAllowBilled(false);
    const grantedAtCheck = snapshot.hostPermission.granted;
    try {
      const report = await client.sendCommand({
        kind: 'connection/check',
        scope,
        allowBilledAudioProbe,
      });
      setLocal({ report, grantedAtCheck });
    } catch (error) {
      // 本次检查已被更新的检查取代（例如另一页面发起了同类检查）：新结果会随快照到达，
      // 不提示失败，也不改动已有结果。
      if (errorInfoOf(error)?.code === CHECK_REPLACED_CODE) return;
      notify(`检查失败：${errorMessageOf(error)}`, 'danger');
    } finally {
      finish();
    }
  };

  return (
    <>
      <div className={styles.row}>
        <Button
          variant={scope === 'text' ? 'primary' : 'secondary'}
          icon={<PlugZap size={15} aria-hidden="true" />}
          busy={checking}
          disabled={!!disabledReason || otherChecking}
          // 进行中的按钮不设 disabled，避免键盘焦点丢失；重复点击由 check() 忽略。
          aria-disabled={checking || undefined}
          onClick={() => void check()}
        >
          {buttonLabel}
        </Button>
        {disabledReason ? (
          <Hint>{disabledReason}</Hint>
        ) : (
          otherChecking && <Hint>另一项检查正在进行，完成后可再检查。</Hint>
        )}
      </div>
      {billable && (
        <Checkbox
          label="允许实际调用 sub2api 音频接口（可能产生少量费用，仅本次检查）"
          checked={allowBilled}
          disabled={!!disabledReason}
          onChange={setAllowBilled}
        />
      )}
      {!report ? (
        <Hint>{emptyHint}</Hint>
      ) : (
        <>
          <Hint>
            最近检查：{formatDateTime(report.checkedAt)}
            {scope === 'text' && report.detectedProtocol && !stale
              ? ` · 协议 ${report.detectedProtocol === 'responses' ? 'Responses' : 'Chat Completions'}`
              : ''}
          </Hint>
          {stale && (
            <Callout tone="warning">
              结果已过期，请重新检查（检查之后 Key、配置或访问权限已变化）。
            </Callout>
          )}
          <ul className={styles.checks} aria-label={resultLabel}>
            {items.map((item) => (
              <li key={item.key} className={styles.check}>
                <span className={styles.checkIcon}>
                  <StatusIcon status={stale ? 'unknown' : item.status} />
                </span>
                <span className={styles.checkName}>{CHECK_LABELS[item.key]}</span>
                <span className={styles.checkMessage}>
                  {stale ? '已过期，请重新检查' : checkItemText(item)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

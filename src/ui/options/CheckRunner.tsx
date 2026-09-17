/**
 * 分项连接检查：按 scope 发送 connection/check，只展示与本区块相关的检查项。
 *
 * - sub2api 语音识别/合成的检查需要一次实际调用（可能计费）：只有用户勾选「允许实际调用」时才发送
 *   allowBilledAudioProbe: true，且每次检查后恢复为不勾选；未探测的项目显示「未检测」。
 * - 配置版本、凭证代数或主机权限变化后，结果标为过期，不再显示「通过」。
 */
import { PlugZap } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CapabilityKey } from '../../domain/capability';
import type {
  AppSnapshot,
  ConnectionCheckItem,
  ConnectionReport,
} from '../../messaging/ui-protocol';
import { Button, Checkbox, Hint } from '../components/controls';
import { Callout } from '../components/layout';
import { formatDateTime, formatLatency } from '../format';
import { useCommandRunner } from '../shared/hooks';
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

export interface CheckRunnerProps {
  snapshot: AppSnapshot;
  scope: 'text' | 'asr' | 'tts';
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
  const { run, isBusy } = useCommandRunner();
  const busyKey = `check:${scope}`;
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
    const result = await run(
      { kind: 'connection/check', scope, allowBilledAudioProbe: billable && allowBilled },
      { key: busyKey, errorPrefix: '检查失败' },
    );
    // 计费确认只对本次检查有效。
    setAllowBilled(false);
    if (result) setLocal({ report: result, grantedAtCheck: snapshot.hostPermission.granted });
  };

  return (
    <>
      <div className={styles.row}>
        <Button
          variant={scope === 'text' ? 'primary' : 'secondary'}
          icon={<PlugZap size={15} aria-hidden="true" />}
          busy={isBusy(busyKey)}
          disabled={!!disabledReason}
          onClick={() => void check()}
        >
          {buttonLabel}
        </Button>
        {disabledReason && <Hint>{disabledReason}</Hint>}
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

/**
 * 「授予访问权限」：必须在点击处理函数中同步调用 permissions.request 以保留用户手势，
 * 之后通知 worker 重新核对权限。只申请由地址计算出的单一 origin；更换地址后，
 * 不再被任何配置使用的旧 origin 由 worker 在设置保存成功后通过 permissions.remove 回收。
 */
import { KeyRound } from 'lucide-react';
import { browser } from 'wxt/browser';
import { Button, type ButtonProps } from '../components/controls';
import { useToast } from '../components/toast';
import { errorMessageOf } from '../state/client';
import { useUiClient } from '../state/hooks';
import { checkLocalAsrUrl, checkServiceUrl } from '../state/permissions';

export interface GrantPermissionButtonProps extends Omit<ButtonProps, 'onClick'> {
  url: string;
  /** service：sub2api 地址（与 worker 相同的 normalizeBaseUrl 规则）；local-asr：本地识别服务。 */
  target?: 'service' | 'local-asr';
  onGranted?: () => void;
  label?: string;
}

export function GrantPermissionButton({
  url,
  target = 'service',
  onGranted,
  label = '授予访问权限',
  disabled,
  ...rest
}: GrantPermissionButtonProps) {
  const client = useUiClient();
  const notify = useToast();
  const check = target === 'local-asr' ? checkLocalAsrUrl(url) : checkServiceUrl(url);
  const demo = client.mode === 'demo';

  const onClick = () => {
    if (!check.ok || demo) return;
    let request: Promise<boolean>;
    try {
      // 同步调用，保持用户手势。
      request = browser.permissions.request({ origins: [check.pattern] });
    } catch {
      notify('无法申请访问权限，请在扩展详情页手动授予。', 'danger');
      return;
    }
    void request.then(
      async (granted) => {
        try {
          await client.sendCommand({ kind: 'permissions/changed' });
        } catch (error) {
          notify(`权限状态同步失败：${errorMessageOf(error)}`, 'warning');
        }
        if (granted) {
          notify(`已授予访问 ${check.origin} 的权限。`, 'success');
          onGranted?.();
        } else {
          notify('未授予访问权限，扩展无法向该地址发送请求。', 'warning');
        }
      },
      () => notify('申请访问权限失败，请检查地址后重试。', 'danger'),
    );
  };

  return (
    <Button
      icon={<KeyRound size={15} aria-hidden="true" />}
      onClick={onClick}
      disabled={disabled || !check.ok || demo}
      title={demo ? '演示模式下不可用' : check.ok ? `申请访问 ${check.pattern}` : check.reason}
      {...rest}
    >
      {label}
    </Button>
  );
}

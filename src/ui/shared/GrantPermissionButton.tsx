/**
 * 「授予访问权限」：必须在点击处理函数中同步调用 permissions.request 以保留用户手势，
 * 之后通知 worker 重新核对权限。只申请由地址计算出的单一 origin；更换地址后，
 * 不再被任何配置使用的旧 origin 由 worker 在设置保存成功后通过 permissions.remove 回收。
 */
import { KeyRound } from 'lucide-react';
import { browser } from 'wxt/browser';
import { useLocale, useT } from '../../i18n/react';
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
  label,
  disabled,
  ...rest
}: GrantPermissionButtonProps) {
  const client = useUiClient();
  const notify = useToast();
  const locale = useLocale();
  const t = useT();
  const check =
    target === 'local-asr' ? checkLocalAsrUrl(url, locale) : checkServiceUrl(url, locale);
  const demo = client.mode === 'demo';

  const onClick = () => {
    if (!check.ok || demo) return;
    let request: Promise<boolean>;
    try {
      // 同步调用，保持用户手势。
      request = browser.permissions.request({ origins: [check.pattern] });
    } catch {
      notify(t('common.permission.requestUnavailable'), 'danger');
      return;
    }
    void request.then(
      async (granted) => {
        try {
          await client.sendCommand({ kind: 'permissions/changed' });
        } catch (error) {
          notify(t('common.permission.syncFailed', { detail: errorMessageOf(error) }), 'warning');
        }
        if (granted) {
          notify(t('common.permission.granted', { origin: check.origin }), 'success');
          onGranted?.();
        } else {
          notify(t('common.permission.denied'), 'warning');
        }
      },
      () => notify(t('common.permission.requestFailed'), 'danger'),
    );
  };

  return (
    <Button
      icon={<KeyRound size={15} aria-hidden="true" />}
      onClick={onClick}
      disabled={disabled || !check.ok || demo}
      title={
        demo
          ? t('common.permission.demoDisabled')
          : check.ok
            ? t('common.permission.requestTitle', { pattern: check.pattern })
            : check.reason
      }
      {...rest}
    >
      {label ?? t('common.permission.grant')}
    </Button>
  );
}

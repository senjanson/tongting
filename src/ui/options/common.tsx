/**
 * 设置页通用小组件。
 */
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import type { CapabilityStatus } from '../../domain/capability';
import { translate, type Locale } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import { capabilityStatusLabel } from '../format';
import styles from './options.module.css';

export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section id={id} className={styles.section} aria-labelledby={headingId}>
      <div className={styles.sectionHead}>
        <h2 id={headingId}>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

export function StatusIcon({ status }: { status: CapabilityStatus | undefined }) {
  if (status === 'verified')
    return <CircleCheck size={16} className={styles.verified} aria-hidden="true" />;
  if (status === 'failed' || status === 'unsupported')
    return <CircleX size={16} className={styles.failed} aria-hidden="true" />;
  return <CircleDashed size={16} className={styles.unknown} aria-hidden="true" />;
}

export function CapabilityStatusText({
  status,
  message,
}: {
  status: CapabilityStatus | undefined;
  message?: string;
}) {
  const t = useT();
  const locale = useLocale();
  const label = capabilityStatusLabel(status, locale);
  return (
    <span className={styles.status}>
      <StatusIcon status={status} />
      <span>
        {message && status !== 'verified'
          ? t('options.check.statusWithMessage', { status: label, message })
          : label}
      </span>
    </span>
  );
}

/** 文本草稿：未编辑时跟随快照值，编辑后保留本地值直到保存或放弃。 */
export interface Draft {
  value: string;
  dirty: boolean;
}

export function draftValue(draft: Draft, external: string): string {
  return draft.dirty ? draft.value : external;
}

/** 凭证保存位置说明。storage 为 none 表示只在后台内存中，随时可能丢失。 */
export function credentialStorageText(
  storage: 'none' | 'session' | 'local',
  locale: Locale = 'zh-CN',
): string {
  switch (storage) {
    case 'local':
      return translate(locale, 'options.connection.storageLocal');
    case 'session':
      return translate(locale, 'options.connection.storageSession');
    case 'none':
      return translate(locale, 'options.connection.storageNone');
  }
}

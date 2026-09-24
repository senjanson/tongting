/**
 * 布局与反馈组件：品牌、状态胶囊、标签页、提示、空状态、分组、横幅、对话框。
 */
import {
  CircleAlert,
  CircleCheck,
  FlaskConical,
  Info,
  TriangleAlert,
  WifiOff,
  X,
} from 'lucide-react';
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { translate } from '../../i18n';
import { useLocale, useT } from '../../i18n/react';
import type { StatusTone } from '../state/derive';
import { Button, IconButton } from './controls';
import { ToastRegion, useModalToasts } from './toast';
import { cx } from './cx';
import styles from './layout.module.css';

export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cx(styles.mark, className)} aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export function Brand({ note }: { note?: string }) {
  const t = useT();
  return (
    <div className={styles.brand}>
      <BrandMark />
      <div className={styles.brandText}>
        <span className={styles.brandName}>{t('common.brand.name')}</span>
        <span className={styles.brandNote}>{note ?? t('common.brand.note')}</span>
      </div>
    </div>
  );
}

export function StatusPill({ label, tone }: { label: string; tone: StatusTone }) {
  return (
    <span
      className={cx(styles.pill, tone !== 'neutral' && styles[`tone-${tone}`])}
      role="status"
      aria-live="polite"
    >
      <span className={cx(styles.dot, tone === 'busy' && styles.busyDot)} aria-hidden="true" />
      {label}
    </span>
  );
}

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
}

export function tabIds(prefix: string, id: string): { tab: string; panel: string } {
  return { tab: `${prefix}-tab-${id}`, panel: `${prefix}-panel-${id}` };
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  idPrefix,
  label,
}: {
  items: readonly TabItem<T>[];
  value: T;
  onChange(value: T): void;
  idPrefix: string;
  label: string;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const focusTab = (index: number) => {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    onChange(item.id);
    const id = tabIds(idPrefix, item.id).tab;
    Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
      .find((el) => el.id === id)
      ?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = items.findIndex((i) => i.id === value);
    switch (event.key) {
      case 'ArrowRight':
        event.preventDefault();
        focusTab(current + 1);
        break;
      case 'ArrowLeft':
        event.preventDefault();
        focusTab(current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusTab(0);
        break;
      case 'End':
        event.preventDefault();
        focusTab(items.length - 1);
        break;
    }
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={styles.tablist}
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => {
        const ids = tabIds(idPrefix, item.id);
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            id={ids.tab}
            type="button"
            role="tab"
            className={styles.tab}
            aria-selected={selected}
            aria-controls={ids.panel}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
          >
            {item.icon}
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({
  idPrefix,
  id,
  active,
  children,
  className,
}: {
  idPrefix: string;
  id: string;
  active: boolean;
  children: ReactNode;
  className?: string;
}) {
  const ids = tabIds(idPrefix, id);
  return (
    <section
      role="tabpanel"
      id={ids.panel}
      aria-labelledby={ids.tab}
      hidden={!active}
      tabIndex={0}
      className={cx(styles.tabpanel, className)}
    >
      {active ? children : null}
    </section>
  );
}

export type CalloutTone = 'info' | 'warning' | 'danger' | 'success' | 'demo';

const CALLOUT_ICONS: Record<CalloutTone, ReactNode> = {
  info: <Info size={16} aria-hidden="true" />,
  warning: <TriangleAlert size={16} aria-hidden="true" />,
  danger: <CircleAlert size={16} aria-hidden="true" />,
  success: <CircleCheck size={16} aria-hidden="true" />,
  demo: <FlaskConical size={16} aria-hidden="true" />,
};

export function Callout({
  tone = 'info',
  title,
  children,
  actions,
  live,
}: {
  tone?: CalloutTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** 是否作为实时区域播报（错误用 alert）。 */
  live?: boolean;
}) {
  const role = live ? (tone === 'danger' ? 'alert' : 'status') : undefined;
  return (
    <div className={cx(styles.callout, tone !== 'info' && styles[`callout-${tone}`])} role={role}>
      <span className={styles.calloutIcon}>{CALLOUT_ICONS[tone]}</span>
      <div className={styles.calloutBody}>
        {title && <div className={styles.calloutTitle}>{title}</div>}
        {children && <div>{children}</div>}
        {actions && <div className={styles.calloutActions}>{actions}</div>}
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className={styles.empty}>
      {icon && <div className={styles.emptyIcon}>{icon}</div>}
      <div className={styles.emptyTitle}>{title}</div>
      {children && <div>{children}</div>}
      {actions && <div className={styles.emptyActions}>{actions}</div>}
    </div>
  );
}

export function Group({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={cx(styles.group, className)} aria-labelledby={id}>
      <div className={styles.groupHead}>
        <h3 className={styles.groupTitle} id={id}>
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(styles.card, className)}>{children}</div>;
}

/** 中文版本的演示标识（兼容旧引用）；界面请使用 common.demo.label。 */
export const DEMO_LABEL = translate('zh-CN', 'common.demo.label');

export function DemoBanner({ onExit }: { onExit?: () => void }) {
  const t = useT();
  return (
    <div
      className={cx(styles.banner, styles['banner-demo'])}
      role="note"
      aria-label={t('common.demo.aria')}
    >
      <FlaskConical size={14} aria-hidden="true" />
      <span className={styles.bannerText}>{t('common.demo.label')}</span>
      {onExit && (
        <Button size="sm" variant="ghost" onClick={onExit}>
          {t('common.demo.exit')}
        </Button>
      )}
    </div>
  );
}

export function ReconnectBanner({ hasSnapshot }: { hasSnapshot: boolean }) {
  const locale = useLocale();
  return (
    <div className={cx(styles.banner, styles['banner-warning'])} role="status" aria-live="polite">
      <WifiOff size={14} aria-hidden="true" />
      <span className={styles.bannerText}>
        {translate(locale, hasSnapshot ? 'common.reconnect.stale' : 'common.reconnect.connecting')}
      </span>
    </div>
  );
}

export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className={styles.stat}>
      <div className={styles.statLabel}>{label}</div>
      <div className={styles.statValue}>{value}</div>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className={styles.statGrid}>{children}</div>;
}

/**
 * 模态对话框：使用原生 <dialog>，由浏览器负责焦点限制与 Esc；关闭后焦点回到打开前的元素。
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const t = useT();
  useModalToasts(open);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
    const onCancel = (event: Event) => {
      event.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => {
      dialog.removeEventListener('cancel', onCancel);
      if (typeof dialog.close === 'function' && dialog.open) dialog.close();
      else dialog.removeAttribute('open');
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <dialog ref={ref} className={styles.dialog} aria-labelledby={titleId} aria-modal="true">
      <div className={styles.dialogInner}>
        <div className={styles.dialogHead}>
          <h2 className={styles.dialogTitle} id={titleId}>
            {title}
          </h2>
          <IconButton
            label={t('common.close')}
            icon={<X size={16} aria-hidden="true" />}
            bare
            onClick={onClose}
          />
        </div>
        <div className={styles.dialogBody}>{children}</div>
        {footer && <div className={styles.dialogFoot}>{footer}</div>}
      </div>
      <ToastRegion />
    </dialog>
  );
}

export const layoutStyles = styles;

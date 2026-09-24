/**
 * 基础表单控件：按钮、开关、选择、滑块、分段按钮、输入框。
 */
import {
  useId,
  type ButtonHTMLAttributes,
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { cx } from './cx';
import styles from './controls.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  block?: boolean;
  /**
   * 只显示「处理中」（转圈与 aria-busy），不阻止点击：主按钮在命令进行中仍要接受新的意图
   * （例如启动中点「暂停翻译」），不能因 busy 丢掉。不应重复触发的按钮由调用方自行禁用或忽略点击
   * （例如 CheckRunner 在检查进行中忽略重复点击）。
   */
  busy?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  block,
  busy,
  children,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        styles.button,
        variant !== 'secondary' && styles[variant],
        size === 'sm' && styles.sm,
        block && styles.block,
        className,
      )}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <Spinner /> : icon}
      {children !== undefined && <span className={styles.label}>{children}</span>}
    </button>
  );
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  bare?: boolean;
}

export function IconButton({
  label,
  icon,
  pressed,
  bare,
  className,
  type = 'button',
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      className={cx(styles.iconButton, bare && styles.iconBare, className)}
      {...rest}
    >
      {icon}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span
      className={styles.spinner}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    />
  );
}

export function Hint({ children, id, tone }: { children: ReactNode; id?: string; tone?: 'error' }) {
  return (
    <p id={id} className={tone === 'error' ? styles.error : styles.hint}>
      {children}
    </p>
  );
}

export interface SwitchRowProps {
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  description?: ReactNode;
  disabled?: boolean;
}

export function SwitchRow({ label, checked, onChange, description, disabled }: SwitchRowProps) {
  const id = useId();
  return (
    <div className={styles.row}>
      <span className={styles.rowText}>
        <label htmlFor={id}>{label}</label>
        {description && (
          <span className={styles.hint} id={`${id}-desc`}>
            {description}
          </span>
        )}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        className={styles.switch}
        checked={checked}
        disabled={disabled}
        aria-describedby={description ? `${id}-desc` : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
    </div>
  );
}

export interface CheckboxProps {
  label: ReactNode;
  checked: boolean;
  onChange(checked: boolean): void;
  disabled?: boolean;
}

export function Checkbox({ label, checked, onChange, disabled }: CheckboxProps) {
  return (
    <label className={styles.checkbox}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectFieldProps<T extends string> {
  label: ReactNode;
  value: T;
  options: readonly SelectOption<T>[];
  onChange(value: T): void;
  disabled?: boolean;
  hint?: ReactNode;
  /** 行内布局：标签在左，选择框在右。 */
  inline?: boolean;
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  hint,
  inline,
}: SelectFieldProps<T>) {
  const id = useId();
  const select = (
    <select
      id={id}
      className={styles.select}
      value={value}
      disabled={disabled}
      aria-describedby={hint ? `${id}-hint` : undefined}
      onChange={(e) => onChange(e.currentTarget.value as T)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (inline) {
    return (
      <div className={styles.field}>
        <div className={styles.row}>
          <label htmlFor={id}>{label}</label>
          <span className={styles.rowControl}>{select}</span>
        </div>
        {hint && <Hint id={`${id}-hint`}>{hint}</Hint>}
      </div>
    );
  }
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      {select}
      {hint && <Hint id={`${id}-hint`}>{hint}</Hint>}
    </div>
  );
}

export interface RangeFieldProps {
  label: ReactNode;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange(value: number): void;
  format(value: number): string;
  disabled?: boolean;
  hint?: ReactNode;
}

export function RangeField({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  disabled,
  hint,
}: RangeFieldProps) {
  const id = useId();
  return (
    <div className={styles.range}>
      <div className={styles.rangeHead}>
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id}>{format(value)}</output>
      </div>
      <input
        id={id}
        type="range"
        className={styles.rangeInput}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-valuetext={format(value)}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
      />
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  disabled?: boolean;
}

export interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange(value: T): void;
  disabled?: boolean;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: SegmentedProps<T>) {
  return (
    <div role="group" aria-label={label} className={styles.segments}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={styles.segment}
          aria-pressed={o.value === value}
          disabled={disabled || o.disabled}
          onClick={() => onChange(o.value)}
        >
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'onChange' | 'value'
> {
  label: ReactNode;
  value: string;
  onChange(value: string): void;
  hint?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
}

export function TextField({
  label,
  value,
  onChange,
  hint,
  error,
  trailing,
  id: idProp,
  className,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const describedBy =
    [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cx(styles.field, className)}>
      <label htmlFor={id} className={styles.fieldLabel}>
        {label}
      </label>
      <div style={{ display: 'flex', gap: 6, minWidth: 0 }}>
        <input
          id={id}
          className={cx(styles.input, error ? styles.inputInvalid : undefined)}
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onChange(e.currentTarget.value)}
          {...rest}
        />
        {trailing}
      </div>
      {hint && <Hint id={`${id}-hint`}>{hint}</Hint>}
      {error && (
        <Hint id={`${id}-error`} tone="error">
          {error}
        </Hint>
      )}
    </div>
  );
}

export function TextArea({ className, ...rest }: ComponentProps<'textarea'>) {
  return <textarea className={cx(styles.textarea, className)} {...rest} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className={styles.kbd}>{children}</kbd>;
}

export const controlStyles = styles;

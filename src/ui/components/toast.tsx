/**
 * 轻量通知：role=status 实时区域，自动消失，可手动关闭。
 *
 * 模态对话框打开时，页面其余部分（含根部提示区域）被浏览器置为惰性且在 top layer 之下，
 * 因此对话框内部渲染自己的提示区域，根部区域暂时隐藏，避免提示不可见或重复播报。
 */
import { X } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useT } from '../../i18n/react';
import { IconButton } from './controls';
import { cx } from './cx';
import styles from './layout.module.css';

export type ToastTone = 'info' | 'success' | 'warning' | 'danger';

interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
}

type Notify = (message: string, tone?: ToastTone) => void;

interface ToastContextValue {
  notify: Notify;
  items: readonly ToastItem[];
  dismiss(id: number): void;
  /** 模态对话框打开时调用，返回关闭时的回调。 */
  enterModal(): () => void;
  modalOpen: boolean;
}

const noop = () => undefined;
const ToastContext = createContext<ToastContextValue>({
  notify: noop,
  items: [],
  dismiss: noop,
  enterModal: () => noop,
  modalOpen: false,
});

const MAX_TOASTS = 3;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const [modalCount, setModalCount] = useState(0);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<Notify>(
    (message, tone = 'info') => {
      const id = nextId.current++;
      setItems((list) => {
        // 相同文案不重复堆叠
        const filtered = list.filter((t) => t.message !== message);
        return [...filtered, { id, message, tone }].slice(-MAX_TOASTS);
      });
      const timer = setTimeout(
        () => dismiss(id),
        tone === 'danger' || tone === 'warning' ? 9_000 : 4_500,
      );
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const enterModal = useCallback(() => {
    setModalCount((n) => n + 1);
    let left = false;
    return () => {
      if (left) return;
      left = true;
      setModalCount((n) => Math.max(0, n - 1));
    };
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const timer of map.values()) clearTimeout(timer);
      map.clear();
    };
  }, []);

  const value = useMemo<ToastContextValue>(
    () => ({ notify, items, dismiss, enterModal, modalOpen: modalCount > 0 }),
    [notify, items, dismiss, enterModal, modalCount],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {modalCount === 0 && <ToastRegion />}
    </ToastContext.Provider>
  );
}

/** 提示列表（根部或对话框内部）。 */
export function ToastRegion() {
  const { items, dismiss } = useContext(ToastContext);
  const t = useT();
  return (
    <div className={styles.toasts} role="status" aria-live="polite">
      {items.map((item) => (
        <div
          key={item.id}
          className={cx(styles.toast, item.tone !== 'info' && styles[`toast-${item.tone}`])}
        >
          <span className={styles.toastText}>{item.message}</span>
          <IconButton
            bare
            label={t('common.toast.dismiss')}
            icon={<X size={14} aria-hidden="true" />}
            onClick={() => dismiss(item.id)}
          />
        </div>
      ))}
    </div>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext).notify;
}

/** 对话框打开期间把提示区域移入对话框内部。 */
export function useModalToasts(open: boolean): void {
  const { enterModal } = useContext(ToastContext);
  useEffect(() => (open ? enterModal() : undefined), [open, enterModal]);
}

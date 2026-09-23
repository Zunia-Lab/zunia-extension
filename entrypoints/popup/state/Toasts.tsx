import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Toast } from "@zunialab/ui";

export type ToastTone = "success" | "danger" | "neutral";

export interface ToastOptions {
  tone?: ToastTone;
  /** Short detail on the right, for example a truncated hash. */
  meta?: string;
}

type ShowToast = (title: string, options?: ToastOptions) => void;

interface ToastEntry {
  id: number;
  title: string;
  meta?: string;
  tone: ToastTone;
}

const MAX_TOASTS = 3;
const TOAST_MS = 2400;
const DANGER_TOAST_MS = 5000;

const ToastContext = createContext<ShowToast>(() => {});

/**
 * Short confirmations ("Address copied", "Transaction sent") stacked above the
 * bottom navigation. The container stays mounted as a polite live region so
 * screen readers announce each toast as it arrives; errors use the assertive
 * alert role instead.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
  }, []);

  const show = useCallback<ShowToast>(
    (title, options = {}) => {
      nextId.current += 1;
      const id = nextId.current;
      const tone = options.tone ?? "success";
      setToasts((list) =>
        [
          ...list.filter((toast) => toast.title !== title),
          { id, title, meta: options.meta, tone },
        ].slice(-MAX_TOASTS),
      );
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), tone === "danger" ? DANGER_TOAST_MS : TOAST_MS),
      );
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-3 bottom-[76px] z-[60] flex flex-col items-stretch gap-2"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="animate-[z-rise_var(--z-duration-base)_var(--z-ease)]"
          >
            <Toast title={toast.title} meta={toast.meta} tone={toast.tone} />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** Show a toast: `toast("Address copied")`, `toast("Could not send", { tone: "danger" })`. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

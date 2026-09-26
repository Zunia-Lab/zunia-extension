import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Toast, truncateAddress } from "@zunialab/ui";
import { showBrowserAlert } from "../../../lib/browser-alerts";

export type ToastTone = "success" | "danger" | "warning" | "neutral";

export interface ToastOptions {
  tone?: ToastTone;
  /** Short detail on the right, for example a truncated hash. */
  meta?: string;
  /** Second line. Auto-dismisses with the toast. */
  detail?: string;
  /**
   * Also raise a browser notification when alerts are on.
   * Defaults on for danger and warning.
   */
  alert?: boolean;
}

type ShowToast = (title: string, options?: ToastOptions) => void;

interface ToastEntry {
  id: number;
  title: string;
  meta?: string;
  detail?: string;
  tone: ToastTone;
}

const MAX_TOASTS = 3;
const TOAST_MS = 2800;
const DETAIL_TOAST_MS = 4800;
const DANGER_TOAST_MS = 5600;

const ToastContext = createContext<ShowToast>(() => {});

function shouldAlert(tone: ToastTone, alert: boolean | undefined): boolean {
  if (alert === true) return true;
  if (alert === false) return false;
  return tone === "danger" || tone === "warning";
}

/**
 * Short confirmations stacked above the bottom navigation. Portaled onto
 * `document.body` so `overflow: hidden` on the popup shell cannot clip them.
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
          { id, title, meta: options.meta, detail: options.detail, tone },
        ].slice(-MAX_TOASTS),
      );
      const hold =
        tone === "danger" || tone === "warning"
          ? DANGER_TOAST_MS
          : options.detail
            ? DETAIL_TOAST_MS
            : TOAST_MS;
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), hold),
      );
      if (shouldAlert(tone, options.alert)) {
        void showBrowserAlert(
          `zunia-toast-${id}`,
          title,
          [options.detail, options.meta].filter(Boolean).join(" · ") || title,
        );
      }
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

  const stack =
    typeof document === "undefined"
      ? null
      : createPortal(
          <div
            aria-live="polite"
            className="pointer-events-none fixed inset-x-3 bottom-[76px] z-[200] flex flex-col items-stretch gap-2"
          >
            {toasts.map((toast) => (
              <div
                key={toast.id}
                className="pointer-events-auto animate-[z-rise_var(--z-duration-base)_var(--z-ease)]"
              >
                <Toast
                  title={toast.title}
                  meta={toast.meta}
                  detail={toast.detail}
                  tone={toast.tone}
                />
              </div>
            ))}
          </div>,
          document.body,
        );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {stack}
    </ToastContext.Provider>
  );
}

/** Show a toast: `toast("Address copied")`, `toast("Could not send", { tone: "danger" })`. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}

/** Broadcast accepted by the node. Not a page banner; inclusion is still pending. */
export function notifyBroadcastAccepted(toast: ShowToast, txHash: string): void {
  toast("Broadcast accepted", {
    meta: truncateAddress(txHash, 10, 8),
    detail: "Inclusion still depends on the network.",
    alert: true,
  });
}

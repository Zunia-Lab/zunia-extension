import { useCallback, useEffect, useRef } from "react";

export const SENSITIVE_CLIPBOARD_MS = 30_000;

export const SENSITIVE_CLIPBOARD_NOTE =
  "Copied. Zunia clears the clipboard after 30 seconds, or when you leave this screen, as long as this window stays open.";

/**
 * Copies text that must not linger and overwrites the clipboard after
 * SENSITIVE_CLIPBOARD_MS or when the screen unmounts, whichever comes first.
 *
 * Browsers only allow the write while the document has focus, so a timer that
 * fires while another window is focused retries on the next focus. Nothing
 * runs once the page is gone: closing the popup early leaves the clipboard as
 * it is, which is why the UI copy says so. The overwrite is unconditional
 * because reading the clipboard back would need the clipboardRead permission.
 */
export function useSensitiveClipboard(): (text: string) => Promise<void> {
  const state = useRef({ armed: false, due: false, timer: 0 });

  const wipe = useCallback(async () => {
    const current = state.current;
    if (!current.armed) return;
    try {
      await navigator.clipboard.writeText("");
      current.armed = false;
      current.due = false;
    } catch {
      current.due = true;
    }
  }, []);

  useEffect(() => {
    const current = state.current;
    const onFocus = () => {
      if (current.due) void wipe();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearTimeout(current.timer);
      void wipe();
    };
  }, [wipe]);

  return useCallback(
    async (text: string) => {
      const current = state.current;
      await navigator.clipboard.writeText(text);
      current.armed = true;
      current.due = false;
      window.clearTimeout(current.timer);
      current.timer = window.setTimeout(() => {
        current.due = true;
        void wipe();
      }, SENSITIVE_CLIPBOARD_MS);
    },
    [wipe],
  );
}

import { useCallback, useEffect, useState } from "react";

import {
  dropNotificationPermission,
  hasNotificationPermission,
  requestNotificationPermission,
} from "../../../lib/browser-alerts";
import { usePrefs } from "../state/Prefs";

const BROWSER_ALERTS_NOTE =
  "A notification when a cross-chain transfer or swap settles, even with Zunia closed.";

/** Safari gives extensions no notifications API, so the Safari build does not ask for it. */
const ALERTS_SUPPORTED = import.meta.env.BROWSER !== "safari";

/**
 * The browser alerts switch: on only while the setting is on and the browser
 * grants `notifications`. Turning it on asks for the permission first, so a
 * refusal leaves the switch off with the reason instead of a switch that lies.
 */
export function useBrowserAlerts(): {
  checked: boolean;
  disabled: boolean;
  description: string;
  toggle: (next: boolean) => Promise<void>;
} {
  const { settings, update } = usePrefs();
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ALERTS_SUPPORTED) void hasNotificationPermission().then(setGranted);
  }, []);

  const toggle = useCallback(
    async (next: boolean) => {
      if (!next) {
        setError(null);
        await update({ browserAlerts: false });
        await dropNotificationPermission();
        setGranted(false);
        return;
      }
      // Asked before anything else is awaited, while the click still counts
      // as the user's action. It resolves at once when already granted.
      const ok = await requestNotificationPermission();
      if (!ok) {
        setError("The browser did not allow notifications, so alerts stay off.");
        return;
      }
      setError(null);
      setGranted(true);
      await update({ browserAlerts: true });
    },
    [update],
  );

  if (!ALERTS_SUPPORTED) {
    return {
      checked: false,
      disabled: true,
      description: "Safari does not let extensions show notifications.",
      toggle,
    };
  }
  return {
    checked: settings.browserAlerts && granted,
    disabled: false,
    description: error ?? BROWSER_ALERTS_NOTE,
    toggle,
  };
}

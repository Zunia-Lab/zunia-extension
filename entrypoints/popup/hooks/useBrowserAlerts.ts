import { useCallback, useEffect, useState } from "react";

import {
  dropNotificationPermission,
  hasNotificationPermission,
  requestNotificationPermission,
} from "../../../lib/browser-alerts";
import { usePrefs } from "../state/Prefs";

export const BROWSER_ALERTS_NOTE =
  "A notification when a cross-chain transfer or swap settles, even with Zunia closed.";

/**
 * The browser alerts switch: on only while the setting is on and the browser
 * grants `notifications`. Turning it on asks for the permission first, so a
 * refusal leaves the switch off with the reason instead of a switch that lies.
 */
export function useBrowserAlerts(): {
  checked: boolean;
  toggle: (next: boolean) => Promise<void>;
  error: string | null;
} {
  const { settings, update } = usePrefs();
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void hasNotificationPermission().then(setGranted);
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

  return { checked: settings.browserAlerts && granted, toggle, error };
}

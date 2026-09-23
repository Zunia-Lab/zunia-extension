/**
 * Browser notifications, behind an optional permission.
 *
 * `notifications` is an optional manifest permission: it is requested when the
 * user turns browser alerts on, never at install, and the setting only counts
 * while the browser still grants it.
 */

import { getSettings } from "./settings";

export async function hasNotificationPermission(): Promise<boolean> {
  try {
    return await browser.permissions.contains({ permissions: ["notifications"] });
  } catch {
    return false;
  }
}

/**
 * Ask for the permission. Call it first thing in the click handler: Firefox
 * only shows the prompt while the click is still the current user action.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  try {
    return await browser.permissions.request({ permissions: ["notifications"] });
  } catch {
    return false;
  }
}

export async function dropNotificationPermission(): Promise<void> {
  try {
    await browser.permissions.remove({ permissions: ["notifications"] });
  } catch {
    // Already gone, or this browser does not let an extension give it back.
  }
}

/** Show one notification when alerts are on and allowed. Never throws. */
export async function showBrowserAlert(
  id: string,
  title: string,
  message: string,
): Promise<boolean> {
  try {
    const settings = await getSettings();
    if (!settings.browserAlerts || !(await hasNotificationPermission())) return false;
    await browser.notifications.create(id, {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/128.png"),
      title,
      message,
    });
    return true;
  } catch {
    return false;
  }
}

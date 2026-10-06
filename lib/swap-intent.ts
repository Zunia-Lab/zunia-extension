/**
 * The swap a user set out to make when its tokens first had to move to
 * Osmosis (lib/swap-path.ts `move-first`).
 *
 * Swap sends them to Send to move the tokens, and the Swap screen is gone by
 * the time they come back. This keeps the pair, the Osmosis row the tokens
 * will arrive as and the To, so Swap opens on it again: the From picked as the
 * Osmosis balance (once that balance has been read), the To as it was. Only
 * two row keys are kept, nothing that signs; in chrome.storage.session for an
 * hour, and read once.
 */

import { STORAGE_KEYS } from "./storage-keys";

/** The two rows Swap opens on. */
export interface SwapIntent {
  /** `${chainId}:${denom}` of the From row once the tokens are on Osmosis. */
  readonly fromKey: string;
  /** `${chainId}:${denom}` of the To row. */
  readonly toKey: string;
}

/** Long enough for any transfer to Osmosis to arrive; older, the user has moved on. */
export const SWAP_INTENT_TTL_MS = 60 * 60_000;

function sessionArea() {
  try {
    return browser.storage?.session;
  } catch {
    return undefined;
  }
}

/** Remember the pair. Best effort: without session storage Swap just opens as usual. */
export async function rememberSwapIntent(intent: SwapIntent, now: number = Date.now()): Promise<void> {
  const area = sessionArea();
  if (!area) return;
  try {
    await area.set({ [STORAGE_KEYS.swapIntent]: { ...intent, at: now } });
  } catch {
    // Nothing to keep it in.
  }
}

/** The pair, once: reading it forgets it. `null` when there is none, or it is over an hour old. */
export async function takeSwapIntent(now: number = Date.now()): Promise<SwapIntent | null> {
  const area = sessionArea();
  if (!area) return null;
  try {
    const stored = (await area.get(STORAGE_KEYS.swapIntent))[STORAGE_KEYS.swapIntent];
    await area.remove(STORAGE_KEYS.swapIntent);
    if (typeof stored !== "object" || stored === null) return null;
    const { fromKey, toKey, at } = stored as Record<string, unknown>;
    if (typeof fromKey !== "string" || typeof toKey !== "string" || typeof at !== "number") return null;
    if (now - at > SWAP_INTENT_TTL_MS || now < at) return null;
    return { fromKey, toKey };
  } catch {
    return null;
  }
}

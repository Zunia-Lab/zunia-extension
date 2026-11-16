/**
 * Keeping a balance honest after a transaction.
 *
 * A swap changes balances at two moments the screen cannot predict: the
 * source chain the moment the transaction is included, and, for a route that
 * crosses chains, the destination whenever a relayer delivers the packet. The
 * chain is the only authority on both, so the screen reads it again until the
 * answer differs from what it showed when the swap was signed, and gives up
 * after a bounded time rather than reading for ever.
 *
 * Pure of the browser: the read and the clock are passed in, so the loop is
 * tested without a chain or a timer.
 */

import type { ChainBalance } from "./balances";

/** Between two reads of the source chain: about a block, so inclusion shows within one. */
export const SOURCE_WATCH_INTERVAL_MS = 4_000;
/** A transaction not in a block after this long has been dropped. */
export const SOURCE_WATCH_MAX_MS = 90_000;
/** Between two reads of the destination chain: a relayer is not faster. */
export const DEST_WATCH_INTERVAL_MS = 8_000;
/** Long enough for a packet-forward route; past it the tracker's end is the last read. */
export const DEST_WATCH_MAX_MS = 180_000;

/**
 * What a chain's balance reads as, in one string: the chain's own coin and
 * every bank denom with its amount. Two rows with the same fingerprint show
 * the same numbers. `null` for no row and for a row whose read failed, which
 * says nothing about what the account holds.
 */
export function balanceFingerprint(row: ChainBalance | null | undefined): string | null {
  if (!row || row.error) return null;
  const coins = row.tokens
    .map((token) => `${token.denom}=${token.amount}`)
    .sort()
    .join(",");
  return `${row.available}|${coins}`;
}

/** How a {@link watchForChange} ended. */
export type WatchEnd = "changed" | "settled" | "timeout" | "aborted";

export interface WatchOptions {
  /** The fingerprint of the chain right now, or `null` when it could not be read. */
  readonly read: () => Promise<string | null>;
  /**
   * The fingerprint the screen showed when the swap was signed. `null` when
   * it showed none: the first answer then becomes the baseline.
   */
  readonly baseline: string | null;
  /** True once the route's tracker has nothing left to report. */
  readonly settled: () => boolean;
  readonly signal: AbortSignal;
  readonly intervalMs?: number;
  readonly maxMs?: number;
  /** Resolves after `ms`, or at once when the signal aborts. Defaults to a timer. */
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly now?: () => number;
}

function timerWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });
}

/**
 * Read a chain on an interval until its balance differs from the baseline,
 * the route settles, the time is up or the caller aborts. The read itself is
 * what updates the screen (it goes through the worker, which pushes every
 * answer to the open popup); this only decides when to stop asking.
 */
export async function watchForChange(options: WatchOptions): Promise<WatchEnd> {
  const intervalMs = options.intervalMs ?? DEST_WATCH_INTERVAL_MS;
  const maxMs = options.maxMs ?? DEST_WATCH_MAX_MS;
  const wait = options.wait ?? timerWait;
  const now = options.now ?? Date.now;
  const startedAt = now();
  let baseline = options.baseline;

  while (now() - startedAt < maxMs) {
    await wait(intervalMs, options.signal);
    if (options.signal.aborted) return "aborted";
    // The tracker's end triggers its own last read; asking again here would
    // only repeat it.
    if (options.settled()) return "settled";
    const current = await options.read();
    if (options.signal.aborted) return "aborted";
    if (current === null) continue;
    if (baseline === null) baseline = current;
    else if (current !== baseline) return "changed";
  }
  return "timeout";
}

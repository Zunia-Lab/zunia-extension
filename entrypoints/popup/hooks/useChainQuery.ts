import { useCallback, useEffect, useState } from "react";
import {
  MAX_ACTIVITY_LIMIT,
  type ActivityItem,
  type DelegationInfo,
  type ProposalInfo,
  type TxDetailInfo,
  type UnbondingInfo,
  type ValidatorInfo,
} from "../../../lib/chain-queries";
import type { ExtensionMessageType } from "../../../lib/messaging";
import { sendToBackground } from "../../../lib/popup-client";

interface QueryState<T> {
  rows: T[];
  loading: boolean;
  reload: () => void;
}

/** Stable identity for "nothing settled yet", so consumers do not see a new
 *  array on every render while a query is in flight. */
const NO_ROWS: never[] = [];

/**
 * Shared plumbing for the read-only chain queries. Returns an empty list when
 * the user has not opted into network reads, so screens fall back to their
 * "reads are off" state instead of spinning forever.
 */
function useQuery<T>(
  type: ExtensionMessageType,
  payload: Record<string, unknown>,
  enabled: boolean,
  key: string,
): QueryState<T> {
  // Identity of the data this hook is meant to be showing. `enabled` is folded
  // in so that switching network reads off invalidates the rows by derivation,
  // rather than by an effect writing [] on the render after the switch flips.
  const cacheKey = `${enabled ? "on" : "off"}:${key}`;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    cacheKey: string;
    attempt: number;
    rows: T[];
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    sendToBackground<T[]>(type, payload)
      .then((data) => {
        if (!cancelled) setSettled({ cacheKey, attempt, rows: data ?? [] });
      })
      .catch(() => {
        if (!cancelled) setSettled({ cacheKey, attempt, rows: [] });
      });
    return () => {
      cancelled = true;
    };
    // payload is rebuilt every render upstream; cacheKey stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, enabled, cacheKey, attempt]);

  const current = settled?.cacheKey === cacheKey ? settled : null;
  // Both derived rather than stored: the previous chain's rows must not read as
  // settled on the render that switches chains, and a stored `loading` needs a
  // setState inside the effect to say so: a cascading render on every switch.
  const rows: T[] = current ? current.rows : NO_ROWS;
  const loading = enabled && (current === null || current.attempt !== attempt);

  const reload = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  return { rows, loading, reload };
}

export function useValidators(chainId: string, enabled: boolean) {
  return useQuery<ValidatorInfo>(
    "GET_VALIDATORS",
    { chainId },
    enabled && Boolean(chainId),
    chainId,
  );
}

export function useDelegations(chainIds: string[], enabled: boolean) {
  return useQuery<DelegationInfo>(
    "GET_DELEGATIONS",
    { chainIds },
    enabled && chainIds.length > 0,
    chainIds.join(","),
  );
}

export function useUnbonding(chainIds: string[], enabled: boolean) {
  return useQuery<UnbondingInfo>(
    "GET_UNBONDING",
    { chainIds },
    enabled && chainIds.length > 0,
    chainIds.join(","),
  );
}

export function useProposals(chainIds: string[], enabled: boolean) {
  return useQuery<ProposalInfo>(
    "GET_PROPOSALS",
    { chainIds },
    enabled && chainIds.length > 0,
    chainIds.join(","),
  );
}

export function useActivity(chainIds: string[], enabled: boolean) {
  return useQuery<ActivityItem>(
    "GET_ACTIVITY",
    { chainIds },
    enabled && chainIds.length > 0,
    chainIds.join(","),
  );
}

/** How often the history is read again while it is on screen. */
export const ACTIVITY_REFRESH_MS = 15_000;
/** Focus and visibility often fire together; one read covers both. */
const MIN_REFRESH_GAP_MS = 2_000;

/**
 * Call `refresh` every `intervalMs` while the page is visible, and at once
 * when it comes back into view or regains focus.
 */
export function useLiveRefresh(
  refresh: () => void,
  active: boolean,
  intervalMs = ACTIVITY_REFRESH_MS,
): void {
  useEffect(() => {
    if (!active) return;
    let last = Date.now();
    const run = () => {
      last = Date.now();
      refresh();
    };
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") run();
    }, intervalMs);
    const onReturn = () => {
      if (document.visibilityState === "visible" && Date.now() - last >= MIN_REFRESH_GAP_MS) {
        run();
      }
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [refresh, active, intervalMs]);
}

interface ActivityPage {
  key: string;
  limit: number;
  attempt: number;
  rows: ActivityItem[];
}

/**
 * The history screen's feed: `limit` rows per chain, read again on `refresh`.
 *
 * Rows already on screen stay while a refresh or a bigger page loads, and a
 * chain whose read fails keeps its previous rows rather than dropping out of
 * the list until the next read.
 */
export function useActivityFeed(chainIds: string[], enabled: boolean, limit: number) {
  const on = enabled && chainIds.length > 0;
  const key = `${on ? "on" : "off"}:${chainIds.join(",")}`;
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState<ActivityPage | null>(null);

  useEffect(() => {
    if (!on) return;
    let cancelled = false;
    sendToBackground<{ rows: ActivityItem[]; failed: string[] }>("GET_ACTIVITY_FEED", {
      chainIds,
      limit,
    })
      .then((data) => {
        if (cancelled) return;
        const failed = new Set(data?.failed ?? []);
        setPage((previous) => {
          const kept =
            previous?.key === key ? previous.rows.filter((row) => failed.has(row.chainId)) : [];
          const rows = [...(data?.rows ?? []), ...kept].sort((a, b) => b.timestamp - a.timestamp);
          return { key, limit, attempt, rows };
        });
      })
      .catch(() => {
        if (cancelled) return;
        setPage((previous) =>
          previous?.key === key
            ? { ...previous, limit, attempt }
            : { key, limit, attempt, rows: [] },
        );
      });
    return () => {
      cancelled = true;
    };
    // chainIds is rebuilt upstream on every render; key stands in for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, key, limit, attempt]);

  const current = page?.key === key ? page : null;
  const rows: ActivityItem[] = current ? current.rows : NO_ROWS;
  const loading = on && (current === null || current.attempt !== attempt || current.limit !== limit);
  const perChain = new Map<string, number>();
  for (const row of rows) perChain.set(row.chainId, (perChain.get(row.chainId) ?? 0) + 1);
  const fullest = Math.max(0, ...perChain.values());

  return {
    rows,
    loading,
    /** A bigger page is on its way; the rows shown are the previous page. */
    loadingMore: loading && current !== null && current.limit < limit,
    /** Some chain filled its page, so a bigger one may hold more. */
    hasMore: current !== null && current.limit < MAX_ACTIVITY_LIMIT && fullest >= current.limit,
    refresh: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

/** Seconds between reads of a transaction the node has not indexed yet. */
const TX_RETRY_MS = 6_000;
/** About two minutes; past that the node has most likely pruned it. */
const MAX_TX_RETRIES = 20;

/**
 * One transaction's detail. A transaction the node does not know yet, as
 * right after a broadcast, is asked for again until it shows up.
 */
export function useTxDetail(
  chainId: string,
  hash: string,
  enabled: boolean,
  options?: { intervalMs?: number; maxRetries?: number },
) {
  const key = `${enabled ? "on" : "off"}:${chainId}:${hash}`;
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{
    key: string;
    attempt: number;
    detail: TxDetailInfo | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    sendToBackground<TxDetailInfo | null>("GET_TX_DETAIL", { chainId, hash })
      .then((detail) => {
        if (!cancelled) setSettled({ key, attempt, detail: detail ?? null, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSettled((previous) => ({
          key,
          attempt,
          detail: previous?.key === key ? previous.detail : null,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, key, chainId, hash, attempt]);

  const current = settled?.key === key ? settled : null;
  const missing = enabled && current !== null && current.detail === null && current.error === null;

  const intervalMs = options?.intervalMs ?? TX_RETRY_MS;
  const maxRetries = options?.maxRetries ?? MAX_TX_RETRIES;
  const retrying = missing && (current?.attempt ?? 0) < maxRetries;
  useEffect(() => {
    if (!retrying) return;
    const timer = window.setTimeout(() => setAttempt((n) => n + 1), intervalMs);
    return () => window.clearTimeout(timer);
  }, [retrying, current?.attempt, intervalMs]);

  return {
    detail: current?.detail ?? null,
    error: current?.error ?? null,
    loading: enabled && (current === null || current.attempt !== attempt),
    /** The node answered and does not have it, yet. */
    missing,
    /** Still asking again on its own. */
    retrying,
    reload: useCallback(() => setAttempt((n) => n + 1), []),
  };
}

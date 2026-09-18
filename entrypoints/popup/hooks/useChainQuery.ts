import { useCallback, useEffect, useState } from "react";
import type {
  ActivityItem,
  DelegationInfo,
  ProposalInfo,
  UnbondingInfo,
  ValidatorInfo,
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
  // setState inside the effect to say so — a cascading render on every switch.
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

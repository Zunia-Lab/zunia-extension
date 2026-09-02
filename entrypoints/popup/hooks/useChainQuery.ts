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
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(() => {
    if (!enabled) {
      setRows([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    sendToBackground<T[]>(type, payload)
      .then((data) => {
        if (!cancelled) setRows(data ?? []);
      })
      .catch(() => {
        if (!cancelled) setRows([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // payload is rebuilt every render upstream; key keeps this stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, enabled, key]);

  useEffect(() => {
    reload();
  }, [reload]);

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

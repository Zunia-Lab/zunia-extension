import { useCallback, useEffect, useState } from "react";
import { sendToBackground } from "../../../lib/popup-client";
import type { SessionStatus } from "../../../lib/session";
import type { ExtensionSettings } from "../../../lib/settings";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { OriginGrant } from "../../../lib/permissions";

interface ExtensionSnapshot {
  attempt: number;
  status: SessionStatus | null;
  settings: ExtensionSettings | null;
  approvals: ApprovalRequest[];
  grants: OriginGrant[];
}

/** Stable identities so a pre-first-load render does not churn consumers. */
const NO_APPROVALS: ApprovalRequest[] = [];
const NO_GRANTS: OriginGrant[] = [];

export function useExtensionState() {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<ExtensionSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      sendToBackground<SessionStatus>("GET_STATUS"),
      sendToBackground<ExtensionSettings>("GET_SETTINGS"),
      sendToBackground<ApprovalRequest[]>("GET_PENDING_APPROVALS"),
      sendToBackground<OriginGrant[]>("LIST_PERMISSIONS"),
    ])
      .then(([status, settings, approvals, grants]) => {
        if (cancelled) return;
        setError(null);
        setSnapshot({ attempt, status, settings, approvals, grants });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        // Settle the attempt even on failure, so the shell leaves the "Opening
        // wallet…" boot screen and the user sees the error instead of a
        // spinner that never resolves.
        setSnapshot((prev) => ({
          attempt,
          status: prev?.status ?? null,
          settings: prev?.settings ?? null,
          approvals: prev?.approvals ?? NO_APPROVALS,
          grants: prev?.grants ?? NO_GRANTS,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const refresh = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // Derived, not stored: a refresh is in flight for exactly as long as the
  // snapshot lags the attempt that asked for it. Storing it needs setLoading in
  // the effect body, which re-renders every screen a second time on each load.
  const loading = snapshot === null || snapshot.attempt !== attempt;

  return {
    status: snapshot?.status ?? null,
    settings: snapshot?.settings ?? null,
    approvals: snapshot?.approvals ?? NO_APPROVALS,
    grants: snapshot?.grants ?? NO_GRANTS,
    error,
    loading,
    refresh,
    setError,
  };
}

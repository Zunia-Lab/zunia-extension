import { useCallback, useEffect, useState } from "react";
import { sendToBackground } from "../../../lib/popup-client";
import type { SessionStatus } from "../../../lib/session";
import type { ExtensionSettings } from "../../../lib/settings";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { OriginGrant } from "../../../lib/permissions";

export function useExtensionState() {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [settings, setSettingsState] = useState<ExtensionSettings | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [grants, setGrants] = useState<OriginGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextStatus, nextSettings, nextApprovals, nextGrants] =
        await Promise.all([
          sendToBackground<SessionStatus>("GET_STATUS"),
          sendToBackground<ExtensionSettings>("GET_SETTINGS"),
          sendToBackground<ApprovalRequest[]>("GET_PENDING_APPROVALS"),
          sendToBackground<OriginGrant[]>("LIST_PERMISSIONS"),
        ]);
      setStatus(nextStatus);
      setSettingsState(nextSettings);
      setApprovals(nextApprovals);
      setGrants(nextGrants);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    status,
    settings,
    approvals,
    grants,
    error,
    loading,
    refresh,
    setError,
  };
}

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { ChainBalance } from "../../../lib/balances";
import type {
  ActivityItem,
  ProposalInfo,
  UnbondingInfo,
} from "../../../lib/chain-queries";
import { formatUnits } from "../../../lib/format";
import { STORAGE_KEYS } from "../../../lib/storage-keys";

export type NoticeKind =
  | "approval"
  | "transfer"
  | "rewards"
  | "unbonding"
  | "governance";

export interface Notice {
  id: string;
  kind: NoticeKind;
  title: string;
  meta: string;
  /** Route the row opens, when there is somewhere useful to go. */
  target?: { route: "approve" | "earn" | "governance" | "chain"; chainId?: string };
  timestamp: number;
  read: boolean;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function daysLeft(iso?: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 86_400_000);
}

/**
 * Derives the notification feed from what the wallet already knows: pending
 * approvals, claimable rewards, finished unbondings, incoming transfers and
 * governance deadlines. Nothing is pushed from a server.
 */
export function useNotifications({
  approvals,
  balances,
  chainNames,
  activity,
  proposals,
  unbonding,
}: {
  approvals: ApprovalRequest[];
  balances: Record<string, ChainBalance>;
  chainNames: Map<string, string>;
  activity: ActivityItem[];
  proposals: ProposalInfo[];
  unbonding: UnbondingInfo[];
}) {
  const [read, setRead] = useState<string[]>([]);

  useEffect(() => {
    void browser.storage.local
      .get(STORAGE_KEYS.readNotifications)
      .then((store) => {
        const value = store[STORAGE_KEYS.readNotifications];
        if (Array.isArray(value)) setRead(value as string[]);
      });
  }, []);

  const notices = useMemo(() => {
    const rows: Omit<Notice, "read">[] = [];

    for (const approval of approvals) {
      rows.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        title: approval.title,
        meta: `${hostOf(approval.origin)} · waiting for you`,
        target: { route: "approve" },
        timestamp: approval.createdAt,
      });
    }

    for (const [chainId, balance] of Object.entries(balances)) {
      if (!balance.rewards || balance.rewards === "0") continue;
      rows.push({
        id: `rewards:${chainId}:${balance.rewards}`,
        kind: "rewards",
        title: "Rewards ready to claim",
        meta: `${formatUnits(balance.rewards, balance.decimals, 3)} ${balance.symbol} on ${chainNames.get(chainId) ?? chainId}`,
        target: { route: "earn" },
        timestamp: Date.now(),
      });
    }

    for (const row of unbonding) {
      const remaining = daysLeft(row.completionTime);
      rows.push({
        id: `unbonding:${row.chainId}:${row.validatorAddress}:${row.completionTime}`,
        kind: "unbonding",
        title: remaining === null ? "Unbonding complete" : "Unbonding in progress",
        meta:
          remaining === null
            ? `${formatUnits(row.amount, row.decimals, 3)} ${row.symbol} is liquid again`
            : `${formatUnits(row.amount, row.decimals, 3)} ${row.symbol} · ${remaining}d left`,
        target: { route: "earn" },
        timestamp: Date.parse(row.completionTime) || Date.now(),
      });
    }

    for (const item of activity.slice(0, 8)) {
      if (item.kind !== "received") continue;
      rows.push({
        id: `transfer:${item.hash}`,
        kind: "transfer",
        title: `Transfer arrived on ${item.chainId}`,
        meta: item.amount
          ? `${formatUnits(item.amount.replace("-", ""), item.decimals, 3)} ${item.symbol}`
          : item.subtitle,
        target: { route: "chain", chainId: item.chainId },
        timestamp: item.timestamp,
      });
    }

    for (const proposal of proposals) {
      const remaining = daysLeft(proposal.votingEndTime);
      if (proposal.status !== "voting" || remaining === null) continue;
      rows.push({
        id: `gov:${proposal.chainId}:${proposal.id}`,
        kind: "governance",
        title: `Proposal ${proposal.id} ends in ${remaining}d`,
        meta: `${chainNames.get(proposal.chainId) ?? proposal.chainId} · ${proposal.title}`,
        target: { route: "governance" },
        timestamp: Date.parse(proposal.votingEndTime ?? "") || Date.now(),
      });
    }

    return rows
      .map((row) => ({ ...row, read: read.includes(row.id) }))
      .sort((a, b) => {
        if (a.read !== b.read) return a.read ? 1 : -1;
        return b.timestamp - a.timestamp;
      });
  }, [approvals, balances, chainNames, activity, proposals, unbonding, read]);

  const markAllRead = useCallback(() => {
    const ids = Array.from(new Set([...read, ...notices.map((n) => n.id)]));
    setRead(ids);
    void browser.storage.local.set({ [STORAGE_KEYS.readNotifications]: ids });
  }, [read, notices]);

  const unreadCount = notices.filter((n) => !n.read).length;

  return { notices, unreadCount, markAllRead };
}

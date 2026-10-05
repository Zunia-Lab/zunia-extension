import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { ChainBalance } from "../../../lib/balances";
import type {
  ActivityItem,
  ProposalInfo,
  UnbondingInfo,
} from "../../../lib/chain-queries";
import {
  INITIAL_REWARDS_NOTICE,
  deriveNotices,
  parseRewardsNotice,
  type Notice,
  type NoticeKind,
  type RewardsNoticeState,
} from "../../../lib/notices";
import { sendToBackground } from "../../../lib/popup-client";
import type { NotifyPrefs } from "../../../lib/settings";
import { STORAGE_KEYS } from "../../../lib/storage-keys";

export type { Notice, NoticeKind };

/**
 * The notification feed as the popup shows it.
 *
 * The derivation is the worker's own (`lib/notices.ts`), fed with what the
 * open screens have loaded on top of it (history, proposals, unbondings), so
 * a row has the same id here as on the toolbar badge. Browser alerts and the
 * badge are the worker's job alone: this hook never raises an alert, so an
 * open popup cannot double one, and it never advances the rewards cycle, it
 * only reads it.
 */
export function useNotifications({
  approvals,
  balances,
  chainNames,
  activity,
  proposals,
  unbonding,
  prefs,
}: {
  approvals: ApprovalRequest[];
  balances: Record<string, ChainBalance>;
  chainNames: Map<string, string>;
  activity: ActivityItem[];
  proposals: ProposalInfo[];
  unbonding: UnbondingInfo[];
  prefs: NotifyPrefs;
}) {
  const [read, setRead] = useState<string[]>([]);
  const [rewards, setRewards] = useState<RewardsNoticeState>(INITIAL_REWARDS_NOTICE);
  // The feed's timestamps and "Nd left" labels need a clock, but reading it
  // inside the memo below makes the derivation impure: React can re-render the
  // same inputs twice (StrictMode, a concurrent retry) and produce two
  // different feeds, with row ids that no longer match what was marked read.
  // Sample it once, then step it forward on an interval, which is also what
  // keeps the labels honest in a surface that stays open, like the side panel.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(handle);
  }, []);

  // Read ids and the rewards cycle live in storage, written by the worker:
  // follow them, so a row read in another surface turns read here too.
  useEffect(() => {
    let cancelled = false;
    void browser.storage.local
      .get([STORAGE_KEYS.readNotifications, STORAGE_KEYS.rewardsNotice])
      .then((store) => {
        if (cancelled) return;
        const ids = store[STORAGE_KEYS.readNotifications];
        if (Array.isArray(ids)) setRead(ids.filter((id): id is string => typeof id === "string"));
        setRewards(parseRewardsNotice(store[STORAGE_KEYS.rewardsNotice]));
      });
    const onChanged = (
      changes: Record<string, { newValue?: unknown }>,
      area: string,
    ) => {
      if (area !== "local") return;
      const ids = changes[STORAGE_KEYS.readNotifications];
      if (ids && Array.isArray(ids.newValue)) {
        setRead(ids.newValue.filter((id): id is string => typeof id === "string"));
      }
      const cycle = changes[STORAGE_KEYS.rewardsNotice];
      if (cycle) setRewards(parseRewardsNotice(cycle.newValue));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  const notices = useMemo(
    () =>
      deriveNotices({
        approvals,
        balances,
        chainNames,
        activity,
        proposals,
        unbonding,
        // The worker's socket arrivals reach this list through its own feed;
        // here, history covers transfers.
        arrivals: [],
        read,
        now,
        rewards,
        prefs,
      }),
    [approvals, balances, chainNames, activity, proposals, unbonding, read, now, rewards, prefs],
  );

  /** Mark rows read through the worker, which also lowers the toolbar badge. */
  const markRead = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;
    setRead((prev) => [...new Set([...prev, ...ids])]);
    void sendToBackground("MARK_NOTICES_READ", { ids }).catch(() => undefined);
  }, []);

  const markAllRead = useCallback(() => {
    markRead(notices.filter((notice) => !notice.read).map((notice) => notice.id));
  }, [markRead, notices]);

  const unreadCount = notices.filter((n) => !n.read).length;

  return { notices, unreadCount, markRead, markAllRead };
}

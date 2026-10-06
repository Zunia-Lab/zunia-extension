import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  ScreenScaffold,
  cn,
  focusRing,
} from "@zunialab/ui";
import { ChipSkeleton, ListSkeleton } from "../components/ListSkeleton";
import { ActivityBadge } from "../components/ActivityBadge";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { ChainBalance } from "../../../lib/balances";
import type { ActivityKind } from "../../../lib/chain-queries";
import { relativeTime } from "../../../lib/format";
import type { NotifyPrefs } from "../../../lib/settings";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import {
  useActivity,
  useProposals,
  useUnbonding,
} from "../hooks/useChainQuery";
import {
  useNotifications,
  type Notice,
  type NoticeKind,
} from "../hooks/useNotifications";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import { IconBell, IconSettings } from "./icons";

const NOTICE_FILTERS: ReadonlyArray<{ id: "all" | NoticeKind; label: string }> = [
  { id: "all", label: "All" },
  { id: "approval", label: "Approvals" },
  { id: "transfer", label: "Transfers" },
  { id: "rewards", label: "Rewards" },
  { id: "unbonding", label: "Unbonding" },
  { id: "governance", label: "Gov" },
];

/** Whether the user still wants notices of this kind (approvals always). */
function kindEnabled(kind: "all" | NoticeKind, prefs: NotifyPrefs): boolean {
  switch (kind) {
    case "transfer":
      return prefs.transfers;
    case "unbonding":
      return prefs.unbonding;
    case "governance":
      return prefs.governance;
    case "rewards":
      return prefs.rewards !== "off";
    default:
      return true;
  }
}

function noticeActivityKind(kind: NoticeKind): ActivityKind {
  switch (kind) {
    case "approval":
      return "other";
    case "transfer":
      return "received";
    case "rewards":
      return "claim";
    case "unbonding":
      return "staking";
    case "governance":
      return "governance";
  }
}

function clockLabel(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function NoticeRow({
  notice,
  onOpen,
}: {
  notice: Notice;
  onOpen: (notice: Notice) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(notice)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] px-2 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <ActivityBadge kind={noticeActivityKind(notice.kind)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {notice.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
          {notice.meta}
          {notice.timestamp ? ` · ${clockLabel(notice.timestamp)}` : ""}
        </span>
      </span>
      <span className="max-w-[34%] shrink-0 text-right">
        <span className="block font-mono text-[9px] text-fg-dim">
          {notice.timestamp ? relativeTime(notice.timestamp) : ""}
        </span>
        {notice.read ? null : (
          <span className="mt-[3px] inline-block size-[6px] rounded-full bg-accent" />
        )}
      </span>
    </button>
  );
}

/** Everything waiting on the user: approvals, rewards, unbondings, votes. */
export function NotificationsScreen({
  approvals,
  chains,
  balances,
  readsLive,
  onBack,
  onNavigate,
}: {
  approvals: ApprovalRequest[];
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  /**
   * Whether chain reads may run: the live balances setting and the host access
   * it needs, the flag Home and the balance reads use. The setting alone is on
   * by default before any access is granted, so on a fresh install it made
   * this screen wait for reads that could never run.
   */
  readsLive: boolean;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId?: string) => void;
}) {
  const { settings } = usePrefs();
  const live = readsLive;
  // What shows is chosen in Settings → Notifications; this screen only reads it.
  const prefs = settings.notify;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const chainNames = useMemo(
    () => new Map(chains.map((c) => [c.chainId, c.entry.chainName])),
    [chains],
  );

  const activity = useActivity(chainIds, live);
  const proposals = useProposals(chainIds, live);
  const unbonding = useUnbonding(chainIds, live);

  const { notices, unreadCount, markRead, markAllRead } = useNotifications({
    approvals,
    balances,
    chainNames,
    activity: activity.rows,
    proposals: proposals.rows,
    unbonding: unbonding.rows,
    prefs,
  });
  const [filter, setFilter] = useState<"all" | NoticeKind>("all");
  // A filter for a kind the user turned off would always be empty.
  const active = kindEnabled(filter, prefs) ? filter : "all";
  const filters = NOTICE_FILTERS.filter((item) => kindEnabled(item.id, prefs));
  const visible = useMemo(
    () => (active === "all" ? notices : notices.filter((notice) => notice.kind === active)),
    [active, notices],
  );
  const feedLoading =
    live &&
    notices.length === 0 &&
    (activity.loading || proposals.loading || unbonding.loading);

  return (
    <ScreenScaffold
      title="Notifications"
      onBack={onBack}
      right={
        <span className="flex items-center gap-1">
          {unreadCount > 0 ? (
            <button
              type="button"
              onClick={markAllRead}
              className={cn(
                "rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
                "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
                focusRing,
              )}
            >
              Mark all read
            </button>
          ) : null}
          <button
            type="button"
            aria-label="Notification settings"
            title="Notification settings"
            onClick={() => onNavigate("notification-settings")}
            className={cn(
              "flex size-[26px] items-center justify-center rounded-full text-fg-dim",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
              focusRing,
            )}
          >
            <IconSettings width={14} height={14} />
          </button>
        </span>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {feedLoading ? <ChipSkeleton chips={4} label="Loading filters" /> : null}

        {notices.length > 0 ? (
          <ul
            className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
            role="listbox"
            aria-label="Notification type"
          >
            {filters.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={active === item.id}
                  onClick={() => setFilter(item.id)}
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px]",
                    "transition-colors duration-[var(--z-duration-base)]",
                    active === item.id
                      ? "border-[color-mix(in_srgb,var(--z-accent)_55%,transparent)] bg-[var(--z-state-selected)] text-fg"
                      : "border-[var(--z-line)] text-fg-dim hover:text-fg",
                    focusRing,
                  )}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        {feedLoading ? (
          <ListSkeleton rows={5} label="Loading notifications" />
        ) : notices.length === 0 ? (
          <EmptyState
            icon={<IconBell width={16} height={16} />}
            title="Nothing waiting"
            description={
              live
                ? "Approvals, claimable rewards and governance deadlines land here."
                : "Turn on live balances in Preferences to be told about rewards, transfers and votes."
            }
            action={
              live ? undefined : (
                <Button size="sm" variant="secondary" onClick={() => onNavigate("preferences")}>
                  Open Preferences
                </Button>
              )
            }
          />
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-fg-muted">
            Nothing here with these filters.
          </p>
        ) : (
          <ul className="-mx-1 flex flex-col">
            {visible.map((notice) => (
              <li key={notice.id}>
                <NoticeRow
                  notice={notice}
                  onOpen={(row) => {
                    if (!row.read) markRead([row.id]);
                    if (!row.target) return;
                    onNavigate(row.target.route, row.target.chainId);
                  }}
                />
              </li>
            ))}
          </ul>
        )}

      </div>
    </ScreenScaffold>
  );
}

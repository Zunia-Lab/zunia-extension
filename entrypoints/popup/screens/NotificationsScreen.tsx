import { useMemo } from "react";
import {
  Callout,
  EmptyState,
  ScreenScaffold,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { ChainBalance } from "../../../lib/balances";
import { relativeTime } from "../../../lib/format";
import { SettingsGroup, SettingsToggle } from "../components/SettingsList";
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
import {
  IconBell,
  IconGovernance,
  IconReceive,
  IconShield,
  IconStake,
} from "./icons";

function noticeIcon(kind: NoticeKind) {
  switch (kind) {
    case "approval":
      return <IconShield width={16} height={16} />;
    case "transfer":
      return <IconReceive width={16} height={16} />;
    case "rewards":
    case "unbonding":
      return <IconStake width={16} height={16} />;
    case "governance":
      return <IconGovernance width={16} height={16} />;
  }
}

function NoticeRow({
  notice,
  onOpen,
}: {
  notice: Notice;
  onOpen: (notice: Notice) => void;
}) {
  const accent = notice.kind === "approval";
  return (
    <button
      type="button"
      onClick={() => onOpen(notice)}
      className={cn(
        "flex w-full items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        notice.read
          ? "border-[var(--z-line)]"
          : accent
            ? "border-[color-mix(in_srgb,var(--z-accent)_45%,transparent)] bg-[var(--z-state-selected)]"
            : "border-[var(--z-line-strong)]",
        focusRing,
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[8px] border border-[var(--z-line)]",
          notice.read ? "text-fg-dim" : "text-accent",
        )}
      >
        {noticeIcon(notice.kind)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {notice.title}
        </span>
        <span className="mt-[3px] block truncate font-mono text-[9.5px] text-fg-dim">
          {notice.meta}
          {notice.timestamp ? ` · ${relativeTime(notice.timestamp)}` : ""}
        </span>
      </span>
      {notice.read ? null : (
        <span className="mt-1.5 size-[6px] shrink-0 rounded-full bg-accent" />
      )}
    </button>
  );
}

/** Everything waiting on the user: approvals, rewards, unbondings, votes. */
export function NotificationsScreen({
  approvals,
  chains,
  balances,
  onBack,
  onNavigate,
}: {
  approvals: ApprovalRequest[];
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId?: string) => void;
}) {
  const { settings, update } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const chainNames = useMemo(
    () => new Map(chains.map((c) => [c.chainId, c.entry.chainName])),
    [chains],
  );

  const activity = useActivity(chainIds, live);
  const proposals = useProposals(chainIds, live);
  const unbonding = useUnbonding(chainIds, live);

  const { notices, unreadCount, markAllRead } = useNotifications({
    approvals,
    balances,
    chainNames,
    activity: activity.rows,
    proposals: proposals.rows,
    unbonding: unbonding.rows,
  });

  return (
    <ScreenScaffold
      title="Notifications"
      onBack={onBack}
      right={
        unreadCount > 0 ? (
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
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3.5 pt-1">
        {notices.length === 0 ? (
          <EmptyState
            icon={<IconBell width={16} height={16} />}
            title="Nothing waiting"
            description={
              live
                ? "Approvals, claimable rewards and governance deadlines land here."
                : "Turn on on-chain reads in Preferences to be told about rewards, transfers and votes."
            }
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {notices.map((notice) => (
              <li key={notice.id}>
                <NoticeRow
                  notice={notice}
                  onOpen={(row) => {
                    if (!row.target) return;
                    onNavigate(row.target.route, row.target.chainId);
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        <SettingsGroup label="Alerts">
          <SettingsToggle
            title="Browser alerts"
            description="Transfers and governance deadlines."
            checked={settings.browserAlerts}
            onCheckedChange={(browserAlerts) => void update({ browserAlerts })}
          />
        </SettingsGroup>

        <Callout tone="neutral" title="Only what this wallet sees">
          Zunia does not subscribe to a push service. Every line above is
          derived from the chains you enabled and the requests this browser
          received.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

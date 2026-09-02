import { useMemo, useState } from "react";
import {
  Callout,
  EmptyState,
  ScreenScaffold,
  Spinner,
  activityAmountClass,
  activityPresentation,
  amountInlineClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ActivityItem } from "../../../lib/chain-queries";
import { formatUnits } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { IconActivity } from "./icons";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "sent", label: "Sent" },
  { id: "received", label: "Received" },
  { id: "ibc", label: "IBC" },
  { id: "staking", label: "Staking" },
  { id: "claim", label: "Claim" },
  { id: "governance", label: "Gov" },
  { id: "swap", label: "Swap" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function matchesFilter(item: ActivityItem, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "staking") {
    return item.kind === "staking" || item.kind === "claim";
  }
  return item.kind === filter;
}

/** TODAY / YESTERDAY / date, matching the design's day grouping. */
function dayLabel(timestamp: number): string {
  if (!timestamp) return "Undated";
  const date = new Date(timestamp);
  const today = new Date();
  const startOf = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((startOf(today) - startOf(date)) / 86_400_000);
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function clockLabel(timestamp: number): string {
  if (!timestamp) return "";
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Row({
  item,
  hidden,
  onOpen,
}: {
  item: ActivityItem;
  hidden: boolean;
  onOpen: (chainId: string) => void;
}) {
  const presentation = activityPresentation(item.kind, item.success);
  const amount = item.amount
    ? hidden
      ? "••••"
      : `${item.amount.startsWith("-") ? "-" : "+"}${formatUnits(
          item.amount.replace("-", ""),
          item.decimals,
          3,
        )} ${item.symbol}`
    : null;
  const amountClass = activityAmountClass(item.kind, item.success, item.amount);

  return (
    <button
      type="button"
      onClick={() => onOpen(item.chainId)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] px-2 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full border text-[15px] font-semibold leading-none"
        style={{
          color: presentation.fg,
          background: presentation.bg,
          borderColor: presentation.border,
        }}
        aria-label={presentation.label}
      >
        {presentation.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {item.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
          {item.subtitle} · {clockLabel(item.timestamp)}
        </span>
      </span>
      <span className="shrink-0 text-right">
        {amount ? (
          <span
            className={cn(
              amountInlineClass,
              "block",
              amountClass,
            )}
          >
            {amount}
          </span>
        ) : null}
        <span
          className={cn(
            "mt-[3px] block font-mono text-[9px]",
            item.success ? "text-fg-dim" : "text-[var(--z-danger)]",
          )}
        >
          {item.success ? "confirmed" : "reverted"}
        </span>
      </span>
    </button>
  );
}

/** Recent transactions across every enabled chain. */
export function ActivityScreen({
  chains,
  onOpenChain,
}: {
  chains: ChainAccountView[];
  onOpenChain: (chainId: string) => void;
}) {
  const { settings, hidden } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows, loading } = useActivity(chainIds, live);
  const [filter, setFilter] = useState<FilterId>("all");

  const filtered = useMemo(
    () => rows.filter((r) => matchesFilter(r, filter)),
    [rows, filter],
  );

  const groups = useMemo(() => {
    const map = new Map<string, ActivityItem[]>();
    for (const item of filtered) {
      const key = dayLabel(item.timestamp);
      const bucket = map.get(key);
      if (bucket) bucket.push(item);
      else map.set(key, [item]);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <ScreenScaffold
      title="Activity"
      right={
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          {chains.length} chains
        </span>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {FILTERS.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                onClick={() => setFilter(option.id)}
                className={cn(
                  "whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.08em]",
                  "transition-colors duration-[var(--z-duration-base)]",
                  option.id === filter
                    ? "border-[color-mix(in_srgb,var(--z-accent)_55%,transparent)] bg-[var(--z-state-selected)] text-fg"
                    : "border-[var(--z-line)] text-fg-dim hover:text-fg",
                  focusRing,
                )}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>

        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Turn on live balances in Preferences to pull recent transactions
            from each chain's public endpoint.
          </Callout>
        ) : null}

        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : groups.length === 0 ? (
          <EmptyState
            icon={<IconActivity width={16} height={16} />}
            title="No history yet"
            description={
              live
                ? "Nothing indexed for this wallet on the enabled chains."
                : "History loads once on-chain reads are on."
            }
          />
        ) : (
          <div className="flex flex-col gap-3">
            {groups.map(([label, items]) => (
              <section key={label}>
                <p className="px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                  {label}
                </p>
                <ul className="-mx-1 mt-1 flex flex-col">
                  {items.map((item) => (
                    <li key={`${item.chainId}:${item.hash}`}>
                      <Row item={item} hidden={hidden} onOpen={onOpenChain} />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {live && groups.length > 0 ? (
          <p className="pb-1 text-center font-mono text-[9.5px] text-fg-dim">
            Public nodes prune history. Older transactions live in the
            dashboard.
          </p>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

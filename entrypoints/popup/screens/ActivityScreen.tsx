import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Button,
  TokenLogo,
  Callout,
  EmptyState,
  ScreenScaffold,
  SearchField,
  activityAmountClass,
  amountInlineClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import { chainTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import {
  ACTIVITY_PAGE_SIZE,
  MAX_ACTIVITY_LIMIT,
  activityAmount,
  activityAmountPieces,
  activityTokenIdentity,
  type ActivityAmount,
  type ActivityItem,
} from "../../../lib/chain-queries";
import { shortAddress } from "../../../lib/format";
import { routeOutcome, type RouteOutcome, type TrackedRoute } from "../../../lib/packet-tracking";
import {
  listPendingTransfers,
  removePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import { searchItems } from "../../../lib/picker";
import { STORAGE_KEYS } from "../../../lib/storage-keys";
import { tokenKeywords } from "../../../lib/token-identity";
import { ActivityBadge } from "../components/ActivityBadge";
import { ListSkeleton } from "../components/ListSkeleton";
import { PickerSheet, type PickerItem } from "../components/PickerSheet";
import { TokenTicker } from "../components/TokenLabel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivityFeed, useLiveRefresh } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { IconActivity, IconChevronDown } from "./icons";
import { useRouteTracking } from "./interchain-ui";

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

const ALL_NETWORKS = "all-networks";

function isOutgoing(item: ActivityItem): boolean {
  return item.amount?.startsWith("-") ?? false;
}

function matchesFilter(item: ActivityItem, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "staking":
      return item.kind === "staking" || item.kind === "claim";
    // A transfer over IBC is still a send or a receipt.
    case "sent":
      return item.kind === "sent" || (item.kind === "ibc" && isOutgoing(item));
    case "received":
      return item.kind === "received" || (item.kind === "ibc" && !isOutgoing(item));
    default:
      return item.kind === filter;
  }
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

function sameHash(a: string, b: string): boolean {
  return a.toUpperCase() === b.toUpperCase();
}

/** A bech32 address in a subtitle (`to osmo1…`), shown short so the time after it stays in view. */
const ADDRESS_WORD = /\b[a-z][a-z0-9]*1[02-9ac-hj-np-z]{20,}\b/g;

function rowSubtitle(item: ActivityItem): string {
  return item.subtitle.replace(ADDRESS_WORD, (address) => shortAddress(address));
}

/**
 * A history amount whose unit is never cut short. The figure, the `base
 * units` words and the ticker each wrap as a whole, right-aligned; a figure
 * wider than the column (an 18-decimal token nothing names, read in base
 * units) breaks inside its digits rather than running over the title. A
 * ticker wider than the whole column gives up its family part first, so the
 * variant suffix (`.axl.polygon`, `·498A`) stays in view.
 *
 * Assistive tech reads the amount in one piece (`+12.34 USDC.n`): the pieces
 * on screen are separate boxes, which a screen reader would otherwise read
 * with a break inside the ticker (`USDC .n`).
 */
export function HistoryAmountText({ amount, className }: { amount: ActivityAmount; className?: string }) {
  const { figure, words, unit } = activityAmountPieces(amount);
  return (
    <span className={cn("block min-w-0 max-w-full", className)}>
      <span className="sr-only">{amount.text}</span>
      <span aria-hidden="true" className="flex min-w-0 max-w-full flex-wrap items-baseline justify-end gap-x-1">
        <span className="min-w-0 max-w-full [overflow-wrap:anywhere]">{figure}</span>
        {words ? <span className="whitespace-nowrap">{words}</span> : null}
        {unit ? <TokenTicker identity={{ ticker: unit, family: "" }} className="max-w-full" /> : null}
      </span>
    </span>
  );
}

function Row({
  item,
  amount,
  onOpen,
}: {
  item: ActivityItem;
  amount: ActivityAmount | null;
  onOpen: (item: ActivityItem) => void;
}) {
  const amountClass = activityAmountClass(item.kind, item.success, item.amount);

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] px-2 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <ActivityBadge kind={item.kind} messageType={item.messageType} success={item.success} />
      <span className="min-w-0 flex-1">
        {/* Three lines before a cut, so a long ticker in the title stays whole
            beside a two-line amount (`Send` / `USDC.axl.polygon` / `over IBC`). */}
        <span className="line-clamp-3 text-[12.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
          {item.title}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim" title={item.subtitle}>
          {rowSubtitle(item)} · {clockLabel(item.timestamp)}
        </span>
      </span>
      <span className="flex max-w-[46%] shrink-0 flex-col items-end text-right">
        {amount ? <HistoryAmountText amount={amount} className={cn(amountInlineClass, amountClass)} /> : null}
        <span
          className={cn(
            "mt-[3px] block font-mono text-[9px]",
            item.success ? "text-fg-dim" : "text-[var(--z-danger)]",
          )}
        >
          {item.success ? "confirmed" : "failed"}
        </span>
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- *
 * In flight
 * -------------------------------------------------------------------------- */

/**
 * Routes the wallet is still following, newest first.
 *
 * A route that lands is dropped from storage, but it stays here for the rest
 * of the visit so the row turns to "Confirmed" instead of vanishing.
 */
function useInFlightTransfers(): readonly PendingTransfer[] {
  const [rows, setRows] = useState<readonly PendingTransfer[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void listPendingTransfers().then((fresh) => {
        if (cancelled) return;
        setRows((previous) => {
          const stored = new Set(fresh.map((row) => row.txHash));
          return [...fresh, ...previous.filter((row) => !stored.has(row.txHash))].sort(
            (a, b) => b.startedAt - a.startedAt,
          );
        });
      });
    };
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && STORAGE_KEYS.pendingTransfers in changes) load();
    };
    load();
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return rows;
}

function chainName(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

interface InFlightStatus {
  label: string;
  detail: string;
  tone: "info" | "success" | "warning" | "danger" | "muted";
}

function inFlightStatus(
  record: PendingTransfer,
  route: TrackedRoute | null,
  outcome: RouteOutcome | null,
  error: string | null,
): InFlightStatus {
  const dest = chainName(record.plan.destChainId);
  const source = chainName(record.chainId);
  if (outcome === "delivered") {
    return { label: "Confirmed", detail: `Arrived on ${dest}`, tone: "success" };
  }
  if (outcome === "recoverable") {
    return { label: "Action needed", detail: "Recover the tokens from Swap", tone: "warning" };
  }
  if (outcome === "refunded") {
    return {
      label: route?.failure === "timeout" ? "Timed out" : "Refunded",
      detail: `Tokens go back to ${source}`,
      tone: "danger",
    };
  }
  if (!route) {
    return error
      ? { label: "Unknown", detail: "Could not read its status", tone: "muted" }
      : { label: "Checking", detail: `${source} to ${dest}`, tone: "muted" };
  }
  const step = `Step ${route.currentHopIndex + 1} of ${route.hops.length}`;
  return route.stalled
    ? { label: "Slow", detail: `${step} is taking longer than usual`, tone: "warning" }
    : { label: "In flight", detail: `${step}, ${source} to ${dest}`, tone: "info" };
}

/** The arrow between a route label's two sides (`swapRouteLabel`, `transferLabel`). */
const ROUTE_ARROW = " → ";

/**
 * A route's stored label, laid out to break between its sides rather than
 * inside one: `10 OSMO (Osmosis)` / `→ USDC.axl (Axelar)`, never
 * `10 OSMO (Osmosis) → USDC.axl` / `(Axelar)`. Each side is one box that
 * stays whole on a line when it fits and wraps within itself only when it
 * alone is wider than the column, so nothing is cut. The text, and so what a
 * screen reader reads, is the label as stored.
 */
export function RouteLabel({ label }: { label: string }) {
  const sides = label.split(ROUTE_ARROW);
  return sides.map((side, index) => (
    <Fragment key={index}>
      {index > 0 ? " " : null}
      <span className="inline-block max-w-full">{index > 0 ? `${ROUTE_ARROW.trimStart()}${side}` : side}</span>
    </Fragment>
  ));
}

const TONE_CLASS: Record<InFlightStatus["tone"], string> = {
  info: "text-fg",
  success: "text-[var(--z-success)]",
  warning: "text-[var(--z-warning)]",
  danger: "text-[var(--z-danger)]",
  muted: "text-fg-dim",
};

export function InFlightRow({
  record,
  onOpen,
}: {
  record: PendingTransfer;
  onOpen: (record: PendingTransfer) => void;
}) {
  const tracking = useRouteTracking({
    plan: record.plan,
    sourceTxHash: record.txHash,
    expectedAmount: record.amountBaseUnits,
    ...(record.swapContract ? { swapContract: record.swapContract } : {}),
    ...(record.recoveryAddress ? { recoveryAddress: record.recoveryAddress } : {}),
  });
  const outcome = tracking.route ? routeOutcome(tracking.route) : null;
  const finished = outcome === "delivered" || outcome === "refunded";
  useEffect(() => {
    if (finished) void removePendingTransfer(record.txHash);
  }, [finished, record.txHash]);

  const status = inFlightStatus(record, tracking.route, outcome, tracking.error);

  return (
    <button
      type="button"
      onClick={() => onOpen(record)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] px-2 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <ActivityBadge
        kind={record.kind === "swap" ? "swap" : "ibc"}
        decorative
      />
      <span className="min-w-0 flex-1">
        {/* Two lines for a swap's two sides (`10 OSMO (Osmosis)` / `→
            USDC.axl (Axelar)`), so neither token nor chain is cut. */}
        <span className="block text-[12.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
          <RouteLabel label={record.label} />
        </span>
        <span
          className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim"
          title={`${status.detail} · ${clockLabel(record.startedAt)}`}
        >
          {status.detail} · {clockLabel(record.startedAt)}
        </span>
      </span>
      <span
        role="status"
        className={cn(
          "shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em]",
          TONE_CLASS[status.tone],
        )}
      >
        {status.label}
      </span>
    </button>
  );
}

/* -------------------------------------------------------------------------- *
 * Network filter
 * -------------------------------------------------------------------------- */

function NetworkFilter({
  chains,
  value,
  onChange,
}: {
  chains: readonly ChainAccountView[];
  value: string | null;
  onChange: (chainId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value ? chains.find((chain) => chain.chainId === value) : undefined;
  const items = useMemo<PickerItem[]>(
    () => [
      {
        id: ALL_NETWORKS,
        label: "All networks",
        sublabel: `${chains.length} enabled`,
        keywords: ["all", "every"],
      },
      ...chains.map((chain) => ({
        id: chain.chainId,
        label: chain.entry.chainName,
        sublabel: `${chainTicker(chain.entry)} · ${chain.chainId}`,
        keywords: [chain.entry.coinDenom, chainTicker(chain.entry), chain.chainId],
        icon: (
          <TokenLogo
            src={chain.iconUrl}
            symbol={chain.entry.chainName}
            size={26}
            verified={chain.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        ),
      })),
    ],
    [chains],
  );

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Show activity on ${active?.entry.chainName ?? "all networks"}`}
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-2 pr-1.5",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        {active ? (
          <TokenLogo
            src={active.iconUrl}
            symbol={active.entry.chainName}
            size={16}
            verified={active.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        ) : null}
        <span className="max-w-[92px] truncate text-[11px] text-fg-muted">
          {active?.entry.chainName ?? "All networks"}
        </span>
        <IconChevronDown width={16} height={16} className="text-fg-dim" />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Show activity on"
        items={items}
        selectedId={value ?? ALL_NETWORKS}
        searchPlaceholder="Search networks"
        onSelect={(id) => onChange(id === ALL_NETWORKS ? null : id)}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- *
 * Screen
 * -------------------------------------------------------------------------- */

/** Recent transactions across every enabled chain, read again while in view. */
export function ActivityScreen({
  chains,
  balances,
  initialChainId,
  onOpenTx,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  onOpenTx: (item: ActivityItem, transfer?: PendingTransfer) => void;
}) {
  const { settings, hidden } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const [limit, setLimit] = useState(ACTIVITY_PAGE_SIZE);
  const feed = useActivityFeed(chainIds, live, limit);
  useLiveRefresh(feed.refresh, live);
  const inFlight = useInFlightTransfers();
  const [filter, setFilter] = useState<FilterId>("all");
  const [network, setNetwork] = useState<string | null>(initialChainId ?? null);
  const [query, setQuery] = useState("");
  // A network that was turned off since it was picked filters nothing.
  const networkFilter = network && chainIds.includes(network) ? network : null;

  const shownInFlight = useMemo(
    () => inFlight.filter((row) => !networkFilter || row.chainId === networkFilter),
    [inFlight, networkFilter],
  );

  const filtered = useMemo(() => {
    const kept = feed.rows.filter(
      (row) =>
        (!networkFilter || row.chainId === networkFilter) &&
        matchesFilter(row, filter) &&
        !inFlight.some((pending) => sameHash(pending.txHash, row.hash)),
    );
    if (!query.trim()) return kept;
    const chainNames = new Map(chains.map((c) => [c.chainId, c.entry.chainName]));
    const byKey = new Map(kept.map((r) => [`${r.chainId}:${r.hash}`, r]));
    return searchItems(
      kept.map((r) => {
        // The coin's every name: `usdc noble` finds USDC.n rows, `ibc/498a`
        // the exact voucher.
        const identity = activityTokenIdentity(r, balances);
        return {
          id: `${r.chainId}:${r.hash}`,
          label: r.title,
          sublabel: r.subtitle,
          keywords: [
            ...(identity ? tokenKeywords(identity) : [r.symbol]),
            r.hash,
            r.chainId,
            chainNames.get(r.chainId) ?? "",
          ],
        };
      }),
      query,
    )
      .flatMap((item) => byKey.get(item.id) ?? [])
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [feed.rows, filter, networkFilter, query, chains, inFlight, balances]);

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

  function openInFlight(record: PendingTransfer) {
    onOpenTx(
      {
        chainId: record.chainId,
        hash: record.txHash,
        kind: record.kind === "swap" ? "swap" : "ibc",
        title: record.label,
        subtitle: `${chainName(record.chainId)} to ${chainName(record.plan.destChainId)}`,
        decimals: 0,
        symbol: "",
        timestamp: record.startedAt,
        success: true,
      },
      record,
    );
  }

  const narrowed = Boolean(networkFilter) || filter !== "all" || Boolean(query.trim());

  return (
    <ScreenScaffold
      title="Activity"
      right={<NetworkFilter chains={chains} value={networkFilter} onChange={setNetwork} />}
    >
      <div className="flex flex-col gap-3 pt-1">
        {shownInFlight.length > 0 ? (
          <section aria-label="In flight">
            <p className="px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              In flight
            </p>
            <ul className="-mx-1 mt-1 flex flex-col">
              {shownInFlight.map((record) => (
                <li key={record.txHash}>
                  <InFlightRow record={record} onOpen={openInFlight} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
          {FILTERS.map((option) => (
            <li key={option.id}>
              <button
                type="button"
                aria-pressed={option.id === filter}
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

        {feed.rows.length > 0 ? (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Search by name, token, network, or hash"
          />
        ) : null}

        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Turn on live balances in Preferences to pull recent transactions
            from each chain's public endpoint.
          </Callout>
        ) : null}

        {feed.loading && feed.rows.length === 0 ? (
          <ListSkeleton rows={5} label="Loading activity" />
        ) : groups.length === 0 && narrowed ? (
          <p className="py-6 text-center text-[12px] text-fg-muted">
            {query.trim()
              ? `Nothing matches "${query.trim()}".`
              : "Nothing here with these filters."}
          </p>
        ) : groups.length === 0 && shownInFlight.length === 0 ? (
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
              <section key={label} aria-label={label}>
                <p className="px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                  {label}
                </p>
                <ul className="-mx-1 mt-1 flex flex-col">
                  {items.map((item) => (
                    <li key={`${item.chainId}:${item.hash}`}>
                      <Row
                        item={item}
                        amount={activityAmount(item, "history", { balances, hidden })}
                        onOpen={onOpenTx}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}

        {live && feed.hasMore ? (
          <Button
            variant="secondary"
            size="sm"
            loading={feed.loadingMore}
            onClick={() => setLimit((n) => Math.min(n + ACTIVITY_PAGE_SIZE, MAX_ACTIVITY_LIMIT))}
          >
            {feed.loadingMore ? "Loading more…" : "Load more"}
          </Button>
        ) : null}

        {live && feed.rows.length > 0 && !feed.hasMore ? (
          <p className="pb-1 text-center font-mono text-[9.5px] text-fg-dim">
            Public nodes prune history, so older transactions may be missing
            here. A block explorer keeps the full record.
          </p>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

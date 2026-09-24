import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  ConnectedBanner,
  EmptyState,
  ScreenScaffold,
  SearchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TokenLogo,
  activityAmountClass,
  amountHeroClass,
  amountInlineClass,
  amountPrimaryClass,
  amountSecondaryClass,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { OriginGrant } from "../../../lib/permissions";
import type { SessionStatus } from "../../../lib/session";
import {
  hasLiveBalancePermission,
  liveBalanceRefusalNote,
  requestLiveBalancePermission,
  type ChainBalance,
  type TokenBalance,
} from "../../../lib/balances";
import type { PriceMap, SpotPrice } from "../../../lib/prices";
import type { ActivityItem } from "../../../lib/chain-queries";
import { computePortfolio, toWholeCoins } from "../../../lib/portfolio";
import { searchItems } from "../../../lib/picker";
import { sendToBackground } from "../../../lib/popup-client";
import {
  NO_VALUE,
  formatFiat,
  formatUnits,
  relativeTime,
} from "../../../lib/format";
import { ActivityBadge } from "../components/ActivityBadge";
import { PopupHeader } from "../components/PopupHeader";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconChevronDown,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconGlobe,
  IconReceive,
  IconRefresh,
  IconSend,
  IconStake,
  IconSwap,
} from "./icons";

/** Past this many networks the list gets a search box and a held-only filter. */
const FILTER_FROM = 6;

/** True when the network holds anything: spendable, staked, or other tokens. */
function holdsFunds(balance: ChainBalance | undefined): boolean {
  if (!balance) return false;
  return (
    balance.available !== "0" ||
    balance.staked !== "0" ||
    balance.tokens.some((token) => token.amount !== "0")
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

function QuickAction({
  label,
  icon,
  primary,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  primary?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-1.5 rounded-[13px] py-2.5",
        "transition-[background-color,border-color,filter,transform] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
        primary
          ? "bg-[image:var(--z-accent-gradient)] text-[var(--z-accent-fg)] shadow-[var(--z-accent-glow)] hover:brightness-110 active:brightness-95 active:scale-[0.98]"
          : "border border-[var(--z-line)] bg-[image:var(--z-surface-raised-gradient)] text-fg hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] active:bg-[var(--z-state-press)] active:scale-[0.98]",
        focusRing,
      )}
    >
      {icon}
      <span className="text-[10.5px] font-medium leading-none">{label}</span>
    </button>
  );
}

function TokenLine({
  token,
  hidden,
}: {
  token: TokenBalance;
  hidden: boolean;
}) {
  const kindLabel =
    token.kind === "ibc"
      ? "IBC"
      : token.kind === "factory"
        ? "Factory"
        : null;

  return (
    <div className="flex items-center gap-2.5 py-1.5 pl-10 pr-1">
      <TokenLogo src={token.iconUrl} symbol={token.symbol} size={22} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[12px] font-medium text-fg">
            {token.displayName}
          </span>
          {kindLabel ? (
            <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-fg-dim">
              {kindLabel}
            </span>
          ) : null}
        </span>
      </span>
      <span className={cn(amountInlineClass, "max-w-[45%] shrink-0 truncate text-[12.5px]")}>
        {hidden ? "••••" : formatUnits(token.amount, token.decimals)}
      </span>
    </div>
  );
}

function NetworkRow({
  chain,
  balance,
  price,
  currency,
  hidden,
  query,
  onOpen,
}: {
  chain: ChainAccountView;
  balance?: ChainBalance;
  price?: SpotPrice;
  currency: string;
  hidden: boolean;
  /** The list search, so a network found by one of its tokens shows it. */
  query: string;
  onOpen: () => void;
}) {
  // Null until the user toggles, so a search can open the token list.
  const [open, setOpen] = useState<boolean | null>(null);
  const nativeToken =
    balance?.tokens.find((t) => t.kind === "native") ??
    (balance
      ? {
          denom: balance.denom,
          amount: balance.available,
          kind: "native" as const,
          symbol: balance.symbol,
          displayName: balance.symbol,
          decimals: balance.decimals,
          iconUrl: balance.iconUrl ?? chain.iconUrl,
        }
      : undefined);
  const extras = (balance?.tokens ?? []).filter((t) => t.kind !== "native");
  const needle = query.trim().toLowerCase();
  const tokenMatch =
    needle.length > 0 &&
    extras.some(
      (token) =>
        token.symbol.toLowerCase().includes(needle) ||
        token.displayName.toLowerCase().includes(needle),
    );
  const expanded = open ?? tokenMatch;
  const amount = balance
    ? formatUnits(balance.available, balance.decimals)
    : NO_VALUE;
  const fiat =
    balance && price
      ? formatFiat(
          toWholeCoins(balance.available, balance.decimals) * price.price,
          currency,
        )
      : null;
  const tokenIcon = nativeToken?.iconUrl ?? balance?.iconUrl ?? chain.iconUrl;
  const tokenSymbol = nativeToken?.symbol ?? chain.entry.coinDenom;
  const primaryAmount = hidden
    ? "••••"
    : fiat
      ? fiat
      : `${amount} ${tokenSymbol}`;
  const secondaryAmount =
    fiat && !hidden ? `${amount} ${tokenSymbol}` : hidden && fiat ? "••••" : null;

  return (
    <div>
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2.5 rounded-[10px] px-1.5 py-2 text-left",
            "transition-[background-color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
            "hover:bg-[var(--z-state-hover)] active:bg-[var(--z-state-press)]",
            focusRing,
          )}
        >
          <TokenLogo src={tokenIcon} symbol={tokenSymbol} size={32} />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[13px] font-semibold tracking-[-0.02em] text-fg">
                {tokenSymbol}
              </span>
              {chain.entry.network === "testnet" ? (
                <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-[var(--z-warning)]">
                  test
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-[11px] text-fg-muted">
              {chain.entry.chainName}
            </span>
          </span>
          <span className="max-w-[48%] shrink-0 text-right">
            <span className={cn(amountPrimaryClass, "block truncate text-[14px]")}>
              {primaryAmount}
            </span>
            {secondaryAmount ? (
              <span className={cn(amountSecondaryClass, "mt-0.5 block truncate text-[10px]")}>
                {secondaryAmount}
              </span>
            ) : null}
          </span>
        </button>

        {extras.length > 0 ? (
          <button
            type="button"
            aria-label={
              expanded
                ? `Hide other ${chain.entry.chainName} tokens`
                : `Show ${extras.length} other ${chain.entry.chainName} tokens`
            }
            aria-expanded={expanded}
            onClick={() => setOpen(!expanded)}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-[8px] text-fg-dim",
              "transition-[background-color,color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
              "hover:bg-[var(--z-state-hover)] hover:text-fg",
              expanded && "text-fg",
              focusRing,
            )}
          >
            <IconChevronDown
              width={14}
              height={14}
              aria-hidden
              className={cn(
                "transition-transform duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
                expanded && "rotate-180",
              )}
            />
          </button>
        ) : null}
      </div>

      {expanded && extras.length > 0 ? (
        <div className="pb-1">
          {extras.map((token) => (
            <TokenLine key={token.denom} token={token} hidden={hidden} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ActivityRow({
  item,
  hidden,
  onOpen,
}: {
  item: ActivityItem;
  hidden: boolean;
  onOpen: () => void;
}) {
  const signed =
    item.amount && item.amount !== "0"
      ? `${item.amount.startsWith("-") ? "" : "+"}${formatUnits(
          item.amount,
          item.decimals,
        )} ${item.symbol}`
      : null;
  const amountClass = activityAmountClass(item.kind, item.success, item.amount);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "-mx-1.5 flex w-[calc(100%+12px)] items-center gap-2.5 rounded-[10px] px-1.5 py-2 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <ActivityBadge kind={item.kind} success={item.success} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[11.5px] font-medium text-fg">
          {item.title}
        </span>
        <span className="mt-[2px] block truncate font-mono text-[8.5px] text-fg-dim">
          {item.subtitle} · {relativeTime(item.timestamp)}
        </span>
      </span>
      {signed ? (
        <span
          className={cn(
            amountInlineClass,
            "max-w-[46%] shrink-0 truncate",
            amountClass,
          )}
        >
          {hidden ? "••••" : signed}
        </span>
      ) : null}
    </button>
  );
}

/** A staking position: what is bonded on the network and what it has earned. */
function StakedRow({
  chain,
  balance,
  price,
  currency,
  hidden,
  onOpen,
}: {
  chain: ChainAccountView;
  balance: ChainBalance;
  price?: SpotPrice;
  currency: string;
  hidden: boolean;
  onOpen: () => void;
}) {
  const symbol = balance.symbol || chain.entry.coinDenom;
  const staked = formatUnits(balance.staked, balance.decimals, 4);
  const rewards =
    balance.rewards && balance.rewards !== "0"
      ? formatUnits(balance.rewards, balance.decimals, 4)
      : null;
  const fiat = price
    ? formatFiat(toWholeCoins(balance.staked, balance.decimals) * price.price, currency)
    : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5 text-left",
        "transition-[background-color,border-color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
        "hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <TokenLogo
        src={balance.iconUrl ?? chain.iconUrl}
        symbol={symbol}
        size={30}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {chain.entry.chainName}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
          {hidden ? "••••" : fiat ? `${fiat} staked` : "staked"}
        </span>
      </span>
      <span className="max-w-[48%] shrink-0 text-right">
        <span className={cn(amountInlineClass, "block truncate")}>
          {hidden ? "••••" : `${staked} ${symbol}`}
        </span>
        <span className="mt-[3px] block truncate font-mono text-[9.5px] tabular-nums text-accent">
          {hidden ? "••••" : rewards ? `+${rewards} to claim` : "no rewards yet"}
        </span>
      </span>
    </button>
  );
}

export function HomeScreen({
  status,
  pendingCount,
  grants,
  chains,
  balances,
  prices,
  balancesLoading,
  hostGranted,
  onHostGranted,
  onReloadBalances,
  onNavigate,
  onOpenChain,
  onOpenEarn,
  onOpenTx,
  onOpenMenu,
  onRefresh,
}: {
  status: SessionStatus;
  grants: OriginGrant[];
  pendingCount: number;
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  prices: PriceMap;
  balancesLoading: boolean;
  hostGranted: boolean;
  onHostGranted: () => void;
  onReloadBalances: () => void;
  onNavigate: (route: PopupRoute) => void;
  onOpenChain: (chainId: string) => void;
  /** Earn on one network, or on its default network without an argument. */
  onOpenEarn: (chainId?: string) => void;
  onOpenTx: (item: ActivityItem) => void;
  onOpenMenu: () => void;
  onRefresh: () => void;
}) {
  const [enabling, setEnabling] = useState(false);
  const [query, setQuery] = useState("");
  const [heldOnly, setHeldOnly] = useState(false);
  const toast = useToast();
  const { settings, update, hidden, toggleHidden } = usePrefs();
  const active =
    status.accounts.find((a) => a.index === status.activeAccountIndex) ??
    status.accounts[0];

  const primary = chains[0];
  const networkLabel = primary?.entry.chainName ?? `${chains.length} chains`;
  // The header names one chain, so show that chain's address rather than the
  // account's default derivation, which belongs to a different prefix.
  const headerAddress = primary?.address ?? active?.address;
  const readsLive = settings.liveBalances && hostGranted;
  const filterable = chains.length > FILTER_FROM;
  // Held-only needs balances to judge by; without live reads it would hide all.
  const filterHeld = filterable && heldOnly && readsLive;
  const visibleChains = useMemo(() => {
    const byId = new Map(chains.map((chain) => [chain.chainId, chain]));
    const pool = filterHeld
      ? chains.filter((chain) => holdsFunds(balances[chain.chainId]))
      : chains;
    return searchItems(
      pool.map((chain) => ({
        id: chain.chainId,
        label: chain.entry.chainName,
        sublabel: chain.entry.coinDenom,
        keywords: [
          chain.chainId,
          ...(balances[chain.chainId]?.tokens ?? []).flatMap((token) => [
            token.symbol,
            token.displayName,
          ]),
        ],
      })),
      filterable ? query : "",
    ).flatMap((item) => byId.get(item.id) ?? []);
  }, [chains, balances, query, filterable, filterHeld]);
  const staked = chains.filter((c) => {
    const b = balances[c.chainId];
    return b && b.staked !== "0";
  });

  const totals = useMemo(
    () => computePortfolio(balances, prices),
    [balances, prices],
  );
  const currency = (settings.currency ?? "USD").toUpperCase();
  const hasTotal = totals.pricedChains > 0;

  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows: activity } = useActivity(chainIds, readsLive);
  const recentActivity = activity.slice(0, 5);

  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => {
    const sync = () => {
      void hasLiveBalancePermission().then((ok) => {
        if (!ok) return;
        onHostGranted();
        setRefusal(null);
      });
    };
    sync();
    window.addEventListener("focus", sync);
    return () => window.removeEventListener("focus", sync);
  }, [onHostGranted]);

  async function enableLiveBalances() {
    setEnabling(true);
    try {
      const ok = await requestLiveBalancePermission();
      if (!ok) {
        setRefusal(liveBalanceRefusalNote());
        return;
      }
      setRefusal(null);
      onHostGranted();
      await update({ liveBalances: true });
      onRefresh();
      window.setTimeout(() => onReloadBalances(), 80);
    } finally {
      setEnabling(false);
    }
  }

  async function copyAddress() {
    if (!headerAddress) return;
    try {
      await navigator.clipboard.writeText(headerAddress);
      toast("Address copied", { meta: primary?.entry.chainName });
    } catch {
      toast("Could not copy the address", { tone: "danger" });
    }
  }

  return (
    <ScreenScaffold
      header={
        <PopupHeader
          accounts={status.accounts}
          activeIndex={status.activeAccountIndex}
          networkLabel={networkLabel}
          networkCount={chains.length}
          pendingCount={pendingCount}
          onSelectAccount={(index) => {
            void sendToBackground("SET_ACTIVE_ACCOUNT", { index }).then(
              onRefresh,
            );
          }}
          onAddAccount={() => {
            void sendToBackground("ADD_ACCOUNT").then(onRefresh);
          }}
          onManageWallets={() => onNavigate("wallets")}
          onNetworks={() => onNavigate("networks")}
          onNotifications={() => onNavigate("notifications")}
          onMenu={onOpenMenu}
        />
      }
    >
      {grants[0] ? (
        <ConnectedBanner
          domain={hostOf(grants[0].origin)}
          onManage={() => onNavigate("sites")}
        />
      ) : null}
      <div className="flex flex-col gap-4 pt-4">
        <section>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-muted">
              Total balance
            </span>
            <button
              type="button"
              aria-label={hidden ? "Show amounts" : "Hide amounts"}
              onClick={toggleHidden}
              className={cn(
                "flex size-[20px] items-center justify-center rounded-full text-fg-dim",
                "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                focusRing,
              )}
            >
              {hidden ? (
                <IconEyeOff width={12} height={12} />
              ) : (
                <IconEye width={12} height={12} />
              )}
            </button>
            {readsLive ? (
              <button
                type="button"
                aria-label="Refresh balances"
                onClick={onReloadBalances}
                className={cn(
                  "ml-auto flex size-[20px] items-center justify-center rounded-full text-fg-dim",
                  "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                  balancesLoading && "animate-spin",
                  focusRing,
                )}
              >
                <IconRefresh width={12} height={12} />
              </button>
            ) : null}
          </div>

          <div className="mt-1.5 flex items-end gap-2">
            <span className={cn(amountHeroClass, "text-[32px] leading-none")}>
              {hidden
                ? "••••"
                : hasTotal
                  ? formatFiat(totals.total, currency)
                  : NO_VALUE}
            </span>
            {hidden ? null : hasTotal ? (
              totals.change24h === null ? null : (
                <span
                  className={cn(
                    "pb-1 font-mono text-[10px] tabular-nums",
                    totals.change24h >= 0
                      ? "text-[var(--z-success)]"
                      : "text-[var(--z-danger)]",
                  )}
                >
                  {totals.change24h >= 0 ? "+" : ""}
                  {totals.change24h.toFixed(1)}%
                </span>
              )
            ) : (
              <span className="pb-1 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim">
                {readsLive ? "no price feed" : "balances off"}
              </span>
            )}
          </div>

          {hasTotal && totals.unpricedChains > 0 ? (
            <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-fg-dim">
              {totals.pricedChains} of{" "}
              {totals.pricedChains + totals.unpricedChains} chains priced
            </div>
          ) : null}

          <button
            type="button"
            onClick={() => void copyAddress()}
            aria-label={headerAddress ? `Copy address ${headerAddress}` : "No address yet"}
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-dim",
              "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
              focusRing,
            )}
          >
            {headerAddress ? truncateAddress(headerAddress, 10, 6) : NO_VALUE}
            <IconCopy width={11} height={11} />
          </button>
        </section>

        <section className="flex gap-2">
          <QuickAction
            label="Send"
            primary
            icon={<IconSend width={15} height={15} />}
            onClick={() => onNavigate("send")}
          />
          <QuickAction
            label="Receive"
            icon={<IconReceive width={15} height={15} />}
            onClick={() => onNavigate("receive")}
          />
          <QuickAction
            label="Swap"
            icon={<IconSwap width={15} height={15} />}
            onClick={() => onNavigate("swap")}
          />
          <QuickAction
            label="Stake"
            icon={<IconStake width={15} height={15} />}
            onClick={() => onNavigate("earn")}
          />
        </section>

        {!readsLive ? (
          <Callout tone="info" title="Turn on live balances">
            <p>
              Read native, IBC, and factory balances from each chain&rsquo;s
              public endpoint, once you allow the wallet to reach them.
            </p>
            {refusal ? (
              <p className="mt-1.5 text-[var(--z-danger)]">{refusal}</p>
            ) : null}
            <Button
              size="sm"
              className="mt-2.5"
              loading={enabling}
              onClick={() => void enableLiveBalances()}
            >
              Enable
            </Button>
          </Callout>
        ) : null}

        <Tabs defaultValue="tokens">
          <TabsList>
            <TabsTrigger value="tokens">Networks</TabsTrigger>
            <TabsTrigger value="staked">Staked</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="tokens" className="pt-0.5">
            {filterable ? (
              <div className="mb-1.5 mt-2 flex items-center gap-2">
                <SearchField
                  className="min-w-0 flex-1"
                  value={query}
                  onValueChange={setQuery}
                  placeholder="Search networks and tokens"
                />
                {readsLive ? (
                  <button
                    type="button"
                    aria-pressed={heldOnly}
                    onClick={() => setHeldOnly((v) => !v)}
                    className={cn(
                      "h-9 shrink-0 rounded-full border px-3 font-mono text-[9.5px] uppercase tracking-[0.08em]",
                      "transition-colors duration-[var(--z-duration-base)]",
                      heldOnly
                        ? "border-accent bg-[var(--z-state-selected)] text-fg"
                        : "border-[var(--z-line)] text-fg-muted hover:border-[var(--z-line-strong)] hover:text-fg",
                      focusRing,
                    )}
                  >
                    Held only
                  </button>
                ) : null}
              </div>
            ) : null}
            {visibleChains.length === 0 && chains.length > 0 ? (
              <p className="py-6 text-center text-[12px] text-fg-muted">
                {query.trim()
                  ? <>Nothing matches &ldquo;{query.trim()}&rdquo;{filterHeld ? " among networks with funds" : ""}.</>
                  : "No network holds funds yet."}
              </p>
            ) : null}
            <ul className="flex flex-col">
              {visibleChains.map((chain) => (
                <li key={chain.chainId}>
                  <NetworkRow
                    chain={chain}
                    balance={balances[chain.chainId]}
                    price={prices[chain.chainId]}
                    currency={currency}
                    hidden={hidden}
                    query={filterable ? query : ""}
                    onOpen={() => onOpenChain(chain.chainId)}
                  />
                </li>
              ))}
            </ul>
            <button
              type="button"
              onClick={() => onNavigate("networks")}
              className={cn(
                "mt-2.5 flex w-full items-center justify-center gap-2 rounded-[14px] border border-dashed border-[var(--z-line)] py-3",
                "text-[12px] text-fg-muted",
                "transition-[background-color,border-color,color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
                "hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                focusRing,
              )}
            >
              <IconGlobe width={16} height={16} />
              Manage networks
            </button>
          </TabsContent>

          <TabsContent value="staked" className="pt-1">
            {staked.length === 0 ? (
              <EmptyState
                icon={<IconStake width={18} height={18} />}
                title={readsLive ? "Nothing staked" : "Staking is off"}
                description={
                  readsLive
                    ? "Pick a validator in Earn and your positions land here."
                    : "Enable live balances to read staking positions from each chain."
                }
                action={
                  readsLive ? (
                    <Button size="sm" variant="secondary" onClick={() => onOpenEarn()}>
                      Open Earn
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="mb-2 mt-1 grid grid-cols-2 gap-2">
                  <div className="rounded-[12px] border border-[var(--z-line)] px-3 py-2">
                    <p className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-fg-dim">
                      Staked value
                    </p>
                    <p className={cn(amountInlineClass, "mt-1 truncate text-[14px]")}>
                      {hidden
                        ? "••••"
                        : totals.staked > 0
                          ? formatFiat(totals.staked, currency)
                          : NO_VALUE}
                    </p>
                  </div>
                  <div className="rounded-[12px] border border-[var(--z-line)] px-3 py-2">
                    <p className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-fg-dim">
                      To claim
                    </p>
                    <p className={cn(amountInlineClass, "mt-1 truncate text-[14px] text-accent")}>
                      {hidden
                        ? "••••"
                        : totals.claimable > 0
                          ? formatFiat(totals.claimable, currency)
                          : NO_VALUE}
                    </p>
                  </div>
                </div>
                <ul className="flex flex-col gap-1.5">
                  {staked.map((chain) => (
                    <li key={chain.chainId}>
                      <StakedRow
                        chain={chain}
                        balance={balances[chain.chainId]!}
                        price={prices[chain.chainId]}
                        currency={currency}
                        hidden={hidden}
                        onOpen={() => onOpenEarn(chain.chainId)}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </TabsContent>

          <TabsContent value="activity" className="pt-1">
            {recentActivity.length === 0 ? (
              <EmptyState
                icon={<IconActivity width={16} height={16} />}
                title={readsLive ? "No activity yet" : "Activity is off"}
                description={
                  readsLive
                    ? "Transfers and signatures from this wallet are listed here."
                    : "Enable live balances to read history from each chain's public endpoint."
                }
              />
            ) : (
              <>
                <ul className="flex flex-col">
                  {recentActivity.map((item) => (
                    <li key={`${item.chainId}:${item.hash}`}>
                      <ActivityRow
                        item={item}
                        hidden={hidden}
                        onOpen={() => onOpenTx(item)}
                      />
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => onNavigate("activity")}
                  className={cn(
                    "mt-2 w-full rounded-[12px] border border-[var(--z-line)] py-2.5",
                    "text-[11.5px] text-fg-muted transition-colors duration-[var(--z-duration-base)]",
                    "hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                    focusRing,
                  )}
                >
                  See all activity
                </button>
              </>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </ScreenScaffold>
  );
}

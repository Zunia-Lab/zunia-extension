import { useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  ConnectedBanner,
  EmptyState,
  ScreenScaffold,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TokenLogo,
  activityAmountClass,
  activityPresentation,
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
  requestLiveBalancePermission,
  type ChainBalance,
  type TokenBalance,
} from "../../../lib/balances";
import type { PriceMap, SpotPrice } from "../../../lib/prices";
import type { ActivityItem } from "../../../lib/chain-queries";
import { computePortfolio, toWholeCoins } from "../../../lib/portfolio";
import { sendToBackground } from "../../../lib/popup-client";
import {
  NO_VALUE,
  formatFiat,
  formatUnits,
  relativeTime,
} from "../../../lib/format";
import { PopupHeader } from "../components/PopupHeader";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconCheck,
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
      <span className={cn(amountInlineClass, "shrink-0 text-[12.5px]")}>
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
  onOpen,
}: {
  chain: ChainAccountView;
  balance?: ChainBalance;
  price?: SpotPrice;
  currency: string;
  hidden: boolean;
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
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
          <span className="shrink-0 text-right">
            <span className={cn(amountPrimaryClass, "block text-[14px]")}>
              {primaryAmount}
            </span>
            {secondaryAmount ? (
              <span className={cn(amountSecondaryClass, "mt-0.5 text-[10px]")}>
                {secondaryAmount}
              </span>
            ) : null}
          </span>
        </button>

        {extras.length > 0 ? (
          <button
            type="button"
            aria-label={open ? "Hide other tokens" : "Show other tokens"}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-[8px] text-fg-dim",
              "transition-[background-color,color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
              "hover:bg-[var(--z-state-hover)] hover:text-fg",
              open && "text-fg",
              focusRing,
            )}
          >
            <IconChevronDown
              width={14}
              height={14}
              aria-hidden
              className={cn(
                "transition-transform duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
                open && "rotate-180",
              )}
            />
          </button>
        ) : null}
      </div>

      {open && extras.length > 0 ? (
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
}: {
  item: ActivityItem;
  hidden: boolean;
}) {
  const presentation = activityPresentation(item.kind, item.success);
  const signed =
    item.amount && item.amount !== "0"
      ? `${item.amount.startsWith("-") ? "" : "+"}${formatUnits(
          item.amount,
          item.decimals,
        )} ${item.symbol}`
      : null;
  const amountClass = activityAmountClass(item.kind, item.success, item.amount);

  return (
    <div className="flex items-center gap-2.5 py-2">
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
            "shrink-0",
            amountClass,
          )}
        >
          {hidden ? "••••" : signed}
        </span>
      ) : null}
    </div>
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
  onReloadBalances,
  onNavigate,
  onOpenChain,
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
  onReloadBalances: () => void;
  onNavigate: (route: PopupRoute) => void;
  onOpenChain: (chainId: string) => void;
  onOpenMenu: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [hostGranted, setHostGranted] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const { settings, update, hidden, toggleHidden } = usePrefs();
  const active =
    status.accounts.find((a) => a.index === status.activeAccountIndex) ??
    status.accounts[0];

  const primary = chains[0];
  const networkLabel = primary?.entry.chainName ?? `${chains.length} chains`;
  // The header names one chain, so show that chain's address rather than the
  // account's default derivation, which belongs to a different prefix.
  const headerAddress = primary?.address ?? active?.address;
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
  const readsLive = settings.liveBalances && hostGranted;

  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows: activity } = useActivity(chainIds, readsLive);
  const recentActivity = activity.slice(0, 5);

  useEffect(() => {
    void hasLiveBalancePermission().then(setHostGranted);
  }, []);

  async function enableLiveBalances() {
    setEnabling(true);
    try {
      const ok = (await hasLiveBalancePermission())
        ? true
        : await requestLiveBalancePermission();
      if (!ok) return;
      setHostGranted(true);
      await update({ liveBalances: true });
      onRefresh();
      window.setTimeout(() => onReloadBalances(), 50);
    } finally {
      setEnabling(false);
    }
  }

  async function copyAddress() {
    if (!headerAddress) return;
    await navigator.clipboard.writeText(headerAddress);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
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
            className={cn(
              "mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-dim",
              "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
              focusRing,
            )}
          >
            {headerAddress ? truncateAddress(headerAddress, 10, 6) : NO_VALUE}
            {copied ? (
              <IconCheck width={11} height={11} className="text-accent" />
            ) : (
              <IconCopy width={11} height={11} />
            )}
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
              public endpoint. Chrome will ask for host access once.
            </p>
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
            <ul className="flex flex-col">
              {chains.map((chain) => (
                <li key={chain.chainId}>
                  <NetworkRow
                    chain={chain}
                    balance={balances[chain.chainId]}
                    price={prices[chain.chainId]}
                    currency={currency}
                    hidden={hidden}
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
                title="Nothing staked"
                description="Delegate from a network page and your positions land here."
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {staked.map((chain) => (
                  <li key={chain.chainId}>
                    <NetworkRow
                      chain={chain}
                      balance={{
                        ...balances[chain.chainId]!,
                        available: balances[chain.chainId]!.staked,
                      }}
                      price={prices[chain.chainId]}
                      currency={currency}
                      hidden={hidden}
                      onOpen={() => onOpenChain(chain.chainId)}
                    />
                  </li>
                ))}
              </ul>
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
                      <ActivityRow item={item} hidden={hidden} />
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

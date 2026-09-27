import { useEffect, useMemo, useRef, useState } from "react";
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
} from "../../../lib/balances";
import type { PriceMap, SpotPrice } from "../../../lib/prices";
import type { ActivityItem } from "../../../lib/chain-queries";
import {
  groupHomeAssets,
  groupedSubtitle,
  homeAssets,
  type HomeAsset,
} from "../../../lib/home-assets";
import type { AssetListMode } from "../../../lib/settings";
import { computePortfolio, toWholeCoins } from "../../../lib/portfolio";
import { searchItems } from "../../../lib/picker";
import { sendToBackground } from "../../../lib/popup-client";
import {
  NO_VALUE,
  displaysAsZero,
  formatFiat,
  formatUnits,
  relativeTime,
} from "../../../lib/format";
import { ActivityBadge } from "../components/ActivityBadge";
import { HeroSkeleton, ListSkeleton } from "../components/ListSkeleton";
import { PopupHeader } from "../components/PopupHeader";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconChevronRight,
  IconGlobe,
  IconLayers,
  IconLock,
  IconReceive,
  IconRows,
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
          ? "bg-[image:var(--z-button-gradient)] text-[var(--z-button-fg)] shadow-[0_10px_22px_rgba(154,16,22,0.34)] hover:brightness-110 active:brightness-95 active:scale-[0.98]"
          : "border border-[var(--z-line)] bg-[image:var(--z-surface-raised-gradient)] text-fg hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] active:bg-[var(--z-state-press)] active:scale-[0.98]",
        focusRing,
      )}
    >
      {icon}
      <span className="text-[11px] font-semibold leading-none">{label}</span>
    </button>
  );
}

function AssetRow({
  asset,
  currency,
  hidden,
  verified,
  grouped,
  onOpen,
}: {
  asset: HomeAsset;
  currency: string;
  hidden: boolean;
  verified?: boolean;
  grouped?: boolean;
  onOpen: () => void;
}) {
  const { token } = asset;
  const bridged = token.kind === "ibc" || token.kind === "factory";
  const borrowedIcon = Boolean(
    bridged && token.iconUrl && token.iconUrl === asset.chainIconUrl,
  );
  const amount = formatUnits(token.amount, token.decimals, 2);
  const subtitle = grouped ? groupedSubtitle(token) : asset.subtitle;
  const fiat =
    asset.fiatValue !== null ? formatFiat(asset.fiatValue, currency) : null;
  const change = asset.change24h;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 items-center text-left",
        "transition-[background-color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
        "hover:bg-[var(--z-state-hover)] active:bg-[var(--z-state-press)]",
        grouped
          ? "gap-2 rounded-none px-2.5 py-1.5"
          : "gap-2.5 rounded-[10px] px-1.5 py-2",
        focusRing,
      )}
    >
      <TokenLogo
        src={borrowedIcon ? undefined : (token.iconUrl ?? asset.chainIconUrl)}
        symbol={token.symbol}
        size={grouped ? 26 : 32}
        verified={token.kind === "native" ? verified : false}
        verifiedLabel="Listed in the Cosmos chain registry"
        chainSrc={!grouped && bridged ? asset.chainIconUrl : undefined}
        chainLabel={!grouped && bridged ? asset.chainName : undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              "truncate font-semibold tracking-[-0.02em] text-fg",
              grouped ? "text-[12.5px]" : "text-[13px]",
            )}
          >
            {token.symbol}
          </span>
          {token.kind !== "native" ? (
            <span className="shrink-0 rounded-full bg-[var(--z-glass-2)] px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.08em] text-fg-dim">
              {asset.kindLabel}
            </span>
          ) : null}
        </span>
        {grouped && token.kind === "native" ? null : (
          <span className="mt-0.5 flex min-w-0 items-center gap-1 text-[11px] text-fg-muted">
            <span className="truncate">{subtitle}</span>
            {!grouped && asset.testnet ? (
              <IconLock
                width={9}
                height={9}
                aria-label="Testnet"
                className="shrink-0 text-fg-dim"
              />
            ) : null}
          </span>
        )}
      </span>
      <span className="max-w-[46%] shrink-0 text-right">
        <span
          className={cn(
            amountPrimaryClass,
            "block truncate",
            grouped ? "text-[13px]" : "text-[14px]",
          )}
        >
          {hidden ? "••••" : amount}
        </span>
        {fiat || (change !== null && token.amount !== "0") ? (
          <span
            className={cn(
              amountSecondaryClass,
              "mt-0.5 block truncate text-[10px]",
              !fiat && change !== null
                ? change >= 0
                  ? "text-[var(--z-success)]"
                  : "text-[var(--z-danger)]"
                : null,
            )}
          >
            {hidden
              ? "••••"
              : fiat
                ? fiat
                : `${change! >= 0 ? "+" : ""}${change!.toFixed(2)}%`}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function AssetModeSwitch({
  mode,
  onChange,
}: {
  mode: AssetListMode;
  onChange: (mode: AssetListMode) => void;
}) {
  return (
    <div
      className="grid h-8 w-[60px] shrink-0 grid-cols-2 items-center overflow-hidden rounded-full border border-[var(--z-line)] bg-[var(--z-glass)] p-[3px]"
      role="group"
      aria-label="Asset list layout"
    >
      {(
        [
          ["separate", "Show each token", IconRows],
          ["grouped", "Group by network", IconLayers],
        ] as const
      ).map(([value, label, Icon]) => {
        const on = mode === value;
        return (
          <button
            key={value}
            type="button"
            aria-label={label}
            aria-pressed={on}
            title={label}
            onClick={() => onChange(value)}
            className={cn(
              "flex h-full w-full items-center justify-center rounded-full p-0 leading-none",
              "transition-colors duration-[var(--z-duration-fast)]",
              on
                ? "bg-[var(--z-state-selected)] text-fg"
                : "text-fg-muted hover:text-fg",
              focusRing,
            )}
          >
            <Icon width={14} height={14} className="block shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

function ChainGroupHeader({
  name,
  iconUrl,
  testnet,
  count,
  fiat,
  hidden,
  currency,
  onOpen,
}: {
  name: string;
  iconUrl?: string;
  testnet: boolean;
  count: number;
  fiat: number | null;
  hidden: boolean;
  currency: string;
  onOpen: () => void;
}) {
  const meta = hidden
    ? "••••"
    : fiat !== null
      ? formatFiat(fiat, currency)
      : count === 1
        ? "1"
        : String(count);
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 border-b border-[var(--z-line)] px-2.5 py-2 text-left",
        "bg-[var(--z-glass-2)]",
        "transition-[background-color] duration-[var(--z-duration-fast)] ease-[var(--z-ease)]",
        "hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <TokenLogo src={iconUrl} symbol={name} size={20} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[12px] font-semibold tracking-[-0.02em] text-fg">
            {name}
          </span>
          {testnet ? (
            <IconLock
              width={9}
              height={9}
              aria-label="Testnet"
              className="shrink-0 text-fg-dim"
            />
          ) : null}
        </span>
      </span>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-fg-muted">
        {meta}
      </span>
      <IconChevronRight width={12} height={12} className="shrink-0 text-fg-dim" />
    </button>
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
      <ActivityBadge kind={item.kind} messageType={item.messageType} success={item.success} />
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
        verified={chain.entry.inCosmosRegistry}
        verifiedLabel="Listed in the Cosmos chain registry"
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
  const connectedDomain = grants[0] ? hostOf(grants[0].origin) : "";
  const [showConnected, setShowConnected] = useState(false);
  // A site that is already connected when the wallet opens stays quiet.
  // The bar only flashes when a new site connects while this screen is open.
  const announcedDomain = useRef<string | null>(null);
  useEffect(() => {
    if (!connectedDomain) {
      announcedDomain.current = null;
      setShowConnected(false);
      return;
    }
    if (announcedDomain.current === null || announcedDomain.current === connectedDomain) {
      announcedDomain.current = connectedDomain;
      return;
    }
    announcedDomain.current = connectedDomain;
    setShowConnected(true);
    const timer = window.setTimeout(() => setShowConnected(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [connectedDomain]);
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
  const assets = useMemo(
    () =>
      homeAssets(
        chains.map((chain) => ({
          chainId: chain.chainId,
          chainName: chain.entry.chainName,
          network: chain.entry.network,
          coinDenom: chain.entry.coinDenom,
          coinMinimalDenom: chain.entry.coinMinimalDenom,
          coinDecimals: chain.entry.coinDecimals,
          ...(chain.iconUrl ? { iconUrl: chain.iconUrl } : {}),
          ...(chain.entry.inCosmosRegistry
            ? { inCosmosRegistry: chain.entry.inCosmosRegistry }
            : {}),
        })),
        balances,
        prices,
      ),
    [chains, balances, prices],
  );
  const visibleAssets = useMemo(() => {
    const pool =
      heldOnly && readsLive
        ? assets.filter((asset) => asset.token.amount !== "0")
        : assets;
    const byKey = new Map(pool.map((asset) => [asset.key, asset]));
    return searchItems(
      pool.map((asset) => ({
        id: asset.key,
        label: asset.token.symbol,
        sublabel: asset.subtitle,
        keywords: [
          asset.chainId,
          asset.chainName,
          asset.token.displayName,
          asset.token.denom,
          asset.token.baseDenom ?? "",
          asset.token.originChainName ?? "",
          asset.kindLabel,
        ],
      })),
      query,
    ).flatMap((item) => byKey.get(item.id) ?? []);
  }, [assets, heldOnly, readsLive, query]);
  const chainById = useMemo(
    () => new Map(chains.map((chain) => [chain.chainId, chain])),
    [chains],
  );
  const listMode: AssetListMode =
    settings.assetListMode === "grouped" ? "grouped" : "separate";
  const groupedAssets = useMemo(
    () => groupHomeAssets(visibleAssets, chains.map((chain) => chain.chainId)),
    [visibleAssets, chains],
  );
  const staked = chains.filter((c) => {
    const b = balances[c.chainId];
    return b && !displaysAsZero(b.staked, b.decimals, 2);
  });

  const totals = useMemo(
    () => computePortfolio(balances, prices),
    [balances, prices],
  );
  const currency = (settings.currency ?? "USD").toUpperCase();
  const hasTotal = totals.pricedChains > 0;

  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows: activity, loading: activityLoading } = useActivity(
    chainIds,
    readsLive,
  );
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
            void sendToBackground("SET_ACTIVE_ACCOUNT", { index }).then(() => {
              onRefresh();
              onReloadBalances();
            });
          }}
          onAddAccount={() => onNavigate("add-account")}
          onManageWallets={() => onNavigate("wallets")}
          onNetworks={() => onNavigate("networks")}
          onNotifications={() => onNavigate("notifications")}
          onMenu={onOpenMenu}
        />
      }
    >
      {showConnected && connectedDomain ? (
        <ConnectedBanner domain={connectedDomain} onManage={() => onNavigate("sites")} />
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
            {readsLive && balancesLoading && !hasTotal && !hidden ? (
              <HeroSkeleton label="Loading total balance" />
            ) : (
              <>
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
              </>
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
            label="Deposit"
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
            <TabsTrigger value="tokens">Assets</TabsTrigger>
            <TabsTrigger value="staked">Staked</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>

          <TabsContent value="tokens" className="pt-0.5">
            <div className="mb-2 mt-2 flex h-8 items-center gap-1.5">
              <AssetModeSwitch
                mode={listMode}
                onChange={(mode) => void update({ assetListMode: mode })}
              />
              <SearchField
                compact
                className="min-w-0 flex-1"
                value={query}
                onValueChange={setQuery}
                placeholder="Search asset or network"
                aria-label="Search asset or network"
              />
              {readsLive ? (
                <button
                  type="button"
                  aria-pressed={heldOnly}
                  onClick={() => setHeldOnly((v) => !v)}
                  className={cn(
                    "flex h-8 shrink-0 items-center rounded-full border px-2.5 font-mono text-[9.5px] leading-none uppercase tracking-[0.08em]",
                    "transition-colors duration-[var(--z-duration-base)]",
                    heldOnly
                      ? "border-accent bg-[var(--z-state-selected)] text-fg"
                      : "border-[var(--z-line)] bg-[var(--z-glass)] text-fg-muted hover:border-[var(--z-line-strong)] hover:text-fg",
                    focusRing,
                  )}
                >
                  Held
                </button>
              ) : null}
            </div>
            {readsLive && balancesLoading && Object.keys(balances).length === 0 ? (
              <ListSkeleton
                rows={Math.min(5, Math.max(3, chains.length))}
                label="Loading balances"
              />
            ) : visibleAssets.length === 0 && chains.length > 0 ? (
              <p className="py-6 text-center text-[12px] text-fg-muted">
                {query.trim()
                  ? <>Nothing matches &ldquo;{query.trim()}&rdquo;{heldOnly ? " among held assets" : ""}.</>
                  : heldOnly
                    ? "No spendable assets yet."
                    : "No networks enabled."}
              </p>
            ) : (
              listMode === "grouped" ? (
                <ul className="flex flex-col gap-2">
                  {groupedAssets.map((group) => (
                    <li
                      key={group.chainId}
                      className="min-w-0 overflow-hidden rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)]"
                    >
                      <ChainGroupHeader
                        name={group.chainName}
                        iconUrl={group.chainIconUrl}
                        testnet={group.testnet}
                        count={group.assets.length}
                        fiat={group.fiatValue}
                        hidden={hidden}
                        currency={currency}
                        onOpen={() => onOpenChain(group.chainId)}
                      />
                      <ul className="divide-y divide-[var(--z-line)]">
                        {group.assets.map((asset) => (
                          <li key={asset.key}>
                            <AssetRow
                              asset={asset}
                              currency={currency}
                              hidden={hidden}
                              grouped
                              verified={
                                chainById.get(asset.chainId)?.entry.inCosmosRegistry
                              }
                              onOpen={() => onOpenChain(asset.chainId)}
                            />
                          </li>
                        ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              ) : (
                <ul className="flex flex-col">
                  {visibleAssets.map((asset) => (
                    <li key={asset.key}>
                      <AssetRow
                        asset={asset}
                        currency={currency}
                        hidden={hidden}
                        verified={chainById.get(asset.chainId)?.entry.inCosmosRegistry}
                        onOpen={() => onOpenChain(asset.chainId)}
                      />
                    </li>
                  ))}
                </ul>
              )
            )}
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
            {readsLive && balancesLoading && staked.length === 0 ? (
              <ListSkeleton rows={2} bordered label="Loading staked positions" />
            ) : staked.length === 0 ? (
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
            {activityLoading && recentActivity.length === 0 ? (
              <ListSkeleton rows={4} avatar={false} label="Loading activity" />
            ) : recentActivity.length === 0 ? (
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

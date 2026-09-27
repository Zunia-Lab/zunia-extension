import {
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  Spinner,
  TokenLogo,
  activityAmountClass,
  amountInlineClass,
  amountPrimaryClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance, TokenBalance } from "../../../lib/balances";
import type { ActivityItem } from "../../../lib/chain-queries";
import type { SpotPrice } from "../../../lib/prices";
import { toWholeCoins } from "../../../lib/portfolio";
import {
  NO_VALUE,
  formatFiat,
  formatUnits,
  relativeTime,
  shortDenom,
} from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconChevronRight,
  IconNft,
  IconReceive,
  IconSend,
  IconStake,
  IconSwap,
} from "./icons";
import { nftChainSupport } from "../../../lib/nft";
import { ActivityBadge } from "../components/ActivityBadge";
import { ListSkeleton } from "../components/ListSkeleton";

function Action({
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
          ? "bg-[image:var(--z-button-gradient)] text-[var(--z-button-fg)] shadow-[0_10px_22px_rgba(154,16,22,0.34)] hover:brightness-110 active:scale-[0.98] active:brightness-95"
          : "border border-[var(--z-line)] text-fg hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] active:scale-[0.98] active:bg-[var(--z-state-press)]",
        focusRing,
      )}
    >
      {icon}
      <span className="text-[10.5px] font-medium leading-none">{label}</span>
    </button>
  );
}

function TokenGroup({
  title,
  tokens,
  hidden,
  fallbackIcon,
}: {
  title: string;
  tokens: readonly TokenBalance[];
  hidden: boolean;
  fallbackIcon?: string;
}) {
  return (
    <section className="rounded-[14px] border border-[var(--z-line)] px-3 py-2">
      <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {title}
      </p>
      <ul className="divide-y divide-[var(--z-line)]">
        {tokens.map((token) => (
          <li key={token.denom} className="flex items-center gap-3 py-2">
            <TokenLogo
              src={token.iconUrl || fallbackIcon}
              symbol={token.symbol}
              size={28}
              chainSrc={
                token.kind === "ibc" || token.kind === "factory"
                  ? fallbackIcon
                  : undefined
              }
            />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate text-[12.5px] font-medium text-fg">
                  {token.symbol}
                </span>
                {token.kind !== "native" ? (
                  <span className="shrink-0 font-mono text-[8px] uppercase tracking-[0.08em] text-fg-dim">
                    {token.kind === "ibc"
                      ? "IBC"
                      : token.kind === "factory"
                        ? "Factory"
                        : "Asset"}
                  </span>
                ) : null}
              </span>
              <span className="mt-[2px] block truncate font-mono text-[8.5px] text-fg-dim">
                {token.kind === "ibc"
                  ? token.originChainName ||
                    token.baseDenom ||
                    shortDenom(token.denom)
                  : token.kind === "factory"
                    ? shortDenom(token.denom)
                    : token.baseDenom || token.denom}
              </span>
            </span>
            <span className={cn(amountInlineClass, "shrink-0")}>
              {hidden ? "••••" : formatUnits(token.amount, token.decimals, 6)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Breakdown({
  label,
  value,
  denom,
  fiat,
  accent,
}: {
  label: string;
  value: string;
  denom: string;
  fiat?: string | null;
  accent?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-dim">
        {label}
      </span>
      <span className="text-right">
        <span
          className={cn(
            amountPrimaryClass,
            "text-[14px]",
            accent ? "text-accent" : null,
          )}
        >
          {value}
          <span className="ml-1.5 font-mono text-[11px] font-semibold text-fg-muted">
            {denom}
          </span>
        </span>
        {fiat ? (
          <span className="mt-1 block font-mono text-[11px] font-semibold tabular-nums text-fg-muted">
            {fiat}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * One enabled chain, and the screen a token on Home opens: live balance
 * breakdown with fiat values, money actions, other denoms, and recent
 * transactions from the public endpoint.
 */
export function ChainDetailScreen({
  chain,
  balance,
  price,
  loading,
  onBack,
  onNavigate,
  onOpenTx,
}: {
  chain: ChainAccountView;
  balance?: ChainBalance;
  price?: SpotPrice;
  loading: boolean;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId: string) => void;
  onOpenTx: (item: ActivityItem) => void;
}) {
  const { settings, hidden } = usePrefs();
  const entry = chain.entry;
  const currency = (settings.currency ?? "USD").toUpperCase();
  const live = settings.liveBalances;
  const { rows: activity, loading: activityLoading } = useActivity(
    [chain.chainId],
    live,
  );
  const recent = activity.slice(0, 5);
  const tokens = balance?.tokens ?? [];
  const ibcTokens = tokens.filter((t) => t.kind === "ibc");
  const factoryTokens = tokens.filter((t) => t.kind === "factory");
  const otherTokens = tokens.filter((t) => t.kind !== "native" && t.kind !== "ibc" && t.kind !== "factory");
  // Only 118 of the 332 registry chains declare `cosmwasm`, so the NFT row is
  // usually the disabled one. It says why rather than disappearing, because a
  // missing entry reads as a bug and an empty NFT list reads as "you own none".
  const nftSupport = nftChainSupport(chain.chainId);

  const show = (raw: string | undefined) => {
    if (hidden) return "••••";
    if (!raw || !balance) return NO_VALUE;
    return formatUnits(raw, balance.decimals);
  };

  /** Fiat for a base-unit amount, or null when this chain has no price. */
  const fiat = (raw: string | undefined) => {
    if (hidden || !raw || !balance || !price) return null;
    return formatFiat(
      toWholeCoins(raw, balance.decimals) * price.price,
      currency,
    );
  };

  const totalFiat =
    balance && price
      ? fiat(
          (
            BigInt(balance.available) +
            BigInt(balance.staked) +
            BigInt(balance.rewards)
          ).toString(),
        )
      : null;

  return (
    <ScreenScaffold
      title={entry.chainName}
      onBack={onBack}
      right={
        entry.network === "testnet" ? (
          <Pill tone="warning">testnet</Pill>
        ) : (
          <Pill tone="success">mainnet</Pill>
        )
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <section className="flex items-center gap-3">
          <TokenLogo
            src={chain.iconUrl}
            symbol={entry.chainName}
            size={42}
            verified={entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-[26px] font-semibold leading-none tracking-[-0.04em] text-fg">
                {loading ? <Spinner /> : show(balance?.available)}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-fg-dim">
                {entry.coinDenom}
              </span>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
              <span>{entry.chainId}</span>
              {totalFiat ? (
                <span className="text-fg-muted">{totalFiat} total</span>
              ) : null}
              {price ? (
                <span
                  className={cn(
                    "normal-case tracking-normal",
                    price.change24h >= 0
                      ? "text-[var(--z-success)]"
                      : "text-[var(--z-danger)]",
                  )}
                >
                  {price.change24h >= 0 ? "+" : ""}
                  {price.change24h.toFixed(1)}%
                </span>
              ) : null}
            </p>
          </div>
        </section>

        <section className="flex gap-2">
          <Action
            label="Send"
            primary
            icon={<IconSend width={18} height={18} />}
            onClick={() => onNavigate("send", chain.chainId)}
          />
          <Action
            label="Deposit"
            icon={<IconReceive width={18} height={18} />}
            onClick={() => onNavigate("receive", chain.chainId)}
          />
          <Action
            label="Swap"
            icon={<IconSwap width={18} height={18} />}
            onClick={() => onNavigate("swap", chain.chainId)}
          />
          <Action
            label="Stake"
            icon={<IconStake width={18} height={18} />}
            onClick={() => onNavigate("earn", chain.chainId)}
          />
        </section>

        {/* Collectibles, as a row rather than a fifth action button: four
            buttons already fill a 360px popup, and this one has to be able to
            carry a sentence when the chain cannot hold NFTs at all. */}
        <button
          type="button"
          disabled={!nftSupport.supported}
          onClick={() => onNavigate("nft", chain.chainId)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-[14px] border border-[var(--z-line)] px-3 py-2.5 text-left",
            "hover:bg-[var(--z-state-hover)] disabled:cursor-not-allowed disabled:hover:bg-transparent",
            focusRing,
          )}
        >
          <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--z-line)] text-fg-muted">
            <IconNft width={15} height={15} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[12.5px] text-fg">NFTs</span>
            <span className="mt-0.5 block text-[10px] leading-snug text-fg-muted">
              {nftSupport.supported
                ? "CW721 collections held by this address."
                : nftSupport.reason}
            </span>
          </span>
          {nftSupport.supported ? (
            <IconChevronRight width={14} height={14} className="shrink-0 text-fg-dim" />
          ) : null}
        </button>

        <section className="divide-y divide-[var(--z-line)] rounded-[14px] border border-[var(--z-line)] px-3 py-1">
          <Breakdown
            label="Available"
            value={show(balance?.available)}
            denom={entry.coinDenom}
            fiat={fiat(balance?.available)}
          />
          <Breakdown
            label="Staked"
            value={show(balance?.staked)}
            denom={entry.coinDenom}
            fiat={fiat(balance?.staked)}
          />
          <Breakdown
            label="Rewards"
            value={show(balance?.rewards)}
            denom={entry.coinDenom}
            fiat={fiat(balance?.rewards)}
            accent
          />
        </section>

        {ibcTokens.length > 0 ? (
          <TokenGroup
            title="IBC tokens"
            tokens={ibcTokens}
            hidden={hidden}
            fallbackIcon={chain.iconUrl}
          />
        ) : null}
        {factoryTokens.length > 0 ? (
          <TokenGroup
            title="Token factory"
            tokens={factoryTokens}
            hidden={hidden}
            fallbackIcon={chain.iconUrl}
          />
        ) : null}
        {otherTokens.length > 0 ? (
          <TokenGroup
            title="Other assets"
            tokens={otherTokens}
            hidden={hidden}
            fallbackIcon={chain.iconUrl}
          />
        ) : null}

        {balance?.error ? (
          <Callout tone="warning" title="Could not reach this chain">
            {balance.error}. Your address is still derived locally. Open Deposit
            to copy it or show the QR.
          </Callout>
        ) : null}

        {!live ? (
          <Callout tone="info" title="Balances are off">
            Turn on live balances from Home to load amounts and recent
            transactions for this network.
          </Callout>
        ) : null}

        <section>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Recent activity
            </p>
            <button
              type="button"
              onClick={() => onNavigate("activity", chain.chainId)}
              className={cn(
                "rounded-full px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent",
                "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
                focusRing,
              )}
            >
              View all
            </button>
          </div>
          {!live ? (
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              Enable live balances to pull history from this chain&rsquo;s
              public endpoint.
            </p>
          ) : activityLoading && recent.length === 0 ? (
            <ListSkeleton rows={3} label="Loading recent activity" />
          ) : recent.length === 0 ? (
            <EmptyState
              icon={<IconActivity width={16} height={16} />}
              title="No recent activity"
              description="Transfers that touch this address on this chain show up here."
            />
          ) : (
            <ul className="flex flex-col">
              {recent.map((item) => {
                const signed =
                  item.amount && item.amount !== "0"
                    ? `${item.amount.startsWith("-") ? "" : "+"}${formatUnits(
                        item.amount,
                        item.decimals,
                      )} ${item.symbol}`
                    : null;
                const amountClass = activityAmountClass(
                  item.kind,
                  item.success,
                  item.amount,
                );
                return (
                  <li
                    key={`${item.chainId}:${item.hash}`}
                    className="border-b border-[var(--z-line)] last:border-b-0"
                  >
                    <button
                      type="button"
                      onClick={() => onOpenTx(item)}
                      className={cn(
                        "-mx-1.5 flex w-[calc(100%+12px)] items-center gap-2.5 rounded-[10px] px-1.5 py-2.5 text-left",
                        "hover:bg-[var(--z-state-hover)]",
                        focusRing,
                      )}
                    >
                      <ActivityBadge
                        kind={item.kind}
                        messageType={item.messageType}
                        success={item.success}
                      />
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
                  </li>
                );
              })}
            </ul>
          )}
          {live && recent.length > 0 ? (
            <Button
              variant="secondary"
              className="mt-2 w-full"
              onClick={() => onNavigate("activity", chain.chainId)}
            >
              View all activities
            </Button>
          ) : null}
        </section>
      </div>
    </ScreenScaffold>
  );
}

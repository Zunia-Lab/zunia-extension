import { useId, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  Spinner,
  TokenLogo,
  amountInlineClass,
  amountPrimaryClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance, TokenBalance } from "../../../lib/balances";
import { chainTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import type { ActivityItem } from "../../../lib/chain-queries";
import { groupedSubtitle, listAmount, type HeldIdentify } from "../../../lib/home-assets";
import type { SpotPrice } from "../../../lib/prices";
import { toWholeCoins } from "../../../lib/portfolio";
import { NO_VALUE, formatFiat, formatFiatPrice, relativeTime, shortDenom } from "../../../lib/format";
import { formatTokenAmount } from "../../../lib/token-amount";
import type { TokenIdentity } from "../../../lib/token-identity";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconNft,
  IconReceive,
  IconSend,
  IconStake,
  IconSwap,
} from "./icons";
import { nftChainSupport } from "../../../lib/nft";
import { ActivityBadge } from "../components/ActivityBadge";
import { ListSkeleton } from "../components/ListSkeleton";
import { TokenAvatar, TokenTicker, provenanceLabel } from "../components/TokenLabel";
import { ActivityAmountText, assetRowLabel, useHeldIdentify } from "./HomeScreen";

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

/** `channel-750 → Noble`, one hop at a time; a hop nothing names reads `unknown chain`. */
function pathText(identity: TokenIdentity): string | null {
  const parts = identity.path.split("/");
  if (!identity.path || parts.length % 2 !== 0) return null;
  const hops: string[] = [];
  for (let hop = 0; hop < parts.length / 2; hop += 1) {
    const next = identity.hopChainIds[hop];
    const name = next ? (findCatalogEntry(next)?.chainName ?? next) : "unknown chain";
    hops.push(`${parts[hop * 2 + 1]} → ${name}`);
  }
  return hops.join(" · ");
}

/** The chain that issued the token, or `Unknown` when nothing proves it. */
function issuerText(identity: TokenIdentity): string {
  if (!identity.originChainId) return "Unknown";
  return identity.originChainName ?? identity.originChainId;
}

/**
 * The facts behind a row's name, for whoever wants to check them: the exact
 * denom (copyable), the IBC path hop by hop, the issuer and the denom there,
 * and how the identity was proven, or that it was not.
 */
function TokenDetails({
  id,
  identity,
  onCopy,
}: {
  id: string;
  identity: TokenIdentity;
  onCopy: (denom: string) => void;
}) {
  const path = pathText(identity);
  const proof = provenanceLabel(identity);
  const row = "flex min-w-0 items-baseline justify-between gap-3";
  const label = "shrink-0 text-fg-muted";
  const value = "min-w-0 text-right text-fg [overflow-wrap:anywhere]";
  return (
    <div
      id={id}
      className="mb-2 ml-10 flex flex-col gap-1.5 rounded-[10px] bg-[var(--z-glass)] px-2.5 py-2 font-mono text-[10px] leading-snug"
    >
      <div className={row}>
        <span className={label}>Denom</span>
        <span className="flex min-w-0 items-baseline justify-end gap-1.5">
          <span className={value}>{identity.denom}</span>
          <button
            type="button"
            onClick={() => onCopy(identity.denom)}
            aria-label={`Copy the denom of ${identity.ticker}`}
            className={cn(
              "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-accent",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
          >
            <IconCopy width={10} height={10} />
            Copy
          </button>
        </span>
      </div>
      {path ? (
        <div className={row}>
          <span className={label}>Path</span>
          <span className={value}>{path}</span>
        </div>
      ) : null}
      <div className={row}>
        <span className={label}>Issued on</span>
        <span className={value}>{issuerText(identity)}</span>
      </div>
      {identity.originDenom && identity.originDenom !== identity.denom ? (
        <div className={row}>
          <span className={label}>Origin denom</span>
          <span className={value} title={identity.originDenom}>
            {shortDenom(identity.originDenom)}
          </span>
        </div>
      ) : null}
      <p className={cn("text-right", proof ? "text-fg" : "text-[var(--z-warning)]")}>
        {proof ??
          (identity.originChainId
            ? "Not verified: no registry or checked IBC path names this token."
            : "Not verified: nothing proves where this token comes from.")}
      </p>
    </div>
  );
}

function TokenRow({
  chainId,
  token,
  hidden,
  identify,
  onCopy,
}: {
  chainId: string;
  token: TokenBalance;
  hidden: boolean;
  identify: HeldIdentify;
  onCopy: (denom: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const identity = identify(chainId, token);
  const subtitle = groupedSubtitle(identity);
  const { figure, words } = listAmount(token.amount, identity, hidden);
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailsId : undefined}
        aria-label={assetRowLabel(identity, { figure, words }, null, hidden)}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "-mx-1.5 flex w-[calc(100%+12px)] items-center gap-3 rounded-[10px] px-1.5 py-2 text-left",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        <TokenAvatar identity={identity} size={28} locationBadge="never" />
        <span className="min-w-0 flex-1">
          <TokenTicker identity={identity} className="text-[12.5px] font-medium text-fg" />
          {subtitle ? (
            // Two lines before a cut: an unknown token's short denom is the
            // one thing that tells it apart, so its tail stays in view.
            <span
              className="mt-[2px] line-clamp-2 text-[10.5px] text-fg-muted [overflow-wrap:anywhere]"
              title={subtitle}
            >
              {subtitle}
            </span>
          ) : null}
        </span>
        <span
          className={cn("shrink-0 text-right", words === null ? "max-w-[46%]" : "max-w-[34%]")}
        >
          <span
            className={
              words === null
                ? cn(amountInlineClass, "block truncate")
                : "block font-mono text-[11px] font-semibold leading-tight tabular-nums text-fg [overflow-wrap:anywhere]"
            }
          >
            {figure}
          </span>
          {words !== null ? (
            <span className="mt-0.5 block font-mono text-[9.5px] text-fg-muted">{words}</span>
          ) : null}
        </span>
        <IconChevronDown
          width={10}
          height={10}
          aria-hidden="true"
          className={cn(
            "shrink-0 text-fg-dim transition-transform duration-[var(--z-duration-base)]",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? <TokenDetails id={detailsId} identity={identity} onCopy={onCopy} /> : null}
    </li>
  );
}

/**
 * Tokens of one kind held on this chain, each drawn from its identity: the
 * token's own logo (never the chain's), the seal only when the identity is
 * proven, the ticker, and what the token is. The page names the chain, so
 * there is no location badge and no "on <chain>". A row opens the facts
 * behind its name.
 */
function TokenGroup({
  title,
  chainId,
  tokens,
  hidden,
  identify,
  onCopy,
}: {
  title: string;
  chainId: string;
  tokens: readonly TokenBalance[];
  hidden: boolean;
  identify: HeldIdentify;
  onCopy: (denom: string) => void;
}) {
  return (
    <section className="rounded-[14px] border border-[var(--z-line)] px-3 py-1">
      <p className="mb-0.5 mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {title}
      </p>
      <ul className="divide-y divide-[var(--z-line)]">
        {tokens.map((token) => (
          <TokenRow
            key={token.denom}
            chainId={chainId}
            token={token}
            hidden={hidden}
            identify={identify}
            onCopy={onCopy}
          />
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
  const toast = useToast();
  // Rows re-render with token facts proven after this page opened.
  const identify = useHeldIdentify();
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

  // The chain's own coin, shown the way Home's row for it reads.
  const coin = balance
    ? identify(chain.chainId, { denom: balance.denom, decimals: balance.decimals })
    : null;
  // History amounts of a held coin nothing names use its balance row's scale,
  // as Home and the Activity screen do.
  const heldBalances = balance ? { [chain.chainId]: balance } : undefined;
  const show = (raw: string | undefined) => {
    if (hidden) return "••••";
    if (!raw || !coin) return NO_VALUE;
    return formatTokenAmount(raw, coin, "list");
  };

  /** Fiat for a base-unit amount, or null when this chain has no price. */
  const fiat = (raw: string | undefined) => {
    if (hidden || !raw || !coin?.decimalsKnown || !price) return null;
    return formatFiat(toWholeCoins(raw, coin.decimals) * price.price, currency);
  };

  async function copyDenom(denom: string) {
    try {
      await navigator.clipboard.writeText(denom);
      toast("Denom copied", { meta: shortDenom(denom) });
    } catch {
      toast("Could not copy the denom", { tone: "danger" });
    }
  }

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
                {chainTicker(entry)}
              </span>
            </div>
            <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
              <span>{entry.chainId}</span>
              {totalFiat ? (
                <span className="text-fg-muted">{totalFiat} total</span>
              ) : null}
              {price ? (
                <span className="normal-case tracking-normal text-fg-muted">
                  {formatFiatPrice(price.price, currency)}
                </span>
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
              {price?.source ? (
                // One exchange market, not an aggregate: say which, and link it.
                <a
                  href={price.source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Price from the ${price.source.pair} market on ${price.source.name}`}
                  className="normal-case tracking-normal text-fg-dim underline decoration-dotted underline-offset-2 hover:text-fg"
                >
                  via {price.source.name}
                </a>
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
            denom={chainTicker(entry)}
            fiat={fiat(balance?.available)}
          />
          <Breakdown
            label="Staked"
            value={show(balance?.staked)}
            denom={chainTicker(entry)}
            fiat={fiat(balance?.staked)}
          />
          <Breakdown
            label="Rewards"
            value={show(balance?.rewards)}
            denom={chainTicker(entry)}
            fiat={fiat(balance?.rewards)}
            accent
          />
        </section>

        {ibcTokens.length > 0 ? (
          <TokenGroup
            title="IBC tokens"
            chainId={chain.chainId}
            tokens={ibcTokens}
            hidden={hidden}
            identify={identify}
            onCopy={(denom) => void copyDenom(denom)}
          />
        ) : null}
        {factoryTokens.length > 0 ? (
          <TokenGroup
            title="Token factory"
            chainId={chain.chainId}
            tokens={factoryTokens}
            hidden={hidden}
            identify={identify}
            onCopy={(denom) => void copyDenom(denom)}
          />
        ) : null}
        {otherTokens.length > 0 ? (
          <TokenGroup
            title="Other assets"
            chainId={chain.chainId}
            tokens={otherTokens}
            hidden={hidden}
            identify={identify}
            onCopy={(denom) => void copyDenom(denom)}
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
              {recent.map((item) => (
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
                      <span className="line-clamp-2 text-[11.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
                        {item.title}
                      </span>
                      <span className="mt-[2px] flex min-w-0 font-mono text-[8.5px] text-fg-dim">
                        <span className="truncate">{item.subtitle}</span>
                        <span className="shrink-0 whitespace-pre"> · {relativeTime(item.timestamp)}</span>
                      </span>
                    </span>
                    <ActivityAmountText item={item} hidden={hidden} balances={heldBalances} />
                  </button>
                </li>
              ))}
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

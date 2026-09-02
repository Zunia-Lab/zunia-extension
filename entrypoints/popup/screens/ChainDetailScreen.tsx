import {
  Avatar,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  Spinner,
  TokenLogo,
  activityAmountClass,
  activityPresentation,
  amountInlineClass,
  amountPrimaryClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import type { SpotPrice } from "../../../lib/prices";
import { toWholeCoins } from "../../../lib/portfolio";
import {
  NO_VALUE,
  formatFiat,
  formatUnits,
  relativeTime,
} from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useActivity } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import {
  IconActivity,
  IconReceive,
  IconSend,
  IconStake,
  IconSwap,
} from "./icons";

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
          ? "bg-[image:var(--z-accent-gradient)] text-[var(--z-accent-fg)] shadow-[var(--z-accent-glow)] hover:brightness-110 active:scale-[0.98] active:brightness-95"
          : "border border-[var(--z-line)] text-fg hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] active:scale-[0.98] active:bg-[var(--z-state-press)]",
        focusRing,
      )}
    >
      {icon}
      <span className="text-[10.5px] font-medium leading-none">{label}</span>
    </button>
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
 * One enabled chain: live balance breakdown, money actions, other denoms,
 * and recent transactions from the public endpoint.
 */
export function ChainDetailScreen({
  chain,
  balance,
  price,
  loading,
  onBack,
  onNavigate,
}: {
  chain: ChainAccountView;
  balance?: ChainBalance;
  price?: SpotPrice;
  loading: boolean;
  onBack: () => void;
  onNavigate: (route: PopupRoute, chainId: string) => void;
}) {
  const { settings, hidden } = usePrefs();
  const entry = chain.entry;
  const currency = (settings.currency ?? "USD").toUpperCase();
  const live = settings.liveBalances;
  const { rows: activity, loading: activityLoading } = useActivity(
    [chain.chainId],
    live,
  );
  const recent = activity.slice(0, 8);
  const extras = (balance?.tokens ?? []).filter((t) => t.kind !== "native");

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
          <Avatar src={chain.iconUrl} fallback={entry.chainName} size={42} />
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
            label="Receive"
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

        {extras.length > 0 ? (
          <section className="rounded-[14px] border border-[var(--z-line)] px-3 py-2">
            <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Other tokens
            </p>
            <ul className="divide-y divide-[var(--z-line)]">
              {extras.map((token) => (
                <li
                  key={token.denom}
                  className="flex items-center gap-3 py-2"
                >
                  <TokenLogo
                    src={token.iconUrl}
                    symbol={token.symbol}
                    size={28}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-fg">
                      {token.displayName}
                    </span>
                    {token.baseDenom ? (
                      <span className="mt-[2px] block truncate font-mono text-[8.5px] text-fg-dim">
                        {token.baseDenom}
                      </span>
                    ) : null}
                  </span>
                  <span className={cn(amountInlineClass, "shrink-0")}>
                    {hidden
                      ? "••••"
                      : formatUnits(token.amount, token.decimals)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {balance?.error ? (
          <Callout tone="warning" title="Could not reach this chain">
            {balance.error}. Your address is still derived locally — open Receive
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
          <p className="mb-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
            Recent transactions
          </p>
          {!live ? (
            <p className="text-[11.5px] leading-relaxed text-fg-dim">
              Enable live balances to pull history from this chain&rsquo;s
              public endpoint.
            </p>
          ) : activityLoading && recent.length === 0 ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : recent.length === 0 ? (
            <EmptyState
              icon={<IconActivity width={16} height={16} />}
              title="No recent activity"
              description="Transfers that touch this address on this chain show up here."
            />
          ) : (
            <ul className="flex flex-col">
              {recent.map((item) => {
                const presentation = activityPresentation(
                  item.kind,
                  item.success,
                );
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
                    className="flex items-center gap-2.5 border-b border-[var(--z-line)] py-2.5 last:border-b-0"
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
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </ScreenScaffold>
  );
}

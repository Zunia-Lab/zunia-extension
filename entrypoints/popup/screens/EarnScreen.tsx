import { useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  Spinner,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  amountInlineClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import type {
  DelegationInfo,
  UnbondingInfo,
  ValidatorInfo,
} from "../../../lib/chain-queries";
import { NO_VALUE, formatUnits } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import {
  useDelegations,
  useUnbonding,
  useValidators,
} from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { IconChevronDown, IconStake } from "./icons";

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function daysUntil(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms)) return "pending";
  if (ms <= 0) return "ready to claim";
  const days = Math.ceil(ms / 86_400_000);
  return days > 1 ? `${days} days left` : "less than a day";
}

/** Chain switcher that lives in the header slot, per the design. */
function ChainSelect({
  chains,
  value,
  onChange,
}: {
  chains: ChainAccountView[];
  value: string;
  onChange: (chainId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = chains.find((c) => c.chainId === value);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-1.5 pr-2",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        {active ? (
          <Avatar
            src={active.iconUrl}
            fallback={active.entry.chainName}
            size={16}
          />
        ) : null}
        <span className="max-w-[92px] truncate text-[11px] text-fg-muted">
          {active?.entry.chainName ?? "Chain"}
        </span>
        <IconChevronDown
          width={16}
          height={16}
          className={cn("text-fg-dim transition-transform", open && "rotate-180")}
        />
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close chain picker"
            className="fixed inset-0 z-30 cursor-default"
            onClick={() => setOpen(false)}
          />
          <ul
            className={cn(
              "absolute right-0 top-[calc(100%+6px)] z-40 max-h-[240px] w-[196px] overflow-y-auto",
              "rounded-[14px] border border-[var(--z-line-strong)] bg-[var(--z-surface-raised)] p-1",
              "shadow-[var(--z-shadow-overlay)]",
            )}
          >
            {chains.map((chain) => (
              <li key={chain.chainId}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(chain.chainId);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left",
                    "hover:bg-[var(--z-state-hover)]",
                    chain.chainId === value && "bg-[var(--z-state-selected)]",
                    focusRing,
                  )}
                >
                  <Avatar
                    src={chain.iconUrl}
                    fallback={chain.entry.chainName}
                    size={20}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] text-fg">
                      {chain.entry.chainName}
                    </span>
                    <span className="block truncate font-mono text-[9px] text-fg-dim">
                      {chain.chainId}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function ValidatorItem({
  validator,
  delegated,
  decimals,
  symbol,
  hidden,
  selected,
  onSelect,
}: {
  validator: ValidatorInfo;
  delegated?: DelegationInfo;
  decimals: number;
  symbol: string;
  hidden: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] border px-2.5 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)]",
        selected
          ? "border-[var(--z-line-strong)] bg-[var(--z-state-selected)]"
          : "border-transparent hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <Avatar fallback={validator.moniker} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {validator.moniker}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate font-mono text-[9.5px]",
            validator.jailed ? "text-[var(--z-danger)]" : "text-fg-dim",
          )}
        >
          {validator.jailed
            ? "jailed · redelegate"
            : `${pct(validator.commission, 0)} comm · ${pct(validator.votingPower, 2)} power`}
        </span>
      </span>
      {validator.jailed ? (
        <Pill tone="danger">Move</Pill>
      ) : (
        <span className="shrink-0 text-right">
          <span className={cn(amountInlineClass, "block")}>
            {delegated
              ? hidden
                ? "••••"
                : `${formatUnits(delegated.amount, decimals, 2)} ${symbol}`
              : NO_VALUE}
          </span>
          <span className="mt-[3px] block font-mono text-[9px] text-fg-dim">
            {delegated ? "delegated" : "not staked"}
          </span>
        </span>
      )}
    </button>
  );
}

/** Staking home: portfolio hero, validator directory, positions and unbondings. */
export function EarnScreen({
  chains,
  balances,
  initialChainId,
  onOpenChain,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  /** Set when arriving from a chain page, so Stake opens on that chain. */
  initialChainId?: string;
  onOpenChain: (chainId: string) => void;
}) {
  const { settings, hidden } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const [chainId, setChainId] = useState(
    initialChainId ?? chains[0]?.chainId ?? "",
  );
  const [picked, setPicked] = useState<string | null>(null);

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const decimals = chain?.entry.coinDecimals ?? 6;
  const symbol = chain?.entry.coinDenom ?? "";

  const validators = useValidators(chain?.chainId ?? "", live);
  const delegations = useDelegations(chainIds, live);
  const unbonding = useUnbonding(chainIds, live);

  const totals = useMemo(() => {
    let staked = 0n;
    let rewards = 0n;
    for (const c of chains) {
      const b = balances[c.chainId];
      if (!b) continue;
      staked += BigInt(b.staked || "0");
      rewards += BigInt(b.rewards || "0");
    }
    return { staked, rewards };
  }, [chains, balances]);

  const chainDelegations = delegations.rows.filter(
    (d) => d.chainId === chain?.chainId,
  );
  const delegationByValidator = new Map(
    chainDelegations.map((d) => [d.validatorAddress, d]),
  );
  const activeChains = chains.filter((c) => {
    const staked = balances[c.chainId]?.staked;
    return staked && staked !== "0";
  });

  const heroStaked = hidden
    ? "••••"
    : live && totals.staked > 0n
      ? formatUnits(totals.staked.toString(), decimals, 2)
      : NO_VALUE;
  const heroRewards = hidden
    ? "••••"
    : live && totals.rewards > 0n
      ? formatUnits(totals.rewards.toString(), decimals, 2)
      : NO_VALUE;

  return (
    <ScreenScaffold
      title="Earn"
      right={
        chains.length > 0 ? (
          <ChainSelect
            chains={chains}
            value={chain?.chainId ?? ""}
            onChange={(next) => {
              setChainId(next);
              setPicked(null);
            }}
          />
        ) : undefined
      }
      footer={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => chain && onOpenChain(chain.chainId)}
          >
            Compare
          </Button>
          <Button className="flex-1" disabled={!picked}>
            Delegate
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5 pt-1">
        <section
          className={cn(
            "rounded-[16px] border border-[var(--z-line-strong)] px-3.5 py-3",
            "bg-[color-mix(in_srgb,var(--z-accent)_10%,transparent)]",
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                Staked
              </p>
              <p className="mt-1 truncate text-[24px] font-medium leading-none tracking-[-0.035em] text-fg">
                {heroStaked}
                {heroStaked !== NO_VALUE && heroStaked !== "••••" ? (
                  <span className="ml-1.5 font-mono text-[11px] text-fg-dim">
                    {symbol}
                  </span>
                ) : null}
              </p>
            </div>
            <div className="shrink-0 text-right">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                Networks
              </p>
              <p className="mt-1 text-[24px] font-medium leading-none tracking-[-0.035em] text-accent">
                {activeChains.length}
              </p>
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between gap-3 border-t border-[var(--z-line)] pt-2.5">
            <p className="min-w-0 truncate font-mono text-[10px] text-fg-dim">
              Claimable{" "}
              <span className="text-fg-muted">
                {heroRewards}
                {heroRewards !== NO_VALUE && heroRewards !== "••••"
                  ? ` ${symbol}`
                  : ""}
              </span>
            </p>
            <Button size="sm" variant="secondary" disabled>
              Claim all
            </Button>
          </div>
        </section>

        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Turn on live balances in Preferences to load validators, positions
            and rewards from each chain's public endpoint.
          </Callout>
        ) : null}

        <Tabs defaultValue="validators">
          <TabsList>
            <TabsTrigger value="validators">Validators</TabsTrigger>
            <TabsTrigger value="mine">My stake</TabsTrigger>
            <TabsTrigger value="unbonding">Unbonding</TabsTrigger>
          </TabsList>

          <TabsContent value="validators" className="pt-1">
            {validators.loading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : validators.rows.length === 0 ? (
              <EmptyState
                icon={<IconStake width={16} height={16} />}
                title="No validator set"
                description={
                  live
                    ? "This chain's endpoint did not return a bonded validator set."
                    : "Validators load once on-chain reads are on."
                }
              />
            ) : (
              <ul className="-mx-1 flex flex-col">
                {validators.rows.slice(0, 40).map((validator) => (
                  <li key={validator.operatorAddress}>
                    <ValidatorItem
                      validator={validator}
                      delegated={delegationByValidator.get(
                        validator.operatorAddress,
                      )}
                      decimals={decimals}
                      symbol={symbol}
                      hidden={hidden}
                      selected={picked === validator.operatorAddress}
                      onSelect={() =>
                        setPicked((v) =>
                          v === validator.operatorAddress
                            ? null
                            : validator.operatorAddress,
                        )
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="mine" className="pt-1">
            {delegations.loading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : delegations.rows.length === 0 ? (
              <EmptyState
                icon={<IconStake width={16} height={16} />}
                title="No delegations"
                description="Pick a validator and delegate to start earning."
              />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {delegations.rows.map((row) => (
                  <li key={`${row.chainId}:${row.validatorAddress}`}>
                    <PositionRow row={row} hidden={hidden} onOpen={onOpenChain} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="unbonding" className="pt-1">
            {unbonding.loading ? (
              <div className="flex justify-center py-8">
                <Spinner />
              </div>
            ) : unbonding.rows.length === 0 ? (
              <EmptyState
                icon={<IconStake width={16} height={16} />}
                title="Nothing unbonding"
                description="Undelegated stake shows here until the chain releases it."
              />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {unbonding.rows.map((row, index) => (
                  <li key={`${row.chainId}:${row.validatorAddress}:${index}`}>
                    <UnbondingRow row={row} hidden={hidden} />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>

        <Callout tone="neutral" title="Delegating needs signing">
          Positions and rewards are read live. The delegate and claim
          transactions land with the broadcasting path.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

function PositionRow({
  row,
  hidden,
  onOpen,
}: {
  row: DelegationInfo;
  hidden: boolean;
  onOpen: (chainId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(row.chainId)}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <Avatar fallback={row.moniker} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {row.moniker}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
          {row.chainId}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className={cn(amountInlineClass, "block")}>
          {hidden
            ? "••••"
            : `${formatUnits(row.amount, row.decimals, 2)} ${row.symbol}`}
        </span>
        <span className="mt-[3px] block font-mono text-[11px] font-bold tabular-nums text-accent">
          {hidden ? "••••" : `+${formatUnits(row.rewards, row.decimals, 2)}`}
        </span>
      </span>
    </button>
  );
}

function UnbondingRow({
  row,
  hidden,
}: {
  row: UnbondingInfo;
  hidden: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5">
      <Avatar fallback={row.moniker} size={28} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">
          {row.moniker}
        </span>
        <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
          {daysUntil(row.completionTime)}
        </span>
      </span>
      <span className={cn(amountInlineClass, "shrink-0 text-fg-muted")}>
        {hidden
          ? "••••"
          : `${formatUnits(row.amount, row.decimals, 2)} ${row.symbol}`}
      </span>
    </div>
  );
}

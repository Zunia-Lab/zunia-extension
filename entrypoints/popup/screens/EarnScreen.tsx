import { useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  EmptyState,
  FeeSummary,
  Input,
  KeyValueRow,
  Pill,
  ScreenScaffold,
  SearchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  amountInlineClass,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import type {
  DelegationInfo,
  UnbondingInfo,
  ValidatorInfo,
} from "../../../lib/chain-queries";
import {
  estimateFee,
  msgDelegate,
  msgWithdrawReward,
} from "../../../lib/amino-tx";
import { NO_VALUE, formatUnits } from "../../../lib/format";
import { searchItems } from "../../../lib/picker";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import {
  useDelegations,
  useUnbonding,
  useValidators,
} from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { ChainSheet } from "../components/ChainSheet";
import { ListSkeleton } from "../components/ListSkeleton";
import { IconChevronDown, IconChevronRight, IconStake } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";

/** Validators listed before a search; the set runs to hundreds on some chains. */
const VALIDATORS_SHOWN = 40;

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
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Network: ${active?.entry.chainName ?? "pick a network"}`}
        onClick={() => setOpen(true)}
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
        <IconChevronDown width={16} height={16} className="text-fg-dim" />
      </button>
      <ChainSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Staking network"
        chains={chains}
        selectedId={value}
        onSelect={onChange}
      />
    </>
  );
}

/**
 * A tap picks the validator for the Delegate footer; the arrow beside it opens
 * the validator page. Two sibling buttons, since a button cannot hold another.
 */
function ValidatorItem({
  validator,
  delegated,
  decimals,
  symbol,
  hidden,
  selected,
  onSelect,
  onOpen,
}: {
  validator: ValidatorInfo;
  delegated?: DelegationInfo;
  decimals: number;
  symbol: string;
  hidden: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center rounded-[12px] border",
        "transition-colors duration-[var(--z-duration-base)]",
        selected
          ? "border-[var(--z-line-strong)] bg-[var(--z-state-selected)]"
          : "border-transparent",
      )}
    >
      <button
        type="button"
        aria-pressed={selected}
        onClick={onSelect}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] py-2.5 pl-2.5 text-left",
          onOpen ? "pr-1" : "pr-2.5",
          "transition-colors duration-[var(--z-duration-base)]",
          !selected && "hover:bg-[var(--z-state-hover)]",
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
              ? "jailed · earns no rewards"
              : `${pct(validator.commission, 0)} comm · ${pct(validator.votingPower, 2)} power`}
          </span>
        </span>
        {validator.jailed ? (
          <Pill tone="danger">Jailed</Pill>
        ) : (
          <span className="max-w-[40%] shrink-0 text-right">
            <span className={cn(amountInlineClass, "block truncate")}>
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
      {onOpen ? (
        <button
          type="button"
          aria-label={`${validator.moniker} details`}
          onClick={onOpen}
          className={cn(
            "mr-1 flex size-8 shrink-0 items-center justify-center rounded-full text-fg-dim",
            "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
            focusRing,
          )}
        >
          <IconChevronRight width={16} height={16} />
        </button>
      ) : null}
    </div>
  );
}

/** Staking home: portfolio hero, validator directory, positions and unbondings. */
export function EarnScreen({
  chains,
  balances,
  initialChainId,
  initialValidator,
  onOpenChain,
  onOpenValidator,
  onSelectionChange,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  /** Set when arriving from a chain page, so Stake opens on that chain. */
  initialChainId?: string;
  /** The validator picked before the user left, restored on the way back. */
  initialValidator?: string;
  onOpenChain: (chainId: string) => void;
  onOpenValidator?: (validator: ValidatorInfo) => void;
  /** Lets the popup keep the network and pick across a visit to another view. */
  onSelectionChange?: (chainId: string, operatorAddress: string | null) => void;
}) {
  const signedSend = useSignedSend();
  const { settings, hidden } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const [chainId, setChainId] = useState(
    initialChainId ?? chains[0]?.chainId ?? "",
  );
  const [picked, setPicked] = useState<string | null>(
    initialValidator ?? null,
  );
  const [sheet, setSheet] = useState<"delegate" | "claim" | null>(null);
  const [delegateAmount, setDelegateAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [txNote, setTxNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [validatorQuery, setValidatorQuery] = useState("");

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const decimals = chain?.entry.coinDecimals ?? 6;
  const symbol = chain?.entry.coinDenom ?? "";
  const balance = chain ? balances[chain.chainId] : undefined;
  const available = balance ? BigInt(balance.available) : null;

  const validators = useValidators(chain?.chainId ?? "", live);
  const delegations = useDelegations(chainIds, live);
  const unbonding = useUnbonding(chainIds, live);

  // Each chain stakes its own coin, so the hero reads the network in the
  // header rather than adding base units of different denoms together.
  const stakedHere = BigInt(balance?.staked || "0");
  const rewardsHere = BigInt(balance?.rewards || "0");

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
    : live && stakedHere > 0n
      ? formatUnits(stakedHere.toString(), decimals, 2)
      : NO_VALUE;
  const heroRewards = hidden
    ? "••••"
    : live && rewardsHere > 0n
      ? formatUnits(rewardsHere.toString(), decimals, 2)
      : NO_VALUE;

  const claimable = chainDelegations.filter((d) => BigInt(d.rewards || "0") > 0n);
  const pickedValidator = validators.rows.find(
    (v) => v.operatorAddress === picked,
  );
  const shownValidators = useMemo(() => {
    if (!validatorQuery.trim()) {
      const head = validators.rows.slice(0, VALIDATORS_SHOWN);
      // A pick restored from a search further down the set stays on screen.
      const kept =
        picked && !head.some((v) => v.operatorAddress === picked)
          ? validators.rows.filter((v) => v.operatorAddress === picked)
          : [];
      return [...kept, ...head];
    }
    const byAddress = new Map(validators.rows.map((v) => [v.operatorAddress, v]));
    return searchItems(
      validators.rows.map((v) => ({
        id: v.operatorAddress,
        label: v.moniker,
        keywords: [v.operatorAddress],
      })),
      validatorQuery,
    ).flatMap((item) => byAddress.get(item.id) ?? []);
  }, [validators.rows, validatorQuery, picked]);
  const fee = estimateFee({
    gasLimit: sheet === "claim" ? Math.max(250_000, claimable.length * 120_000) : 250_000,
    gasPrice: chain?.entry.gasPriceStep?.average ?? 0.025,
    denom: chain?.entry.feeMinimalDenom ?? "uatom",
  });
  const feeRows = [
    {
      label: "Network fee",
      value: chain
        ? `${formatUnits(fee.amount[0]!.amount, chain.entry.feeDecimals)} ${chain.entry.feeDenom}`
        : NO_VALUE,
    },
    { label: "Gas", value: Number(fee.gas).toLocaleString("en-US") },
  ];

  function pick(next: string | null) {
    setPicked(next);
    onSelectionChange?.(chain?.chainId ?? chainId, next);
  }

  function toBaseUnits(input: string): bigint | null {
    if (!/^\d*\.?\d*$/.test(input) || input === "" || input === ".") return null;
    const [whole = "0", fraction = ""] = input.split(".");
    if (fraction.length > decimals) return null;
    return BigInt(whole + fraction.padEnd(decimals, "0"));
  }
  const delegateUnits = delegateAmount ? toBaseUnits(delegateAmount) : null;
  const delegateError = !delegateAmount
    ? null
    : delegateUnits === null || delegateUnits <= 0n
      ? "Enter a valid amount"
      : available !== null && delegateUnits > available
        ? "More than your available balance"
        : null;

  async function runBroadcast(
    msgs: ReturnType<typeof msgDelegate>[],
    gasLimit: number,
  ) {
    if (!chain?.address) throw new Error("No signer address");
    setBusy(true);
    setError(null);
    try {
      const result = await signedSend<{ txhash: string }>(
        "SIGN_AND_BROADCAST",
        {
          chainId: chain.chainId,
          signerAddress: chain.address,
          msgs,
          fee: estimateFee({
            gasLimit,
            gasPrice: chain.entry.gasPriceStep?.average ?? 0.025,
            denom: chain.entry.feeMinimalDenom,
          }),
          gasLimit,
        },
      );
      setTxNote(result.txhash);
      setSheet(null);
      setDelegateAmount("");
    } catch (err) {
      setError(signingError(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelegate() {
    if (!chain || !picked) return;
    const units = toBaseUnits(delegateAmount);
    if (units === null || units <= 0n) {
      setError("Enter a valid amount");
      return;
    }
    await runBroadcast(
      [
        msgDelegate({
          delegatorAddress: chain.address,
          validatorAddress: picked,
          amount: {
            denom: chain.entry.coinMinimalDenom,
            amount: units.toString(),
          },
        }),
      ],
      250_000,
    );
  }

  async function confirmClaim() {
    if (!chain || claimable.length === 0) return;
    await runBroadcast(
      claimable.map((d) =>
        msgWithdrawReward({
          delegatorAddress: chain.address,
          validatorAddress: d.validatorAddress,
        }),
      ),
      Math.max(250_000, claimable.length * 120_000),
    );
  }

  if (sheet === "delegate" && chain && picked) {
    return (
      <ScreenScaffold
        title="Confirm delegate"
        onBack={() => {
          setSheet(null);
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => setSheet(null)}
            >
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={busy || !delegateAmount || delegateError !== null}
              onClick={() => void confirmDelegate()}
            >
              {busy ? "Signing…" : "Sign and broadcast"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <KeyValueRow
            label="Validator"
            value={pickedValidator?.moniker ?? truncateAddress(picked, 8, 6)}
          />
          <Input
            label={`Amount (${symbol})`}
            inputMode="decimal"
            placeholder="0.00"
            value={delegateAmount}
            onChange={(e) => setDelegateAmount(e.target.value)}
            state={delegateError ? "error" : "default"}
            hint={
              delegateError ??
              (available !== null
                ? `${formatUnits(available.toString(), decimals)} ${symbol} available`
                : undefined)
            }
          />
          <FeeSummary rows={feeRows} />
          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

  if (sheet === "claim" && chain) {
    return (
      <ScreenScaffold
        title="Claim rewards"
        onBack={() => {
          setSheet(null);
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => setSheet(null)}
            >
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={busy || claimable.length === 0}
              onClick={() => void confirmClaim()}
            >
              {busy ? "Signing…" : `Claim ${claimable.length}`}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <Callout
            tone="info"
            title={
              claimable.length === 1
                ? "1 validator"
                : `${claimable.length} validators`
            }
          >
            Withdraws pending rewards with MsgWithdrawDelegationReward.
          </Callout>
          <FeeSummary rows={feeRows} />
          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

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
              onSelectionChange?.(next, null);
              setTxNote(null);
              setValidatorQuery("");
            }}
          />
        ) : undefined
      }
      footer={
        <Button
          className="w-full"
          disabled={!pickedValidator || pickedValidator.jailed || !chain?.address}
          onClick={() => {
            setError(null);
            setSheet("delegate");
          }}
        >
          <span className="min-w-0 truncate">
            {!pickedValidator
              ? picked && validators.loading
                ? "Loading validators…"
                : "Pick a validator to delegate"
              : pickedValidator.jailed
                ? "This validator is jailed"
                : `Delegate to ${pickedValidator.moniker}`}
          </span>
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
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
            <Button
              size="sm"
              variant="secondary"
              disabled={!live || claimable.length === 0 || !chain?.address}
              onClick={() => {
                setError(null);
                setSheet("claim");
              }}
            >
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

        {txNote ? (
          <Callout tone="info" title="Broadcast accepted">
            Tx {truncateAddress(txNote, 10, 8)}. Inclusion still depends on the
            network.
          </Callout>
        ) : null}

        <Tabs defaultValue="validators">
          <TabsList>
            <TabsTrigger value="validators">Validators</TabsTrigger>
            <TabsTrigger value="mine">My stake</TabsTrigger>
            <TabsTrigger value="unbonding">Unbonding</TabsTrigger>
          </TabsList>

          <TabsContent value="validators" className="pt-1">
            {validators.rows.length > 8 ? (
              <SearchField
                className="mb-1.5 mt-1"
                value={validatorQuery}
                onValueChange={setValidatorQuery}
                placeholder="Search validators"
              />
            ) : null}
            {validators.loading ? (
              <ListSkeleton rows={5} label="Loading validators" />
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
            ) : shownValidators.length === 0 ? (
              <p className="py-6 text-center text-[12px] text-fg-muted">
                No validator matches &ldquo;{validatorQuery.trim()}&rdquo;.
              </p>
            ) : (
              <ul className="-mx-1 flex flex-col">
                {shownValidators.map((validator) => (
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
                        pick(
                          picked === validator.operatorAddress
                            ? null
                            : validator.operatorAddress,
                        )
                      }
                      onOpen={
                        onOpenValidator
                          ? () => onOpenValidator(validator)
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="mine" className="pt-1">
            {delegations.loading ? (
              <ListSkeleton rows={2} label="Loading your stake" />
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
                    <PositionRow
                      row={row}
                      chainName={
                        chains.find((c) => c.chainId === row.chainId)?.entry
                          .chainName ?? row.chainId
                      }
                      hidden={hidden}
                      onOpen={onOpenChain}
                    />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="unbonding" className="pt-1">
            {unbonding.loading ? (
              <ListSkeleton rows={2} label="Loading unbonding stake" />
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

        <Callout tone="neutral" title="Signed on this device">
          Delegate and claim build amino messages, sign with the unlocked
          keyring, and post to this chain&rsquo;s public REST endpoint.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

function PositionRow({
  row,
  chainName,
  hidden,
  onOpen,
}: {
  row: DelegationInfo;
  chainName: string;
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
          {chainName}
        </span>
      </span>
      <span className="max-w-[48%] shrink-0 text-right">
        <span className={cn(amountInlineClass, "block truncate")}>
          {hidden
            ? "••••"
            : `${formatUnits(row.amount, row.decimals, 2)} ${row.symbol}`}
        </span>
        <span className="mt-[3px] block truncate font-mono text-[11px] font-bold tabular-nums text-accent">
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
      <span className={cn(amountInlineClass, "max-w-[45%] shrink-0 truncate text-fg-muted")}>
        {hidden
          ? "••••"
          : `${formatUnits(row.amount, row.decimals, 2)} ${row.symbol}`}
      </span>
    </div>
  );
}

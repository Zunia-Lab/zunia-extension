import { useMemo, useState } from "react";
import {
  Button,
  TokenLogo,
  Callout,
  EmptyState,
  Input,
  KeyValueRow,
  Pill,
  ScreenScaffold,
  SearchField,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ValidatorLogo,
  amountInlineClass,
  cn,
  focusRing,
  truncateAddress,
  Skeleton,
  Spinner,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import { chainTicker, feeTicker } from "../../../lib/chain-catalog";
import {
  validatorBondState,
  validatorWebsite,
  type DelegationInfo,
  type UnbondingInfo,
  type ValidatorBondState,
  type ValidatorInfo,
} from "../../../lib/chain-queries";
import {
  estimateFee,
  msgDelegate,
  msgUndelegate,
  msgWithdrawReward,
} from "../../../lib/amino-tx";
import { resolveTxMemo } from "../../../lib/tx-memo";
import {
  NO_VALUE,
  displaysAsZero,
  formatUnits,
  formatUnitsExact,
} from "../../../lib/format";
import { maxSendable, reservedFeeUnits } from "../../../lib/fee-prefs";
import { catalogLogoSlugs } from "../../../lib/chain-catalog";
import { searchItems } from "../../../lib/picker";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import {
  useDelegations,
  useUnbonding,
  useValidators,
} from "../hooks/useChainQuery";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { usePrefs } from "../state/Prefs";
import { ChainSheet } from "../components/ChainSheet";
import { ListSkeleton } from "../components/ListSkeleton";
import { IconChevronDown, IconChevronRight, IconCopy, IconRefresh, IconStake } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";
import { notifyBroadcastAccepted, useToast } from "../state/Toasts";

const BOND_PILL: Record<
  ValidatorBondState,
  { tone: "success" | "warning" | "danger"; label: string }
> = {
  active: { tone: "success", label: "Active" },
  inactive: { tone: "warning", label: "Inactive" },
  jailed: { tone: "danger", label: "Jailed" },
};

/** Validators listed before a search; the set runs to hundreds on some chains. */
const VALIDATORS_SHOWN = 40;

function pct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function websiteHostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-[14px] border border-[var(--z-line)] px-3 py-2.5">
      <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {label}
      </p>
      <p
        className={cn(
          amountInlineClass,
          "mt-1.5 truncate",
          accent && "text-accent",
        )}
      >
        {value}
      </p>
    </div>
  );
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
          <TokenLogo
            src={active.iconUrl}
            symbol={active.entry.chainName}
            size={16}
            verified={active.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
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

function RefreshButton({
  loading,
  disabled,
  onClick,
}: {
  loading: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label="Refresh staking"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-[30px] items-center justify-center rounded-[10px] border border-[var(--z-line)] text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
        "disabled:cursor-not-allowed disabled:opacity-40",
        focusRing,
      )}
    >
      {loading ? <Spinner className="size-3.5" /> : <IconRefresh width={15} height={15} />}
    </button>
  );
}

function PercentRow({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (pct: number) => void;
}) {
  return (
    <div className="flex gap-1.5">
      {([25, 50, 75, 100] as const).map((pct) => (
        <button
          key={pct}
          type="button"
          disabled={disabled}
          onClick={() => onPick(pct)}
          className={cn(
            "flex-1 rounded-full border border-[var(--z-line-strong)] py-1 font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-fg",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
            "disabled:cursor-not-allowed disabled:opacity-40",
            focusRing,
          )}
        >
          {pct === 100 ? "MAX" : `${pct}%`}
        </button>
      ))}
    </div>
  );
}

/**
 * A tap picks the validator for the Delegate footer; the arrow beside it opens
 * the validator page. Two sibling buttons, since a button cannot hold another.
 */
function ValidatorItem({
  validator,
  chainName,
  logoSlugs,
  delegated,
  decimals,
  symbol,
  hidden,
  selected,
  onSelect,
  onOpen,
}: {
  validator: ValidatorInfo;
  chainName: string;
  logoSlugs?: readonly string[];
  delegated?: DelegationInfo;
  decimals: number;
  symbol: string;
  hidden: boolean;
  selected: boolean;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const bond = validatorBondState(validator);
  const pill = BOND_PILL[bond];
  const stake =
    delegated && !displaysAsZero(delegated.amount, decimals, 2)
      ? delegated
      : null;
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
        <ValidatorLogo
          chainId={validator.chainId}
          chainName={chainName}
          logoSlugs={logoSlugs ?? catalogLogoSlugs(validator.chainId)}
          operatorAddress={validator.operatorAddress}
          identity={validator.identity}
          logoUrl={validator.logoUrl}
          moniker={validator.moniker}
          size={28}
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">
              {validator.moniker}
            </span>
            <Pill
              tone={pill.tone}
              className="shrink-0 px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]"
            >
              {pill.label}
            </Pill>
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate font-mono text-[9.5px]",
              bond === "jailed" ? "text-[var(--z-danger)]" : "text-fg-dim",
            )}
          >
            {bond === "jailed"
              ? "earns no rewards"
              : bond === "inactive"
                ? "not in the bonded set"
                : `${pct(validator.commission, 0)} comm · ${pct(validator.votingPower, 2)} power`}
          </span>
        </span>
        {stake ? (
          <span className="max-w-[40%] shrink-0 text-right">
            <span className={cn(amountInlineClass, "block truncate")}>
              {hidden
                ? "••••"
                : `${formatUnits(stake.amount, decimals, 2)} ${symbol}`}
            </span>
            <span className="mt-[3px] block font-mono text-[9px] text-fg-dim">
              delegated
            </span>
          </span>
        ) : null}
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

/** Staking home: portfolio, positions and unbondings. The validator list lives on Stake. */
export function EarnScreen({
  chains,
  balances,
  initialChainId,
  initialValidator,
  onOpenChain: _onOpenChain,
  onOpenValidator,
  onSelectionChange,
  onRefreshBalances,
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
  /** Force-refresh bank + stake totals after a signed tx. */
  onRefreshBalances?: () => void;
}) {
  const signedSend = useSignedSend();
  const toast = useToast();
  const { settings, hidden } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const [chainId, setChainId] = useState(
    initialChainId ?? chains[0]?.chainId ?? "",
  );
  const [picked, setPicked] = useState<string | null>(
    initialValidator ?? null,
  );
  const [sheet, setSheet] = useState<
    "pick" | "delegate" | "undelegate" | "position" | "claim" | null
  >(initialValidator ? "pick" : null);
  const [delegateAmount, setDelegateAmount] = useState("");
  const [undelegateAmount, setUndelegateAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validatorQuery, setValidatorQuery] = useState("");

  const chain = chains.find((c) => c.chainId === chainId) ?? chains[0];
  const decimals = chain?.entry.coinDecimals ?? 6;
  const symbol = chain ? chainTicker(chain.entry) : "";
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
    const row = balances[c.chainId];
    return row && !displaysAsZero(row.staked, row.decimals, 2);
  });
  const myStake = delegations.rows.filter(
    (row) => !displaysAsZero(row.amount, row.decimals, 2),
  );

  const balancesPending = live && Boolean(chain) && !balance;
  const heroStaked = hidden
    ? "••••"
    : live && !displaysAsZero(stakedHere.toString(), decimals, 2)
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
  const position = chainDelegations.find((d) => d.validatorAddress === picked);
  const stakedUnits = position ? BigInt(position.amount) : 0n;
  const feeGas = sheet === "claim" ? Math.max(250_000, claimable.length * 120_000) : 250_000;
  const fee = estimateFee({
    gasLimit: Math.max(1, Math.ceil(feeGas * settings.gasAdjustment)),
    gasPrice: chain?.entry.gasPriceStep?.[settings.feeSpeed] ?? 0.025,
    denom: chain?.entry.feeMinimalDenom ?? "uatom",
  });
  const refreshing =
    live && (delegations.loading || unbonding.loading || validators.loading);

  function refreshStake() {
    if (!live) return;
    validators.reload();
    delegations.reload();
    unbonding.reload();
    onRefreshBalances?.();
  }

  async function copyOperator(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      toast("Operator address copied", {
        meta: truncateAddress(address, 10, 6),
      });
    } catch {
      toast("Could not copy the address", { tone: "danger" });
    }
  }

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
  const undelegateUnits = undelegateAmount ? toBaseUnits(undelegateAmount) : null;
  const undelegateError = !undelegateAmount
    ? null
    : undelegateUnits === null || undelegateUnits <= 0n
      ? "Enter a valid amount"
      : undelegateUnits > stakedUnits
        ? "More than you have staked here"
        : null;

  function fillAmount(target: "delegate" | "undelegate", pct: number) {
    const pool = target === "delegate" ? available : stakedUnits;
    if (pool === null || pool <= 0n) return;
    const reserved =
      target === "delegate" && chain
        ? reservedFeeUnits(chain.chainId, chain.entry.coinMinimalDenom, settings)
        : 0n;
    const units = (maxSendable(pool, reserved) * BigInt(pct)) / 100n;
    const next = formatUnitsExact(units.toString(), decimals);
    if (target === "delegate") setDelegateAmount(next);
    else setUndelegateAmount(next);
  }

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
          memo: resolveTxMemo("", msgs),
          fee: estimateFee({
            gasLimit,
            gasPrice: chain.entry.gasPriceStep?.average ?? 0.025,
            denom: chain.entry.feeMinimalDenom,
          }),
          gasLimit,
        },
      );
      notifyBroadcastAccepted(toast, result.txhash);
      setSheet(null);
      setDelegateAmount("");
      delegations.reload();
      unbonding.reload();
      onRefreshBalances?.();
    } catch (err) {
      const message = signingError(err);
      setError(message);
      if (message) toast(message, { tone: "danger" });
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

  async function confirmUndelegate() {
    if (!chain || !picked) return;
    const units = toBaseUnits(undelegateAmount);
    if (units === null || units <= 0n) {
      setError("Enter a valid amount");
      return;
    }
    await runBroadcast(
      [
        msgUndelegate({
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
    setUndelegateAmount("");
  }

  async function confirmClaimOne() {
    if (!chain || !picked) return;
    await runBroadcast(
      [
        msgWithdrawReward({
          delegatorAddress: chain.address,
          validatorAddress: picked,
        }),
      ],
      250_000,
    );
  }

  if (sheet === "pick" && chain) {
    return (
      <ScreenScaffold
        title="Stake"
        onBack={() => {
          setSheet(null);
          pick(null);
          setValidatorQuery("");
          setError(null);
        }}
        right={
          <div className="flex items-center gap-1.5">
            <RefreshButton
              loading={refreshing}
              disabled={!live}
              onClick={refreshStake}
            />
            {chains.length > 0 ? (
              <ChainSelect
                chains={chains}
                value={chain.chainId}
                onChange={(next) => {
                  setChainId(next);
                  pick(null);
                  setValidatorQuery("");
                }}
              />
            ) : null}
          </div>
        }
        toolbar={
          <SearchField
            value={validatorQuery}
            onValueChange={setValidatorQuery}
            placeholder="Search validators"
          />
        }
        footer={
          <Button
            className="w-full"
            disabled={!pickedValidator || pickedValidator.jailed || !chain.address}
            onClick={() => {
              setError(null);
              setSheet("delegate");
            }}
          >
            <span className="min-w-0 truncate">
              {!pickedValidator
                ? validators.loading
                  ? "Loading validators…"
                  : "Pick a validator"
                : pickedValidator.jailed
                  ? "This validator is jailed"
                  : `Stake with ${pickedValidator.moniker}`}
            </span>
          </Button>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[12px] leading-snug text-fg-muted">
            Search the set, pick one validator, then confirm the amount. Jailed
            validators cannot earn rewards.
          </p>
          {!live ? (
            <Callout tone="info" title="On-chain reads are off">
              Turn on live balances in Preferences to load this chain&rsquo;s
              validator set.
            </Callout>
          ) : validators.loading ? (
            <ListSkeleton rows={6} bordered label="Loading validators" />
          ) : validators.rows.length === 0 ? (
            <EmptyState
              icon={<IconStake width={16} height={16} />}
              title="No validator set"
              description="This chain&rsquo;s endpoint did not return a bonded validator set."
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
                    chainName={chain.entry.chainName}
                    logoSlugs={chain.entry.logoSlugs}
                    delegated={delegationByValidator.get(validator.operatorAddress)}
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
                      onOpenValidator ? () => onOpenValidator(validator) : undefined
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </ScreenScaffold>
    );
  }

  if (sheet === "delegate" && chain && picked) {
    return (
      <ScreenScaffold
        title="Confirm stake"
        onBack={() => {
          setSheet(position ? "position" : "pick");
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => setSheet(position ? "position" : "pick")}
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
          {pickedValidator ? (
            <section className="flex items-center gap-3 rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3">
              <ValidatorLogo
                chainId={pickedValidator.chainId}
                chainName={chain.entry.chainName}
                logoSlugs={chain.entry.logoSlugs}
                operatorAddress={pickedValidator.operatorAddress}
                identity={pickedValidator.identity}
                logoUrl={pickedValidator.logoUrl}
                moniker={pickedValidator.moniker}
                size={40}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 truncate text-[13.5px] font-semibold tracking-tight text-fg">
                    {pickedValidator.moniker}
                  </p>
                  <Pill
                    tone={BOND_PILL[validatorBondState(pickedValidator)].tone}
                    className="shrink-0 px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]"
                  >
                    {BOND_PILL[validatorBondState(pickedValidator)].label}
                  </Pill>
                </div>
                <p className="mt-1 font-mono text-[10px] leading-snug text-fg-dim">
                  {`${pct(pickedValidator.commission, 0)} comm · ${pct(pickedValidator.votingPower, 2)} power`}
                </p>
                <p className="mt-0.5 truncate font-mono text-[9.5px] text-fg-faint">
                  {truncateAddress(pickedValidator.operatorAddress, 12, 8)}
                </p>
              </div>
            </section>
          ) : (
            <KeyValueRow
              label="Validator"
              value={truncateAddress(picked, 8, 6)}
            />
          )}
          <KeyValueRow label="Network" value={chain.entry.chainName} />
          <KeyValueRow
            label="Memo"
            value={resolveTxMemo("", [
              {
                type: "cosmos-sdk/MsgDelegate",
                value: { amount: { denom: chain.entry.coinMinimalDenom } },
              },
            ])}
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
          <PercentRow
            disabled={available === null || available <= 0n}
            onPick={(pct) => fillAmount("delegate", pct)}
          />
          <section className="rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={fee.amount[0]?.amount}
              feeDecimals={chain?.entry.feeDecimals ?? 6}
              feeSymbol={chain ? feeTicker(chain.entry) : "ATOM"}
            />
          </section>
          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

  if (sheet === "position" && chain && picked && position) {
    const bond = validatorBondState(pickedValidator ?? position);
    const pill = BOND_PILL[bond];
    const rewardUnits = BigInt(position.rewards || "0");
    const stakedText = hidden
      ? "••••"
      : `${formatUnits(position.amount, decimals, 2)} ${symbol}`;
    const rewardText = hidden
      ? "••••"
      : `${formatUnits(position.rewards, decimals, 2)} ${symbol}`;
    const website = validatorWebsite(pickedValidator?.website);
    const websiteHost = website ? websiteHostOf(website) : null;
    return (
      <ScreenScaffold
        title="My stake"
        onBack={() => {
          setSheet(null);
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                setError(null);
                setUndelegateAmount("");
                setSheet("undelegate");
              }}
            >
              Unstake
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                setError(null);
                setDelegateAmount("");
                setSheet("delegate");
              }}
            >
              Stake more
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <section className="flex items-start gap-3 rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3.5">
            <ValidatorLogo
              chainId={position.chainId}
              chainName={chain.entry.chainName}
              logoSlugs={chain.entry.logoSlugs}
              operatorAddress={position.validatorAddress}
              identity={pickedValidator?.identity || position.identity}
              logoUrl={pickedValidator?.logoUrl || position.logoUrl}
              moniker={pickedValidator?.moniker ?? position.moniker}
              size={48}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 truncate text-[15px] font-semibold tracking-tight text-fg">
                  {pickedValidator?.moniker ?? position.moniker}
                </p>
                <Pill
                  tone={pill.tone}
                  className="shrink-0 px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]"
                >
                  {pill.label}
                </Pill>
              </div>
              <p className="mt-1 font-mono text-[10px] leading-snug text-fg-dim">
                {chain.entry.chainName}
                {pickedValidator
                  ? ` · ${pct(pickedValidator.commission, 1)} comm · ${pct(pickedValidator.votingPower, 2)} power`
                  : null}
              </p>
              {pickedValidator?.identity ? (
                <p className="mt-0.5 truncate font-mono text-[9.5px] text-fg-faint">
                  Keybase {pickedValidator.identity}
                </p>
              ) : null}
            </div>
          </section>

          <section className="grid grid-cols-2 gap-2">
            <StatCard label="Staked" value={stakedText} />
            <StatCard
              label="Rewards"
              value={hidden ? "••••" : `+${rewardText}`}
              accent
            />
          </section>

          <Button
            variant="secondary"
            className="w-full"
            disabled={!chain.address || rewardUnits <= 0n || busy}
            onClick={() => void confirmClaimOne()}
          >
            {busy
              ? "Signing…"
              : rewardUnits <= 0n
                ? "No rewards yet"
                : `Claim ${rewardText}`}
          </Button>

          <section className="flex flex-col gap-1.5 rounded-[14px] border border-[var(--z-line)] px-3 py-3">
            <p className="mb-0.5 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
              Validator
            </p>
            {pickedValidator ? (
              <>
                <KeyValueRow
                  label="Commission"
                  value={pct(pickedValidator.commission, 2)}
                />
                {pickedValidator.maxCommission > 0 ? (
                  <KeyValueRow
                    label="Max commission"
                    value={pct(pickedValidator.maxCommission, 2)}
                  />
                ) : null}
                <KeyValueRow
                  label="Voting power"
                  value={pct(pickedValidator.votingPower, 2)}
                />
                <KeyValueRow
                  label="Bonded"
                  value={`${formatUnits(pickedValidator.tokens, decimals, 2)} ${symbol}`}
                />
                {BigInt(pickedValidator.minSelfDelegation || "0") > 0n ? (
                  <KeyValueRow
                    label="Min self-stake"
                    value={`${formatUnits(pickedValidator.minSelfDelegation, decimals, 2)} ${symbol}`}
                  />
                ) : null}
              </>
            ) : null}
            <KeyValueRow label="Network" value={chain.entry.chainName} />
            <div className="flex items-center justify-between gap-3 py-0.5">
              <p className="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-dim">
                Operator
              </p>
              <button
                type="button"
                onClick={() => void copyOperator(position.validatorAddress)}
                className={cn(
                  "inline-flex min-w-0 items-center gap-1 font-mono text-[11px] text-fg",
                  "transition-colors duration-[var(--z-duration-base)] hover:text-accent",
                  focusRing,
                )}
              >
                <span className="truncate">
                  {truncateAddress(position.validatorAddress, 10, 6)}
                </span>
                <IconCopy width={12} height={12} aria-hidden />
              </button>
            </div>
            {website && websiteHost ? (
              <KeyValueRow
                label="Website"
                value={
                  <a
                    href={website}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent"
                  >
                    {websiteHost}
                  </a>
                }
              />
            ) : null}
            {pickedValidator?.details ? (
              <p className="mt-1 line-clamp-4 text-[11.5px] leading-snug text-fg-muted">
                {pickedValidator.details}
              </p>
            ) : null}
          </section>

          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : (
            <p className="text-[11px] leading-snug text-fg-muted">
              Unstaking starts the unbonding period. Stake more uses your
              available balance on this network.
            </p>
          )}
        </div>
      </ScreenScaffold>
    );
  }

  if (sheet === "undelegate" && chain && picked && position) {
    return (
      <ScreenScaffold
        title="Unstake"
        onBack={() => {
          setSheet("position");
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => setSheet("position")}
            >
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={busy || !undelegateAmount || undelegateError !== null}
              onClick={() => void confirmUndelegate()}
            >
              {busy ? "Signing…" : "Sign unstake"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <KeyValueRow
            label="Validator"
            value={pickedValidator?.moniker ?? position.moniker}
          />
          <KeyValueRow
            label="Memo"
            value={resolveTxMemo("", [
              {
                type: "cosmos-sdk/MsgUndelegate",
                value: { amount: { denom: chain.entry.coinMinimalDenom } },
              },
            ])}
          />
          <Input
            label={`Amount (${symbol})`}
            inputMode="decimal"
            placeholder="0.00"
            value={undelegateAmount}
            onChange={(e) => setUndelegateAmount(e.target.value)}
            state={undelegateError ? "error" : "default"}
            hint={
              undelegateError ??
              `${formatUnits(position.amount, decimals)} ${symbol} staked`
            }
          />
          <PercentRow
            disabled={stakedUnits <= 0n}
            onPick={(pct) => fillAmount("undelegate", pct)}
          />
          <section className="rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={fee.amount[0]?.amount}
              feeDecimals={chain?.entry.feeDecimals ?? 6}
              feeSymbol={chain ? feeTicker(chain.entry) : "ATOM"}
            />
          </section>
          {error ? (
            <Callout tone="danger" title="Could not broadcast">
              {error}
            </Callout>
          ) : (
            <p className="text-[11px] leading-snug text-fg-muted">
              Unbonded stake sits in Unbonding until the chain releases it.
            </p>
          )}
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
          <KeyValueRow
            label="Memo"
            value={resolveTxMemo("", [
              { type: "cosmos-sdk/MsgWithdrawDelegationReward", value: {} },
            ])}
          />
          <section className="rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={fee.amount[0]?.amount}
              feeDecimals={chain?.entry.feeDecimals ?? 6}
              feeSymbol={chain ? feeTicker(chain.entry) : "ATOM"}
            />
          </section>
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
        <div className="flex items-center gap-1.5">
          <RefreshButton
            loading={refreshing}
            disabled={!live}
            onClick={refreshStake}
          />
          {chains.length > 0 ? (
            <ChainSelect
              chains={chains}
              value={chain?.chainId ?? ""}
              onChange={(next) => {
                setChainId(next);
                setPicked(null);
                onSelectionChange?.(next, null);
                setValidatorQuery("");
              }}
            />
          ) : null}
        </div>
      }
      footer={
        <Button
          className="w-full"
          disabled={!chain?.address}
          onClick={() => {
            setError(null);
            setSheet("pick");
          }}
        >
          Stake
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
              {balancesPending && !hidden ? (
                <Skeleton className="mt-1.5 h-7 w-28 rounded-[10px]" />
              ) : (
                <p className="mt-1 truncate text-[24px] font-medium leading-none tracking-[-0.035em] text-fg">
                  {heroStaked}
                  {heroStaked !== NO_VALUE && heroStaked !== "••••" ? (
                    <span className="ml-1.5 font-mono text-[11px] text-fg-dim">
                      {symbol}
                    </span>
                  ) : null}
                </p>
              )}
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
              {balancesPending && !hidden ? (
                <Skeleton className="ml-1 inline-block h-2.5 w-16 align-middle" />
              ) : (
                <span className="text-fg-muted">
                  {heroRewards}
                  {heroRewards !== NO_VALUE && heroRewards !== "••••"
                    ? ` ${symbol}`
                    : ""}
                </span>
              )}
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

        <Tabs defaultValue="mine">
          <TabsList>
            <TabsTrigger value="mine">My stake</TabsTrigger>
            <TabsTrigger value="unbonding">Unbonding</TabsTrigger>
          </TabsList>

          <TabsContent value="mine" className="pt-1">
            {delegations.loading ? (
              <ListSkeleton rows={2} bordered label="Loading your stake" />
            ) : myStake.length === 0 ? (
              <EmptyState
                icon={<IconStake width={16} height={16} />}
                title="No delegations"
                description="Tap Stake to pick a validator and start earning."
              />
            ) : (
              <ul className="flex flex-col gap-1.5">
                {myStake.map((row) => (
                  <li key={`${row.chainId}:${row.validatorAddress}`}>
                    <PositionRow
                      row={row}
                      chainName={
                        chains.find((c) => c.chainId === row.chainId)?.entry
                          .chainName ?? row.chainId
                      }
                      logoSlugs={
                        chains.find((c) => c.chainId === row.chainId)?.entry
                          .logoSlugs
                      }
                      hidden={hidden}
                      onOpen={() => {
                        setChainId(row.chainId);
                        pick(row.validatorAddress);
                        setError(null);
                        setSheet("position");
                      }}
                    />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>

          <TabsContent value="unbonding" className="pt-1">
            {unbonding.loading ? (
              <ListSkeleton rows={2} bordered label="Loading unbonding stake" />
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
                    <UnbondingRow
                      row={row}
                      chainName={
                        chains.find((c) => c.chainId === row.chainId)?.entry
                          .chainName ?? row.chainId
                      }
                      logoSlugs={
                        chains.find((c) => c.chainId === row.chainId)?.entry
                          .logoSlugs
                      }
                      hidden={hidden}
                    />
                  </li>
                ))}
              </ul>
            )}
          </TabsContent>
        </Tabs>
      </div>
    </ScreenScaffold>
  );
}

function PositionRow({
  row,
  chainName,
  logoSlugs,
  hidden,
  onOpen,
}: {
  row: DelegationInfo;
  chainName: string;
  logoSlugs?: readonly string[];
  hidden: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        focusRing,
      )}
    >
      <ValidatorLogo
        chainId={row.chainId}
        chainName={chainName}
        logoSlugs={logoSlugs ?? catalogLogoSlugs(row.chainId)}
        operatorAddress={row.validatorAddress}
        identity={row.identity}
        logoUrl={row.logoUrl}
        moniker={row.moniker}
        size={28}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-[12.5px] font-medium text-fg">
            {row.moniker}
          </span>
          <Pill
            tone={BOND_PILL[validatorBondState(row)].tone}
            className="shrink-0 px-1.5 py-0.5 text-[8.5px] tracking-[0.08em]"
          >
            {BOND_PILL[validatorBondState(row)].label}
          </Pill>
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
  chainName,
  logoSlugs,
  hidden,
}: {
  row: UnbondingInfo;
  chainName: string;
  logoSlugs?: readonly string[];
  hidden: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2.5">
      <ValidatorLogo
        chainId={row.chainId}
        chainName={chainName}
        logoSlugs={logoSlugs ?? catalogLogoSlugs(row.chainId)}
        operatorAddress={row.validatorAddress}
        identity={row.identity}
        logoUrl={row.logoUrl}
        moniker={row.moniker}
        size={28}
      />
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

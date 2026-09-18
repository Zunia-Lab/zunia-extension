/**
 * Cross-chain swap: one signature on the source chain, an Osmosis
 * crosschain-swap executed by relayers inside packet processing, and delivery
 * on the destination chain.
 *
 * There is no aggregator and no custodian. The wallet plans the route itself
 * with `@zunialab/interchain` — unwinding a wrapped denom, discovering and
 * verifying channels, composing the ibc-hooks memo with a packet-forward hop
 * before or after when Osmosis is not adjacent — prices the pool against the
 * Osmosis router, and hands one `MsgTransfer` to `@zunialab/core` to sign.
 *
 * Every control on this screen is enabled only when its whole path works, and
 * the first thing that does not work is named on the button.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  KeyValueRow,
  PacketTracker,
  Pill,
  RoutePreview,
  ScreenScaffold,
  SectionLabel,
  Spinner,
  SwapQuotePanel,
  cn,
  focusRing,
  truncateAddress,
  type SwapQuoteView,
} from "@zunialab/ui";
import type { BuiltMsg } from "@zunialab/interchain";

import type { ChainBalance } from "../../../lib/balances";
import {
  explorerTxUrl,
  HIGH_SLIPPAGE_PERCENT,
  MAX_SLIPPAGE_PERCENT,
  SLIPPAGE_PRESETS,
} from "../../../config/interchain";
import { NO_VALUE, formatUnits, formatUnitsExact } from "../../../lib/format";
import { buildRecoverMsg } from "../../../lib/packet-tracking";
import {
  removePendingTransfer,
  savePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import {
  INITIAL_SLIPPAGE_PERCENT,
  VENUE_CHAIN_ID,
  buildTransferMsgFromPlan,
  planSwap,
  type ManualChannel,
  type RoutePlanView,
  type SwapPlanResult,
} from "../../../lib/route-plan";
import { sendToBackground } from "../../../lib/popup-client";
import type { TxPreview } from "../../../lib/tx-kernel";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import {
  AssetSide,
  DisabledReason,
  HopChannelList,
  ResumeTrackingBanner,
  SwapContractOverride,
  formatAsset,
  receivableAssets,
  spendableAssets,
  toBaseUnits,
  useKernelSigning,
  useResolveAddresses,
  useRouteTracking,
  shortDenom,
  TruncatedValue,
  usePendingTransfers,
  useSwapVenue,
} from "./interchain-ui";
import { IconSwap } from "./icons";

const PERCENTS = [25, 50, 75, 100] as const;

type Phase = "form" | "confirm" | "sent";

/** What the confirm phase is about to sign. Shared by the swap and the recovery. */
interface PendingTx {
  readonly kind: "swap" | "recover";
  readonly chainId: string;
  readonly signerAddress: string;
  readonly msgs: readonly BuiltMsg[];
  readonly title: string;
  /** The plan this transaction executes, kept so tracking can follow it. */
  readonly plan: RoutePlanView | null;
  readonly amountBaseUnits: string;
}

function rateLine(
  inputBase: string,
  inputDecimals: number,
  inputSymbol: string,
  outputBase: string,
  outputDecimals: number,
  outputSymbol: string,
): string | null {
  const scale = (value: string, decimals: number): number => {
    const n = Number(value) / 10 ** decimals;
    return Number.isFinite(n) ? n : 0;
  };
  const input = scale(inputBase, inputDecimals);
  const output = scale(outputBase, outputDecimals);
  if (input <= 0 || output <= 0) return null;
  const rate = output / input;
  const digits = rate >= 100 ? 2 : rate >= 1 ? 4 : 6;
  return `1 ${inputSymbol} ≈ ${rate.toFixed(digits)} ${outputSymbol}`;
}

export function SwapScreen({
  chains,
  balances,
  initialChainId,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
}) {
  const { hidden, settings } = usePrefs();
  const liveReads = settings.liveBalances;

  const sources = useMemo(() => spendableAssets(chains, balances), [chains, balances]);
  // An empty balance map is "not read yet", not "holds nothing": the reader
  // writes a row per chain even when every denom is zero.
  const balancesLoaded = Object.keys(balances).length > 0;
  const destinations = useMemo(
    () => receivableAssets(chains, balances),
    [chains, balances],
  );

  // Stored as "what the user picked", null until they pick. The effective
  // selection is derived below, so opening the screen needs no effect that
  // writes state on the first render.
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [toKey, setToKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState(INITIAL_SLIPPAGE_PERCENT);
  const [manual, setManual] = useState<ManualChannel[]>([]);
  // Bumped by the retry controls. Part of the plan key, because re-running the
  // same inputs must actually re-run them — a new array identity would not.
  const [retryToken, setRetryToken] = useState(0);
  const [phase, setPhase] = useState<Phase>("form");
  const [pending, setPending] = useState<PendingTx | null>(null);
  const [preview, setPreview] = useState<TxPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The route being followed. Survives a popup close through storage. */
  const [tracked, setTracked] = useState<PendingTransfer | null>(null);
  /** Hash of a `{"recover":{}}` transaction, shown alongside the route it rescued. */
  const [recoverTxHash, setRecoverTxHash] = useState<string | null>(null);

  const kernel = useKernelSigning();
  const venue = useSwapVenue(liveReads);
  const pendingRoutes = usePendingTransfers();
  const resolveAddresses = useResolveAddresses();

  // The source defaults to whatever chain the user came from, the destination
  // to anything on a different chain, so the screen opens with a plausible pair
  // already in it.
  const from =
    sources.find((asset) => asset.key === fromKey) ??
    sources.find((asset) => asset.chainId === initialChainId) ??
    sources[0];
  const to =
    destinations.find((asset) => asset.key === toKey) ??
    destinations.find((asset) => asset.chainId !== from?.chainId) ??
    destinations[0];
  const sourceAccount = chains.find((chain) => chain.chainId === from?.chainId);
  const destAccount = chains.find((chain) => chain.chainId === to?.chainId);

  const amountUnits = from ? toBaseUnits(amount, from.decimals) : null;
  const available = from ? BigInt(from.amount) : null;
  const overBalance =
    amountUnits !== null && available !== null && amountUnits > available;

  /* ---------------------------------------------------------------- *
   * The wallet's own address on the venue chain
   * ---------------------------------------------------------------- */

  // `on_failed_delivery.local_recovery_addr` must be an address on the venue
  // chain that this wallet controls. Without it the contract is told
  // "do_nothing" and a swap that succeeds but fails to deliver strands the
  // funds permanently, so the swap is refused rather than built that way.
  const [recovery, setRecovery] = useState<{ address: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void resolveAddresses([VENUE_CHAIN_ID]).then((map) => {
      if (!cancelled) setRecovery({ address: map[VENUE_CHAIN_ID] ?? null });
    });
    return () => {
      cancelled = true;
    };
  }, [resolveAddresses]);
  const recoveryAddress = recovery?.address ?? null;
  const recoveryFailed = recovery !== null && recovery.address === null;

  /* ---------------------------------------------------------------- *
   * Planning
   * ---------------------------------------------------------------- */

  const [settledPlan, setSettledPlan] = useState<{
    key: string;
    result: SwapPlanResult;
  } | null>(null);

  // The contract reads `slippage_percentage` on a 0-100 scale and divides by
  // 100 itself, so an out-of-range value is not a wide tolerance — it is a memo
  // the contract rejects. Caught before planning rather than as a build error.
  const slippageOk =
    Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;

  const canPlan =
    liveReads &&
    Boolean(from && to && sourceAccount?.address && destAccount?.address) &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    Boolean(venue.check?.venue) &&
    Boolean(recoveryAddress) &&
    slippageOk &&
    !(from?.chainId === to?.chainId && from?.denom === to?.denom);

  const planKey = canPlan
    ? [
        from?.chainId,
        from?.denom,
        to?.chainId,
        to?.denom,
        amountUnits?.toString(),
        slippage,
        manual.map((m) => `${m.fromChainId}>${m.toChainId}:${m.channelId}`).join("|"),
        venue.check?.contractAddress,
        retryToken,
      ].join("~")
    : "";

  useEffect(() => {
    if (!planKey) return;
    const controller = new AbortController();
    // Debounced: the amount field fires per keystroke and a plan is several
    // LCD round trips.
    const timer = window.setTimeout(() => {
      void planSwap({
        sourceChainId: from!.chainId,
        destChainId: to!.chainId,
        inputDenom: from!.denom,
        destDenom: to!.denom,
        amountBaseUnits: amountUnits!.toString(),
        sender: sourceAccount!.address,
        recipient: destAccount!.address,
        recoveryAddress: recoveryAddress!,
        slippagePercent: slippage,
        venue: venue.check!.venue!,
        manualChannels: manual,
        resolveAddresses,
        signal: controller.signal,
      }).then((next) => {
        if (!controller.signal.aborted) setSettledPlan({ key: planKey, result: next });
      });
    }, 450);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
    // Everything the plan depends on is folded into planKey; listing the raw
    // values as well would replan on an object identity that never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planKey]);

  // Both wholly derived from the request key, so a stale answer for inputs the
  // user has since edited can never be shown as the current plan.
  const result = settledPlan?.key === planKey ? settledPlan.result : null;
  const planning = Boolean(planKey) && settledPlan?.key !== planKey;
  const plan = result?.best ?? null;
  const quote = result?.quote ?? null;

  /* ---------------------------------------------------------------- *
   * Why the button is off
   * ---------------------------------------------------------------- */

  const blockedReason = useMemo((): string | null => {
    if (!liveReads) {
      return "Swapping reads channels, denom traces and pool prices from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (kernel.loading) return null;
    if (kernel.reason) return kernel.reason;
    if (venue.loading) return null;
    if (venue.check?.reason) return venue.check.reason;
    if (sources.length === 0) {
      // "Nothing to swap" and "balances have not arrived yet" are different
      // facts, and only one of them is the user's problem.
      return balancesLoaded
        ? "This wallet holds no non-zero balance to swap."
        : "Balances have not loaded yet.";
    }
    if (!from || !to) return "Pick what you are swapping and what you want back.";
    if (!sourceAccount?.address) {
      return `Zunia has no address on ${from.chainName}, so it cannot sign there.`;
    }
    if (!destAccount?.address) {
      return `Zunia has no address on ${to.chainName}, so it has nowhere to deliver.`;
    }
    if (from.chainId === to.chainId && from.denom === to.denom) {
      return "Both sides are the same asset on the same chain.";
    }
    if (from.chainId === VENUE_CHAIN_ID) {
      return "Swapping on Osmosis and then transferring takes two signatures, which this screen does not do. Send the token to another chain first, or swap on Osmosis directly.";
    }
    if (!amount) return "Enter an amount to swap.";
    if (amountUnits === null) return "That amount is not a number this chain can hold.";
    if (amountUnits <= 0n) return "Enter an amount above zero.";
    if (overBalance) return `More than the ${from.symbol} this wallet holds.`;
    if (!slippageOk) {
      return `Slippage must be between 0 and ${MAX_SLIPPAGE_PERCENT}%. Above that the tolerance stops protecting anything.`;
    }
    if (recoveryFailed) {
      return `Zunia could not derive your address on ${VENUE_CHAIN_ID}, so it cannot set a recovery address. Without one, funds stranded by a failed delivery could not be reclaimed, so the swap is refused.`;
    }
    if (!recoveryAddress) return null;
    if (planning) return null;
    if (result?.error) return result.error;
    if (!plan) {
      return result?.warnings[0] ?? "No route exists from here to there for this asset.";
    }
    if (plan.blockedReason) return plan.blockedReason;
    if (result?.quoteBlockedReason) return result.quoteBlockedReason;
    if (!quote) return "Waiting for a price from the Osmosis router.";
    return null;
  }, [
    liveReads,
    kernel.loading,
    kernel.reason,
    venue.loading,
    venue.check,
    sources.length,
    balancesLoaded,
    from,
    to,
    sourceAccount,
    destAccount,
    amount,
    amountUnits,
    overBalance,
    slippageOk,
    recoveryAddress,
    recoveryFailed,
    planning,
    result,
    plan,
    quote,
  ]);

  const ready = blockedReason === null && Boolean(plan && quote && from && sourceAccount);

  /* ---------------------------------------------------------------- *
   * Actions
   * ---------------------------------------------------------------- */

  const openConfirm = useCallback(
    async (next: PendingTx) => {
      setBusy(true);
      setError(null);
      try {
        const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
          chainId: next.chainId,
          signerAddress: next.signerAddress,
          msgs: next.msgs,
        });
        setPreview(built);
        setPending(next);
        setPhase("confirm");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  async function signPending() {
    if (!pending || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const broadcastResult = await sendToBackground<{ txhash: string }>(
        "SIGN_AND_BROADCAST_TX",
        {
          chainId: pending.chainId,
          signerAddress: pending.signerAddress,
          msgs: pending.msgs,
          fee: preview.fee,
          accountNumber: preview.accountNumber,
          sequence: preview.sequence,
          expectSignBytesHash: preview.preview.signBytesHash,
        },
      );
      if (pending.kind === "recover") {
        // The recovery is its own transaction on the venue chain. It does not
        // replace the route being tracked, which still records what happened.
        setRecoverTxHash(broadcastResult.txhash);
        setPhase("sent");
      } else if (pending.plan) {
        const record: PendingTransfer = {
          kind: "swap",
          txHash: broadcastResult.txhash,
          chainId: pending.chainId,
          plan: pending.plan.plan,
          amountBaseUnits: pending.amountBaseUnits,
          ...(venue.check?.contractAddress
            ? { swapContract: venue.check.contractAddress }
            : {}),
          ...(recoveryAddress ? { recoveryAddress } : {}),
          label: `${amount} ${from?.symbol ?? ""} → ${to?.symbol ?? ""}`.trim(),
          startedAt: Date.now(),
        };
        // Persisted before the screen changes: if the popup closes on the next
        // frame, the route is still followable.
        await savePendingTransfer(record);
        pendingRoutes.reload();
        setTracked(record);
        setPhase("sent");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  function applyPercent(pct: number) {
    if (available === null || !from) return;
    const units = (available * BigInt(pct)) / 100n;
    setAmount(formatUnitsExact(units.toString(), from.decimals));
  }

  /* ---------------------------------------------------------------- *
   * Tracking
   * ---------------------------------------------------------------- */

  const trackInput =
    phase === "sent" && tracked
      ? {
          plan: tracked.plan,
          sourceTxHash: tracked.txHash,
          expectedAmount: tracked.amountBaseUnits,
          ...(tracked.swapContract ? { swapContract: tracked.swapContract } : {}),
          ...(tracked.recoveryAddress
            ? { recoveryAddress: tracked.recoveryAddress }
            : {}),
        }
      : null;
  const tracking = useRouteTracking(trackInput);

  // Forget a route that has finished with nothing left to claim. A recoverable
  // failure is deliberately kept: it is the only path back to the recover
  // action once the popup closes.
  const trackedHash = tracked?.txHash ?? null;
  const finished =
    tracking.route?.settled === true &&
    tracking.route.failure !== "swap-delivery-failed";
  useEffect(() => {
    if (!trackedHash || !finished) return;
    void removePendingTransfer(trackedHash);
  }, [trackedHash, finished]);

  const startRecovery = useCallback(() => {
    const recovery = tracking.route?.recovery;
    if (!recovery?.contractAddress || !recovery.recoveryAddress) return;
    void openConfirm({
      kind: "recover",
      chainId: recovery.chainId,
      signerAddress: recovery.recoveryAddress,
      msgs: [
        buildRecoverMsg({
          contractAddress: recovery.contractAddress,
          recoveryAddress: recovery.recoveryAddress,
        }),
      ],
      title: "Recover swap output",
      plan: null,
      amountBaseUnits: "0",
    });
  }, [tracking.route, openConfirm]);

  /* ---------------------------------------------------------------- *
   * Confirm
   * ---------------------------------------------------------------- */

  if (phase === "confirm" && pending && preview) {
    const memo = preview.packetMemo;
    const feeCoin = preview.fee.amount[0];
    const feeChain = chains.find((chain) => chain.chainId === pending.chainId);
    return (
      <ScreenScaffold
        title={pending.title}
        onBack={() => {
          setPhase(tracked ? "sent" : "form");
          setError(null);
        }}
        footer={
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              disabled={busy}
              onClick={() => {
                setPhase(tracked ? "sent" : "form");
                setError(null);
              }}
            >
              Back
            </Button>
            <Button className="flex-1" disabled={busy} onClick={() => void signPending()}>
              {busy ? "Signing…" : "Sign and send"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            {preview.preview.summaries.map((line, index) => (
              <p key={index} className="text-[11.5px] leading-snug text-fg">
                {line}
              </p>
            ))}
          </section>

          {memo ? (
            <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
              <SectionLabel>What the memo will do</SectionLabel>
              <p className="mt-1.5 text-[11.5px] leading-snug text-fg">{memo.summary}</p>
              {memo.xcs ? (
                <div className="mt-2 flex flex-col gap-1">
                  <KeyValueRow
                    label="Contract"
                    value={truncateAddress(memo.xcs.contract, 10, 8)}
                  />
                  <KeyValueRow
                    label="Buys"
                    value={<TruncatedValue>{shortDenom(memo.xcs.outputDenom)}</TruncatedValue>}
                  />
                  <KeyValueRow
                    label="Pays out to"
                    value={truncateAddress(memo.xcs.receiver, 10, 8)}
                  />
                  <KeyValueRow
                    label="If delivery fails"
                    value={
                      memo.xcs.onFailedDelivery.kind === "local_recovery_addr"
                        ? `recoverable by ${truncateAddress(memo.xcs.onFailedDelivery.address, 6, 6)}`
                        : "NOT recoverable"
                    }
                  />
                </div>
              ) : null}
              {memo.forward ? (
                <p className="mt-2 text-[10.5px] leading-snug text-fg-muted">
                  Forwards {memo.forward.hops.length}{" "}
                  {memo.forward.hops.length === 1 ? "hop" : "hops"} (
                  {memo.forward.hops.map((hop) => hop.channelId).join(", then ")}) and pays{" "}
                  {truncateAddress(memo.forward.finalReceiver, 8, 6)}.
                </p>
              ) : null}
              {memo.warnings.map((warning) => (
                <p key={warning} className="mt-1.5 text-[10.5px] text-[var(--z-warning)]">
                  {warning}
                </p>
              ))}
            </section>
          ) : null}

          <section className="flex flex-col gap-1.5 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
            <KeyValueRow
              label="Network fee"
              value={
                feeCoin
                  ? `${formatUnits(feeCoin.amount, feeChain?.entry.feeDecimals ?? 6)} ${feeChain?.entry.feeDenom ?? feeCoin.denom}`
                  : "none"
              }
            />
            <KeyValueRow label="Gas" value={preview.fee.gas_limit} />
            <KeyValueRow
              label="Sign bytes"
              value={`${preview.preview.signBytesHash.slice(0, 12)}…`}
            />
          </section>

          {preview.feeNote ? (
            <Callout tone="warning" title="Fee is an estimate">
              {preview.feeNote}
            </Callout>
          ) : null}

          {error ? (
            <Callout tone="danger" title="Could not sign">
              {error}
            </Callout>
          ) : (
            <Callout tone="info" title="One signature, one chain">
              You pay gas only on {feeChain?.entry.chainName ?? pending.chainId}. The swap
              itself runs on Osmosis inside packet processing and is paid for by the
              relayer, so you do not need OSMO.
            </Callout>
          )}
        </div>
      </ScreenScaffold>
    );
  }

  /* ---------------------------------------------------------------- *
   * Tracking
   * ---------------------------------------------------------------- */

  if (phase === "sent" && tracked) {
    const route = tracking.route;
    const recovery = route?.recovery ?? null;
    return (
      <ScreenScaffold
        title="Swap in flight"
        footer={
          <Button
            className="w-full"
            variant="secondary"
            onClick={() => {
              setPhase("form");
              setTracked(null);
              setRecoverTxHash(null);
              setPending(null);
              setPreview(null);
              setAmount("");
              pendingRoutes.reload();
            }}
          >
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-3 pt-1">
          <PacketTracker
            compact
            hops={route?.hops ?? []}
            sourceTxHash={tracked.txHash}
            sourceChainId={tracked.chainId}
            failure={route?.failure ?? null}
            recoveryReady={Boolean(recovery?.msg)}
            onRecover={startRecovery}
            recoverDisabledReason={
              recovery && !recovery.contractAddress
                ? "The crosschain-swaps contract address is not configured, so Zunia cannot build the recovery message."
                : recovery && !recovery.recoveryAddress
                  ? "This swap recorded no recovery address, so the contract has nobody to pay."
                  : null
            }
            txUrl={explorerTxUrl}
            loading={tracking.loading && !route}
            error={tracking.error}
            onRefresh={tracking.refresh}
            lastUpdatedAt={route?.updatedAt ?? null}
          />
          {recoverTxHash ? (
            <Callout tone="success" title="Recovery broadcast">
              Transaction {recoverTxHash.slice(0, 16)}… was accepted on{" "}
              {tracked.swapContract ? "Osmosis" : "the venue chain"}. It pays the swap
              output to your recovery address; check the balance there once it is
              included.
            </Callout>
          ) : null}
          {error ? (
            <Callout tone="danger" title="Recovery failed">
              {error}
            </Callout>
          ) : null}
          <Callout tone="neutral" title="This keeps running without the popup">
            The transfer proceeds on chain whether or not Zunia is open. Zunia remembers
            this route for a day, so you can come back to this screen; the transaction
            hash above is the only identifier you need in the meantime.
          </Callout>
        </div>
      </ScreenScaffold>
    );
  }

  /* ---------------------------------------------------------------- *
   * Form
   * ---------------------------------------------------------------- */

  const quoteView: SwapQuoteView | null =
    quote && from && to
      ? {
          inputAmount: formatUnits(quote.inputAmount, from.decimals),
          inputSymbol: from.symbol,
          outputAmount: formatUnits(quote.outputAmount, to.decimals),
          outputSymbol: to.symbol,
          rate: rateLine(
            quote.inputAmount,
            from.decimals,
            from.symbol,
            quote.outputAmount,
            to.decimals,
            to.symbol,
          ),
          minReceived: formatAsset(quote.minReceived, to.decimals, to.symbol),
          // `null`, not 0: the router reports no spot price for some pairs and
          // the panel renders "not reported" rather than a confident zero.
          priceImpact: quote.spotPrice === null ? null : quote.priceImpact,
          poolFee: quote.effectiveFeeFraction === null ? null : quote.poolFee,
          route: quote.route.map((hop) => ({ poolId: hop.poolId })),
        }
      : null;

  // When no route exists yet there is no hop list to hang the channel editors
  // off, and the legs a swap always needs are known regardless: into the venue,
  // and back out to the destination. Offering them here is what lets a user
  // recover from failed discovery instead of hitting a dead end.
  const fallbackHops =
    !plan && from && to
      ? [
          {
            index: 0,
            chainId: from.chainId,
            chainName: from.chainName,
            counterpartyChainId: VENUE_CHAIN_ID,
            counterpartyChainName: venue.check?.venue?.label ?? VENUE_CHAIN_ID,
            channelId: "",
            port: "transfer",
            kind: "transfer" as const,
          },
          ...(to.chainId === VENUE_CHAIN_ID
            ? []
            : [
                {
                  index: 1,
                  chainId: VENUE_CHAIN_ID,
                  chainName: venue.check?.venue?.label ?? VENUE_CHAIN_ID,
                  counterpartyChainId: to.chainId,
                  counterpartyChainName: to.chainName,
                  channelId: "",
                  port: "transfer",
                  kind: "forward" as const,
                },
              ]),
        ]
      : [];

  const feeLabel = sourceAccount
    ? `paid in ${sourceAccount.entry.feeDenom} on ${sourceAccount.entry.chainName}`
    : null;

  return (
    <ScreenScaffold
      title="Swap"
      right={
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          {planning ? "planning…" : `slippage ${slippage}%`}
        </span>
      }
      footer={
        <div>
          <Button
            className="w-full"
            disabled={!ready || busy}
            onClick={() => {
              if (!plan || !from || !sourceAccount || amountUnits === null) return;
              void openConfirm({
                kind: "swap",
                chainId: from.chainId,
                signerAddress: sourceAccount.address,
                msgs: [
                  buildTransferMsgFromPlan({
                    view: plan,
                    sender: sourceAccount.address,
                    amountBaseUnits: amountUnits.toString(),
                  }),
                ],
                title: "Confirm swap",
                plan,
                amountBaseUnits: amountUnits.toString(),
              });
            }}
          >
            {busy ? "Preparing…" : "Review swap"}
          </Button>
          <DisabledReason reason={ready ? null : blockedReason} />
        </div>
      }
    >
      <div className="flex flex-col gap-2 pt-1">
        <ResumeTrackingBanner
          rows={pendingRoutes.rows.filter((row) => row.kind === "swap")}
          onResume={(row) => {
            setTracked(row);
            setRecoverTxHash(null);
            setError(null);
            setPhase("sent");
          }}
          onDismiss={pendingRoutes.forget}
        />

        <AssetSide
          label="From"
          meta={
            hidden
              ? "••••"
              : from
                ? `${formatUnits(from.amount, from.decimals)} available`
                : NO_VALUE
          }
          asset={from}
          options={sources}
          onSelect={(key) => {
            setFromKey(key);
            setAmount("");
            setManual([]);
          }}
          amount={amount}
          onAmountChange={setAmount}
          emptyLabel="Nothing held"
        />

        <div className="flex gap-1.5">
          {PERCENTS.map((pct) => (
            <button
              key={pct}
              type="button"
              disabled={available === null}
              onClick={() => applyPercent(pct)}
              className={cn(
                "flex-1 rounded-full border border-[var(--z-line)] py-1 font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-muted",
                "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
                "disabled:cursor-not-allowed disabled:opacity-40",
                focusRing,
              )}
            >
              {pct === 100 ? "MAX" : `${pct}%`}
            </button>
          ))}
        </div>

        <div className="flex justify-center">
          <span
            aria-hidden
            className="-my-1 flex size-[26px] items-center justify-center rounded-full border border-[var(--z-line)] text-fg-dim"
          >
            <IconSwap width={14} height={14} />
          </span>
        </div>

        <AssetSide
          label="To"
          meta={to ? to.chainName : NO_VALUE}
          asset={to}
          options={destinations}
          onSelect={(key) => {
            setToKey(key);
            setManual([]);
          }}
          amount={
            quoteView ? quoteView.outputAmount : amountUnits !== null ? NO_VALUE : ""
          }
          readOnly
          placeholder="—"
          emptyLabel="No network"
        />

        <SwapQuotePanel
          compact
          quote={quoteView}
          gasChainName={sourceAccount?.entry.chainName ?? "the source chain"}
          swapVenueName={venue.check?.venue?.label ?? "Osmosis"}
          gasFeeLabel={feeLabel}
          slippagePercent={slippage}
          onSlippageChange={setSlippage}
          slippagePresets={SLIPPAGE_PRESETS}
          loading={planning && !quote}
          error={result?.quoteBlockedReason ?? result?.error ?? null}
          onRetry={() => setRetryToken((n) => n + 1)}
        />

        {slippage > HIGH_SLIPPAGE_PERCENT ? (
          <Callout tone="warning" title={`${slippage}% is a wide tolerance`}>
            The contract will accept a price up to {slippage}% worse than the pool average
            before it refuses. On a thin pool that is a real loss, not a rounding error.
          </Callout>
        ) : null}

        <RoutePreview
          compact
          hops={plan?.hops ?? []}
          estimatedDurationSeconds={plan?.plan.estimatedDurationSeconds ?? null}
          warnings={plan?.warnings ?? result?.warnings ?? []}
          requiresPfm={plan?.plan.requiresPfm ?? false}
          requiresIbcHooks={plan?.plan.requiresIbcHooks ?? false}
          gasChainName={sourceAccount?.entry.chainName ?? ""}
          swapVenueName={venue.check?.venue?.label ?? "Osmosis"}
          loading={planning && !plan}
          error={result?.error ?? null}
          onRetry={() => setRetryToken((n) => n + 1)}
          emptyTitle={liveReads ? "No route yet" : "Route planning is off"}
          emptyDescription={
            liveReads
              ? "Pick both assets and an amount, and Zunia will plan the hops."
              : "Turn on live balances in Settings → Preferences so Zunia can read channels."
          }
          footer={
            plan ? (
              <HopChannelList
                hops={plan.hops}
                manual={manual}
                onPick={(channel) =>
                  setManual((rows) => [
                    ...rows.filter(
                      (row) =>
                        row.fromChainId !== channel.fromChainId ||
                        row.toChainId !== channel.toChainId,
                    ),
                    channel,
                  ])
                }
                onClear={(fromChainId, toChainId) =>
                  setManual((rows) =>
                    rows.filter(
                      (row) =>
                        row.fromChainId !== fromChainId || row.toChainId !== toChainId,
                    ),
                  )
                }
              />
            ) : null
          }
        />

        {/*
          RoutePreview drops its footer in the empty state, and the empty state
          is exactly when a user needs the channel editors: discovery failed, so
          there is no route to attach them to. The legs a swap always needs are
          known anyway, so they are offered here instead of a dead end.
        */}
        {!plan && fallbackHops.length > 0 ? (
          <section>
            <SectionLabel>Channels this swap needs</SectionLabel>
            <p className="mb-1.5 mt-1 text-[10.5px] leading-snug text-fg-muted">
              Nothing has confirmed a path yet. Pick or type the channel for each leg and
              Zunia will plan again.
            </p>
            <HopChannelList
              hops={fallbackHops}
              manual={manual}
                onPick={(channel) =>
                  setManual((rows) => [
                    ...rows.filter(
                      (row) =>
                        row.fromChainId !== channel.fromChainId ||
                        row.toChainId !== channel.toChainId,
                    ),
                    channel,
                  ])
                }
                onClear={(fromChainId, toChainId) =>
                  setManual((rows) =>
                    rows.filter(
                      (row) =>
                        row.fromChainId !== fromChainId || row.toChainId !== toChainId,
                    ),
                  )
                }
            />
          </section>
        ) : null}

        {venue.loading ? (
          <p className="flex items-center gap-1.5 font-mono text-[10px] text-fg-dim">
            <Spinner className="size-3" /> Checking the crosschain-swaps contract…
          </p>
        ) : null}

        {venue.check?.reason ? (
          <Callout tone="danger" title="Swaps are off">
            {venue.check.reason}
            <button
              type="button"
              onClick={venue.recheck}
              className={cn("mt-1.5 block underline underline-offset-2", focusRing)}
            >
              Check again
            </button>
            {venue.check.problem === "absent" || venue.check.problem === "unset" ? (
              <SwapContractOverride
                current={venue.check.contractAddress}
                onSaved={venue.recheck}
              />
            ) : null}
          </Callout>
        ) : venue.check?.contractAddress ? (
          <p className="font-mono text-[9px] leading-relaxed text-fg-dim">
            Verified {venue.check.label ?? "contract"}{" "}
            {truncateAddress(venue.check.contractAddress, 10, 8)} on {venue.check.chainId}
          </p>
        ) : null}

        {sourceAccount?.entry.network === "testnet" ||
        destAccount?.entry.network === "testnet" ? (
          <Pill tone="warning" className="self-start">
            testnet funds
          </Pill>
        ) : null}

        {error ? (
          <Callout tone="danger" title="Could not prepare the swap">
            {error}
          </Callout>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

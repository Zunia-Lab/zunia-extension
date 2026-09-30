/**
 * Cross-chain swap: one signature on the source chain, an Osmosis
 * crosschain-swap executed by relayers inside packet processing, and delivery
 * on the destination chain.
 *
 * There is no aggregator and no custodian. The wallet plans the route itself
 * with `@zunialab/interchain` (unwinding a wrapped denom, discovering and
 * verifying channels, composing the ibc-hooks memo with a packet-forward hop
 * before or after when Osmosis is not adjacent) prices the pool against the
 * Osmosis router, and hands one `MsgTransfer` to `@zunialab/core` to sign.
 *
 * Every control on this screen is enabled only when its whole path works, and
 * the first thing that does not work is named on the button.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Callout,
  IconButton,
  KeyValueRow,
  PacketTracker,
  Pill,
  TokenLogo,
  RoutePreview,
  ScreenScaffold,
  SectionLabel,
  Skeleton,
  Spinner,
  SwapQuotePanel,
  cn,
  focusRing,
  truncateAddress,
  type SwapQuoteView,
} from "@zunialab/ui";
import type { BuiltMsg, OsmosisSwapQuote } from "@zunialab/interchain";

import type { ChainBalance } from "../../../lib/balances";
import {
  explorerTxUrl,
  MAX_SLIPPAGE_PERCENT,
  QUOTE_TTL_MS,
  SLIPPAGE_PRESETS,
} from "../../../config/interchain";
import { NO_VALUE, formatUnits, formatUnitsExact } from "../../../lib/format";
import { buildRecoverMsg, routeOutcome } from "../../../lib/packet-tracking";
import {
  removePendingTransfer,
  savePendingTransfer,
  type PendingTransfer,
} from "../../../lib/pending-transfers";
import {
  VENUE_CHAIN_ID,
  buildTransferMsgFromPlan,
  planSwap,
  requoteSwap,
  type ManualChannel,
  type RoutePlanView,
  type SwapPlanResult,
} from "../../../lib/route-plan";
import { feeTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import {
  maxSendable,
  prefFeeFor,
  reservedFeeUnits,
  RESERVE_GAS_LIMIT,
} from "../../../lib/fee-prefs";
import { sendToBackground } from "../../../lib/popup-client";
import type { TxPreview } from "../../../lib/tx-kernel";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { SwapPair } from "../components/SwapPair";
import { SwapSettingsDialog } from "../components/SwapSettingsDialog";
import { usePrices } from "../hooks/usePrices";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import {
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
  useClock,
  useOsmosisAssets,
  usePendingTransfers,
  useSwapVenue,
  catalogNativeAssets,
  withCatalogAssets,
  withOsmosisAssets,
} from "./interchain-ui";
import { IconSettings } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";
import { notifyBroadcastAccepted, useToast } from "../state/Toasts";

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

/** How long the shown price stays current, and a way to fetch a new one now. */
function QuoteClock({
  secondsLeft,
  refreshing,
  onRefresh,
  confirm = false,
}: {
  secondsLeft: number;
  refreshing: boolean;
  onRefresh: () => void;
  confirm?: boolean;
}) {
  const expired = secondsLeft === 0;
  const text = refreshing
    ? "Updating the price…"
    : expired
      ? confirm
        ? "Price expired. Refresh it to sign."
        : "Price expired"
      : confirm
        ? `Price valid for ${secondsLeft}s`
        : `Price updates in ${secondsLeft}s`;
  return (
    <div className="mt-2 flex items-center justify-between gap-2">
      <span
        role="timer"
        className={cn(
          "flex min-w-0 items-center gap-1.5 font-mono text-[9.5px]",
          expired && !refreshing ? "text-[var(--z-warning)]" : "text-fg-dim",
        )}
      >
        {refreshing ? <Spinner className="size-3 shrink-0" /> : null}
        {text}
      </span>
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className={cn(
          "shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          "disabled:cursor-not-allowed disabled:opacity-40",
          focusRing,
        )}
      >
        Refresh
      </button>
    </div>
  );
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
  const signedSend = useSignedSend();
  const toast = useToast();
  const { hidden, settings, fiat } = usePrefs();
  const liveReads = settings.liveBalances;

  const sources = useMemo(() => spendableAssets(chains, balances), [chains, balances]);
  // An empty balance map is "not read yet", not "holds nothing": the reader
  // writes a row per chain even when every denom is zero.
  const balancesLoaded = Object.keys(balances).length > 0;
  const osmosis = useOsmosisAssets(liveReads);
  const destinations = useMemo(
    () =>
      withOsmosisAssets(
        withCatalogAssets(receivableAssets(chains, balances), catalogNativeAssets()),
        osmosis.assets,
        VENUE_CHAIN_ID,
      ),
    [chains, balances, osmosis.assets],
  );

  // Stored as "what the user picked", null until they pick. The effective
  // selection is derived below, so opening the screen needs no effect that
  // writes state on the first render.
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [toKey, setToKey] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const slippage = settings.swapSlippage;
  const [manual, setManual] = useState<ManualChannel[]>([]);
  // Bumped by the retry controls. Part of the plan key, because re-running the
  // same inputs must actually re-run them; a new array identity would not.
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
  const [routeOpen, setRouteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const expert = advanced;

  const kernel = useKernelSigning();
  const venue = useSwapVenue(liveReads);
  const pendingRoutes = usePendingTransfers();
  const resolveAddresses = useResolveAddresses();

  // The source defaults to whatever chain the user came from, the destination
  // to anything on a different chain, so the screen opens with a plausible pair
  // already in it.
  // Held balances first. A flipped side can be a token this wallet does not
  // hold yet, and that pick has to stay put so the route is replanned instead
  // of snapping back to the first balance.
  const fromChoices = useMemo(() => {
    const held = new Set(sources.map((asset) => asset.key));
    return [...sources, ...destinations.filter((asset) => !held.has(asset.key))];
  }, [sources, destinations]);
  const from =
    fromChoices.find((asset) => asset.key === fromKey) ??
    sources.find((asset) => asset.chainId === initialChainId) ??
    sources[0];
  const to =
    destinations.find((asset) => asset.key === toKey) ??
    destinations.find((asset) => asset.chainId !== from?.chainId) ??
    destinations[0];
  const sourceAccount = chains.find((chain) => chain.chainId === from?.chainId);
  const destAccount = chains.find((chain) => chain.chainId === to?.chainId);
  const [catalogDestAddress, setCatalogDestAddress] = useState<string | null>(null);

  const amountUnits = from ? toBaseUnits(amount, from.decimals) : null;
  const available = from ? BigInt(from.amount) : null;
  const feeReserve = from
    ? reservedFeeUnits(from.chainId, from.denom, settings)
    : 0n;
  const spendable =
    available !== null ? maxSendable(available, feeReserve) : null;
  const overBalance =
    amountUnits !== null && spendable !== null && amountUnits > spendable;

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
  // A token listed on Osmosis is delivered there, to this wallet's own Osmosis
  // address, whether or not Osmosis is one of the enabled chains.
  useEffect(() => {
    if (!to?.chainId || destAccount?.address) {
      setCatalogDestAddress(destAccount?.address ?? null);
      return;
    }
    let cancelled = false;
    void resolveAddresses([to.chainId]).then((map) => {
      if (!cancelled) setCatalogDestAddress(map[to.chainId] ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [to?.chainId, destAccount?.address, resolveAddresses]);

  const destAddress =
    destAccount?.address ??
    catalogDestAddress ??
    (to?.chainId === VENUE_CHAIN_ID ? recoveryAddress : null);

  const priceChainIds = useMemo(() => {
    const ids = [from?.chainId, to?.chainId].filter(
      (id): id is string => Boolean(id),
    );
    return [...new Set(ids)];
  }, [from?.chainId, to?.chainId]);
  const { prices } = usePrices(priceChainIds, liveReads);

  function pricedFiat(
    asset: typeof from,
    displayAmount: string,
  ): string | null {
    if (!asset) return null;
    const entry = findCatalogEntry(asset.chainId);
    if (!entry || entry.coinMinimalDenom !== asset.denom) return null;
    const spot = prices[asset.chainId];
    if (!spot) return null;
    const n = Number(displayAmount);
    if (!displayAmount.trim() || !Number.isFinite(n)) return fiat(0);
    return fiat(n * spot.price);
  }

  /* ---------------------------------------------------------------- *
   * Planning
   * ---------------------------------------------------------------- */

  const [settledPlan, setSettledPlan] = useState<{
    key: string;
    result: SwapPlanResult;
    quotedAt: number;
  } | null>(null);
  /** A price fetched after the plan, for the same plan key. */
  const [requoted, setRequoted] = useState<{
    key: string;
    quote: OsmosisSwapQuote | null;
    error: string | null;
    at: number;
  } | null>(null);
  const [requotingKey, setRequotingKey] = useState<string | null>(null);

  // The contract reads `slippage_percentage` on a 0-100 scale and divides by
  // 100 itself, so an out-of-range value is not a wide tolerance, it is a memo
  // the contract rejects. Caught before planning rather than as a build error.
  const slippageOk =
    Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;

  const canPlan =
    liveReads &&
    Boolean(from && to && sourceAccount?.address && destAddress) &&
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
        recipient: destAddress!,
        recoveryAddress: recoveryAddress!,
        slippagePercent: slippage,
        venue: venue.check!.venue!,
        manualChannels: manual,
        resolveAddresses,
        signal: controller.signal,
      }).then((next) => {
        if (!controller.signal.aborted) {
          setSettledPlan({ key: planKey, result: next, quotedAt: Date.now() });
        }
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

  /* ---------------------------------------------------------------- *
   * The price, and how old it is
   * ---------------------------------------------------------------- */

  // A later price for the same plan replaces the one planning returned. The
  // `at` check keeps a price fetched for an earlier run of the same inputs
  // from overriding a newer plan.
  const fresh =
    result && requoted?.key === planKey && requoted.at >= (settledPlan?.quotedAt ?? 0)
      ? requoted
      : null;
  const quote = fresh ? fresh.quote : (result?.quote ?? null);
  const quoteError = fresh ? fresh.error : (result?.quoteBlockedReason ?? null);
  const quotedAt = fresh ? fresh.at : result ? (settledPlan?.quotedAt ?? null) : null;
  const refreshing = Boolean(planKey) && requotingKey === planKey;

  const now = useClock(quotedAt !== null && phase !== "sent");
  const quoteSecondsLeft =
    quotedAt === null
      ? null
      : Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - quotedAt)) / 1000));
  const quoteExpired = quote !== null && quoteSecondsLeft === 0;

  const venueChainId = result?.venue?.chainId ?? null;
  const venueContract = result?.venue?.contractAddress ?? null;
  const venueInputDenom = result?.venueInputDenom ?? null;
  const venueOutputDenom = result?.venueOutputDenom ?? null;
  const amountBase = amountUnits?.toString() ?? null;
  const canRequote = Boolean(
    planKey && venueChainId && venueContract && venueInputDenom && venueOutputDenom && amountBase,
  );

  const refreshQuote = useCallback(async () => {
    if (
      !planKey ||
      !venueChainId ||
      !venueContract ||
      !venueInputDenom ||
      !venueOutputDenom ||
      !amountBase
    ) {
      return { quote: null, error: "There is no route to price yet." };
    }
    const key = planKey;
    setRequotingKey(key);
    const next = await requoteSwap({
      venueChainId,
      venueContract,
      venueInputDenom,
      venueOutputDenom,
      amountBaseUnits: amountBase,
      slippagePercent: slippage,
    }).catch((caught: unknown) => ({
      quote: null,
      error: caught instanceof Error ? caught.message : String(caught),
    }));
    setRequoted({ key, quote: next.quote, error: next.error, at: Date.now() });
    setRequotingKey((current) => (current === key ? null : current));
    return next;
  }, [
    planKey,
    venueChainId,
    venueContract,
    venueInputDenom,
    venueOutputDenom,
    amountBase,
    slippage,
    setRequoted,
    setRequotingKey,
  ]);

  // The form keeps the price current on its own. The confirm screen does not:
  // a number changing under the user's cursor right before they sign is worse
  // than asking them to refresh it.
  useEffect(() => {
    if (phase !== "form" || !canRequote || quotedAt === null) return;
    const due = quotedAt + QUOTE_TTL_MS;
    const refreshIfDue = () => {
      if (document.visibilityState === "visible" && Date.now() >= due) void refreshQuote();
    };
    const timer = window.setTimeout(refreshIfDue, Math.max(0, due - Date.now()));
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [phase, canRequote, quotedAt, refreshQuote]);

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
    if (!destAddress) {
      if (to.chainId === VENUE_CHAIN_ID && recovery === null) return null;
      return `Zunia has no address on ${to.chainName}, so it has nowhere to deliver.`;
    }
    if (from.chainId === to.chainId && from.denom === to.denom) {
      return "Both sides are the same asset on the same chain.";
    }
    if (from.chainId === VENUE_CHAIN_ID && to.chainId === VENUE_CHAIN_ID) {
      return "Both tokens are already on Osmosis, and this screen swaps by sending to another chain after the pool.";
    }
    if (!amount) return "Enter an amount to swap.";
    if (amountUnits === null) return "That amount is not a number this chain can hold.";
    if (amountUnits <= 0n) return "Enter an amount above zero.";
    if (overBalance) {
      return `More than the ${from.symbol} left after the network fee.`;
    }
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
    if (quoteError) return quoteError;
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
    destAddress,
    recovery,
    amount,
    amountUnits,
    overBalance,
    slippageOk,
    recoveryAddress,
    recoveryFailed,
    planning,
    result,
    plan,
    quoteError,
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
          feeSpeed: settings.feeSpeed,
          gasAdjustment: settings.gasAdjustment,
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
    [settings.feeSpeed, settings.gasAdjustment],
  );

  async function signPending() {
    if (!pending || !preview) return;
    if (
      pending.kind === "swap" &&
      (!quote || quotedAt === null || Date.now() - quotedAt >= QUOTE_TTL_MS)
    ) {
      setError(
        `This price is more than ${QUOTE_TTL_MS / 1000} seconds old. Refresh it, check it, then sign.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const broadcastResult = await signedSend<{ txhash: string }>(
        "SIGN_AND_BROADCAST_TX",
        {
          chainId: pending.chainId,
          signerAddress: pending.signerAddress,
          msgs: pending.msgs,
          memo: preview.preview.memo,
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
        notifyBroadcastAccepted(toast, broadcastResult.txhash);
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
        notifyBroadcastAccepted(toast, broadcastResult.txhash);
      }
    } catch (caught) {
      const message = signingError(caught);
      setError(message);
      if (message) toast(message, { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  /** Price the swap again, then build what gets signed against that price. */
  async function reviewSwap() {
    if (!plan || !from || !sourceAccount || amountUnits === null) return;
    setBusy(true);
    setError(null);
    const priced = await refreshQuote();
    if (!priced.quote) {
      setBusy(false);
      setError(priced.error ?? "The price could not be refreshed, so the swap was not prepared.");
      return;
    }
    await openConfirm({
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
  }

  const canFlip = Boolean(from && to && from.key !== to.key);
  function flipSides() {
    if (!from || !to || from.key === to.key) return;
    setFromKey(to.key);
    setToKey(from.key);
    setManual([]);
  }

  function applyMax() {
    if (available === null || !from) return;
    const units = maxSendable(available, feeReserve);
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
  const outcome = tracking.route ? routeOutcome(tracking.route) : null;
  const finished =
    outcome === "delivered" || outcome === "refunded" || outcome === "failed";
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

  /* ---------------------------------------------------------------- *
   * Confirm
   * ---------------------------------------------------------------- */

  if (phase === "confirm" && pending && preview) {
    const memo = preview.packetMemo;
    const swapPriceStale = pending.kind === "swap" && (!quote || quoteExpired || refreshing);
    const feeCoin = preview.fee.amount[0];
    const feeChain = chains.find((chain) => chain.chainId === pending.chainId);
    const feeUnits = feeCoin ? BigInt(feeCoin.amount) : 0n;
    const leftover =
      available !== null && pending.kind === "swap" && amountUnits !== null
        ? available - amountUnits
        : null;
    const feeShort =
      Boolean(from && feeCoin && feeCoin.denom === from.denom) &&
      leftover !== null &&
      leftover < feeUnits;
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
            <Button
              className="flex-1"
              disabled={busy || swapPriceStale || feeShort}
              onClick={() => void signPending()}
            >
              {busy
                ? "Signing…"
                : feeShort
                  ? "Need fee room"
                  : pending.kind === "swap" && quoteExpired
                    ? "Price expired"
                    : "Sign and send"}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          {pending.kind === "swap" && from && to ? (
            <section className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                For about
              </p>
              <div className="mt-1.5 flex items-center gap-2">
                <TokenLogo src={from.iconUrl ?? from.chainIconUrl} symbol={from.symbol} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg">
                    {formatAsset(pending.amountBaseUnits, from.decimals, from.symbol) ?? NO_VALUE}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[9.5px] text-fg-dim">
                    {from.chainName}
                  </p>
                </div>
              </div>
              <div className="my-1.5 h-px bg-[var(--z-line)]" />
              <div className="flex items-center gap-2">
                <TokenLogo src={to.iconUrl ?? to.chainIconUrl} symbol={to.symbol} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="text-[15px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-fg">
                    {quoteView ? `${quoteView.outputAmount} ${quoteView.outputSymbol}` : NO_VALUE}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[9.5px] text-fg-dim">
                    {to.chainName}
                    {quoteView?.minReceived ? ` · at least ${quoteView.minReceived}` : ""}
                  </p>
                </div>
              </div>
              {quoteSecondsLeft !== null ? (
                <div className="mt-2">
                  <QuoteClock
                    confirm
                    secondsLeft={quote ? quoteSecondsLeft : 0}
                    refreshing={refreshing}
                    onRefresh={() => {
                      setError(null);
                      void refreshQuote();
                    }}
                  />
                </div>
              ) : null}
              {quoteError && !refreshing ? (
                <p className="mt-1.5 text-[10px] leading-snug text-[var(--z-warning)]">{quoteError}</p>
              ) : null}
            </section>
          ) : pending.kind === "recover" ? (
            <section className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                Recover
              </p>
              <p className="mt-1 text-[13px] font-semibold tracking-tight text-fg">
                Claim stranded swap output
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
                Contract call on the venue chain, not another transfer.
              </p>
            </section>
          ) : null}

          <section className="min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            {preview.preview.summaries.map((line, index) => (
              <p key={index} className="min-w-0 break-words text-[11px] leading-snug text-fg [overflow-wrap:anywhere]">
                {line}
              </p>
            ))}
          </section>

          {memo ? (
            <section className="min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
              <SectionLabel>What the memo will do</SectionLabel>
              <p className="mt-1 min-w-0 break-words text-[11px] leading-snug text-fg [overflow-wrap:anywhere]">
                {memo.summary}
              </p>
              {memo.xcs ? (
                <div className="mt-1.5 flex flex-col gap-0.5">
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
                <p className="mt-1.5 text-[10px] leading-snug text-fg-muted">
                  Forwards {memo.forward.hops.length}{" "}
                  {memo.forward.hops.length === 1 ? "hop" : "hops"} (
                  {memo.forward.hops.map((hop) => hop.channelId).join(", then ")}) and pays{" "}
                  {truncateAddress(memo.forward.finalReceiver, 8, 6)}.
                </p>
              ) : null}
              {memo.warnings.map((warning) => (
                <p key={warning} className="mt-1 text-[10px] text-[var(--z-warning)]">
                  {warning}
                </p>
              ))}
            </section>
          ) : null}

          <section className="min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={feeCoin?.amount}
              feeDecimals={feeChain?.entry.feeDecimals ?? 6}
              feeSymbol={feeChain ? feeTicker(feeChain.entry) : (feeCoin?.denom ?? "")}
              onChanged={() => {
                if (!pending) return;
                void openConfirm(pending);
              }}
            />
            {preview.preview.memo ? (
              <div className="mt-1.5">
                <KeyValueRow label="Memo" value={preview.preview.memo} />
              </div>
            ) : null}
          </section>

          {feeShort ? (
            <Callout compact tone="danger" title="Not enough left for the fee">
              Lower the amount or the gas speed. The chain takes the fee first,
              then the swap.
            </Callout>
          ) : null}

          {preview.feeNote ? (
            <Callout compact tone="warning" title="Fee is an estimate">
              {preview.feeNote}
            </Callout>
          ) : null}

          {error ? (
            <Callout compact tone="danger" title="Could not sign">
              {error}
            </Callout>
          ) : null}
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
    const failed = outcome === "failed" || route?.failure === "source-failed";
    return (
      <ScreenScaffold
        title={failed ? "Swap failed" : "Swap in flight"}
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
            <Callout compact tone="danger" title="Recovery failed">
              {error}
            </Callout>
          ) : null}
          {failed ? (
            <Callout compact tone="danger" title="Transaction failed">
              {route?.sourceError ||
                "The source chain rejected this swap. Nothing was transferred."}
            </Callout>
          ) : (
            <Callout compact tone="neutral" title="Runs without the popup">
              Zunia follows this for a day and lists it on Activity until it
              arrives. The hash above is the identifier you need meanwhile.
            </Callout>
          )}
        </div>
      </ScreenScaffold>
    );
  }

  /* ---------------------------------------------------------------- *
   * Form
   * ---------------------------------------------------------------- */

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

  const estimatedFee = from
    ? prefFeeFor(from.chainId, RESERVE_GAS_LIMIT, settings)
    : null;
  const feeText = estimatedFee
    ? `${formatUnits(estimatedFee.amount.toString(), estimatedFee.decimals, 6)} ${estimatedFee.symbol}`
    : null;
  const poolFeeText =
    typeof quoteView?.poolFee === "number" && Number.isFinite(quoteView.poolFee)
      ? `${quoteView.poolFee.toFixed(quoteView.poolFee >= 1 ? 2 : 3)}%`
      : null;
  const feesLine = [feeText, poolFeeText].filter(Boolean).join(" + ") || "—";
  const maxLabel =
    from && spendable !== null
      ? `${formatUnitsExact(spendable.toString(), from.decimals, 6)} ${from.symbol}`
      : null;

  const quoteFooter =
    quote && quoteSecondsLeft !== null ? (
      <QuoteClock
        secondsLeft={quoteSecondsLeft}
        refreshing={refreshing}
        onRefresh={() => void refreshQuote()}
      />
    ) : null;

  return (
    <ScreenScaffold
      header={
        <header className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <h1 className="text-[17px] font-semibold tracking-tight text-fg">
                Swap
              </h1>
              <span className="truncate text-[11px] text-fg-dim">via Osmosis</span>
            </div>
          </div>
          <IconButton
            label="Swap settings"
            variant="ghost"
            size="sm"
            className="h-8 w-8 text-fg-muted hover:text-fg"
            onClick={() => setSettingsOpen(true)}
          >
            <IconSettings width={16} height={16} />
          </IconButton>
        </header>
      }
      footer={
        <div>
          <Button className="w-full" disabled={!ready || busy} onClick={() => void reviewSwap()}>
            {busy
              ? "Checking the price…"
              : ready && quoteView
                ? `Swap for ${quoteView.outputAmount} ${quoteView.outputSymbol}`
                : "Swap"}
          </Button>
          <DisabledReason reason={ready ? null : blockedReason} />
        </div>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
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

        <SwapPair
          from={from}
          to={to}
          fromOptions={
            from && !sources.some((asset) => asset.key === from.key)
              ? [from, ...sources]
              : sources
          }
          toOptions={destinations}
          amount={amount}
          receiveAmount={quoteView ? quoteView.outputAmount : ""}
          onAmountChange={setAmount}
          onSelectFrom={(key) => {
            setFromKey(key);
            setAmount("");
            setManual([]);
          }}
          onSelectTo={(key) => {
            setToKey(key);
            setManual([]);
          }}
          onFlip={flipSides}
          flipLabel="Swap the two sides"
          canFlip={canFlip}
          quoting={planning || refreshing}
          hidden={hidden}
          fromFiat={hidden ? "••••" : pricedFiat(from, amount)}
          toFiat={hidden ? "••••" : pricedFiat(to, quoteView?.outputAmount ?? "")}
          maxLabel={maxLabel}
          onMax={applyMax}
        />

        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className={cn(
            "flex w-full items-center justify-between gap-2 px-0.5 py-0.5 text-left",
            focusRing,
          )}
        >
          <span className="flex items-center gap-1.5 text-[12px] text-fg-muted">
            Fees
            <span
              className={cn(
                "size-1.5 rounded-full",
                estimatedFee ? "bg-[var(--z-success)]" : "bg-[var(--z-line-strong)]",
              )}
              aria-hidden
            />
          </span>
          <span className="font-mono text-[11px] tabular-nums text-fg">
            {feesLine}
          </span>
        </button>

        {quote && quoteSecondsLeft !== null ? (
          <QuoteClock
            secondsLeft={quoteSecondsLeft}
            refreshing={refreshing}
            onRefresh={() => void refreshQuote()}
          />
        ) : null}

        <SwapSettingsDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          advanced={advanced}
          onAdvancedChange={setAdvanced}
        />

        {osmosis.error ? (
          <p className="text-[10.5px] leading-snug text-fg-muted">
            The Osmosis token list did not load ({osmosis.error}), so only your own tokens are
            offered to receive.
          </p>
        ) : null}

        {expert || quoteError || result?.error ? (
          <SwapQuotePanel
            compact
            variant={expert ? "expert" : "simple"}
            title={null}
            quote={quoteView}
            slippagePercent={slippage}
            slippagePresets={SLIPPAGE_PRESETS}
            loading={(planning || refreshing) && !quote}
            error={quoteError ?? result?.error ?? null}
            onRetry={() => setRetryToken((n) => n + 1)}
            footer={expert ? quoteFooter : null}
          />
        ) : null}

        {expert ? (
          <>
            <button
              type="button"
              onClick={() => setRouteOpen((open) => !open)}
              className={cn(
                "flex w-full items-center justify-between rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-2.5 text-left",
                "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
                focusRing,
              )}
            >
              <span className="min-w-0">
                <span className="block text-[12.5px] font-medium text-fg">
                  {planning
                    ? "Finding a route…"
                    : plan
                      ? `Via ${venue.check?.venue?.label ?? "Osmosis"}`
                      : "Route and channels"}
                </span>
                <span className="mt-0.5 block font-mono text-[9.5px] text-fg-dim">
                  {plan
                    ? `${plan.hops.length} hop${plan.hops.length === 1 ? "" : "s"} · best Osmosis route`
                    : liveReads
                      ? "Override hops if discovery misses a channel"
                      : "Turn on live balances to plan hops"}
                </span>
              </span>
              <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-accent">
                {routeOpen ? "Hide" : "Show"}
              </span>
            </button>

            {routeOpen ? (
              <>
                <RoutePreview
                  compact
                  hops={plan?.hops ?? []}
                  estimatedDurationSeconds={plan?.plan.estimatedDurationSeconds ?? null}
                  warnings={plan?.warnings ?? result?.warnings ?? []}
                  requiresPfm={plan?.plan.requiresPfm ?? false}
                  requiresIbcHooks={plan?.plan.requiresIbcHooks ?? false}
                  swapVenueName={venue.check?.venue?.label ?? "Osmosis"}
                  loading={planning && !plan}
                  error={result?.error ?? null}
                  onRetry={() => setRetryToken((n) => n + 1)}
                  emptyTitle={liveReads ? "No route yet" : "Route planning is off"}
                  emptyDescription={
                    liveReads
                      ? "Pick both assets and an amount, and Zunia will plan the hops."
                      : "Turn on live balances in Settings, Preferences so Zunia can read channels."
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

                {!plan && fallbackHops.length > 0 ? (
                  <section>
                    <SectionLabel>Channels this swap needs</SectionLabel>
                    <p className="mb-1.5 mt-1 text-[10.5px] leading-snug text-fg-muted">
                      Nothing has confirmed a path yet. Pick or type the channel for each
                      leg and Zunia will plan again.
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
              </>
            ) : null}
          </>
        ) : null}

        {venue.loading ? (
          <div
            role="status"
            aria-label="Checking the swap contract"
            className="flex flex-col gap-1.5"
          >
            <Skeleton className="h-2 w-3/5" />
            <Skeleton className="h-2 w-2/5" />
          </div>
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
            {expert && (venue.check.problem === "absent" || venue.check.problem === "unset") ? (
              <SwapContractOverride
                current={venue.check.contractAddress}
                onSaved={venue.recheck}
              />
            ) : null}
          </Callout>
        ) : expert && routeOpen && venue.check?.contractAddress ? (
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

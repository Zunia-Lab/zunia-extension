/**
 * Cross-chain swap: one signature on the source chain, an Osmosis
 * crosschain-swap executed by relayers inside packet processing, and delivery
 * on the destination chain.
 *
 * There is no aggregator and no custodian. The wallet plans the route itself
 * with `@zunialab/interchain` (unwinding a wrapped denom, discovering and
 * verifying channels, composing the ibc-hooks memo with a packet-forward hop
 * before or after when Osmosis is not adjacent) prices the pool against the
 * Osmosis router, and hands one swap message to `@zunialab/core` to sign: a
 * `MsgTransfer`, or a `MsgExecuteContract` on Osmosis when the funds are
 * already there.
 *
 * Zunia's fee (config/fees.ts, lib/swap-fee.ts) rides in the same
 * transaction, right after the swap message: a bank send of the token sold to
 * the treasury configured for the signing chain. The amount typed (or Max) is
 * what the user spends in all; the swap sells what is left after the fee. A
 * chain with no treasury configured signs the swap message alone.
 *
 * Every control on this screen is enabled only when its whole path works, and
 * the first thing that does not work is named on the button. The confirm
 * screen shows a frozen review ({@link ReviewedSwap}) and, read out of the
 * messages themselves, what the swap contract will do ({@link readSwapMessage})
 * and what the fee pays ({@link readSwapFeeMsg}).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Button,
  Callout,
  IconButton,
  KeyValueRow,
  PacketTracker,
  Pill,
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
import {
  applySlippage,
  decodeBase64Utf8,
  encodeBase64Utf8,
  isWasmHookReceiverValid,
  validateMemo,
  type BuiltMsg,
  type ForwardHopInfo,
  type ForwardMemoInfo,
  type OsmosisSwapQuote,
  type XcsSwapInfo,
} from "@zunialab/interchain";

import type { ChainBalance } from "../../../lib/balances";
import {
  explorerTxUrl,
  MAX_SLIPPAGE_PERCENT,
  QUOTE_TTL_MS,
  SLIPPAGE_PRESETS,
} from "../../../config/interchain";
import { NO_VALUE, formatUnits } from "../../../lib/format";
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
  type SwapPlanInput,
  type SwapPlanResult,
  type SwapQuoteBlockedCode,
  type VenueQuoteInput,
} from "../../../lib/route-plan";
import { feeTicker, findCatalogEntry } from "../../../lib/chain-catalog";
import {
  maxSendable,
  prefFeeFor,
  reservedFeeUnits,
  RESERVE_GAS_LIMIT,
} from "../../../lib/fee-prefs";
import { sendToBackground } from "../../../lib/popup-client";
import {
  buyOptions,
  expectedVenueDenoms,
  sellOptions,
  type AssetOption,
} from "../../../lib/swap-assets";
import {
  BANK_SEND_TYPE_URL,
  buildSwapFeeMsg,
  feeRateText,
  readSwapFeeMsg,
  sameSwapFee,
  swapFeeFor,
  swapFeeIssues,
  type SwapFee,
  type SwapFeeIssue,
  type SwapFeeMessage,
  type SwapFeeRecipients,
} from "../../../lib/swap-fee";
import {
  buildPoolSwapMsg,
  planPoolSwap,
  poolRouteText,
  quotePoolSwap,
  readDeliveryTransfer,
  readPoolSwapMsg,
  sameRoutes,
  type DeliveryTransferFacts,
  type PoolDelivery,
  type PoolQuote,
  type PoolQuoteBlockedCode,
  type PoolRoute,
  type PoolSwapFacts,
  type PoolSwapPlan,
} from "../../../lib/pool-swap";
import { rememberSwapIntent, takeSwapIntent } from "../../../lib/swap-intent";
import { isPoolPath, swapPathFor, type SwapPath } from "../../../lib/swap-path";
import { amountFieldText, canTypeAmount, formatTokenAmount } from "../../../lib/token-amount";
import { identityOf, shortDenom, type TokenIdentity } from "../../../lib/token-identity";
import type { TxPreview } from "../../../lib/tx-kernel";
import { TESTNET_REASON, noRouteReason, osmosisDenomFor } from "../../../lib/xcs-routes";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { SwapPair, shownIdentity } from "../components/SwapPair";
import { SwapSettingsDialog } from "../components/SwapSettingsDialog";
import {
  TokenAvatar,
  TokenTicker,
  provenanceLabel,
  tokenLocationText,
  tokenSubtitle,
} from "../components/TokenLabel";
import { usePrices } from "../hooks/usePrices";
import { useTxDetail } from "../hooks/useChainQuery";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import {
  DisabledReason,
  HopChannelList,
  ResumeTrackingBanner,
  SwapContractOverride,
  swapRouteLabel,
  tickerAmount,
  toBaseUnits,
  useKernelSigning,
  useResolveAddresses,
  useRouteTracking,
  useClock,
  useOsmosisAssets,
  usePendingTransfers,
  useSwapVenue,
  useXcsRoutes,
} from "./interchain-ui";
import { IconCheck, IconChevronDown, IconCopy, IconSettings } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";
import { notifyBroadcastAccepted, useToast } from "../state/Toasts";

type Phase = "form" | "confirm" | "sent";

/** A price for a reviewed plan, or why there is none, and when the venue answered. */
export interface ReviewPrice {
  readonly quote: OsmosisSwapQuote | null;
  readonly error: string | null;
  readonly code: SwapQuoteBlockedCode | null;
  /** `Date.now()` when the answer came back. */
  readonly at: number;
}

/**
 * The swap as the user reviewed it, captured when the confirm screen opens.
 *
 * Live state keeps moving underneath: balances refresh, the route table
 * loads, an unpicked To is picked again, the planner runs again. The confirm
 * screen draws only from this, prices only this plan, and signs only the
 * message built from this plan. Once the swap the form would sign is no
 * longer this one ({@link reviewDrift}), signing waits for a new review.
 */
export interface ReviewedSwap {
  /** Tells one review from the next, so a late price never lands on another. */
  readonly id: number;
  readonly from: AssetOption;
  readonly to: AssetOption;
  /** Base units the user spends in all: the amount typed (or Max), the Zunia fee included. */
  readonly amountUnits: bigint;
  /**
   * The Zunia fee on {@link amountUnits} (lib/swap-fee.ts): what the second
   * message pays, and `fee.net`, what the swap message sells, the amount the
   * plan and its price were made for, and the amount tracking follows. With no
   * fee, `fee.fee` is 0 and `fee.net` is the whole amount.
   */
  readonly fee: SwapFee;
  /** The plan the message was built from, and the one tracking follows. */
  readonly plan: RoutePlanView;
  /** The planner request {@link plan} answered ({@link swapPlanKey}). */
  readonly planKey: string;
  /** What prices {@link plan} again: its venue denoms, the amount and the slippage. */
  readonly requote: VenueQuoteInput;
  readonly price: ReviewPrice;
  /** Where the planner was told to deliver: this wallet's address on the To's chain. */
  readonly recipient: string;
  /** The `local_recovery_addr` the planner was told to set: this wallet's address on Osmosis. */
  readonly recoveryAddress: string;
  /** The crosschain-swaps contract the venue check verified on chain. */
  readonly contract: string;
  /** That contract's on-chain label (`CrossChainSwaps v1.2`), when the check read one. */
  readonly contractLabel: string | null;
  /** This wallet's own address on the other chains the route crosses, by chain id. */
  readonly ownAddresses: Readonly<Record<string, string>>;
}

/**
 * A swap in Osmosis's own pools as the user reviewed it (lib/pool-swap.ts), the
 * `pool` and `pool-deliver` paths. Like {@link ReviewedSwap}, frozen when the
 * confirm screen opens: the screen draws from it and signs only the messages
 * built from it. Unlike the contract's TWAP tolerance, the floor here is a
 * number in the message, so a new price is a new message: refreshing the price
 * on the confirm screen builds the messages again from it.
 */
export interface ReviewedPoolSwap {
  /** Tells one review from the next, so a late price never lands on another. */
  readonly id: number;
  readonly path: "pool" | "pool-deliver";
  readonly from: AssetOption;
  readonly to: AssetOption;
  /** Base units the user spends in all: the amount typed (or Max), the Zunia fee included. */
  readonly amountUnits: bigint;
  /** The Zunia fee on {@link amountUnits}; the swap sells `fee.net`. */
  readonly fee: SwapFee;
  /** What the swap buys, as Osmosis names it. */
  readonly venueOutputDenom: string;
  readonly slippagePercent: number;
  /** The price the messages were built from, and when the router gave it. */
  readonly price: { readonly quote: OsmosisSwapQuote; readonly at: number };
  /** The router's order for `fee.net`: the pools the message swaps through. */
  readonly routes: readonly PoolRoute[];
  /** The price's output less the slippage: `token_out_min_amount`, and what a delivery sends on. */
  readonly minOut: string;
  /** The checked transfer that sends {@link minOut} on (`pool-deliver`); `null` for `pool`. */
  readonly delivery: RoutePlanView | null;
  /** This wallet's address on Osmosis: it signs, and poolmanager pays it. */
  readonly signer: string;
  /** Where the output ends up: {@link signer} for `pool`, this wallet's address on the To's chain otherwise. */
  readonly recipient: string;
  /** The planner request the review answered ({@link swapPlanKey}). */
  readonly planKey: string;
}

/** What the confirm phase is about to sign: a reviewed swap, or the recovery of one. */
type PendingTx =
  | {
      readonly kind: "swap";
      readonly chainId: string;
      readonly signerAddress: string;
      /** Built once from `review.plan`, when the review opened. */
      readonly msgs: readonly BuiltMsg[];
      readonly title: string;
      readonly review: ReviewedSwap;
    }
  | {
      readonly kind: "pool";
      readonly chainId: string;
      readonly signerAddress: string;
      /** Built from `review`'s routes and floor, again whenever its price is refreshed. */
      readonly msgs: readonly BuiltMsg[];
      readonly title: string;
      readonly review: ReviewedPoolSwap;
    }
  | {
      readonly kind: "recover";
      readonly chainId: string;
      readonly signerAddress: string;
      readonly msgs: readonly BuiltMsg[];
      readonly title: string;
    };

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

/**
 * The To on screen. A row the user picked stays picked, even once the From
 * or the route table turns it off: its reason is then shown and nothing is
 * planned for it, rather than the destination changing under them. With no
 * pick, the first row that can be used, picked again whenever that changes
 * (the route table loading, another From).
 */
export function pickTo(
  destinations: readonly AssetOption[],
  toKey: string | null,
): AssetOption | undefined {
  return (
    (toKey ? destinations.find((asset) => asset.key === toKey) : undefined) ??
    destinations.find((asset) => asset.disabledReason === null)
  );
}

/**
 * The base units the From field's text stands for, converted with the From
 * row's own exponent (`AssetOption.decimals`, which carries the SQS veto and
 * the balance reader's figure for an unnamed token). When nobody knows the
 * decimals that exponent is 0 and the field takes only Max, whose text is the
 * raw balance (lib/token-amount.ts `amountFieldText`). `null` when the text
 * is empty or does not convert.
 */
export function amountUnitsOf(from: AssetOption | undefined, text: string): bigint | null {
  return from && text ? toBaseUnits(text, from.decimals) : null;
}

/**
 * What a typed amount is read against: the token, and the exponent it was
 * typed with. Text typed for one scale is never read with another.
 */
export function scaleOf(option: AssetOption): string {
  return `${option.key}|${option.decimalsKnown ? option.decimals : "?"}`;
}

/**
 * The side whose venue denom the route got wrong, when the plan can tell:
 * the input when the route enters Osmosis as another denom than the From's,
 * else the output. `null` when the plan does not say what it sells there.
 */
function mismatchedSide(
  from: AssetOption,
  to: AssetOption,
  plan: RoutePlanView | null,
): AssetOption | null {
  const expected = expectedVenueDenoms(from, to);
  if (!expected.expectedVenueInputDenom) return to;
  const routeIn = plan?.candidate.venueInputDenom ?? null;
  if (routeIn) return routeIn === expected.expectedVenueInputDenom ? to : from;
  return expected.expectedVenueOutputDenom ? null : from;
}

/**
 * Why a swap has no price, with the tickers on screen when the planner says
 * which known reason it is (lib/route-plan.ts `SwapQuoteBlockedCode`), in the
 * picker's words for the same pair. Any other reason (a channel that failed
 * its check, a token the venue cannot name) is the planner's own sentence.
 */
export function quoteBlockText(
  code: SwapQuoteBlockedCode | null,
  reason: string | null,
  from: AssetOption | undefined,
  to: AssetOption | undefined,
  plan: RoutePlanView | null,
): string | null {
  if (!code || !from || !to) return reason;
  const sold = from.identity.ticker;
  const bought = to.identity.ticker;
  switch (code) {
    case "no-contract-route":
      return `${noRouteReason(sold, bought)} The swap stays unsigned.`;
    case "route-unreadable":
      return `Zunia could not confirm that the Osmosis swap contract takes ${sold} to ${bought}, so the swap stays unsigned.`;
    case "route-unpriced":
      return `The pools on the Osmosis swap contract's route from ${sold} to ${bought} could not be priced, so the swap stays unsigned.`;
    case "same-token":
      return `Both sides are ${bought} on Osmosis, so there is nothing to swap. Use Send to move it.`;
    case "venue-denom-mismatch": {
      const side = mismatchedSide(from, to, plan);
      return side
        ? `Zunia would trade a different ${side.identity.family} variant than the ${side.identity.ticker} you picked, so the swap stays unsigned.`
        : `Zunia would trade a different variant than the ${sold} and ${bought} you picked, so the swap stays unsigned.`;
    }
  }
}

/**
 * The quote as the screen shows it: amounts in the shared policy
 * (lib/token-amount.ts), exact up to six decimals and never rounded up, with
 * each side's identity ticker. A token whose decimals are unknown reads in
 * base units and gets no rate. Every amount is the number alone: the panel
 * prints `outputSymbol` after `minReceived` itself, so a ticker here would
 * read twice (`35.56 USDC.axl USDC.axl`).
 */
export function swapQuoteView(
  quote: OsmosisSwapQuote,
  from: AssetOption,
  to: AssetOption,
): SwapQuoteView {
  return {
    inputAmount: formatTokenAmount(quote.inputAmount, from.identity, "confirm"),
    inputSymbol: from.identity.ticker,
    outputAmount: formatTokenAmount(quote.outputAmount, to.identity, "confirm"),
    outputSymbol: to.identity.ticker,
    rate:
      from.decimalsKnown && to.decimalsKnown
        ? rateLine(
            quote.inputAmount,
            from.decimals,
            from.identity.ticker,
            quote.outputAmount,
            to.decimals,
            to.identity.ticker,
          )
        : null,
    minReceived: quote.minReceived
      ? formatTokenAmount(quote.minReceived, to.identity, "confirm")
      : null,
    // `null`, not 0: the router reports no spot price for some pairs and
    // the panel renders "not reported" rather than a confident zero.
    priceImpact: quote.spotPrice === null ? null : quote.priceImpact,
    poolFee: quote.effectiveFeeFraction === null ? null : quote.poolFee,
    route: quote.route.map((hop) => ({
      poolId: hop.poolId,
      tokenOutSymbol: hop.tokenOutDenom
        ? identityOf(VENUE_CHAIN_ID, hop.tokenOutDenom).ticker
        : undefined,
    })),
  };
}

/**
 * What the screen asks the planner for. Every field that ends up signed is
 * copied as is: the chain the From is held on and its exact bank denom, the
 * chain the To is delivered on and its exact denom, the base units, the
 * addresses, the slippage, the venue and the channels the user pinned. The
 * identities only add `expectedVenue*Denom`, a check that refuses a route
 * trading another variant on Osmosis; they never name what is signed.
 */
export function swapPlanRequest(args: {
  readonly from: AssetOption;
  readonly to: AssetOption;
  readonly amountUnits: bigint;
  readonly sender: string;
  readonly recipient: string;
  readonly recoveryAddress: string;
  readonly slippagePercent: number;
  readonly venue: SwapPlanInput["venue"];
  readonly manualChannels: readonly ManualChannel[];
  readonly resolveAddresses: SwapPlanInput["resolveAddresses"];
  readonly signal?: AbortSignal;
}): SwapPlanInput {
  return {
    sourceChainId: args.from.chainId,
    destChainId: args.to.chainId,
    inputDenom: args.from.denom,
    destDenom: args.to.denom,
    amountBaseUnits: args.amountUnits.toString(),
    sender: args.sender,
    recipient: args.recipient,
    recoveryAddress: args.recoveryAddress,
    slippagePercent: args.slippagePercent,
    venue: args.venue,
    manualChannels: args.manualChannels,
    resolveAddresses: args.resolveAddresses,
    ...(args.signal ? { signal: args.signal } : {}),
    ...expectedVenueDenoms(args.from, args.to),
  };
}

/**
 * The planner request as one string: every input a plan depends on, the
 * identities' venue check included. A plan belongs to exactly one key, so an
 * answer for inputs since edited is never shown as current, and a review
 * whose key the form no longer produces is no longer what the form would
 * sign ({@link reviewDrift}). The Zunia fee is part of it: the plan sells
 * what is left after the fee, and the transaction pays the fee beside it.
 */
export function swapPlanKey(args: {
  readonly from: Pick<AssetOption, "chainId" | "denom" | "identity">;
  readonly to: Pick<AssetOption, "chainId" | "denom" | "identity">;
  /** Base units the swap sells: what is left after the Zunia fee. */
  readonly amountUnits: bigint;
  /** The Zunia fee paid beside the swap; none when absent or 0. */
  readonly fee?: Pick<SwapFee, "fee" | "recipient"> | null;
  readonly slippage: number;
  readonly manual: readonly ManualChannel[];
  /** The swap contract the venue check names. */
  readonly contract: string | null | undefined;
  /** Bumped by the retry controls: the same inputs, asked again. */
  readonly retryToken: number;
}): string {
  const expected = expectedVenueDenoms(args.from, args.to);
  return [
    args.from.chainId,
    args.from.denom,
    args.to.chainId,
    args.to.denom,
    args.amountUnits.toString(),
    args.fee && args.fee.fee > 0n ? `${args.fee.fee}>${args.fee.recipient ?? ""}` : "",
    args.slippage,
    args.manual.map((m) => `${m.fromChainId}>${m.toChainId}:${m.channelId}`).join("|"),
    args.contract,
    expected.expectedVenueInputDenom ?? "",
    expected.expectedVenueOutputDenom ?? "",
    args.retryToken,
  ].join("~");
}

/* -------------------------------------------------------------------------- *
 * The Zunia fee
 * -------------------------------------------------------------------------- */

/**
 * What a reviewed swap signs, in order: the swap message for the amount left
 * after the Zunia fee, then the bank send that pays the fee, when one is due.
 * With no fee (no treasury for the signing chain, or an amount too small to
 * carry one) it is the one message the swap signed before the fee existed,
 * byte for byte. The swap stays first: the confirm screen reads it there.
 */
export function swapTxMsgs(args: {
  readonly view: RoutePlanView;
  /** The signer on the From's chain: the swap and the fee both leave its account. */
  readonly sender: string;
  /** The From's exact bank denom: the fee is paid in the token sold. */
  readonly denom: string;
  readonly fee: SwapFee;
}): BuiltMsg[] {
  const swap = buildTransferMsgFromPlan({
    view: args.view,
    sender: args.sender,
    amountBaseUnits: args.fee.net.toString(),
  });
  if (args.fee.fee <= 0n || args.fee.recipient === null) return [swap];
  return [
    swap,
    buildSwapFeeMsg({
      sender: args.sender,
      recipient: args.fee.recipient,
      denom: args.denom,
      amount: args.fee.fee,
    }),
  ];
}

/**
 * The form's fee line, under the quote: `Zunia fee` and `0.5% · 0.05 OSMO`,
 * read together as `Zunia fee 0.5% · 0.05 OSMO`. `null` when no fee applies,
 * and then no line is drawn.
 */
export function swapFeeLine(
  fee: SwapFee | null,
  from: Pick<AssetOption, "identity">,
): { readonly label: string; readonly value: string } | null {
  if (!fee || fee.fee <= 0n) return null;
  return {
    label: "Zunia fee",
    value: `${feeRateText(fee.bps)} · ${tickerAmount(fee.fee, from.identity, "confirm")}`,
  };
}

/**
 * An amount with every digit its token has (`0.000123456789 INJ`, never cut to
 * six decimals), or in base units when its decimals are unknown.
 */
function exactTickerAmount(amount: string | bigint, identity: TokenIdentity): string {
  return identity.decimalsKnown
    ? `${amountFieldText(amount, identity)} ${identity.ticker}`
    : tickerAmount(amount, identity, "confirm");
}

/** What a fee coin is named: the From's token when it is the denom sold, else whatever its chain calls it. */
function feeIdentity(denom: string, from: AssetOption): TokenIdentity {
  return denom === from.denom ? from.identity : identityOf(from.chainId, denom);
}

/**
 * What becomes of the fee if the swap fails, by how the swap message reaches
 * the contract. A contract call and the fee are one transaction on Osmosis, so
 * a failed swap undoes both. A transfer pays the fee on its own chain when it
 * is sent: a swap that then fails on Osmosis sends the amount swapped back,
 * and the fee stays paid.
 */
export function swapFeeOutcome(via: SwapMessageFacts["via"], bps: number): string {
  if (via === "contract-call") {
    return "The swap and the fee are one transaction: if the swap fails, no fee is taken.";
  }
  const rate = bps > 0 ? ` ${feeRateText(bps)}` : "";
  return `If the swap fails on Osmosis, the amount swapped comes back to you, but the${rate} Zunia fee does not.`;
}

/* -------------------------------------------------------------------------- *
 * What the signed message says
 * -------------------------------------------------------------------------- */

const EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";
const TRANSFER_TYPE_URL = "/ibc.applications.transfer.v1.MsgTransfer";

/** Said, and signing refused, when the message cannot be read whole. */
export const UNREADABLE_SWAP =
  "Zunia could not read what this swap message does, so it will not ask you to sign it.";

/** Said, and signing refused, when the transaction carries more than the swap and its fee. */
export const EXTRA_MESSAGES =
  "This transaction carries more than the swap and the Zunia fee, so Zunia will not ask you to sign it.";

/** A coin exactly as a message carries it. */
export interface MessageCoin {
  readonly denom: string;
  /** Base units, digits only. */
  readonly amount: string;
}

/**
 * The swap a message asks for, read from the bytes that are signed. Every
 * field is copied out of the message; nothing is looked up, guessed or taken
 * from the plan beside it.
 */
export interface SwapMessageFacts {
  /**
   * `contract-call`: one `MsgExecuteContract` on Osmosis, paid with funds
   * already there. `transfer`: an ICS20 transfer whose memo calls the
   * contract when the packet arrives.
   */
  readonly via: "contract-call" | "transfer";
  /** What leaves the wallet: the call's one `funds` coin, or the transfer's `token`. */
  readonly sold: MessageCoin;
  /** The crosschain-swaps contract the swap runs in. */
  readonly contract: string;
  /** The transfer's ICS20 receiver; `null` for a contract call. */
  readonly transferReceiver: string | null;
  /** Packet-forward hops before the swap, in order; a transfer's only. */
  readonly forwardsIn: readonly ForwardHopInfo[];
  /** The `osmosis_swap` fields: what it buys, whom it pays, its tolerance and its failure action. */
  readonly swap: XcsSwapInfo;
  /** Where `next_memo` forwards the output after the swap, when it does. */
  readonly forwardsOut: ForwardMemoInfo | null;
  /** What the engine's memo classifier flagged. */
  readonly warnings: readonly string[];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageCoin(value: unknown): MessageCoin | null {
  if (!isJsonObject(value)) return null;
  const { denom, amount } = value;
  return typeof denom === "string" && denom !== "" && typeof amount === "string" && /^\d+$/.test(amount)
    ? { denom, amount }
    : null;
}

/**
 * The UTF-8 text of standard padded base64, only when encoding that text
 * again gives back the same string: the bytes read here are then the bytes
 * the kernel signs, with no second spelling a stricter decoder would read
 * differently.
 */
function base64Utf8(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    const text = decodeBase64Utf8(raw);
    return encodeBase64Utf8(text) === raw ? text : null;
  } catch {
    return null;
  }
}

/**
 * What `text` parses to, only when serializing that gives back `text`
 * exactly (no duplicate keys, no stray whitespace), so every JSON reader on
 * the way agrees with this one. `undefined` otherwise.
 */
function canonicalJson(text: string | null): unknown {
  if (text === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(parsed) === text ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The `osmosis_swap` fields the confirm screen reads and shows, and the ones
 * a TWAP tolerance has. Any other (a pinned pool `route`, a field a later
 * contract adds) could change what the contract does without being shown, so
 * a message carrying one is not read at all.
 */
const SWAP_FIELDS: ReadonlySet<string> = new Set([
  "output_denom",
  "slippage",
  "receiver",
  "on_failed_delivery",
  "next_memo",
]);
const TWAP_FIELDS: ReadonlySet<string> = new Set(["slippage_percentage", "window_seconds"]);

function onlyFields(value: unknown, fields: ReadonlySet<string>): boolean {
  return isJsonObject(value) && Object.keys(value).every((key) => fields.has(key));
}

/**
 * The swap part of a memo, through the engine's own classifier
 * (`validateMemo`, the one the planner checks its plans with): the
 * crosschain swap, the forwards before it, and the forward `next_memo`
 * asks for after it. `null` unless every part reads whole.
 */
function readXcs(
  memo: string,
  receiver?: string,
): Pick<SwapMessageFacts, "contract" | "forwardsIn" | "swap" | "forwardsOut" | "warnings"> | null {
  const inspection = validateMemo(memo, receiver === undefined ? {} : { receiver });
  const { xcs: swap, wasm } = inspection;
  if (inspection.kind !== "xcs" || !swap || !wasm) return null;
  const body = wasm.msg.osmosis_swap;
  if (!isJsonObject(body) || !onlyFields(body, SWAP_FIELDS)) return null;
  const twap = isJsonObject(body.slippage) ? body.slippage.twap : undefined;
  if (twap !== undefined && !onlyFields(twap, TWAP_FIELDS)) return null;
  const next = body.next_memo;
  const warnings = [...inspection.warnings];
  let forwardsOut: ForwardMemoInfo | null = null;
  if (next !== undefined && next !== null) {
    if (!isJsonObject(next)) return null;
    const after = validateMemo(JSON.stringify(next));
    if (after.kind !== "forward" || !after.forward || after.forward.hasNextMemo) return null;
    forwardsOut = after.forward;
    warnings.push(...after.warnings);
  }
  return {
    contract: swap.contract,
    forwardsIn: inspection.forward?.hops ?? [],
    swap,
    forwardsOut,
    warnings,
  };
}

/**
 * Read what a swap message will do, from the message itself: a contract
 * call's base64 `msg` (the venue-origin path), or a transfer's packet memo.
 * `null` for any other message, and for one any part of which cannot be read
 * whole: what cannot be read is never described, and never signed.
 */
export function readSwapMessage(msg: BuiltMsg | undefined): SwapMessageFacts | null {
  if (!msg) return null;
  const value: Record<string, unknown> = msg.value;
  if (msg.typeUrl === EXECUTE_CONTRACT_TYPE_URL) {
    const { contract, funds } = value;
    if (typeof contract !== "string" || contract === "") return null;
    // The contract takes exactly one coin: that coin is what is sold.
    if (!Array.isArray(funds) || funds.length !== 1) return null;
    const sold = messageCoin(funds[0]);
    const body = canonicalJson(base64Utf8(value.msg));
    if (!sold || !isJsonObject(body)) return null;
    // The plan keeps the call as the `{wasm:{contract,msg}}` an inbound packet
    // would carry, so one classifier reads both paths.
    const read = readXcs(JSON.stringify({ wasm: { contract, msg: body } }));
    return read ? { via: "contract-call", sold, transferReceiver: null, ...read } : null;
  }
  if (msg.typeUrl === TRANSFER_TYPE_URL) {
    const sold = messageCoin(value.token);
    const { memo, receiver } = value;
    if (!sold || typeof memo !== "string" || typeof receiver !== "string") return null;
    if (canonicalJson(memo) === undefined) return null;
    const read = readXcs(memo, receiver);
    return read ? { via: "transfer", sold, transferReceiver: receiver, ...read } : null;
  }
  return null;
}

/**
 * The chain on which `address` is this wallet's own, as far as the review
 * knows: the delivery address, the recovery address, and the addresses the
 * route's other chains resolved to. `null` when it is none of them.
 */
export function ownerOf(
  address: string,
  review: Pick<ReviewedSwap, "to" | "recipient" | "recoveryAddress" | "ownAddresses">,
): string | null {
  if (address === review.recipient) return review.to.chainId;
  if (address === review.recoveryAddress) return VENUE_CHAIN_ID;
  return Object.entries(review.ownAddresses).find(([, own]) => own === address)?.[0] ?? null;
}

/**
 * The token the message's `output_denom` names: the reviewed To when it is
 * that token's Osmosis denom, else whatever Osmosis calls that denom.
 */
export function boughtIdentity(outputDenom: string, to: AssetOption): TokenIdentity {
  return osmosisDenomFor(to) === outputDenom ? shownIdentity(to) : identityOf(VENUE_CHAIN_ID, outputDenom);
}

/**
 * The least the message lets the swap pay out, as the confirm screen words
 * it. A `min_output_amount` is a number in the message, and reads as one
 * (`exact`). A TWAP tolerance is a rule, not a number: `rule` says it, and
 * the quote only estimates where it lands today, said as an estimate.
 */
export function minimumTerms(
  swap: Pick<XcsSwapInfo, "slippage" | "outputDenom">,
  bought: TokenIdentity,
  quote: OsmosisSwapQuote | null,
): { readonly rule: string; readonly estimate: string | null; readonly exact: string | null } {
  const { slippage } = swap;
  if (slippage.kind === "min_output_amount") {
    const exact = tickerAmount(slippage.minOutputAmount, bought, "confirm");
    return { rule: exact, estimate: null, exact };
  }
  const rule = `The ${slippage.windowSeconds}-second average price, less ${slippage.slippagePercentage}%`;
  if (!quote || quote.outputDenom !== swap.outputDenom) return { rule, estimate: null, exact: null };
  try {
    const floor = applySlippage(quote.outputAmount, Number(slippage.slippagePercentage));
    return { rule, estimate: `About ${tickerAmount(floor, bought, "confirm")} at the quoted price`, exact: null };
  } catch {
    return { rule, estimate: null, exact: null };
  }
}

/**
 * One way the transaction's fee message is not the Zunia fee the review
 * shows (lib/swap-fee.ts `swapFeeIssues`), in the words the confirm screen
 * shows.
 */
export function swapFeeProblem(issue: SwapFeeIssue, review: Pick<ReviewedSwap, "from">): string {
  const { from } = review;
  const amount = (units: string | bigint, denom: string) => exactTickerAmount(units, feeIdentity(denom, from));
  switch (issue.kind) {
    case "unreadable":
      return "Zunia could not read the transaction's second message as its fee, so it will not ask you to sign it.";
    case "not-due":
      return `Zunia charges no fee on this swap, yet the transaction pays ${amount(issue.paid.amount, issue.paid.denom)} to ${truncateAddress(issue.paid.to, 10, 8)}.`;
    case "missing":
      return `The transaction leaves out the ${amount(issue.due.fee, from.denom)} Zunia fee this review shows.`;
    case "sender":
      return `The Zunia fee would be paid from ${truncateAddress(issue.paid.from, 10, 8)}, not from the account signing this swap.`;
    case "recipient":
      return `The Zunia fee would go to ${truncateAddress(issue.paid.to, 10, 8)}, which is not Zunia's fee address on ${from.chainName}.`;
    case "denom":
      return `The Zunia fee is paid in ${shortDenom(issue.paid.denom)}, not in the ${from.identity.ticker} you sell.`;
    case "amount":
      return `The Zunia fee is ${amount(issue.paid.amount, issue.paid.denom)}, not the ${amount(issue.due.fee, from.denom)} you reviewed.`;
  }
}

/**
 * Everything the transaction does that the review did not say, in the words
 * the confirm screen shows; any of it refuses the signature. Empty when it
 * is exactly the swap message (`facts`, read from its first message) and, when
 * a Zunia fee is due, the one bank send that pays it:
 *
 * - the swap spends the reviewed coin, and the amount left after the fee;
 *   calls the swap contract the venue check verified (a transfer landing on
 *   it); buys the reviewed token; pays this wallet's own address; and sets this
 *   wallet's recovery address;
 * - the fee is the one the review shows and the one Zunia charges on the
 *   signing chain, paid from the signer to that chain's treasury, in the token
 *   sold, for exactly that amount; with no fee due, there is no second message;
 * - nothing else: a third message refuses the signature.
 */
export function swapTermsProblems(
  facts: SwapMessageFacts | null,
  review: ReviewedSwap,
  signing: {
    readonly chainId: string;
    /** The account that signs: the fee must leave it. */
    readonly signerAddress: string;
    /** Every message the transaction signs, the swap first. */
    readonly msgs: readonly BuiltMsg[];
    /** The fee treasuries; the compiled-in map unless a test passes its own. */
    readonly recipients?: SwapFeeRecipients;
  },
): string[] {
  if (!facts) return [UNREADABLE_SWAP];
  if (signing.msgs.length > 2) return [EXTRA_MESSAGES];
  const { from, to } = review;
  const problems: string[] = [];
  if (signing.chainId !== from.chainId || facts.sold.denom !== from.denom) {
    problems.push(
      `The message spends ${shortDenom(facts.sold.denom)}, not the ${from.identity.ticker} on ${from.chainName} you reviewed.`,
    );
  } else if (facts.sold.amount !== review.fee.net.toString()) {
    problems.push(
      `The message spends ${tickerAmount(facts.sold.amount, from.identity, "confirm")}, not the ${tickerAmount(review.fee.net, from.identity, "confirm")} you reviewed.`,
    );
  }
  if (facts.contract !== review.contract) {
    problems.push(
      `The message calls ${truncateAddress(facts.contract, 10, 8)}, not the swap contract Zunia verified on Osmosis.`,
    );
  }
  if (facts.via === "transfer") {
    // ibc-hooks runs the call only when the packet reaching Osmosis is
    // addressed to the contract; anything else just delivers the tokens there.
    const lands = facts.forwardsIn[facts.forwardsIn.length - 1]?.receiver ?? facts.transferReceiver ?? "";
    if (!isWasmHookReceiverValid(lands, facts.contract)) {
      problems.push(
        "The transfer is not addressed to the swap contract, so the swap would not run and the tokens would land somewhere else.",
      );
    }
  }
  const expected = osmosisDenomFor(to);
  if (expected && expected !== facts.swap.outputDenom) {
    problems.push(
      `The contract would buy ${identityOf(VENUE_CHAIN_ID, facts.swap.outputDenom).ticker}, not the ${to.identity.ticker} you picked.`,
    );
  }
  const payee = facts.forwardsOut?.finalReceiver ?? facts.swap.receiver;
  if (payee !== review.recipient) {
    problems.push(
      `The swap would pay ${truncateAddress(payee, 10, 8)}, which is not your address on ${to.chainName}.`,
    );
  } else if (facts.forwardsOut && ownerOf(facts.swap.receiver, review) === null) {
    problems.push(
      `On the way, the swap would pay ${truncateAddress(facts.swap.receiver, 10, 8)}, which is not one of this wallet's addresses.`,
    );
  }
  const failed = facts.swap.onFailedDelivery;
  if (failed.kind !== "local_recovery_addr") {
    problems.push(
      "The swap sets no recovery address, so output stranded by a failed delivery could never be claimed back.",
    );
  } else if (failed.address !== review.recoveryAddress) {
    problems.push(
      `The recovery address ${truncateAddress(failed.address, 10, 8)} is not your address on Osmosis.`,
    );
  }
  // The fee the review shows must be the fee Zunia charges here, worked out
  // again from the configuration; the second message must pay exactly it.
  const due = swapFeeFor(signing.chainId, review.amountUnits, signing.recipients);
  if (!sameSwapFee(review.fee, due)) {
    problems.push(
      `The Zunia fee in this review is not the one Zunia charges on ${from.chainName}, so Zunia will not ask you to sign it.`,
    );
  }
  const issues = swapFeeIssues(signing.msgs[1], {
    chainId: signing.chainId,
    signer: signing.signerAddress,
    denom: from.denom,
    amountUnits: review.amountUnits,
    ...(signing.recipients ? { recipients: signing.recipients } : {}),
  });
  problems.push(...issues.map((issue) => swapFeeProblem(issue, review)));
  return problems;
}

/* -------------------------------------------------------------------------- *
 * Whether the review still stands
 * -------------------------------------------------------------------------- */

/** What the form would sign right now, to check a review against. */
export interface LiveSwap {
  readonly from: AssetOption | undefined;
  readonly to: AssetOption | undefined;
  /** What the form spends in all, the Zunia fee included. */
  readonly amountUnits: bigint | null;
  /** The Zunia fee the form works out on {@link amountUnits}; `null` when it has no amount. */
  readonly fee: SwapFee | null;
  /** {@link swapPlanKey} of the form's inputs; `""` when it cannot plan. */
  readonly planKey: string;
  readonly plan: RoutePlanView | null;
  readonly planning: boolean;
  /** The form's own reason it cannot plan or sign, when it has one. */
  readonly blockedReason: string | null;
}

/** What a plan would have signed, without the per-build packet timeout. */
function planFingerprint(view: RoutePlanView): string {
  const { plan } = view;
  return JSON.stringify([
    plan.sourceChainId,
    plan.destChainId,
    plan.inputDenom,
    plan.outputDenom,
    plan.memo,
    view.receiver,
    plan.hops.map((hop) => [hop.chainId, hop.channelId, hop.port, hop.counterpartyChainId, hop.kind]),
  ]);
}

/**
 * Why a review no longer stands, or `null` while it does: in what moved, so
 * the user knows what to check. The form keeps moving under the confirm
 * screen (balances refresh, the route table loads, an unpicked To is picked
 * again); once the swap it would sign is not the one reviewed, the screen
 * keeps showing the review and signing waits for a new one.
 */
export function reviewDrift(
  review: Pick<ReviewedSwap, "from" | "to" | "amountUnits" | "fee" | "planKey" | "plan">,
  live: LiveSwap,
): string | null {
  if (live.from?.key !== review.from.key) {
    return `The swap form no longer sells ${review.from.identity.ticker} on ${review.from.chainName}.`;
  }
  if (live.to?.key !== review.to.key) {
    return `The swap form no longer buys ${review.to.identity.ticker} on ${review.to.chainName}.`;
  }
  if (live.amountUnits !== review.amountUnits) {
    return `The amount on the swap form is no longer ${tickerAmount(review.amountUnits, review.from.identity, "confirm")}.`;
  }
  if (!live.fee || !sameSwapFee(live.fee, review.fee)) {
    return "The Zunia fee on the swap form is no longer the one you reviewed.";
  }
  if (live.planKey !== review.planKey) {
    return (live.planKey === "" ? live.blockedReason : null) ?? "The swap's settings changed after this review.";
  }
  if (live.planning) return "Zunia is checking the route again.";
  if (!live.plan) return live.blockedReason ?? "The route you reviewed is no longer offered.";
  if (live.plan !== review.plan && planFingerprint(live.plan) !== planFingerprint(review.plan)) {
    return "Zunia planned the route again, and it is not the one you reviewed.";
  }
  return live.plan.blockedReason;
}

/** Said when a price is too old to sign against. */
export const PRICE_EXPIRED = `This price is more than ${QUOTE_TTL_MS / 1000} seconds old. Refresh it, check it, then sign.`;

/** Whether a reviewed price is missing or older than a quote lives, at `now`. */
export function priceExpired(price: Pick<ReviewPrice, "quote" | "at">, now: number): boolean {
  return !price.quote || now - price.at >= QUOTE_TTL_MS;
}

/**
 * Why the reviewed swap cannot be signed right now: the button's short label
 * and the sentence behind it, or `null` when it can. Checked again at the
 * moment of signing, not only when the button is drawn.
 */
export function swapSignBlock(args: {
  /** The first of {@link swapTermsProblems}, when there is one. */
  readonly problem: string | null;
  readonly drift: string | null;
  readonly price: ReviewPrice;
  /** Why the price is missing, in the screen's words. */
  readonly priceError: string | null;
  readonly refreshing: boolean;
  readonly now: number;
  readonly feeShort: boolean;
}): { readonly label: string; readonly reason: string } | null {
  if (args.problem) return { label: "Cannot sign", reason: args.problem };
  if (args.drift) {
    return { label: "Out of date", reason: `${args.drift} Go back and review the swap again.` };
  }
  if (args.refreshing) return { label: "Updating the price…", reason: "The price is being updated." };
  if (!args.price.quote) {
    return {
      label: "No price",
      reason: args.priceError ?? "There is no price for this swap. Refresh it, check it, then sign.",
    };
  }
  if (priceExpired(args.price, args.now)) return { label: "Price expired", reason: PRICE_EXPIRED };
  if (args.feeShort) {
    return {
      label: "Need fee room",
      reason: "Not enough is left for the network fee. Lower the amount or the gas speed.",
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- *
 * Osmosis's own pools
 * -------------------------------------------------------------------------- */

/**
 * What a reviewed pool swap signs, in order: the swap of what is left after
 * the Zunia fee, along the router's routes and for at least `minOut`; the
 * bank send that pays the fee, when one is due; and for `pool-deliver` the
 * transfer of exactly `minOut` of the bought token to the To's chain. The
 * transfer comes last because it spends what the swap pays out; the swap
 * pays at least `minOut` or the chain refuses all three.
 */
export function poolSwapTxMsgs(args: {
  /** This wallet's address on Osmosis: the swap, the fee and the transfer all leave it. */
  readonly sender: string;
  /** The From's exact denom on Osmosis. */
  readonly denom: string;
  readonly routes: readonly PoolRoute[];
  readonly minOut: string;
  readonly fee: SwapFee;
  /** The checked transfer leg for `pool-deliver`; `null` for `pool`. */
  readonly delivery: RoutePlanView | null;
}): BuiltMsg[] {
  const msgs: BuiltMsg[] = [
    buildPoolSwapMsg({ sender: args.sender, denom: args.denom, routes: args.routes, minOut: args.minOut }),
  ];
  if (args.fee.fee > 0n && args.fee.recipient !== null) {
    msgs.push(
      buildSwapFeeMsg({
        sender: args.sender,
        recipient: args.fee.recipient,
        denom: args.denom,
        amount: args.fee.fee,
      }),
    );
  }
  if (args.delivery) {
    msgs.push(buildTransferMsgFromPlan({ view: args.delivery, sender: args.sender, amountBaseUnits: args.minOut }));
  }
  return msgs;
}

/**
 * Why a pool swap has no price, with the tickers on screen when the reason
 * is a known one (lib/pool-swap.ts `PoolQuoteBlockedCode`); the module's own
 * sentence otherwise.
 */
export function poolQuoteText(
  code: PoolQuoteBlockedCode | null,
  reason: string | null,
  from: Pick<AssetOption, "identity"> | undefined,
  to: Pick<AssetOption, "identity"> | undefined,
): string | null {
  if (!code || !from || !to) return reason;
  const sold = from.identity.ticker;
  const bought = to.identity.ticker;
  switch (code) {
    case "no-pool-route":
      return `Osmosis has no pool route from ${sold} to ${bought} at this amount, so there is nothing to sign.`;
    case "same-token":
      return `Both sides are ${bought} on Osmosis, so there is nothing to swap. Use Send to move it.`;
    case "routes-invalid":
    case "no-floor":
      return reason;
  }
}

/** What becomes of the fee, and of the transfer, when the swap does not happen. */
export function poolFeeOutcome(path: "pool" | "pool-deliver"): string {
  return path === "pool"
    ? "The swap and the fee are one transaction: if the swap fails, no fee is taken."
    : "The swap, the fee and the transfer are one transaction: if the swap would pay less than the minimum, none of them happens.";
}

/** Said, and signing refused, when the transfer after the swap cannot be read whole. */
export const UNREADABLE_DELIVERY =
  "Zunia could not read the transfer that sends the swap's output on, so it will not ask you to sign it.";

/**
 * Everything the transfer after a `pool-deliver` swap does that the review
 * did not say: it must leave the signer, pay this wallet's address on the To's
 * chain, send exactly the swap's floor of the token bought, over the port and
 * channel the planner checked, with no memo, and expire after now.
 */
export function poolDeliveryProblems(
  transfer: DeliveryTransferFacts | null,
  review: Pick<ReviewedPoolSwap, "delivery" | "recipient" | "venueOutputDenom" | "minOut" | "to">,
  signing: { readonly signerAddress: string; readonly now: number },
): string[] {
  const hop = review.delivery?.plan.hops[0];
  if (!transfer || !hop) return [UNREADABLE_DELIVERY];
  const bought = identityOf(VENUE_CHAIN_ID, review.venueOutputDenom);
  const problems: string[] = [];
  if (transfer.sender !== signing.signerAddress) {
    problems.push(
      `The transfer would leave ${truncateAddress(transfer.sender, 10, 8)}, not the account the swap pays.`,
    );
  }
  if (transfer.receiver !== review.recipient) {
    problems.push(
      `The transfer would pay ${truncateAddress(transfer.receiver, 10, 8)}, which is not your address on ${review.to.chainName}.`,
    );
  }
  if (transfer.token.denom !== review.venueOutputDenom) {
    problems.push(
      `The transfer sends ${shortDenom(transfer.token.denom)}, not the ${review.to.identity.ticker} the swap buys.`,
    );
  } else if (transfer.token.amount !== review.minOut) {
    problems.push(
      `The transfer sends ${tickerAmount(transfer.token.amount, bought, "confirm")}, not the swap's minimum of ${tickerAmount(review.minOut, bought, "confirm")}.`,
    );
  }
  if (transfer.sourcePort !== (hop.port || "transfer") || transfer.sourceChannel !== hop.channelId) {
    problems.push(
      `The transfer leaves over ${transfer.sourceChannel}, not over ${hop.channelId}, the channel Zunia checked.`,
    );
  }
  if (transfer.memo !== "") {
    problems.push("The transfer carries a memo, which a delivery to your own address never needs.");
  }
  if (BigInt(transfer.timeoutTimestamp) <= BigInt(Math.floor(signing.now)) * 1_000_000n) {
    problems.push("The transfer's timeout has already passed, so it would only come back. Refresh the price.");
  }
  return problems;
}

/**
 * Everything a pool swap's transaction does that the review did not say, in
 * the words the confirm screen shows; any of it refuses the signature. Empty
 * when the transaction is exactly:
 *
 * - the swap, read from its first message ({@link readPoolSwapMsg}): signed on
 *   Osmosis by the account it spends from, selling the reviewed token, the
 *   amount left after the fee, through the reviewed routes, for the reviewed
 *   token and the reviewed floor;
 * - when a fee is due, the one bank send that pays it, as for the contract
 *   path ({@link swapTermsProblems});
 * - for `pool-deliver`, the one transfer {@link poolDeliveryProblems} accepts;
 *   for `pool`, no transfer, and a review that delivers to the signer itself,
 *   because poolmanager pays the account that signs;
 * - nothing else.
 */
export function poolSwapTermsProblems(
  facts: PoolSwapFacts | null,
  review: ReviewedPoolSwap,
  signing: {
    readonly chainId: string;
    /** The account that signs: the swap, the fee and the transfer must leave it. */
    readonly signerAddress: string;
    /** Every message the transaction signs, the swap first. */
    readonly msgs: readonly BuiltMsg[];
    /** The fee treasuries; the compiled-in map unless a test passes its own. */
    readonly recipients?: SwapFeeRecipients;
    /** `Date.now()`, for the transfer's timeout. */
    readonly now: number;
  },
): string[] {
  if (!facts) return [UNREADABLE_SWAP];
  // The swap, then the fee when there is a bank send, then the transfer when
  // delivering. Anything left over is a message nobody reviewed.
  const rest = signing.msgs.slice(1);
  const feeMsg = rest[0]?.typeUrl === BANK_SEND_TYPE_URL ? rest[0] : undefined;
  const afterFee = feeMsg ? rest.slice(1) : rest;
  const transferMsg = review.path === "pool-deliver" ? afterFee[0] : undefined;
  if (afterFee.length > (review.path === "pool-deliver" ? 1 : 0)) return [EXTRA_MESSAGES];

  const { from, to } = review;
  const problems: string[] = [];
  if (signing.chainId !== VENUE_CHAIN_ID || from.chainId !== VENUE_CHAIN_ID) {
    problems.push(`A swap in Osmosis's pools signs on Osmosis, and this one would sign on ${signing.chainId}.`);
  }
  if (facts.sender !== signing.signerAddress) {
    problems.push(
      `The swap would spend from ${truncateAddress(facts.sender, 10, 8)}, not from the account signing it.`,
    );
  }
  if (facts.sold.denom !== from.denom) {
    problems.push(
      `The message spends ${shortDenom(facts.sold.denom)}, not the ${from.identity.ticker} on ${from.chainName} you reviewed.`,
    );
  } else if (facts.sold.amount !== review.fee.net.toString()) {
    problems.push(
      `The message spends ${tickerAmount(facts.sold.amount, from.identity, "confirm")}, not the ${tickerAmount(review.fee.net, from.identity, "confirm")} you reviewed.`,
    );
  }
  const expected = osmosisDenomFor(to);
  if (facts.outputDenom !== review.venueOutputDenom || (expected !== null && expected !== facts.outputDenom)) {
    problems.push(
      `The swap would buy ${identityOf(VENUE_CHAIN_ID, facts.outputDenom).ticker}, not the ${to.identity.ticker} you picked.`,
    );
  }
  const bought = boughtIdentity(facts.outputDenom, to);
  if (facts.minOut !== review.minOut) {
    problems.push(
      `The swap's minimum is ${tickerAmount(facts.minOut, bought, "confirm")}, not the ${tickerAmount(review.minOut, bought, "confirm")} you reviewed.`,
    );
  }
  if (!sameRoutes(facts.routes, review.routes)) {
    problems.push("The swap would go through other pools, or other amounts, than the route you reviewed.");
  }
  if (review.path === "pool") {
    if (review.recipient !== signing.signerAddress) {
      problems.push(
        `Osmosis pays a swap to the account that signs it, not to ${truncateAddress(review.recipient, 10, 8)}, where this review delivers.`,
      );
    }
  } else {
    problems.push(...poolDeliveryProblems(readDeliveryTransfer(transferMsg), review, signing));
  }
  // The fee the review shows must be the fee Zunia charges here, worked out
  // again from the configuration; the bank send must pay exactly it.
  const due = swapFeeFor(signing.chainId, review.amountUnits, signing.recipients);
  if (!sameSwapFee(review.fee, due)) {
    problems.push(
      `The Zunia fee in this review is not the one Zunia charges on ${from.chainName}, so Zunia will not ask you to sign it.`,
    );
  }
  const issues = swapFeeIssues(feeMsg, {
    chainId: signing.chainId,
    signer: signing.signerAddress,
    denom: from.denom,
    amountUnits: review.amountUnits,
    ...(signing.recipients ? { recipients: signing.recipients } : {}),
  });
  problems.push(...issues.map((issue) => swapFeeProblem(issue, review)));
  return problems;
}

/** What the form would sign right now, for a pool review to be checked against. */
export interface LivePoolSwap {
  readonly from: AssetOption | undefined;
  readonly to: AssetOption | undefined;
  readonly path: SwapPath | null;
  /** What the form spends in all, the Zunia fee included. */
  readonly amountUnits: bigint | null;
  readonly fee: SwapFee | null;
  /** {@link swapPlanKey} of the form's inputs; `""` when it cannot plan. */
  readonly planKey: string;
  readonly planning: boolean;
  /** The form's checked transfer leg, for `pool-deliver`. */
  readonly delivery: PoolDelivery | null;
  /** The form's own reason it cannot plan or sign, when it has one. */
  readonly blockedReason: string | null;
}

/**
 * Why a pool review no longer stands, or `null` while it does, in what moved.
 * A new price does not move it: the review keeps the price its messages were
 * built from, and the confirm screen refreshes both together.
 */
export function poolReviewDrift(
  review: Pick<ReviewedPoolSwap, "from" | "to" | "path" | "amountUnits" | "fee" | "planKey" | "delivery">,
  live: LivePoolSwap,
): string | null {
  if (live.from?.key !== review.from.key) {
    return `The swap form no longer sells ${review.from.identity.ticker} on ${review.from.chainName}.`;
  }
  if (live.to?.key !== review.to.key) {
    return `The swap form no longer buys ${review.to.identity.ticker} on ${review.to.chainName}.`;
  }
  if (live.amountUnits !== review.amountUnits) {
    return `The amount on the swap form is no longer ${tickerAmount(review.amountUnits, review.from.identity, "confirm")}.`;
  }
  if (!live.fee || !sameSwapFee(live.fee, review.fee)) {
    return "The Zunia fee on the swap form is no longer the one you reviewed.";
  }
  if (live.path !== review.path) return "Zunia now swaps this pair another way. Review it again.";
  if (live.planKey !== review.planKey) {
    return (live.planKey === "" ? live.blockedReason : null) ?? "The swap's settings changed after this review.";
  }
  if (!review.delivery) return null;
  if (live.planning) return "Zunia is checking the transfer again.";
  const current = live.delivery?.view ?? null;
  if (!current) return live.delivery?.error ?? "The transfer you reviewed is no longer offered.";
  if (current !== review.delivery && planFingerprint(current) !== planFingerprint(review.delivery)) {
    return "Zunia planned the transfer again, and it is not the one you reviewed.";
  }
  return current.blockedReason;
}

/** Every chain a plan's hops leave from or arrive on. */
function routeChainIds(view: RoutePlanView): string[] {
  const ids = new Set<string>();
  for (const hop of view.plan.hops) {
    ids.add(hop.chainId);
    if (hop.counterpartyChainId) ids.add(hop.counterpartyChainId);
  }
  return [...ids];
}

/** An exact denom, short on screen and whole in the clipboard. */
function CopyDenom({
  denom,
  where,
  onCopy,
}: {
  denom: string;
  /** The chain that names the denom, said after it. */
  where: string;
  onCopy: (denom: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onCopy(denom)}
      title={denom}
      aria-label={`Copy the exact denom on ${where}: ${denom}`}
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-[6px] font-mono text-[10px] text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
        focusRing,
      )}
    >
      <span className="min-w-0 [overflow-wrap:anywhere]">
        {shortDenom(denom)} on {where}
      </span>
      <IconCopy width={11} height={11} className="shrink-0" aria-hidden />
    </button>
  );
}

/**
 * The confirm screen's "Buys" value: the token the memo's `output_denom`
 * names, where it is delivered, and the exact denom to copy. That denom is
 * the To token's on Osmosis, which the planner checked; should the two ever
 * differ, the row names what the memo really buys.
 */
function BuysValue({
  outputDenom,
  to,
  onCopy,
}: {
  outputDenom: string;
  to: AssetOption;
  onCopy: (denom: string) => void;
}) {
  const same = osmosisDenomFor(to) === outputDenom;
  const identity = same ? shownIdentity(to) : identityOf(VENUE_CHAIN_ID, outputDenom);
  const venueName = findCatalogEntry(VENUE_CHAIN_ID)?.chainName ?? VENUE_CHAIN_ID;
  // `break-normal`: the row's value cell breaks anywhere, which suits a
  // denom and splits words.
  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5 break-normal text-right font-sans">
      <TokenTicker
        identity={identity}
        className="max-w-full text-[12px] font-semibold tracking-[-0.02em] text-fg"
      />
      {/* Wrapped, never cut: where the token arrives is the point of the line. */}
      <span className="text-[10.5px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
        {tokenSubtitle(identity, same ? "delivered" : "on")}
      </span>
      <CopyDenom denom={outputDenom} where={venueName} onCopy={onCopy} />
    </span>
  );
}

/** One value in the swap's terms, right-aligned under its label: the fact, and a line about it. */
function Fact({
  children,
  note,
  tone = "plain",
}: {
  children: ReactNode;
  /** Under the fact: whose an address is, or what a rule comes to. */
  note?: string | null;
  tone?: "plain" | "danger";
}) {
  // `break-normal`: the row's value cell breaks anywhere, which suits an
  // address and splits words.
  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5 break-normal text-right font-sans">
      <span className="max-w-full text-[11.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
        {children}
      </span>
      {note ? (
        <span
          className={cn(
            "text-[10.5px] leading-snug [overflow-wrap:anywhere]",
            tone === "danger" ? "text-[var(--z-danger)]" : "text-fg-muted",
          )}
        >
          {note}
        </span>
      ) : null}
    </span>
  );
}

/** An address, short on screen; whole in its tooltip and to assistive tech. */
function AddressText({ address }: { address: string }) {
  return (
    <>
      <span aria-hidden="true" title={address} className="font-mono">
        {truncateAddress(address, 10, 8)}
      </span>
      <span className="sr-only">{address}</span>
    </>
  );
}

/** Whose an address in the message is, in words: this wallet's on a named chain, or not this wallet's. */
function ownerNote(address: string, review: ReviewedSwap): { text: string; tone: "plain" | "danger" } {
  const chainId = ownerOf(address, review);
  if (chainId === null) return { text: "Not one of your addresses", tone: "danger" };
  const chainName =
    chainId === review.to.chainId ? review.to.chainName : (findCatalogEntry(chainId)?.chainName ?? chainId);
  return { text: `Your address on ${chainName}`, tone: "plain" };
}

/**
 * The terms panel's "Zunia fee" value, read out of the fee message that is
 * signed: the exact amount, its rate of what the user pays, and the address
 * it goes to (short on screen, whole in its tooltip, to assistive tech and in
 * the clipboard) with whose that address is. The rate is said only when the
 * message pays exactly the fee reviewed; anything else reads in danger, and
 * {@link swapTermsProblems} refuses the signature for it.
 */
function FeeValue({
  paid,
  review,
  onCopy,
}: {
  paid: SwapFeeMessage;
  review: Pick<ReviewedSwap, "fee" | "from" | "amountUnits">;
  onCopy: (address: string) => void;
}) {
  const { fee, from } = review;
  const asReviewed = fee.fee > 0n && paid.denom === from.denom && paid.amount === fee.fee.toString();
  const ours = fee.recipient !== null && paid.to === fee.recipient;
  return (
    <span className="flex min-w-0 flex-col items-end gap-0.5 break-normal text-right font-sans">
      <span className="max-w-full text-[11.5px] font-medium leading-snug tabular-nums text-fg [overflow-wrap:anywhere]">
        {exactTickerAmount(paid.amount, feeIdentity(paid.denom, from))}
      </span>
      <span
        className={cn(
          "text-[10.5px] leading-snug [overflow-wrap:anywhere]",
          asReviewed ? "text-fg-muted" : "text-[var(--z-danger)]",
        )}
      >
        {asReviewed
          ? `${feeRateText(fee.bps)} of the ${tickerAmount(review.amountUnits, from.identity, "confirm")} you pay`
          : "Not the fee you reviewed"}
      </span>
      <button
        type="button"
        onClick={() => onCopy(paid.to)}
        title={paid.to}
        aria-label={`Copy the address the fee goes to: ${paid.to}`}
        className={cn(
          "inline-flex max-w-full items-center gap-1 rounded-[6px] font-mono text-[10px] text-fg-muted",
          "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
          focusRing,
        )}
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">To {truncateAddress(paid.to, 10, 8)}</span>
        <IconCopy width={11} height={11} className="shrink-0" aria-hidden />
      </button>
      <span
        className={cn(
          "text-[10.5px] leading-snug [overflow-wrap:anywhere]",
          ours ? "text-fg-muted" : "text-[var(--z-danger)]",
        )}
      >
        {ours ? `Zunia's fee address on ${from.chainName}` : "Not Zunia's fee address"}
      </span>
    </span>
  );
}

/** The panel's opening line: how the message reaches the contract, from the message. */
function termsLead(facts: SwapMessageFacts, venueName: string): string {
  if (facts.via === "contract-call") {
    return `One call to the swap contract on ${venueName}, paid from your balance there. Nothing is transferred before the swap.`;
  }
  const hops = facts.forwardsIn.map((hop) => hop.channelId);
  const route = hops.length > 0 ? `, forwarded over ${hops.join(", then ")},` : "";
  return `An IBC transfer${route} to ${venueName}. When it arrives, its memo calls the swap contract.`;
}

const TERMS_BOX = "min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2";

/** The terms panel's copy action when its caller passes none. */
const COPY_NOTHING = (): void => undefined;

/**
 * What the swap contract will do, read out of the message that is signed
 * ({@link readSwapMessage}), the same for a contract call and a transfer's
 * memo: what is sold and what is bought (the exact denom to copy), whom it
 * pays and whether that is this wallet, the least it may pay out, where the
 * output waits if delivery fails, and the contract. Under them, when the
 * transaction pays one, the Zunia fee as its own message says it
 * ({@link readSwapFeeMsg}), and what becomes of the fee if the swap fails.
 * Nothing here comes from the plan or the form. What the messages do that the
 * review did not say is listed under it ({@link swapTermsProblems}), and
 * refuses the signature.
 */
export function SwapTerms({
  facts,
  review,
  problems,
  onCopy,
  fee = null,
  onCopyAddress = COPY_NOTHING,
  framed = true,
}: {
  facts: SwapMessageFacts | null;
  review: ReviewedSwap;
  problems: readonly string[];
  onCopy: (denom: string) => void;
  /** The transaction's fee message, read out of it; `null` when it signs none. */
  fee?: SwapFeeMessage | null;
  onCopyAddress?: (address: string) => void;
  /** Drawn in its own box; `false` inside a section that already has one. */
  framed?: boolean;
}) {
  const venueName = findCatalogEntry(VENUE_CHAIN_ID)?.chainName ?? VENUE_CHAIN_ID;
  const box = framed ? TERMS_BOX : "min-w-0";
  if (!facts) {
    return (
      <section className={box}>
        <SectionLabel>What the swap will do</SectionLabel>
        <p role="alert" className="mt-1 text-[11px] leading-snug text-[var(--z-danger)]">
          {UNREADABLE_SWAP}
        </p>
      </section>
    );
  }
  const { swap } = facts;
  const sold =
    facts.sold.denom === review.from.denom
      ? shownIdentity(review.from)
      : identityOf(review.from.chainId, facts.sold.denom);
  const minimum = minimumTerms(swap, boughtIdentity(swap.outputDenom, review.to), review.price.quote);
  const payee = ownerNote(swap.receiver, review);
  const failed = swap.onFailedDelivery;
  const recovery = failed.kind === "local_recovery_addr" ? ownerNote(failed.address, review) : null;
  const verified = facts.contract === review.contract;
  const final = facts.forwardsOut ? ownerNote(facts.forwardsOut.finalReceiver, review) : null;
  return (
    <section className={box}>
      <SectionLabel>
        {facts.via === "contract-call" ? "What the contract call does" : "What the memo will do"}
      </SectionLabel>
      <p className="mt-1 min-w-0 text-[11px] leading-snug text-fg [overflow-wrap:anywhere]">
        {termsLead(facts, venueName)}
      </p>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <KeyValueRow
          label="Sells"
          value={<Fact note={tokenLocationText(sold, "held")}>{tickerAmount(facts.sold.amount, sold, "confirm")}</Fact>}
        />
        <KeyValueRow
          label="Buys"
          value={<BuysValue outputDenom={swap.outputDenom} to={review.to} onCopy={onCopy} />}
        />
        <KeyValueRow
          label="Pays out to"
          value={
            <Fact note={payee.text} tone={payee.tone}>
              <AddressText address={swap.receiver} />
            </Fact>
          }
        />
        {facts.forwardsOut && final ? (
          <KeyValueRow
            label="Then"
            value={
              <Fact note={final.text} tone={final.tone}>
                Forwarded over {facts.forwardsOut.hops.map((hop) => hop.channelId).join(", then ")} to{" "}
                <AddressText address={facts.forwardsOut.finalReceiver} />
              </Fact>
            }
          />
        ) : null}
        <KeyValueRow
          label="Minimum received"
          value={<Fact note={minimum.estimate}>{minimum.rule}</Fact>}
        />
        <KeyValueRow
          label="If delivery fails"
          value={
            failed.kind === "local_recovery_addr" && recovery ? (
              <Fact
                note={
                  recovery.tone === "plain"
                    ? `${recovery.text}, which can claim the output back`
                    : recovery.text
                }
                tone={recovery.tone}
              >
                Kept for <AddressText address={failed.address} />
              </Fact>
            ) : (
              <Fact note="The output could never be claimed back" tone="danger">
                No recovery address
              </Fact>
            )
          }
        />
        <KeyValueRow
          label="Contract"
          value={
            <Fact
              note={
                verified
                  ? `The swap contract Zunia verified on ${venueName}${review.contractLabel ? ` (${review.contractLabel})` : ""}`
                  : "Not the swap contract Zunia verified"
              }
              tone={verified ? "plain" : "danger"}
            >
              <AddressText address={facts.contract} />
            </Fact>
          }
        />
        {fee ? (
          <>
            <div aria-hidden="true" className="h-px bg-[var(--z-line)]" />
            <KeyValueRow
              label="Zunia fee"
              value={<FeeValue paid={fee} review={review} onCopy={onCopyAddress} />}
            />
          </>
        ) : null}
      </div>
      {fee ? (
        <p className="mt-1.5 min-w-0 text-[10.5px] leading-snug text-fg [overflow-wrap:anywhere]">
          {swapFeeOutcome(facts.via, review.fee.bps)}
        </p>
      ) : null}
      {facts.warnings.map((warning) => (
        <p key={warning} className="mt-1 text-[10px] leading-snug text-[var(--z-warning)]">
          {warning}
        </p>
      ))}
      {problems.length > 0 ? (
        <div role="alert" className="mt-1.5 flex flex-col gap-0.5">
          {problems.map((problem) => (
            <p key={problem} className="text-[10.5px] leading-snug text-[var(--z-danger)]">
              {problem}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/** Whose an address in a pool swap's messages is: the signer's on Osmosis, the To's chain's, or nobody's here. */
function poolOwnerNote(
  address: string,
  review: Pick<ReviewedPoolSwap, "signer" | "recipient" | "to">,
): { text: string; tone: "plain" | "danger" } {
  if (address === review.signer) return { text: "Your address on Osmosis", tone: "plain" };
  if (address === review.recipient) return { text: `Your address on ${review.to.chainName}`, tone: "plain" };
  return { text: "Not one of your addresses", tone: "danger" };
}

/**
 * What a pool swap's transaction will do, read out of its messages
 * ({@link readPoolSwapMsg}, {@link readDeliveryTransfer},
 * {@link readSwapFeeMsg}): what is sold and bought, the pools it goes
 * through, the floor below which the chain refuses it, whom it pays, and for
 * `pool-deliver` the transfer after it and what happens if that fails. Nothing
 * here comes from the plan or the form. What the messages do that the review
 * did not say is listed under it ({@link poolSwapTermsProblems}), and refuses
 * the signature.
 */
export function PoolSwapTerms({
  facts,
  review,
  problems,
  onCopy,
  fee = null,
  transfer = null,
  onCopyAddress = COPY_NOTHING,
  framed = true,
}: {
  facts: PoolSwapFacts | null;
  review: ReviewedPoolSwap;
  problems: readonly string[];
  onCopy: (denom: string) => void;
  /** The transaction's fee message, read out of it; `null` when it signs none. */
  fee?: SwapFeeMessage | null;
  /** The transfer after the swap, read out of it; `null` for `pool`. */
  transfer?: DeliveryTransferFacts | null;
  onCopyAddress?: (address: string) => void;
  /** Drawn in its own box; `false` inside a section that already has one. */
  framed?: boolean;
}) {
  const venueName = findCatalogEntry(VENUE_CHAIN_ID)?.chainName ?? VENUE_CHAIN_ID;
  const box = framed ? TERMS_BOX : "min-w-0";
  if (!facts) {
    return (
      <section className={box}>
        <SectionLabel>What the swap will do</SectionLabel>
        <p role="alert" className="mt-1 text-[11px] leading-snug text-[var(--z-danger)]">
          {UNREADABLE_SWAP}
        </p>
      </section>
    );
  }
  const sold =
    facts.sold.denom === review.from.denom
      ? shownIdentity(review.from)
      : identityOf(review.from.chainId, facts.sold.denom);
  const bought = boughtIdentity(facts.outputDenom, review.to);
  const payee = poolOwnerNote(facts.sender, review);
  const delivered = transfer ? poolOwnerNote(transfer.receiver, review) : null;
  const sentOn = transfer ? identityOf(VENUE_CHAIN_ID, transfer.token.denom) : null;
  return (
    <section className={box}>
      <SectionLabel>What the transaction does</SectionLabel>
      <p className="mt-1 min-w-0 text-[11px] leading-snug text-fg [overflow-wrap:anywhere]">
        {review.path === "pool"
          ? `One swap in ${venueName}'s own pools, paid from your balance there. No contract, and nothing is transferred before it.`
          : `One transaction on ${venueName}: a swap in its own pools, then an IBC transfer of the swap's minimum to ${review.to.chainName}.`}
      </p>
      <div className="mt-1.5 flex flex-col gap-1.5">
        <KeyValueRow
          label="Sells"
          value={<Fact note={tokenLocationText(sold, "held")}>{tickerAmount(facts.sold.amount, sold, "confirm")}</Fact>}
        />
        <KeyValueRow
          label="Buys"
          value={<BuysValue outputDenom={facts.outputDenom} to={review.to} onCopy={onCopy} />}
        />
        <KeyValueRow
          label="Through"
          value={
            <Fact note={facts.split ? "The router split the order; each route sells its share." : null}>
              {poolRouteText(facts.routes)}
            </Fact>
          }
        />
        <KeyValueRow
          label="Minimum received"
          value={
            <Fact note="If the swap would pay less, the chain refuses the whole transaction.">
              {tickerAmount(facts.minOut, bought, "confirm")}
            </Fact>
          }
        />
        <KeyValueRow
          label="Pays out to"
          value={
            <Fact note={payee.text} tone={payee.tone}>
              <AddressText address={facts.sender} />
            </Fact>
          }
        />
        {transfer && delivered && sentOn ? (
          <>
            <KeyValueRow
              label="Then"
              value={
                <Fact note={delivered.text} tone={delivered.tone}>
                  Sends {tickerAmount(transfer.token.amount, sentOn, "confirm")} over {transfer.sourceChannel} to{" "}
                  <AddressText address={transfer.receiver} />
                </Fact>
              }
            />
            <KeyValueRow
              label="If delivery fails"
              value={
                <Fact note="The transfer times out and the tokens return there">
                  Back to your address on {venueName}
                </Fact>
              }
            />
          </>
        ) : null}
        {fee ? (
          <>
            <div aria-hidden="true" className="h-px bg-[var(--z-line)]" />
            <KeyValueRow
              label="Zunia fee"
              value={<FeeValue paid={fee} review={review} onCopy={onCopyAddress} />}
            />
          </>
        ) : null}
      </div>
      {fee ? (
        <p className="mt-1.5 min-w-0 text-[10.5px] leading-snug text-fg [overflow-wrap:anywhere]">
          {poolFeeOutcome(review.path)}
        </p>
      ) : null}
      {problems.length > 0 ? (
        <div role="alert" className="mt-1.5 flex flex-col gap-0.5">
          {problems.map((problem) => (
            <p key={problem} className="text-[10.5px] leading-snug text-[var(--z-danger)]">
              {problem}
            </p>
          ))}
        </div>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------- *
 * The review, laid out: the essentials first, the rest folded away
 * -------------------------------------------------------------------------- */

/**
 * A section that opens on demand and starts closed: a native `<details>`, so
 * the keyboard and assistive tech open it with no script, and what is inside
 * stays in the page for anyone who wants to read it.
 */
export function ReviewDisclosure({
  title,
  hint = null,
  children,
}: {
  title: string;
  /** Beside the title, quieter: what is inside, in a word or two. */
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <details className="group min-w-0 rounded-[12px] border border-[var(--z-line)]">
      <summary
        className={cn(
          "flex cursor-pointer select-none list-none items-center justify-between gap-2 rounded-[12px] px-3 py-2.5",
          "text-[12px] font-medium text-fg-muted transition-colors duration-[var(--z-duration-base)] hover:text-fg",
          "[&::-webkit-details-marker]:hidden",
          focusRing,
        )}
      >
        <span className="min-w-0">{title}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {hint ? <span className="text-[10.5px] font-normal text-fg-dim">{hint}</span> : null}
          <IconChevronDown
            width={14}
            height={14}
            aria-hidden
            className="transition-transform duration-[var(--z-duration-base)] group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="flex min-w-0 flex-col gap-2 px-3 pb-3">{children}</div>
    </details>
  );
}

/** One line of the review's summary: what it is on the left, the amount on the right, a quiet note under it. */
function ReviewFact({
  label,
  children,
  note = null,
}: {
  label: string;
  children: ReactNode;
  note?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11.5px] text-fg-muted">{label}</span>
      <span className="flex min-w-0 flex-col items-end text-right">
        <span className="max-w-full text-[11.5px] font-medium tabular-nums text-fg [overflow-wrap:anywhere]">
          {children}
        </span>
        {note ? <span className="text-[10px] leading-snug text-fg-dim [overflow-wrap:anywhere]">{note}</span> : null}
      </span>
    </div>
  );
}

/** One side of the review: what it is, the token's logo, the amount in large type, and where the token is. */
function ReviewSide({
  label,
  option,
  amount,
  line,
}: {
  label: string;
  option: AssetOption;
  amount: string;
  line: string;
}) {
  const identity = shownIdentity(option);
  const seal = provenanceLabel(identity);
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">{label}</p>
      <div className="mt-1.5 flex items-center gap-2.5">
        <TokenAvatar identity={identity} size={32} locationBadge="always" />
        <div className="min-w-0 flex-1">
          <p className="text-[18px] font-semibold leading-tight tracking-[-0.03em] tabular-nums text-fg [overflow-wrap:anywhere]">
            {amount}
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">{line}</p>
          {seal ? <span className="sr-only">{seal}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** What the top of a swap's confirm screen says: the two sides, then the few numbers that matter. */
export interface SwapReviewSummary {
  readonly from: AssetOption;
  readonly to: AssetOption;
  /** Everything the user spends, the Zunia fee included: `10 OSMO`. */
  readonly pay: string;
  /** What comes back: `≈ 0.3524 USDC.inj`, or the exact amount when the signed messages fix it. */
  readonly receive: string;
  /** Where it arrives, and anything else the user has to know about it. */
  readonly receiveLine: string;
  /** The floor below which the swap does not happen; `null` when {@link receive} is already exact. */
  readonly minimum: { readonly value: string; readonly note: string | null } | null;
  /** `1 OSMO ≈ 0.0354 USDC.inj`, when both sides have known decimals. */
  readonly rate: string | null;
  /** The Zunia fee and its rate; `null` when none is taken. */
  readonly zuniaFee: { readonly amount: string; readonly rate: string } | null;
}

/** The Zunia fee as the summary shows it. */
function zuniaFeeFact(review: Pick<ReviewedSwap, "fee" | "from">): SwapReviewSummary["zuniaFee"] {
  const { fee, from } = review;
  return fee.fee > 0n
    ? { amount: tickerAmount(fee.fee, from.identity, "confirm"), rate: feeRateText(fee.bps) }
    : null;
}

/**
 * The summary of a swap through the crosschain-swaps contract. The minimum is
 * the one the message carries (`minimumTerms`): a number when it sets one, the
 * TWAP rule with today's estimate when it does not; nothing when the message
 * cannot be read, which the problems above it say.
 */
export function contractReviewSummary(
  review: ReviewedSwap,
  facts: SwapMessageFacts | null,
): SwapReviewSummary {
  const { from, to } = review;
  const quote = review.price.quote;
  const view = quote ? swapQuoteView(quote, from, to) : null;
  const terms = facts ? minimumTerms(facts.swap, boughtIdentity(facts.swap.outputDenom, to), quote) : null;
  return {
    from,
    to,
    pay: tickerAmount(review.amountUnits, from.identity, "confirm"),
    receive: view ? `≈ ${view.outputAmount} ${view.outputSymbol}` : NO_VALUE,
    receiveLine: tokenLocationText(to.identity, "delivered"),
    minimum: terms ? { value: terms.exact ?? terms.rule, note: terms.exact ? null : terms.estimate } : null,
    rate: view?.rate ?? null,
    zuniaFee: zuniaFeeFact(review),
  };
}

/**
 * The summary of a swap in Osmosis's pools. On Osmosis the user receives about
 * the quote, and at least the message's floor. Delivered elsewhere, the
 * transfer sends exactly the floor, so that is what they receive there, said
 * as exact, with what stays behind on Osmosis.
 */
export function poolReviewSummary(review: ReviewedPoolSwap, facts: PoolSwapFacts | null): SwapReviewSummary {
  const { from, to } = review;
  const quote = review.price.quote;
  const view = swapQuoteView(quote, from, to);
  const floor = facts?.minOut ?? review.minOut;
  const bought = boughtIdentity(review.venueOutputDenom, to);
  const base = {
    from,
    to,
    pay: tickerAmount(review.amountUnits, from.identity, "confirm"),
    rate: view.rate ?? null,
    zuniaFee: zuniaFeeFact(review),
  };
  if (review.path === "pool") {
    return {
      ...base,
      receive: `≈ ${view.outputAmount} ${view.outputSymbol}`,
      receiveLine: tokenLocationText(to.identity, "delivered"),
      minimum: { value: tickerAmount(floor, bought, "confirm"), note: null },
    };
  }
  const rest = BigInt(quote.outputAmount) - BigInt(floor);
  return {
    ...base,
    receive: tickerAmount(floor, bought, "confirm"),
    receiveLine:
      rest > 0n
        ? `${tokenLocationText(to.identity, "delivered")} · about ${tickerAmount(rest, bought, "confirm")} more stays on Osmosis`
        : tokenLocationText(to.identity, "delivered"),
    minimum: null,
  };
}

/**
 * The top of a swap's confirm screen: what the user pays, what they get back
 * and where, the minimum, the rate, the fees, and how long the price holds.
 * Everything else about the transaction is in the folded sections under it.
 */
export function SwapReviewCard({
  summary,
  networkFee,
  feeNote = null,
  clock,
  priceError = null,
}: {
  summary: SwapReviewSummary;
  /** The network fee line, with its own way to change the speed. */
  networkFee: ReactNode;
  /** Under the network fee: why it is an estimate, when it is one. */
  feeNote?: string | null;
  /** The price's countdown and its refresh. */
  clock: ReactNode;
  /** Why there is no current price, when there is none. */
  priceError?: string | null;
}) {
  const { minimum, rate, zuniaFee } = summary;
  return (
    <section className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-3">
      <ReviewSide
        label="You pay"
        option={summary.from}
        amount={summary.pay}
        line={tokenLocationText(summary.from.identity, "held")}
      />
      <div className="my-2.5 flex items-center" aria-hidden="true">
        <span className="h-px flex-1 bg-[var(--z-line)]" />
        <span className="mx-2 flex size-6 items-center justify-center rounded-full border border-[var(--z-line)] bg-[var(--z-surface)] text-fg-muted">
          <IconChevronDown width={13} height={13} />
        </span>
        <span className="h-px flex-1 bg-[var(--z-line)]" />
      </div>
      <ReviewSide label="You receive" option={summary.to} amount={summary.receive} line={summary.receiveLine} />
      <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--z-line)] pt-2.5">
        {minimum ? (
          <ReviewFact label="Minimum received" note={minimum.note}>
            {minimum.value}
          </ReviewFact>
        ) : null}
        {rate ? <ReviewFact label="Rate">{rate}</ReviewFact> : null}
        {zuniaFee ? <ReviewFact label={`Zunia fee (${zuniaFee.rate})`}>{zuniaFee.amount}</ReviewFact> : null}
        {networkFee}
        {feeNote ? <p className="text-right text-[10px] leading-snug text-fg-dim">{feeNote}</p> : null}
      </div>
      {clock}
      {priceError ? <p className="mt-1.5 text-[10px] leading-snug text-[var(--z-warning)]">{priceError}</p> : null}
    </section>
  );
}

/** What stops the signature, said where it cannot be missed: above the folded details, never inside them. */
export function ReviewProblems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <Callout compact tone="danger" title="Zunia will not sign this">
      <ul className="flex flex-col gap-0.5">
        {problems.map((problem) => (
          <li key={problem} className="text-[10.5px] leading-snug">
            {problem}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/**
 * The transaction for whoever wants to check it by hand: the chain, the memo,
 * the fee and every message as it is handed to the kernel. A contract call's
 * base64 ExecuteMsg is shown decoded beside it, so it can be read.
 */
export function reviewJson(
  chainId: string,
  msgs: readonly BuiltMsg[],
  preview: Pick<TxPreview, "fee"> & { readonly preview: Pick<TxPreview["preview"], "memo"> },
): string {
  const readable = msgs.map((msg) => {
    if (msg.typeUrl !== EXECUTE_CONTRACT_TYPE_URL) return msg;
    const decoded = canonicalJson(base64Utf8(msg.value.msg));
    return decoded === undefined ? msg : { ...msg, decodedMsg: decoded };
  });
  return JSON.stringify(
    { chain_id: chainId, memo: preview.preview.memo, fee: preview.fee, messages: readable },
    null,
    2,
  );
}

/** The raw transaction, folded: monospace, scrollable, selectable. */
export function ReviewJson({ json }: { json: string }) {
  return (
    <ReviewDisclosure title="Raw transaction" hint="JSON">
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--z-surface-sunken)] p-2 font-mono text-[10px] leading-snug text-fg">
        {json}
      </pre>
    </ReviewDisclosure>
  );
}

/** The kernel's own line for each message, exactly as it will be signed. */
export function ExactMessages({ summaries, memo }: { summaries: readonly string[]; memo: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
        {summaries.length > 1 ? "Exact messages" : "Exact message"}
      </p>
      {summaries.map((line, index) => (
        <p
          key={index}
          className="mt-0.5 min-w-0 break-words font-mono text-[10.5px] leading-snug text-fg [overflow-wrap:anywhere]"
        >
          {line}
        </p>
      ))}
      {memo ? (
        <div className="mt-1.5">
          <KeyValueRow label="Memo" value={memo} />
        </div>
      ) : null}
    </div>
  );
}

/** Back and Sign, with the reason Sign is off as its label when it is. */
export function ConfirmFooter({
  busy,
  label,
  disabled,
  onBack,
  onSign,
}: {
  busy: boolean;
  /** The short reason signing is blocked; `null` when it is not. */
  label: string | null;
  disabled: boolean;
  onBack: () => void;
  onSign: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="secondary" className="flex-1" disabled={busy} onClick={onBack}>
        Back
      </Button>
      <Button className="flex-1" disabled={busy || disabled} onClick={onSign}>
        {busy ? "Signing…" : (label ?? "Sign and send")}
      </Button>
    </div>
  );
}

/**
 * The confirm screen's other warnings, short, under the summary: a review the
 * form no longer stands behind, a balance that cannot cover the network fee,
 * and a signing error.
 */
function ReviewAlerts({
  drift,
  feeShort,
  error,
  onBack,
}: {
  drift: string | null;
  feeShort: boolean;
  error: string | null;
  onBack: () => void;
}) {
  return (
    <>
      {drift ? (
        <Callout compact tone="warning" title="This review is out of date">
          {drift} Nothing was signed.{" "}
          <button type="button" onClick={onBack} className={cn("underline underline-offset-2", focusRing)}>
            Review the swap again
          </button>
        </Callout>
      ) : null}
      {feeShort ? (
        <Callout compact tone="danger" title="Not enough left for the network fee">
          Lower the amount or the gas speed. The chain takes the fee first, then the swap.
        </Callout>
      ) : null}
      {error ? (
        <Callout compact tone="danger" title="Could not sign">
          {error}
        </Callout>
      ) : null}
    </>
  );
}

/** How long the shown price stays current, and a way to fetch a new one now. */
export function QuoteClock({
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
          // The label lines up with the values above it; the pill's padding hangs outside.
          "-mr-1.5 shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
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
  onMoveToVenue,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
  /**
   * Opens Send to move a held token to this wallet's Osmosis address, the
   * first step of a `move-first` swap. Without it that step is only described.
   */
  onMoveToVenue?: (args: { readonly chainId: string; readonly denom: string }) => void;
}) {
  const signedSend = useSignedSend();
  const toast = useToast();
  const { hidden, settings, fiat } = usePrefs();
  const liveReads = settings.liveBalances;

  // An empty balance map is "not read yet", not "holds nothing": the reader
  // writes a row per chain even when every denom is zero.
  const balancesLoaded = Object.keys(balances).length > 0;
  const osmosis = useOsmosisAssets(liveReads);
  const venue = useSwapVenue(liveReads);
  // What the wallet holds, one row per chain and exact denom (lib/swap-assets.ts).
  // The SQS list only checks decimals here: a disagreement makes the field Max-only.
  const sources = useMemo(
    () => sellOptions(chains, balances, osmosis.assets),
    [chains, balances, osmosis.assets],
  );

  // Stored as "what the user picked", null until they pick. The effective
  // selection is derived below, so opening the screen needs no effect that
  // writes state on the first render.
  const [fromKey, setFromKey] = useState<string | null>(null);
  const [toKey, setToKey] = useState<string | null>(null);

  // A swap the user started before moving its tokens to Osmosis (the
  // `move-first` path) opens again on the Osmosis row they arrive as. Read
  // once; a pick the user makes meanwhile wins.
  useEffect(() => {
    let cancelled = false;
    void takeSwapIntent().then((intent) => {
      if (cancelled || !intent) return;
      setFromKey((picked) => picked ?? intent.fromKey);
      setToKey((picked) => picked ?? intent.toKey);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The From is always a held balance, on the chain that holds it. It
  // defaults to whatever chain the user came from.
  const from =
    sources.find((asset) => asset.key === fromKey) ??
    sources.find((asset) => asset.chainId === initialChainId) ??
    sources[0];

  // What can be bought with it and where it arrives, each row gated by the
  // swap contract's route table: a row it cannot execute carries its reason
  // and is listed only by a search. Until the table loads (or when it cannot
  // be read) no row is refused for want of a route; the planner's live route
  // check still decides what may be signed.
  const routeTable = useXcsRoutes(venue.check?.venue?.contractAddress ?? null);
  const routes = routeTable.table;
  const destinations = useMemo(
    () => buyOptions(chains, balances, { from: from ?? null, osmosis: osmosis.assets, routes }),
    [chains, balances, from, osmosis.assets, routes],
  );
  const to = pickTo(destinations, toKey);
  // How this pair reaches Osmosis (lib/swap-path.ts): the crosschain-swaps
  // contract, Osmosis's own pools now, or the pools once the tokens have moved.
  const path: SwapPath | null = from && to ? swapPathFor(from, to, to.executable) : null;
  // Funds on Osmosis bound for another chain take the contract when its table
  // has the pair, the pools otherwise. Until the table answers, neither is
  // planned, so the path does not switch under a quote already shown.
  const pathPending = Boolean(
    from?.chainId === VENUE_CHAIN_ID &&
      to &&
      to.chainId !== VENUE_CHAIN_ID &&
      (venue.loading || routeTable.loading),
  );

  // The typed text belongs to the token and the exponent it was typed for. A
  // new From, or decimals that turn out unknown once the Osmosis list loads,
  // read it as nothing rather than as a different amount.
  const scale = from ? scaleOf(from) : "";
  const [draft, setDraft] = useState<{ text: string; scale: string }>({ text: "", scale: "" });
  const amount = draft.scale === scale ? draft.text : "";
  const setAmount = (text: string) => setDraft({ text, scale });
  const slippage = settings.swapSlippage;
  const [manual, setManual] = useState<ManualChannel[]>([]);
  // Bumped by the retry controls. Part of the plan key, because re-running the
  // same inputs must actually re-run them; a new array identity would not.
  const [retryToken, setRetryToken] = useState(0);
  const [phase, setPhase] = useState<Phase>("form");
  // What the confirm phase signs and the kernel's preview of exactly those
  // messages, kept as one value so neither is ever shown with the other's
  // stand-in.
  const [confirmTx, setConfirmTx] = useState<{ pending: PendingTx; preview: TxPreview } | null>(null);
  const pending = confirmTx?.pending ?? null;
  const preview = confirmTx?.preview ?? null;
  // Only the confirm screen reads the review; Back leaves it in place unread.
  const review = phase === "confirm" && pending?.kind === "swap" ? pending.review : null;
  const poolReview = phase === "confirm" && pending?.kind === "pool" ? pending.review : null;
  /** The id of the review whose price is being fetched again. */
  const [reviewRequoting, setReviewRequoting] = useState<number | null>(null);
  const reviewCount = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The route being followed. Survives a popup close through storage. */
  const [tracked, setTracked] = useState<PendingTransfer | null>(null);
  /** Hash of a `{"recover":{}}` transaction, shown alongside the route it rescued. */
  const [recoverTxHash, setRecoverTxHash] = useState<string | null>(null);
  /** A pool swap just broadcast: one transaction on Osmosis, followed until it is included. */
  const [poolSent, setPoolSent] = useState<{ txHash: string; review: ReviewedPoolSwap } | null>(null);
  const [routeOpen, setRouteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const expert = advanced;

  const kernel = useKernelSigning();
  const pendingRoutes = usePendingTransfers();
  const resolveAddresses = useResolveAddresses();

  const sourceAccount = chains.find((chain) => chain.chainId === from?.chainId);
  const destAccount = chains.find((chain) => chain.chainId === to?.chainId);

  // What the user spends in all, typed or Max. The Zunia fee comes out of it,
  // and the swap is planned, priced and signed for what is left (`net`).
  // Memoized for what it is to the compiler, not for its cost: the plan key,
  // and so the memoized price refresh, are derived from it, and a fee object
  // made afresh each render would read as one that could still change.
  const amountUnits = amountUnitsOf(from, amount);
  const swapFee = useMemo(
    () => (from && amountUnits !== null && amountUnits > 0n ? swapFeeFor(from.chainId, amountUnits) : null),
    [from, amountUnits],
  );
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
  // A token delivered on a chain the wallet has not enabled (Osmosis, or a
  // token's home chain) goes to this wallet's own address there, derived on
  // demand. The answer is kept with its chain, so one for another chain is
  // never used.
  const resolveChainId = to && !destAccount?.address ? to.chainId : null;
  const [resolvedDest, setResolvedDest] = useState<{
    chainId: string;
    address: string | null;
  } | null>(null);
  useEffect(() => {
    if (!resolveChainId) return;
    let cancelled = false;
    void resolveAddresses([resolveChainId]).then((map) => {
      if (!cancelled) {
        setResolvedDest({ chainId: resolveChainId, address: map[resolveChainId] ?? null });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolveChainId, resolveAddresses]);
  const resolvingDest = resolveChainId !== null && resolvedDest?.chainId !== resolveChainId;
  const catalogDestAddress =
    resolveChainId !== null && resolvedDest?.chainId === resolveChainId ? resolvedDest.address : null;

  const destAddress =
    destAccount?.address ??
    catalogDestAddress ??
    (to?.chainId === VENUE_CHAIN_ID ? recoveryAddress : null);

  // A token's price lives with its issuer: USDC.n on Osmosis is priced as
  // Noble's USDC, ATOM on Osmosis as the Hub's ATOM.
  // usePrices keys its read by the ids' text, so a new array per render is fine.
  const priceChainIds = [
    ...new Set(
      [from?.identity.originChainId, to?.identity.originChainId].filter(
        (id): id is string => Boolean(id),
      ),
    ),
  ];
  const { prices } = usePrices(priceChainIds, liveReads);

  /**
   * The fiat value of `displayAmount` of a side's token, priced through its
   * origin chain when the token is that chain's own coin there. Nothing for a
   * token whose identity or decimals are not known: no price beats a wrong one.
   */
  function pricedFiat(asset: AssetOption | undefined, displayAmount: string): string | null {
    if (!asset) return null;
    const { identity } = asset;
    if (!identity.proven || !identity.decimalsKnown || !identity.originChainId) return null;
    const origin = findCatalogEntry(identity.originChainId);
    if (!origin || origin.coinMinimalDenom !== identity.originDenom) return null;
    const spot = prices[identity.originChainId];
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
    code: SwapQuoteBlockedCode | null;
    at: number;
  } | null>(null);
  const [requotingKey, setRequotingKey] = useState<string | null>(null);
  /** A pool path's plan (lib/pool-swap.ts), for the plan key it answered. */
  const [settledPool, setSettledPool] = useState<{
    key: string;
    plan: PoolSwapPlan;
    quotedAt: number;
  } | null>(null);
  /** A pool price fetched after the plan, for the same plan key. */
  const [poolRequoted, setPoolRequoted] = useState<{ key: string; quote: PoolQuote; at: number } | null>(
    null,
  );

  // The contract reads `slippage_percentage` on a 0-100 scale and divides by
  // 100 itself, so an out-of-range value is not a wide tolerance, it is a memo
  // the contract rejects. Caught before planning rather than as a build error.
  const slippageOk =
    Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;

  // A To row the gate refused is never planned: the picker already says why,
  // and the planner's live route check would only refuse it again. The
  // contract path needs the verified contract and a recovery address; the
  // pools need neither.
  const canPlan =
    liveReads &&
    Boolean(from && to && sourceAccount?.address && destAddress) &&
    to?.disabledReason === null &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    slippageOk &&
    !(from?.chainId === to?.chainId && from?.denom === to?.denom) &&
    path !== null &&
    !pathPending &&
    (path !== "contract" || (Boolean(venue.check?.venue) && Boolean(recoveryAddress)));

  // The key carries what both tokens on screen are called on Osmosis, from
  // their identities (lib/swap-assets.ts). The planner refuses a route that
  // would trade another variant, one that only shares the ticker, as
  // `venue-denom-mismatch`, so a plan is always checked against the
  // identities on screen. The plan sells what is left after the Zunia fee,
  // and the fee itself is part of the key.
  const planKey =
    canPlan && from && to && swapFee
      ? swapPlanKey({
          from,
          to,
          amountUnits: swapFee.net,
          fee: swapFee,
          slippage,
          manual,
          // The venue the key is for: the contract's address, or the pool path.
          contract: path === "contract" ? venue.check?.contractAddress : `osmosis-pools:${path}`,
          retryToken,
        })
      : "";

  useEffect(() => {
    if (!planKey) return;
    const controller = new AbortController();
    // Debounced: the amount field fires per keystroke and a plan is several
    // LCD round trips.
    const timer = window.setTimeout(() => {
      if (path !== "contract") {
        // Osmosis's own pools. A `move-first` swap is priced for what it will
        // sell once the tokens are there, after the fee charged on Osmosis.
        const sells = path === "move-first" ? swapFeeFor(VENUE_CHAIN_ID, amountUnits!).net : swapFee!.net;
        void planPoolSwap({
          venueInputDenom: osmosisDenomFor(from!) ?? "",
          venueOutputDenom: osmosisDenomFor(to!) ?? "",
          amountBaseUnits: sells.toString(),
          slippagePercent: slippage,
          delivery:
            path === "pool-deliver"
              ? {
                  destChainId: to!.chainId,
                  destDenom: to!.denom,
                  sender: sourceAccount!.address,
                  recipient: destAddress!,
                  manualChannels: manual,
                  resolveAddresses,
                }
              : null,
          signal: controller.signal,
        }).then((next) => {
          if (!controller.signal.aborted) {
            setSettledPool({ key: planKey, plan: next, quotedAt: Date.now() });
          }
        });
        return;
      }
      void planSwap(
        swapPlanRequest({
          from: from!,
          to: to!,
          amountUnits: swapFee!.net,
          sender: sourceAccount!.address,
          recipient: destAddress!,
          recoveryAddress: recoveryAddress!,
          slippagePercent: slippage,
          venue: venue.check!.venue!,
          manualChannels: manual,
          resolveAddresses,
          signal: controller.signal,
        }),
      ).then((next) => {
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
  const result = path === "contract" && settledPlan?.key === planKey ? settledPlan.result : null;
  const poolSettled = path !== "contract" && settledPool?.key === planKey ? settledPool : null;
  const poolPlan = poolSettled?.plan ?? null;
  const planning =
    Boolean(planKey) &&
    (path === "contract" ? settledPlan?.key !== planKey : settledPool?.key !== planKey);
  const plan = result?.best ?? null;
  // The transfer leg of a `pool-deliver` swap: the route panel and the channel
  // controls work on it as they do on the contract's route.
  const delivery = path === "pool-deliver" ? (poolPlan?.delivery ?? null) : null;
  const routeView = path === "contract" ? plan : (delivery?.view ?? null);

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
  const poolFresh =
    poolSettled && poolRequoted?.key === planKey && poolRequoted.at >= poolSettled.quotedAt
      ? poolRequoted
      : null;
  /** The pools' price and order for the current inputs (every path but the contract's). */
  const poolQuote: PoolQuote | null = poolFresh ? poolFresh.quote : (poolPlan?.quote ?? null);
  const quote =
    path === "contract" ? (fresh ? fresh.quote : (result?.quote ?? null)) : (poolQuote?.quote ?? null);
  const quoteCode = fresh ? fresh.code : (result?.quoteBlockedCode ?? null);
  const quoteError =
    path === "contract"
      ? quoteBlockText(quoteCode, fresh ? fresh.error : (result?.quoteBlockedReason ?? null), from, to, plan)
      : poolQuoteText(poolQuote?.code ?? null, poolQuote?.error ?? null, from, to);
  const quotedAt =
    path === "contract"
      ? fresh
        ? fresh.at
        : result
          ? (settledPlan?.quotedAt ?? null)
          : null
      : poolFresh
        ? poolFresh.at
        : (poolSettled?.quotedAt ?? null);
  const refreshing = Boolean(planKey) && requotingKey === planKey;

  // The confirm screen counts down its review's own price, whatever the form's is.
  const now = useClock(
    phase === "confirm" ? review !== null || poolReview !== null : quotedAt !== null && phase !== "sent",
  );
  const quoteSecondsLeft =
    quotedAt === null
      ? null
      : Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - quotedAt)) / 1000));

  const venueChainId = result?.venue?.chainId ?? null;
  const venueContract = result?.venue?.contractAddress ?? null;
  const venueInputDenom = result?.venueInputDenom ?? null;
  const venueOutputDenom = result?.venueOutputDenom ?? null;
  // The price is for what the swap sells: the amount less the Zunia fee.
  const amountBase = swapFee ? swapFee.net.toString() : null;
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
      return { quote: null, error: "There is no route to price yet.", code: null, at: Date.now(), input: null };
    }
    const key = planKey;
    // Kept with the answer: a review prices this exact plan again later.
    const input: VenueQuoteInput = {
      venueChainId,
      venueContract,
      venueInputDenom,
      venueOutputDenom,
      amountBaseUnits: amountBase,
      slippagePercent: slippage,
    };
    setRequotingKey(key);
    const next = await requoteSwap(input).catch((caught: unknown) => ({
      quote: null,
      error: caught instanceof Error ? caught.message : String(caught),
      code: null,
    }));
    const at = Date.now();
    setRequoted({ key, quote: next.quote, error: next.error, code: next.code, at });
    setRequotingKey((current) => (current === key ? null : current));
    return { ...next, at, input };
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

  /**
   * A new price in the pools for the plan on screen: its denoms, its amount
   * and the slippage it was made with. Returns the answer, and when it came.
   */
  const refreshPoolQuote = useCallback(async (): Promise<{ quote: PoolQuote | null; at: number }> => {
    if (!planKey || !poolPlan) return { quote: null, at: Date.now() };
    const key = planKey;
    setRequotingKey(key);
    const next = await quotePoolSwap({
      venueInputDenom: poolPlan.venueInputDenom,
      venueOutputDenom: poolPlan.venueOutputDenom,
      amountBaseUnits: poolPlan.amountBaseUnits,
      slippagePercent: slippage,
    }).catch(
      (caught: unknown): PoolQuote => ({
        quote: null,
        routes: null,
        minOut: null,
        error: caught instanceof Error ? caught.message : String(caught),
        code: null,
      }),
    );
    const at = Date.now();
    setPoolRequoted({ key, quote: next, at });
    setRequotingKey((current) => (current === key ? null : current));
    return { quote: next, at };
  }, [planKey, poolPlan, slippage, setPoolRequoted, setRequotingKey]);

  const contractPath = path === "contract";
  /** The price refresh for the path on screen. */
  function refreshPrice(): Promise<unknown> {
    return contractPath ? refreshQuote() : refreshPoolQuote();
  }
  const canRefresh = contractPath ? canRequote : Boolean(planKey && poolPlan);

  // The form keeps the price current on its own. The confirm screen does not:
  // a number changing under the user's cursor right before they sign is worse
  // than asking them to refresh it.
  useEffect(() => {
    if (phase !== "form" || !canRefresh || quotedAt === null) return;
    const due = quotedAt + QUOTE_TTL_MS;
    const refreshIfDue = () => {
      if (document.visibilityState !== "visible" || Date.now() < due) return;
      void (contractPath ? refreshQuote() : refreshPoolQuote());
    };
    const timer = window.setTimeout(refreshIfDue, Math.max(0, due - Date.now()));
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [phase, canRefresh, quotedAt, contractPath, refreshQuote, refreshPoolQuote]);

  /* ---------------------------------------------------------------- *
   * Why the button is off
   * ---------------------------------------------------------------- */

  // Cheap to work out, so it is not memoized: a manual memo here only kept
  // the compiler from optimizing the screen.
  const blockedReason = ((): string | null => {
    if (!liveReads) {
      return "Swapping reads channels, denom traces and pool prices from public endpoints. Turn on live balances in Settings → Preferences.";
    }
    if (kernel.loading) return null;
    if (kernel.reason) return kernel.reason;
    if (sources.length === 0) {
      // "Nothing to swap" and "balances have not arrived yet" are different
      // facts, and only one of them is the user's problem.
      return balancesLoaded
        ? "This wallet holds no non-zero balance to swap."
        : "Balances have not loaded yet.";
    }
    if (!from) return "Pick what you are swapping and what you want back.";
    if (!to) {
      if (from.testnet) return TESTNET_REASON;
      return destinations.length > 0
        ? `Nothing can be bought with ${from.identity.ticker} here. Search the To list to see each token and why.`
        : "Pick what you want back.";
    }
    // The gate's reason for a To the user picked before the From changed.
    if (to.disabledReason) return to.disabledReason;
    // The contract has to be verified on its path, and only there: Osmosis's
    // own pools swap without it. Funds on Osmosis wait for its route table,
    // which decides between the two.
    if (path === "contract" || pathPending) {
      if (venue.loading || pathPending) return null;
      if (venue.check?.reason) return venue.check.reason;
    }
    if (!sourceAccount?.address) {
      return `Zunia has no address on ${from.chainName}, so it cannot sign there.`;
    }
    if (!destAddress) {
      if (resolvingDest || (to.chainId === VENUE_CHAIN_ID && recovery === null)) return null;
      return `Zunia has no address on ${to.chainName}, so it has nowhere to deliver.`;
    }
    if (from.chainId === to.chainId && from.denom === to.denom) {
      return "Both sides are the same asset on the same chain.";
    }
    if (!amount) {
      return canTypeAmount(from.identity)
        ? "Enter an amount to swap."
        : "Use Max to set the amount: this token's decimals are unknown.";
    }
    if (amountUnits === null) return "That amount is not a number this chain can hold.";
    if (amountUnits <= 0n) return "Enter an amount above zero.";
    if (overBalance) {
      return `More than the ${from.symbol} left after the network fee.`;
    }
    if (!slippageOk) {
      return `Slippage must be between 0 and ${MAX_SLIPPAGE_PERCENT}%. Above that the tolerance stops protecting anything.`;
    }
    if (path !== "contract") {
      // Osmosis's own pools: the price, then the transfer leg when there is one.
      // A `move-first` swap has its own panel and button, and nothing to sign here.
      if (planning || !poolPlan) return null;
      if (quoteError) return quoteError;
      if (!quote) return "Waiting for a price from the Osmosis router.";
      if (path === "pool-deliver") {
        if (!delivery) return `Zunia is planning the transfer to ${to.chainName}.`;
        if (delivery.error) return delivery.error;
      }
      return null;
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
    // A route that would trade another variant is blocked in the plan too;
    // the tickers say it better than the planner's denoms.
    if (plan.blockedReason) {
      return quoteCode === "venue-denom-mismatch" && quoteError ? quoteError : plan.blockedReason;
    }
    if (quoteError) return quoteError;
    if (!quote) return "Waiting for a price from the Osmosis router.";
    return null;
  })();

  const ready =
    blockedReason === null &&
    Boolean(quote && from && sourceAccount) &&
    (path === "contract"
      ? plan !== null
      : isPoolPath(path) &&
        Boolean(poolQuote?.routes && poolQuote.minOut) &&
        (path === "pool" || Boolean(delivery?.view && !delivery.error)));

  // A channel check that failed on the plan's path (lib/route-plan.ts
  // `failedCheck`): the contract's route, or a pool swap's transfer leg. One
  // that could not finish can be asked again; one on a channel the user pinned
  // stays theirs, with a way back to the automatic pick. A refused channel the
  // planner chose is already routed around.
  const failedCheck = routeView?.failedCheck ?? null;
  const pinnedFailure =
    failedCheck && failedCheck.verdict !== "inconclusive"
      ? (manual.find(
          (pin) =>
            pin.fromChainId === failedCheck.sourceChainId &&
            pin.toChainId === failedCheck.destChainId,
        ) ?? null)
      : null;

  /* ---------------------------------------------------------------- *
   * The review on the confirm screen
   * ---------------------------------------------------------------- */

  // What the messages that are signed say, read from the messages themselves:
  // the swap first, then the Zunia fee when the transaction pays one.
  const reviewFacts = review ? readSwapMessage(pending?.msgs[0]) : null;
  const reviewFee = review ? readSwapFeeMsg(pending?.msgs[1]) : null;
  const reviewProblems =
    review && pending
      ? swapTermsProblems(reviewFacts, review, {
          chainId: pending.chainId,
          signerAddress: pending.signerAddress,
          msgs: pending.msgs,
        })
      : [];
  // The form keeps planning under the confirm screen; the review stands only
  // while the form would still sign the swap that was reviewed, its fee included.
  const drift = review
    ? reviewDrift(review, {
        from,
        to,
        amountUnits,
        fee: swapFee,
        planKey,
        plan,
        planning,
        blockedReason,
      })
    : null;
  const reviewRefreshing = review !== null && reviewRequoting === review.id;
  const reviewPriceError = review
    ? quoteBlockText(review.price.code, review.price.error, review.from, review.to, review.plan)
    : null;
  // The same for a pool swap: its messages, read; what the review did not say;
  // whether the form still stands behind it.
  const poolFacts = poolReview ? readPoolSwapMsg(pending?.msgs[0]) : null;
  const poolFeeMsg =
    poolReview && pending?.msgs[1]?.typeUrl === BANK_SEND_TYPE_URL ? readSwapFeeMsg(pending.msgs[1]) : null;
  const poolTransfer =
    poolReview?.path === "pool-deliver" ? readDeliveryTransfer(pending?.msgs[pending.msgs.length - 1]) : null;
  const poolProblems =
    poolReview && pending
      ? poolSwapTermsProblems(poolFacts, poolReview, {
          chainId: pending.chainId,
          signerAddress: pending.signerAddress,
          msgs: pending.msgs,
          now,
        })
      : [];
  const poolDrift = poolReview
    ? poolReviewDrift(poolReview, {
        from,
        to,
        path,
        amountUnits,
        fee: swapFee,
        planKey,
        planning,
        delivery,
        blockedReason,
      })
    : null;
  const poolRefreshing = poolReview !== null && reviewRequoting === poolReview.id;
  // The chain takes the fee first, out of the reviewed From's live balance.
  const feeCoin = preview?.fee.amount[0];
  const signedFrom = review?.from ?? poolReview?.from ?? null;
  const signedUnits = review?.amountUnits ?? poolReview?.amountUnits ?? null;
  const reviewBalance = signedFrom
    ? BigInt((sources.find((asset) => asset.key === signedFrom.key) ?? signedFrom).amount)
    : null;
  const feeShort =
    signedFrom !== null &&
    signedUnits !== null &&
    feeCoin !== undefined &&
    feeCoin.denom === signedFrom.denom &&
    reviewBalance !== null &&
    reviewBalance - signedUnits < BigInt(feeCoin.amount);
  // Why the Sign button is off, as of the clock's last tick. Signing reads
  // this, and the price's age again at that very moment. Read there, never
  // handed to a call: a value built during render and passed along inside
  // the handler makes the compiler treat the handler as render code.
  const signBlock = review
    ? swapSignBlock({
        problem: reviewProblems[0] ?? null,
        drift,
        price: review.price,
        priceError: reviewPriceError,
        refreshing: reviewRefreshing,
        feeShort,
        now,
      })
    : poolReview
      ? swapSignBlock({
          problem: poolProblems[0] ?? null,
          drift: poolDrift,
          price: { quote: poolReview.price.quote, error: null, code: null, at: poolReview.price.at },
          priceError: null,
          refreshing: poolRefreshing,
          feeShort,
          now,
        })
      : null;

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
        setConfirmTx({ pending: next, preview: built });
        setPhase("confirm");
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
      }
    },
    [settings.feeSpeed, settings.gasAdjustment],
  );

  /**
   * New gas preferences on the confirm screen: the same messages priced
   * again, and nothing else. The pending transaction, a swap's review and its
   * price included, stays the one shown, and a preview that comes back after
   * another one was opened is dropped. No preference is passed: GasFeePrefs
   * saves the new ones before it calls back, through a callback that still
   * holds this render's old ones, and the kernel reads the saved ones.
   */
  async function reprice(current: PendingTx) {
    setBusy(true);
    setError(null);
    try {
      const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
        chainId: current.chainId,
        signerAddress: current.signerAddress,
        msgs: current.msgs,
      });
      setConfirmTx((open) => (open?.pending.msgs === current.msgs ? { ...open, preview: built } : open));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  /**
   * A new price for the reviewed plan itself (its venue denoms, amount and
   * slippage), whatever the form now shows. It lands only on the review it
   * was asked for.
   */
  async function refreshReviewPrice(target: ReviewedSwap) {
    setReviewRequoting(target.id);
    setError(null);
    const next = await requoteSwap(target.requote).catch((caught: unknown) => ({
      quote: null,
      error: caught instanceof Error ? caught.message : String(caught),
      code: null,
    }));
    const price: ReviewPrice = { quote: next.quote, error: next.error, code: next.code, at: Date.now() };
    setConfirmTx((open) =>
      open?.pending.kind === "swap" && open.pending.review.id === target.id
        ? { ...open, pending: { ...open.pending, review: { ...open.pending.review, price } } }
        : open,
    );
    setReviewRequoting((current) => (current === target.id ? null : current));
  }

  /**
   * A new price for a reviewed pool swap, and the messages built again from
   * it: in the pools the floor is a number in the message, so a new price is a
   * new transaction to preview. It lands only on the review it was asked for;
   * when there is no new price, the old one stays, and expires.
   */
  async function refreshPoolReview(target: ReviewedPoolSwap) {
    setReviewRequoting(target.id);
    setError(null);
    try {
      const next = await quotePoolSwap({
        venueInputDenom: target.from.denom,
        venueOutputDenom: target.venueOutputDenom,
        amountBaseUnits: target.fee.net.toString(),
        slippagePercent: target.slippagePercent,
      });
      const at = Date.now();
      if (!next.quote || !next.routes || !next.minOut) {
        setError(
          poolQuoteText(next.code, next.error, target.from, target.to) ??
            "The price could not be refreshed. The one you reviewed has expired.",
        );
        return;
      }
      const { quote: priced, routes: order, minOut } = next;
      const msgs = poolSwapTxMsgs({
        sender: target.signer,
        denom: target.from.denom,
        routes: order,
        minOut,
        fee: target.fee,
        delivery: target.delivery,
      });
      const built = await sendToBackground<TxPreview>("BUILD_TX_PREVIEW", {
        chainId: VENUE_CHAIN_ID,
        signerAddress: target.signer,
        msgs,
      });
      setConfirmTx((open) =>
        open?.pending.kind === "pool" && open.pending.review.id === target.id
          ? {
              pending: {
                ...open.pending,
                msgs,
                review: { ...open.pending.review, price: { quote: priced, at }, routes: order, minOut },
              },
              preview: built,
            }
          : open,
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setReviewRequoting((current) => (current === target.id ? null : current));
    }
  }

  async function signPending() {
    if (!pending || !preview) return;
    if (pending.kind === "swap" || pending.kind === "pool") {
      // The button is off for each of these; checked again here, at the
      // moment of signing, against the clock rather than the last tick.
      const reason = signBlock
        ? signBlock.reason
        : priceExpired(pending.review.price, Date.now())
          ? PRICE_EXPIRED
          : null;
      if (reason) {
        setError(reason);
        return;
      }
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
      } else if (pending.kind === "pool") {
        const signed = pending.review;
        if (signed.delivery) {
          // The transfer after the swap is a route like any other: followed
          // across a popup close, from the one transaction on Osmosis. Its
          // amount is the floor the transfer sends.
          const record: PendingTransfer = {
            kind: "swap",
            txHash: broadcastResult.txhash,
            chainId: pending.chainId,
            plan: signed.delivery.plan,
            amountBaseUnits: signed.minOut,
            label: swapRouteLabel(signed.fee.net, signed.from.identity, signed.to.identity),
            startedAt: Date.now(),
          };
          await savePendingTransfer(record);
          pendingRoutes.reload();
          setTracked(record);
        } else {
          setPoolSent({ txHash: broadcastResult.txhash, review: signed });
        }
        setPhase("sent");
        notifyBroadcastAccepted(toast, broadcastResult.txhash);
      } else {
        // Everything recorded is the review's: the plan signed, its contract
        // and recovery address, and the two tokens as the screen named them.
        // The amount is what the swap message moves (the fee stays behind on
        // the source chain), which is what tracking matches packets on.
        const signed = pending.review;
        const record: PendingTransfer = {
          kind: "swap",
          txHash: broadcastResult.txhash,
          chainId: pending.chainId,
          plan: signed.plan.plan,
          amountBaseUnits: signed.fee.net.toString(),
          swapContract: signed.contract,
          recoveryAddress: signed.recoveryAddress,
          // Activity and the OS notification say this: both tokens and both
          // chains, `10 OSMO (Osmosis) → USDC.axl (Axelar)`.
          label: swapRouteLabel(signed.fee.net, signed.from.identity, signed.to.identity),
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

  /**
   * Price the swap again, build what gets signed against that price, and
   * freeze it all as the review: the From and To rows, the amount and the
   * Zunia fee on it, the plan, the price, and the addresses the plan was made
   * for. Everything here is this render's, the one whose button was pressed.
   */
  /**
   * The pool path's review: price the swap again, take the router's order and
   * floor from that price, build the messages from them and freeze it all,
   * the transfer leg the form planned included.
   */
  async function reviewPoolSwap() {
    if (
      !isPoolPath(path) ||
      !poolPlan ||
      !from ||
      !to ||
      !sourceAccount ||
      amountUnits === null ||
      !swapFee ||
      !destAddress
    ) {
      return;
    }
    const leg = path === "pool-deliver" ? (delivery?.view ?? null) : null;
    if (path === "pool-deliver" && (!leg || delivery?.error)) return;
    setBusy(true);
    setError(null);
    const priced = await refreshPoolQuote();
    const next = priced.quote;
    if (!next?.quote || !next.routes || !next.minOut) {
      setBusy(false);
      setError(
        poolQuoteText(next?.code ?? null, next?.error ?? null, from, to) ??
          "The price could not be refreshed, so the swap was not prepared.",
      );
      return;
    }
    setFromKey(from.key);
    setToKey(to.key);
    reviewCount.current += 1;
    const signer = sourceAccount.address;
    await openConfirm({
      kind: "pool",
      chainId: from.chainId,
      signerAddress: signer,
      msgs: poolSwapTxMsgs({
        sender: signer,
        denom: from.denom,
        routes: next.routes,
        minOut: next.minOut,
        fee: swapFee,
        delivery: leg,
      }),
      title: "Confirm swap",
      review: {
        id: reviewCount.current,
        path,
        from,
        to,
        amountUnits,
        fee: swapFee,
        venueOutputDenom: poolPlan.venueOutputDenom,
        slippagePercent: slippage,
        price: { quote: next.quote, at: priced.at },
        routes: next.routes,
        minOut: next.minOut,
        delivery: leg,
        signer,
        recipient: destAddress,
        planKey,
      },
    });
  }

  /**
   * The first step of a `move-first` swap: Send, opened on this token with
   * Osmosis as the destination. The pair is kept, so Swap opens on it again
   * once the tokens are there.
   */
  function moveToVenue() {
    if (!from || !to || !onMoveToVenue) return;
    const arrives = osmosisDenomFor(from);
    if (arrives) void rememberSwapIntent({ fromKey: `${VENUE_CHAIN_ID}:${arrives}`, toKey: to.key });
    onMoveToVenue({ chainId: from.chainId, denom: from.denom });
  }

  async function reviewSwap() {
    if (isPoolPath(path)) {
      await reviewPoolSwap();
      return;
    }
    const contract = venue.check?.venue?.contractAddress;
    if (
      !plan ||
      !from ||
      !to ||
      !sourceAccount ||
      amountUnits === null ||
      !swapFee ||
      !destAddress ||
      !recoveryAddress ||
      !contract
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    // With the price, this wallet's address on the other chains the route
    // crosses (cached from planning), so the review can say whose every
    // address it names is.
    const crossed = routeChainIds(plan).filter(
      (id) => id !== from.chainId && id !== to.chainId && id !== VENUE_CHAIN_ID,
    );
    const [priced, ownAddresses] = await Promise.all([
      refreshQuote(),
      crossed.length > 0 ? resolveAddresses(crossed) : Promise.resolve({}),
    ]);
    if (!priced.quote || !priced.input) {
      setBusy(false);
      setError(
        quoteBlockText(priced.code, priced.error, from, to, plan) ??
          "The price could not be refreshed, so the swap was not prepared.",
      );
      return;
    }
    // The pair stays the one reviewed: an unpicked To is not picked again
    // under the review when the list reorders, and Back shows the same pair.
    setFromKey(from.key);
    setToKey(to.key);
    reviewCount.current += 1;
    await openConfirm({
      kind: "swap",
      chainId: from.chainId,
      signerAddress: sourceAccount.address,
      // The swap for what is left after the fee, then the fee when one is due.
      msgs: swapTxMsgs({ view: plan, sender: sourceAccount.address, denom: from.denom, fee: swapFee }),
      title: "Confirm swap",
      review: {
        id: reviewCount.current,
        from,
        to,
        amountUnits,
        fee: swapFee,
        plan,
        planKey,
        requote: priced.input,
        price: { quote: priced.quote, error: null, code: null, at: priced.at },
        recipient: destAddress,
        recoveryAddress,
        contract,
        contractLabel: venue.check?.label ?? null,
        ownAddresses,
      },
    });
  }

  /** Copy an exact denom: what the memo names, whole, for checking on an explorer. */
  async function copyDenom(denom: string) {
    try {
      await navigator.clipboard.writeText(denom);
      toast("Denom copied");
    } catch {
      toast("Could not copy the denom", { tone: "danger" });
    }
  }

  /** Copy an address a message pays, whole: the Zunia fee's, for checking on an explorer. */
  async function copyAddress(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      toast("Address copied");
    } catch {
      toast("Could not copy the address", { tone: "danger" });
    }
  }

  // Only a held To can become the From: the From list is what the wallet holds.
  const canFlip = Boolean(from && to && to.held && from.key !== to.key);
  const flipLabel =
    to && !to.held
      ? `Swap the two sides: you hold no ${to.identity.ticker} on ${to.chainName} to sell`
      : "Swap the two sides";
  function flipSides() {
    if (!from || !to || !to.held || from.key === to.key) return;
    setFromKey(to.key);
    setToKey(from.key);
    setManual([]);
    // The typed number carries over only when it can mean the same thing:
    // the new From must take typed amounts.
    setDraft({ text: canTypeAmount(to.identity) ? amount : "", scale: scaleOf(to) });
  }

  function applyMax() {
    if (available === null || !from) return;
    const units = maxSendable(available, feeReserve);
    // Exact digits for any size: the field converts back with the same
    // exponent (0 when unknown), so Max signs the balance and not a rounding.
    setAmount(amountFieldText(units, from.identity));
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

  // A pool swap delivered on Osmosis is one transaction there: followed until
  // the chain includes it, or says why not.
  const poolInclusion = useTxDetail(
    VENUE_CHAIN_ID,
    phase === "sent" && poolSent ? poolSent.txHash : "",
    phase === "sent" && Boolean(poolSent) && liveReads,
    { intervalMs: 2_000, maxRetries: 60 },
  );

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
    });
  }, [tracking.route, openConfirm]);

  const quoteView: SwapQuoteView | null =
    quote && from && to ? swapQuoteView(quote, from, to) : null;
  // The To field holds digits only; a token in base units says so under it.
  const receiveAmount =
    quote && to ? (to.decimalsKnown ? (quoteView?.outputAmount ?? "") : quote.outputAmount) : "";

  /* ---------------------------------------------------------------- *
   * Confirm, a swap in Osmosis's pools
   * ---------------------------------------------------------------- */

  if (phase === "confirm" && pending && preview && poolReview) {
    const target = poolReview;
    const feeChain = chains.find((chain) => chain.chainId === pending.chainId);
    const secondsLeft = Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - target.price.at)) / 1000));
    const back = () => {
      setPhase(tracked ? "sent" : "form");
      setError(null);
    };
    return (
      <ScreenScaffold
        title={pending.title}
        onBack={back}
        footer={
          <ConfirmFooter
            busy={busy}
            label={signBlock?.label ?? null}
            disabled={signBlock !== null}
            onBack={back}
            onSign={() => void signPending()}
          />
        }
      >
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          {/* The review, frozen when this screen opened, read from the messages it signs. */}
          <SwapReviewCard
            summary={poolReviewSummary(target, poolFacts)}
            networkFee={
              <GasFeePrefs
                variant="fact"
                feeAmount={feeCoin?.amount}
                feeDecimals={feeChain?.entry.feeDecimals ?? 6}
                feeSymbol={feeChain ? feeTicker(feeChain.entry) : (feeCoin?.denom ?? "")}
                onChanged={() => void reprice(pending)}
              />
            }
            feeNote={preview.feeNote ?? null}
            clock={
              <QuoteClock
                confirm
                secondsLeft={secondsLeft}
                refreshing={poolRefreshing}
                onRefresh={() => void refreshPoolReview(target)}
              />
            }
          />

          <ReviewProblems problems={poolProblems} />
          <ReviewAlerts
            drift={poolProblems.length === 0 ? poolDrift : null}
            feeShort={feeShort}
            error={error}
            onBack={back}
          />

          <ReviewDisclosure title="Transaction details" hint="pools, addresses, messages">
            <PoolSwapTerms
              framed={false}
              facts={poolFacts}
              review={target}
              problems={[]}
              onCopy={(denom) => void copyDenom(denom)}
              fee={poolFeeMsg}
              transfer={poolTransfer}
              onCopyAddress={(address) => void copyAddress(address)}
            />
            <ExactMessages summaries={preview.preview.summaries} memo={preview.preview.memo} />
          </ReviewDisclosure>
          <ReviewJson json={reviewJson(pending.chainId, pending.msgs, preview)} />
        </div>
      </ScreenScaffold>
    );
  }

  /* ---------------------------------------------------------------- *
   * Sent, a swap in Osmosis's pools delivered on Osmosis
   * ---------------------------------------------------------------- */

  if (phase === "sent" && poolSent) {
    const sent = poolSent.review;
    const confirmed = poolInclusion.detail;
    const waiting =
      liveReads && !confirmed && (poolInclusion.retrying || poolInclusion.loading || poolInclusion.missing);
    const failed = Boolean(confirmed && !confirmed.success);
    const included = Boolean(confirmed?.success);
    const url = explorerTxUrl(VENUE_CHAIN_ID, poolSent.txHash);
    const sentQuote = swapQuoteView(sent.price.quote, sent.from, sent.to);
    const floor = tickerAmount(sent.minOut, boughtIdentity(sent.venueOutputDenom, sent.to), "confirm");
    const done = () => {
      setPhase("form");
      setPoolSent(null);
      setConfirmTx(null);
      setAmount("");
    };
    return (
      <ScreenScaffold
        title={failed ? "Swap failed" : included ? "Swapped" : "Swap sent"}
        footer={
          <div className="flex gap-2">
            {url ? (
              <Button variant="secondary" className="flex-1" asChild>
                <a href={url} target="_blank" rel="noreferrer">
                  View on explorer
                </a>
              </Button>
            ) : null}
            <Button className="flex-1" onClick={done}>
              Done
            </Button>
          </div>
        }
      >
        <div className="flex flex-col items-center px-2 pt-8 text-center">
          {waiting ? (
            <div className="relative flex size-[76px] items-center justify-center">
              <span className="absolute inset-0 rounded-full border border-[var(--z-line)]" />
              <span className="absolute inset-[6px] animate-spin rounded-full border-2 border-transparent border-t-accent" />
              <Spinner className="size-6 text-accent" />
            </div>
          ) : (
            <div
              className={cn(
                "flex size-[76px] items-center justify-center rounded-full",
                failed
                  ? "bg-[var(--z-danger-fill)] text-[var(--z-danger)]"
                  : "bg-[var(--z-success-fill)] text-[var(--z-success)]",
              )}
            >
              {failed ? (
                <span className="text-[28px] font-semibold leading-none">!</span>
              ) : (
                <IconCheck width={32} height={32} />
              )}
            </div>
          )}
          <p className="mt-5 text-[18px] font-semibold tracking-tight text-fg">
            {waiting ? "Confirming" : failed ? "Not swapped" : included ? "Swapped on Osmosis" : "Broadcast accepted"}
          </p>
          <p className="mt-2 max-w-full text-[13px] font-semibold leading-snug tabular-nums text-fg [overflow-wrap:anywhere]">
            {tickerAmount(sent.fee.net, sent.from.identity, "confirm")} → about {sentQuote.outputAmount}{" "}
            {sentQuote.outputSymbol}
          </p>
          <p className="mt-1 max-w-[260px] text-[11px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
            At least {floor}, paid to your address on Osmosis.
          </p>
          <p className="mt-1.5 max-w-[260px] text-[12px] leading-snug text-fg-muted">
            {failed
              ? confirmed?.error ||
                "Osmosis included this transaction with an error. Nothing was swapped, and no Zunia fee was taken."
              : included
                ? "Your Osmosis balance updates in a few seconds."
                : waiting
                  ? "Waiting for Osmosis to include it."
                  : "Osmosis has not confirmed it here yet. Open the explorer to follow it."}
          </p>
          <p className="mt-4 break-all font-mono text-[10px] leading-relaxed text-fg-faint">
            {poolSent.txHash}
          </p>
        </div>
      </ScreenScaffold>
    );
  }

  /* ---------------------------------------------------------------- *
   * Confirm
   * ---------------------------------------------------------------- */

  if (phase === "confirm" && pending && preview) {
    const feeChain = chains.find((chain) => chain.chainId === pending.chainId);
    const back = () => {
      setPhase(tracked ? "sent" : "form");
      setError(null);
    };
    const footer = (
      <ConfirmFooter
        busy={busy}
        label={signBlock?.label ?? null}
        disabled={signBlock !== null}
        onBack={back}
        onSign={() => void signPending()}
      />
    );
    const networkFee = (
      <GasFeePrefs
        variant="fact"
        feeAmount={feeCoin?.amount}
        feeDecimals={feeChain?.entry.feeDecimals ?? 6}
        feeSymbol={feeChain ? feeTicker(feeChain.entry) : (feeCoin?.denom ?? "")}
        onChanged={() => void reprice(pending)}
      />
    );
    const json = reviewJson(pending.chainId, pending.msgs, preview);

    if (!review) {
      // The recovery of a swap's stranded output: one contract call, no price.
      return (
        <ScreenScaffold title={pending.title} onBack={back} footer={footer}>
          <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
            <section className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">Recover</p>
              <p className="mt-1 text-[15px] font-semibold tracking-tight text-fg">Claim stranded swap output</p>
              <p className="mt-0.5 text-[11px] leading-snug text-fg-muted">
                Asks the Osmosis swap contract to pay the output it kept to your recovery address.
              </p>
              <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--z-line)] pt-2.5">
                {networkFee}
                {preview.feeNote ? (
                  <p className="text-right text-[10px] leading-snug text-fg-dim">{preview.feeNote}</p>
                ) : null}
              </div>
            </section>
            <ReviewAlerts drift={null} feeShort={false} error={error} onBack={back} />
            <ReviewDisclosure title="Transaction details" hint="message">
              <ExactMessages summaries={preview.preview.summaries} memo={preview.preview.memo} />
            </ReviewDisclosure>
            <ReviewJson json={json} />
          </div>
        </ScreenScaffold>
      );
    }

    const reviewQuote = review.price.quote;
    const reviewSecondsLeft = Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - review.price.at)) / 1000));
    return (
      <ScreenScaffold title={pending.title} onBack={back} footer={footer}>
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          {/* The review, frozen when this screen opened: never the form's current rows, amount or price. */}
          <SwapReviewCard
            summary={contractReviewSummary(review, reviewFacts)}
            networkFee={networkFee}
            feeNote={preview.feeNote ?? null}
            clock={
              <QuoteClock
                confirm
                secondsLeft={reviewQuote ? reviewSecondsLeft : 0}
                refreshing={reviewRefreshing}
                onRefresh={() => void refreshReviewPrice(review)}
              />
            }
            priceError={reviewPriceError && !reviewRefreshing ? reviewPriceError : null}
          />

          <ReviewProblems problems={reviewProblems} />
          <ReviewAlerts
            drift={reviewProblems.length === 0 ? drift : null}
            feeShort={feeShort}
            error={error}
            onBack={back}
          />

          <ReviewDisclosure title="Transaction details" hint="route, contract, addresses">
            <SwapTerms
              framed={false}
              facts={reviewFacts}
              review={review}
              problems={[]}
              onCopy={(denom) => void copyDenom(denom)}
              fee={reviewFee}
              onCopyAddress={(address) => void copyAddress(address)}
            />
            <ExactMessages summaries={preview.preview.summaries} memo={preview.preview.memo} />
          </ReviewDisclosure>
          <ReviewJson json={json} />
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
              setConfirmTx(null);
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
  // A pool swap delivered elsewhere needs only the leg out of Osmosis.
  const venueLabel = venue.check?.venue?.label ?? VENUE_CHAIN_ID;
  const fallbackHops =
    !routeView && from && to && (path === "contract" || path === "pool-deliver")
      ? [
          ...(path === "contract"
            ? [
                {
                  index: 0,
                  chainId: from.chainId,
                  chainName: from.chainName,
                  counterpartyChainId: VENUE_CHAIN_ID,
                  counterpartyChainName: venueLabel,
                  channelId: "",
                  port: "transfer",
                  kind: "transfer" as const,
                },
              ]
            : []),
          ...(to.chainId === VENUE_CHAIN_ID
            ? []
            : [
                {
                  index: path === "contract" ? 1 : 0,
                  chainId: VENUE_CHAIN_ID,
                  chainName: venueLabel,
                  counterpartyChainId: to.chainId,
                  counterpartyChainName: to.chainName,
                  channelId: "",
                  port: "transfer",
                  kind: path === "contract" ? ("forward" as const) : ("transfer" as const),
                },
              ]),
        ]
      : [];
  // Step one of a `move-first` swap happens in Send, to this wallet's own
  // Osmosis address, which needs Osmosis turned on.
  const venueEnabled = chains.some((chain) => chain.chainId === VENUE_CHAIN_ID);
  const moveBlocked =
    path !== "move-first"
      ? null
      : !onMoveToVenue
        ? "Use Send to move these tokens to your Osmosis address, then swap them here."
        : !venueEnabled
          ? "Turn on Osmosis in Settings → Networks: the tokens move to your Osmosis address first."
          : poolQuote?.code === "no-pool-route"
            ? quoteError
            : null;

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
  // Zunia's own fee, on its own line under the network and pool fees: it
  // comes out of the amount typed, in the token sold.
  const zuniaFee = from ? swapFeeLine(swapFee, from) : null;
  // Exact up to six decimals and cut, never rounded up: Max never reads more
  // than it signs. Without decimals the balance reads in base units.
  const maxLabel =
    from && spendable !== null
      ? `${formatTokenAmount(spendable, from.identity, "picker")}${
          from.decimalsKnown ? ` ${from.identity.ticker}` : ""
        }`
      : null;

  const quoteFooter =
    quote && quoteSecondsLeft !== null ? (
      <QuoteClock
        secondsLeft={quoteSecondsLeft}
        refreshing={refreshing}
        onRefresh={() => void refreshPrice()}
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
        path === "move-first" && from ? (
          <div>
            <Button className="w-full" disabled={moveBlocked !== null || busy} onClick={moveToVenue}>
              Step 1: move {from.identity.ticker} to Osmosis
            </Button>
            <DisabledReason reason={moveBlocked} />
          </div>
        ) : (
        <div>
          <Button className="w-full" disabled={!ready || busy} onClick={() => void reviewSwap()}>
            {busy
              ? "Checking the price…"
              : ready && quoteView
                ? `Swap for ${quoteView.outputAmount} ${quoteView.outputSymbol}`
                : "Swap"}
          </Button>
          <DisabledReason reason={ready ? null : blockedReason} />
          {!ready && failedCheck && !planning ? (
            failedCheck.verdict === "inconclusive" ? (
              <button
                type="button"
                onClick={() => setRetryToken((n) => n + 1)}
                className={cn(
                  "mt-1 text-[10.5px] text-accent underline underline-offset-2",
                  focusRing,
                )}
              >
                Check the channel again
              </button>
            ) : pinnedFailure ? (
              <button
                type="button"
                onClick={() =>
                  setManual((rows) =>
                    rows.filter(
                      (row) =>
                        row.fromChainId !== pinnedFailure.fromChainId ||
                        row.toChainId !== pinnedFailure.toChainId,
                    ),
                  )
                }
                className={cn(
                  "mt-1 text-[10.5px] text-accent underline underline-offset-2",
                  focusRing,
                )}
              >
                Let Zunia pick the channel instead of {pinnedFailure.channelId}
              </button>
            ) : null
          ) : null}
        </div>
        )
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
          fromOptions={sources}
          toOptions={destinations}
          amount={amount}
          receiveAmount={receiveAmount}
          onAmountChange={setAmount}
          onSelectFrom={(key) => {
            setFromKey(key);
            setDraft({ text: "", scale: "" });
            setManual([]);
          }}
          onSelectTo={(key) => {
            setToKey(key);
            setManual([]);
          }}
          onFlip={flipSides}
          flipLabel={flipLabel}
          canFlip={canFlip}
          quoting={planning || refreshing}
          hidden={hidden}
          fromFiat={hidden ? "••••" : pricedFiat(from, amount)}
          toFiat={hidden ? "••••" : pricedFiat(to, quoteView?.outputAmount ?? "")}
          maxLabel={maxLabel}
          onMax={applyMax}
        />

        <div className="flex flex-col gap-1">
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
          {zuniaFee ? (
            // Read as one line: "Zunia fee 0.5% · 0.05 OSMO".
            <p className="flex w-full items-center justify-between gap-2 px-0.5 py-0.5">
              <span className="text-[12px] text-fg-muted">{zuniaFee.label}</span>{" "}
              <span className="min-w-0 text-right font-mono text-[11px] tabular-nums text-fg [overflow-wrap:anywhere]">
                {zuniaFee.value}
              </span>
            </p>
          ) : null}
        </div>

        {quote && quoteSecondsLeft !== null ? (
          <QuoteClock
            secondsLeft={quoteSecondsLeft}
            refreshing={refreshing}
            onRefresh={() => void refreshPrice()}
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
            The Osmosis token list did not load ({osmosis.error}), so only chain coins and your
            own tokens are offered to receive.
          </p>
        ) : null}

        {path === "move-first" && from && to ? (
          <Callout compact tone="neutral" title="Two steps, both on Osmosis">
            <span className="block">
              Osmosis's swap contract has no route from {from.identity.ticker} to {to.identity.ticker}, and
              Osmosis's own pools swap only tokens already on Osmosis.
            </span>
            <span className="mt-1 block">
              1. Move your {from.identity.ticker} from {from.chainName} to your Osmosis address with Send: an
              IBC transfer, with no Zunia fee.
            </span>
            <span className="mt-1 block">
              2. Come back here: Swap opens on your {from.identity.ticker} on Osmosis and swaps it in one
              transaction
              {quoteView ? `, for about ${quoteView.outputAmount} ${quoteView.outputSymbol} at today's price` : ""}.
            </span>
          </Callout>
        ) : null}

        {path === "pool-deliver" && to && poolQuote?.minOut ? (
          <p className="px-0.5 text-[10.5px] leading-snug text-fg-muted">
            In the same transaction,{" "}
            {tickerAmount(poolQuote.minOut, boughtIdentity(poolPlan?.venueOutputDenom ?? "", to), "confirm")} (the
            swap's guaranteed minimum) goes on to your address on {to.chainName}. Anything the swap pays above
            it stays in your Osmosis account.
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
            // A channel refusal stands for a while, so asking again helps only
            // a check that did not finish, which the footer offers itself.
            {...(failedCheck ? {} : { onRetry: () => setRetryToken((n) => n + 1) })}
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
                    : path !== "contract" && poolQuote?.routes
                      ? `Via Osmosis pools: ${poolRouteText(poolQuote.routes)}`
                      : plan
                        ? `Via ${venue.check?.venue?.label ?? "Osmosis"}`
                        : "Route and channels"}
                </span>
                <span className="mt-0.5 block font-mono text-[9.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">
                  {routeView && from && to
                    ? `${from.identity.ticker} on ${from.chainName} → ${to.identity.ticker} on ${to.chainName} · ${routeView.hops.length} hop${routeView.hops.length === 1 ? "" : "s"}`
                    : path === "pool" && from && to
                      ? `${from.identity.ticker} → ${to.identity.ticker}, both on Osmosis · no transfer`
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
                  hops={routeView?.hops ?? []}
                  estimatedDurationSeconds={routeView?.plan.estimatedDurationSeconds ?? null}
                  warnings={routeView?.warnings ?? result?.warnings ?? []}
                  requiresPfm={routeView?.plan.requiresPfm ?? false}
                  requiresIbcHooks={routeView?.plan.requiresIbcHooks ?? false}
                  swapVenueName={venue.check?.venue?.label ?? "Osmosis"}
                  loading={planning && !routeView}
                  error={result?.error ?? (path === "pool-deliver" ? (delivery?.error ?? null) : null)}
                  onRetry={() => setRetryToken((n) => n + 1)}
                  emptyTitle={liveReads ? "No route yet" : "Route planning is off"}
                  emptyDescription={
                    liveReads
                      ? "Pick both assets and an amount, and Zunia will plan the hops."
                      : "Turn on live balances in Settings, Preferences so Zunia can read channels."
                  }
                  footer={
                    routeView ? (
                      <HopChannelList
                        hops={routeView.hops}
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

                {!routeView && fallbackHops.length > 0 ? (
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

        {venue.loading && (path === "contract" || path === null || pathPending) ? (
          <div
            role="status"
            aria-label="Checking the swap contract"
            className="flex flex-col gap-1.5"
          >
            <Skeleton className="h-2 w-3/5" />
            <Skeleton className="h-2 w-2/5" />
          </div>
        ) : null}

        {/* The contract matters on its path only: Osmosis's own pools swap without it. */}
        {venue.check?.reason && (path === "contract" || path === null) ? (
          <Callout tone="danger" title={path === null ? "Cross-chain swaps are off" : "Swaps are off"}>
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

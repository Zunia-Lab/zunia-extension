/**
 * Cross-chain swap: one signature on the source chain, an Osmosis
 * crosschain-swap executed by relayers inside packet processing, and delivery
 * on the destination chain.
 *
 * There is no aggregator and no custodian. The wallet plans the route itself
 * with `@zunialab/interchain` (unwinding a wrapped denom, discovering and
 * verifying channels, composing the ibc-hooks memo with a packet-forward hop
 * before or after when Osmosis is not adjacent) prices the pool against the
 * Osmosis router, and hands one message to `@zunialab/core` to sign: a
 * `MsgTransfer`, or a `MsgExecuteContract` on Osmosis when the funds are
 * already there.
 *
 * Every control on this screen is enabled only when its whole path works, and
 * the first thing that does not work is named on the button. The confirm
 * screen shows a frozen review ({@link ReviewedSwap}) and, read out of the
 * message itself, what the swap contract will do ({@link readSwapMessage}).
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
import { IconCopy, IconSettings } from "./icons";
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
  /** Base units sold. */
  readonly amountUnits: bigint;
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
 * The confirm screen's line under what is bought: where it is delivered and,
 * when the message itself sets one, the floor with its ticker (`Delivered on
 * Axelar · at least 35.56 USDC.axl`). `minimum` is that floor as
 * {@link minimumTerms} reads it out of the message (`exact`); a quote's
 * estimate is never said as "at least", because nothing signed holds the
 * contract to it. A TWAP tolerance has no number, so the line names only
 * the chain, and the terms below say the rule.
 */
export function deliveryLine(to: AssetOption, minimum: string | null): string {
  const floor = minimum ? ` · at least ${minimum}` : "";
  return `${tokenLocationText(to.identity, "delivered")}${floor}`;
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
 * sign ({@link reviewDrift}).
 */
export function swapPlanKey(args: {
  readonly from: Pick<AssetOption, "chainId" | "denom" | "identity">;
  readonly to: Pick<AssetOption, "chainId" | "denom" | "identity">;
  readonly amountUnits: bigint;
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
    args.slippage,
    args.manual.map((m) => `${m.fromChainId}>${m.toChainId}:${m.channelId}`).join("|"),
    args.contract,
    expected.expectedVenueInputDenom ?? "",
    expected.expectedVenueOutputDenom ?? "",
    args.retryToken,
  ].join("~");
}

/**
 * The confirm screen's plain line above the exact message: what leaves, what
 * is bought, and where it arrives. The name joins the ticker when the token
 * arrives away from its origin (`USDC.axl (Axelar USDC)` on Osmosis).
 */
export function swapSentence(amount: string, from: AssetOption, to: AssetOption): string {
  const bought = to.identity;
  const named =
    bought.provenance !== "unknown" && bought.originChainId !== to.chainId
      ? `${bought.ticker} (${bought.name})`
      : bought.ticker;
  return `Sends ${amount} from ${from.chainName} to the Osmosis swap contract, which buys ${named} and delivers it to your address on ${to.chainName}.`;
}

/* -------------------------------------------------------------------------- *
 * What the signed message says
 * -------------------------------------------------------------------------- */

const EXECUTE_CONTRACT_TYPE_URL = "/cosmwasm.wasm.v1.MsgExecuteContract";
const TRANSFER_TYPE_URL = "/ibc.applications.transfer.v1.MsgTransfer";

/** Said, and signing refused, when the message cannot be read whole. */
export const UNREADABLE_SWAP =
  "Zunia could not read what this swap message does, so it will not ask you to sign it.";

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
 * Everything the message does that the review did not say, in the words the
 * confirm screen shows; any of it refuses the signature. Empty when the
 * message spends the reviewed coin and amount, calls the swap contract the
 * venue check verified (a transfer landing on it), buys the reviewed token,
 * pays this wallet's own address, and sets this wallet's recovery address.
 */
export function swapTermsProblems(
  facts: SwapMessageFacts | null,
  review: ReviewedSwap,
  signing: { readonly chainId: string; readonly msgCount: number },
): string[] {
  if (!facts || signing.msgCount !== 1) return [UNREADABLE_SWAP];
  const { from, to } = review;
  const problems: string[] = [];
  if (signing.chainId !== from.chainId || facts.sold.denom !== from.denom) {
    problems.push(
      `The message spends ${shortDenom(facts.sold.denom)}, not the ${from.identity.ticker} on ${from.chainName} you reviewed.`,
    );
  } else if (facts.sold.amount !== review.amountUnits.toString()) {
    problems.push(
      `The message spends ${tickerAmount(facts.sold.amount, from.identity, "confirm")}, not the ${tickerAmount(review.amountUnits, from.identity, "confirm")} you reviewed.`,
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
  return problems;
}

/* -------------------------------------------------------------------------- *
 * Whether the review still stands
 * -------------------------------------------------------------------------- */

/** What the form would sign right now, to check a review against. */
export interface LiveSwap {
  readonly from: AssetOption | undefined;
  readonly to: AssetOption | undefined;
  readonly amountUnits: bigint | null;
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
  review: Pick<ReviewedSwap, "from" | "to" | "amountUnits" | "planKey" | "plan">,
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

/** Every chain a plan's hops leave from or arrive on. */
function routeChainIds(view: RoutePlanView): string[] {
  const ids = new Set<string>();
  for (const hop of view.plan.hops) {
    ids.add(hop.chainId);
    if (hop.counterpartyChainId) ids.add(hop.counterpartyChainId);
  }
  return [...ids];
}

/**
 * One side of the confirm screen's summary: the token's logo with the chain
 * it is on, the amount, and where it is held or delivered. The proven seal is
 * drawn on the logo and said in words to assistive tech.
 */
function HeroSide({ option, amount, line }: { option: AssetOption; amount: string; line: string }) {
  const identity = shownIdentity(option);
  const seal = provenanceLabel(identity);
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <TokenAvatar identity={identity} size={28} locationBadge="always" />
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-semibold leading-tight tracking-[-0.02em] tabular-nums text-fg [overflow-wrap:anywhere]">
          {amount}
        </p>
        <p className="mt-0.5 text-[10.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">
          {line}
        </p>
        {seal ? <span className="sr-only">{seal}</span> : null}
      </div>
    </div>
  );
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

/**
 * What the swap contract will do, read out of the message that is signed
 * ({@link readSwapMessage}), the same for a contract call and a transfer's
 * memo: what is sold and what is bought (the exact denom to copy), whom it
 * pays and whether that is this wallet, the least it may pay out, where the
 * output waits if delivery fails, and the contract. Nothing here comes from
 * the plan or the form. What the message does that the review did not say
 * is listed under it ({@link swapTermsProblems}), and refuses the signature.
 */
export function SwapTerms({
  facts,
  review,
  problems,
  onCopy,
}: {
  facts: SwapMessageFacts | null;
  review: ReviewedSwap;
  problems: readonly string[];
  onCopy: (denom: string) => void;
}) {
  const venueName = findCatalogEntry(VENUE_CHAIN_ID)?.chainName ?? VENUE_CHAIN_ID;
  if (!facts) {
    return (
      <section className={TERMS_BOX}>
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
    <section className={TERMS_BOX}>
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
      </div>
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
  const routes = useXcsRoutes(venue.check?.venue?.contractAddress ?? null);
  const destinations = useMemo(
    () => buyOptions(chains, balances, { from: from ?? null, osmosis: osmosis.assets, routes }),
    [chains, balances, from, osmosis.assets, routes],
  );
  const to = pickTo(destinations, toKey);

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
  /** The id of the review whose price is being fetched again. */
  const [reviewRequoting, setReviewRequoting] = useState<number | null>(null);
  const reviewCount = useRef(0);
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
  const pendingRoutes = usePendingTransfers();
  const resolveAddresses = useResolveAddresses();

  const sourceAccount = chains.find((chain) => chain.chainId === from?.chainId);
  const destAccount = chains.find((chain) => chain.chainId === to?.chainId);

  const amountUnits = amountUnitsOf(from, amount);
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

  // The contract reads `slippage_percentage` on a 0-100 scale and divides by
  // 100 itself, so an out-of-range value is not a wide tolerance, it is a memo
  // the contract rejects. Caught before planning rather than as a build error.
  const slippageOk =
    Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;

  // A To row the gate refused is never planned: the picker already says why,
  // and the planner's live route check would only refuse it again.
  const canPlan =
    liveReads &&
    Boolean(from && to && sourceAccount?.address && destAddress) &&
    to?.disabledReason === null &&
    amountUnits !== null &&
    amountUnits > 0n &&
    !overBalance &&
    Boolean(venue.check?.venue) &&
    Boolean(recoveryAddress) &&
    slippageOk &&
    !(from?.chainId === to?.chainId && from?.denom === to?.denom);

  // The key carries what both tokens on screen are called on Osmosis, from
  // their identities (lib/swap-assets.ts). The planner refuses a route that
  // would trade another variant, one that only shares the ticker, as
  // `venue-denom-mismatch`, so a plan is always checked against the
  // identities on screen.
  const planKey =
    canPlan && from && to && amountUnits !== null
      ? swapPlanKey({
          from,
          to,
          amountUnits,
          slippage,
          manual,
          contract: venue.check?.contractAddress,
          retryToken,
        })
      : "";

  useEffect(() => {
    if (!planKey) return;
    const controller = new AbortController();
    // Debounced: the amount field fires per keystroke and a plan is several
    // LCD round trips.
    const timer = window.setTimeout(() => {
      void planSwap(
        swapPlanRequest({
          from: from!,
          to: to!,
          amountUnits: amountUnits!,
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
  const quoteCode = fresh ? fresh.code : (result?.quoteBlockedCode ?? null);
  const quoteError = quoteBlockText(
    quoteCode,
    fresh ? fresh.error : (result?.quoteBlockedReason ?? null),
    from,
    to,
    plan,
  );
  const quotedAt = fresh ? fresh.at : result ? (settledPlan?.quotedAt ?? null) : null;
  const refreshing = Boolean(planKey) && requotingKey === planKey;

  // The confirm screen counts down its review's own price, whatever the form's is.
  const now = useClock(phase === "confirm" ? review !== null : quotedAt !== null && phase !== "sent");
  const quoteSecondsLeft =
    quotedAt === null
      ? null
      : Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - quotedAt)) / 1000));

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

  // Cheap to work out, so it is not memoized: a manual memo here only kept
  // the compiler from optimizing the screen.
  const blockedReason = ((): string | null => {
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
    if (!from) return "Pick what you are swapping and what you want back.";
    if (!to) {
      if (from.testnet) return TESTNET_REASON;
      return destinations.length > 0
        ? `Nothing can be bought with ${from.identity.ticker} here. Search the To list to see each token and why.`
        : "Pick what you want back.";
    }
    // The gate's reason for a To the user picked before the From changed.
    if (to.disabledReason) return to.disabledReason;
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
    if (from.chainId === VENUE_CHAIN_ID && to.chainId === VENUE_CHAIN_ID) {
      return "Both tokens are already on Osmosis, and this screen swaps by sending to another chain after the pool.";
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

  const ready = blockedReason === null && Boolean(plan && quote && from && sourceAccount);

  // A channel check that failed on the plan's path (lib/route-plan.ts
  // `failedCheck`). One that could not finish can be asked again; one on a
  // channel the user pinned stays theirs, with a way back to the automatic
  // pick. A refused channel the planner chose is already routed around.
  const failedCheck = plan?.failedCheck ?? null;
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

  // What the message that is signed says, read from the message itself.
  const reviewFacts = review ? readSwapMessage(pending?.msgs[0]) : null;
  const reviewProblems =
    review && pending
      ? swapTermsProblems(reviewFacts, review, {
          chainId: pending.chainId,
          msgCount: pending.msgs.length,
        })
      : [];
  // The form keeps planning under the confirm screen; the review stands only
  // while the form would still sign the swap that was reviewed.
  const drift = review
    ? reviewDrift(review, { from, to, amountUnits, planKey, plan, planning, blockedReason })
    : null;
  const reviewRefreshing = review !== null && reviewRequoting === review.id;
  const reviewPriceError = review
    ? quoteBlockText(review.price.code, review.price.error, review.from, review.to, review.plan)
    : null;
  // The chain takes the fee first, out of the reviewed From's live balance.
  const feeCoin = preview?.fee.amount[0];
  const reviewBalance = review
    ? BigInt((sources.find((asset) => asset.key === review.from.key) ?? review.from).amount)
    : null;
  const feeShort =
    review !== null &&
    feeCoin !== undefined &&
    feeCoin.denom === review.from.denom &&
    reviewBalance !== null &&
    reviewBalance - review.amountUnits < BigInt(feeCoin.amount);
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

  async function signPending() {
    if (!pending || !preview) return;
    if (pending.kind === "swap") {
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
      } else {
        // Everything recorded is the review's: the plan signed, its contract
        // and recovery address, and the two tokens as the screen named them.
        const signed = pending.review;
        const record: PendingTransfer = {
          kind: "swap",
          txHash: broadcastResult.txhash,
          chainId: pending.chainId,
          plan: signed.plan.plan,
          amountBaseUnits: signed.amountUnits.toString(),
          swapContract: signed.contract,
          recoveryAddress: signed.recoveryAddress,
          // Activity and the OS notification say this: both tokens and both
          // chains, `10 OSMO (Osmosis) → USDC.axl (Axelar)`.
          label: swapRouteLabel(signed.amountUnits, signed.from.identity, signed.to.identity),
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
   * freeze it all as the review: the From and To rows, the amount, the plan,
   * the price, and the addresses the plan was made for. Everything here is
   * this render's, the one whose button was pressed.
   */
  async function reviewSwap() {
    const contract = venue.check?.venue?.contractAddress;
    if (
      !plan ||
      !from ||
      !to ||
      !sourceAccount ||
      amountUnits === null ||
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
      msgs: [
        buildTransferMsgFromPlan({
          view: plan,
          sender: sourceAccount.address,
          amountBaseUnits: amountUnits.toString(),
        }),
      ],
      title: "Confirm swap",
      review: {
        id: reviewCount.current,
        from,
        to,
        amountUnits,
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
   * Confirm
   * ---------------------------------------------------------------- */

  if (phase === "confirm" && pending && preview) {
    const feeChain = chains.find((chain) => chain.chainId === pending.chainId);
    const reviewQuote = review?.price.quote ?? null;
    const reviewQuoteView = review && reviewQuote ? swapQuoteView(reviewQuote, review.from, review.to) : null;
    const reviewSecondsLeft = review
      ? Math.max(0, Math.ceil((QUOTE_TTL_MS - Math.max(0, now - review.price.at)) / 1000))
      : 0;
    const reviewMinimum =
      review && reviewFacts
        ? minimumTerms(
            reviewFacts.swap,
            boughtIdentity(reviewFacts.swap.outputDenom, review.to),
            reviewQuote,
          )
        : null;
    const back = () => {
      setPhase(tracked ? "sent" : "form");
      setError(null);
    };
    return (
      <ScreenScaffold
        title={pending.title}
        onBack={back}
        footer={
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" disabled={busy} onClick={back}>
              Back
            </Button>
            <Button
              className="flex-1"
              disabled={busy || signBlock !== null}
              onClick={() => void signPending()}
            >
              {busy ? "Signing…" : (signBlock?.label ?? "Sign and send")}
            </Button>
          </div>
        }
      >
        <div className="flex min-w-0 flex-col gap-2 pt-1 [overflow-wrap:anywhere]">
          {review ? (
            // The review, frozen when this screen opened: never the form's
            // current rows, amount or price.
            <section className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5">
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                You swap
              </p>
              <HeroSide
                option={review.from}
                amount={tickerAmount(review.amountUnits, review.from.identity, "confirm")}
                line={tokenLocationText(review.from.identity, "held")}
              />
              <div className="my-1.5 h-px bg-[var(--z-line)]" />
              <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
                For about
              </p>
              <HeroSide
                option={review.to}
                amount={
                  reviewQuoteView
                    ? `${reviewQuoteView.outputAmount} ${reviewQuoteView.outputSymbol}`
                    : NO_VALUE
                }
                line={deliveryLine(review.to, reviewMinimum?.exact ?? null)}
              />
              <div className="mt-2">
                <QuoteClock
                  confirm
                  secondsLeft={reviewQuote ? reviewSecondsLeft : 0}
                  refreshing={reviewRefreshing}
                  onRefresh={() => void refreshReviewPrice(review)}
                />
              </div>
              {reviewPriceError && !reviewRefreshing ? (
                <p className="mt-1.5 text-[10px] leading-snug text-[var(--z-warning)]">
                  {reviewPriceError}
                </p>
              ) : null}
            </section>
          ) : (
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
          )}

          {review && drift && reviewProblems.length === 0 ? (
            <Callout compact tone="warning" title="This review is out of date">
              {drift} Nothing was signed.{" "}
              <button
                type="button"
                onClick={back}
                className={cn("underline underline-offset-2", focusRing)}
              >
                Review the swap again
              </button>
            </Callout>
          ) : null}

          <section className="min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            {/* Plain words first; the kernel's own text, unchanged, is what gets signed. */}
            <p className="min-w-0 text-[11.5px] leading-snug text-fg [overflow-wrap:anywhere]">
              {review
                ? swapSentence(
                    tickerAmount(review.amountUnits, review.from.identity, "confirm"),
                    review.from,
                    review.to,
                  )
                : "Asks the Osmosis swap contract to pay the output it kept to your recovery address."}
            </p>
            <p className="mt-1.5 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
              Exact message
            </p>
            {preview.preview.summaries.map((line, index) => (
              <p
                key={index}
                className="mt-0.5 min-w-0 break-words font-mono text-[10.5px] leading-snug text-fg [overflow-wrap:anywhere]"
              >
                {line}
              </p>
            ))}
          </section>

          {review ? (
            <SwapTerms
              facts={reviewFacts}
              review={review}
              problems={reviewProblems}
              onCopy={(denom) => void copyDenom(denom)}
            />
          ) : null}

          <section className="min-w-0 rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
            <GasFeePrefs
              feeAmount={feeCoin?.amount}
              feeDecimals={feeChain?.entry.feeDecimals ?? 6}
              feeSymbol={feeChain ? feeTicker(feeChain.entry) : (feeCoin?.denom ?? "")}
              onChanged={() => void reprice(pending)}
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
            The Osmosis token list did not load ({osmosis.error}), so only chain coins and your
            own tokens are offered to receive.
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
                    : plan
                      ? `Via ${venue.check?.venue?.label ?? "Osmosis"}`
                      : "Route and channels"}
                </span>
                <span className="mt-0.5 block font-mono text-[9.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">
                  {plan && from && to
                    ? `${from.identity.ticker} on ${from.chainName} → ${to.identity.ticker} on ${to.chainName} · ${plan.hops.length} hop${plan.hops.length === 1 ? "" : "s"}`
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

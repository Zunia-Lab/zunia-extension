/**
 * Amino messages in the kernel's words.
 *
 * A dApp picks the sign mode, not the user. In direct mode the kernel decodes the bytes and
 * writes the prompt (zunia-core crates/cosmos/src/decode.rs, `DecodedMsg::summary`). In Amino
 * mode the prompt was this extension's to write, and for anything but a send or a contract call
 * it said "Message cosmos-sdk/MsgDelegate", or refused an Osmosis swap outright because its type
 * has no "Msg" in it. {@link describeAminoMsg} writes, for the Amino form of a message, the
 * sentence the kernel writes for its direct form, so a transaction reads the same in both modes:
 *
 * - `cosmos-sdk/MsgDelegate`, `MsgUndelegate`, `MsgBeginRedelegate` and
 *   `MsgWithdrawDelegationReward`;
 * - `cosmos-sdk/MsgVote` and gov v1's `cosmos-sdk/v1/MsgVote`;
 * - `cosmos-sdk/MsgTransfer`, whose receiver is the message's recipient, with the kernel's
 *   detail for it: channel, receiver, token and packet memo;
 * - the Osmosis poolmanager swaps `osmosis/poolmanager/swap-exact-amount-in`,
 *   `split-amount-in`, `swap-exact-amount-out` and `split-amount-out`;
 * - the messages a dApp builds that the kernel reads since 0.1.2 (zunia-core dapp.rs):
 *   concentrated liquidity, classic pools and their swaps, lockups, superfluid staking, a
 *   multi-send, cancelling an unbonding, the withdraw address, commission, the community pool,
 *   deposits and weighted votes, revoking an authorization or an allowance, and the CosmWasm
 *   instantiate, migrate and admin messages. Their sentences, recipients and details are the
 *   kernel's; see {@link DAPP_DESCRIBERS}.
 *
 * Only a message in the shape the chain's Amino JSON gives it is described. The checks are the
 * kernel's (`is_complete` in decode.rs, the swap rules in msg.rs), and stricter where the kernel
 * shows bytes as they are: every amount is a canonical integer string, every denom is valid,
 * every account and validator is a 20-byte bech32 address, every route has pools and no pool is
 * 0. Anything else returns null and the caller keeps the generic summary it always gave, which
 * still gates a type without "Msg" in it. The messages that hand control of the account to
 * someone else or run nested messages (`cosmos-sdk/MsgGrant`, `MsgExec`, `MsgGrantAllowance`,
 * `wasm/MsgStoreCode`, a proposal submission, the Osmosis smart-account messages) are not read
 * in either mode, so they get the generic line, gated, and signing them takes the blind-signing
 * opt-in ({@link isGatedAminoType}), as does one of the types above in a shape it refuses. A generic line is honest; a confident sentence about a
 * document the wallet could not fully read is a claim the user acts on.
 *
 * lib/__tests__/amino-summary.test.ts holds every sentence here to the real kernel's, over
 * reference documents made by CosmJS and osmojs.
 */

import { bech32 } from "@scure/base";

import type { DecodedTxMessage } from "./kernel";

/** The kernel's bounds on a swap (zunia-core msg.rs `MAX_SWAP_HOPS`, `MAX_SWAP_SPLITS`). */
const MAX_SWAP_HOPS = 8;
const MAX_SWAP_SPLITS = 16;

const U64_MAX = 2n ** 64n - 1n;

type Fields = Record<string, unknown>;
type Description = Omit<DecodedTxMessage, "typeUrl">;
type Coin = { readonly denom: string; readonly amount: string };

function fields(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

/**
 * A `math.Int` as Amino writes it: digits only, no leading zero, at most 78 of them (256 bits).
 * zunia-core `validate_amount`. `"007"` and `"7"` are the same number but not the same bytes.
 */
function amount(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d{0,77})$/.test(value) ? value : null;
}

/** An amount above zero: what a swap's limits and shares must be, or it fills at any price. */
function positive(value: unknown): string | null {
  const text = amount(value);
  return text !== null && text !== "0" ? text : null;
}

/** A u64, which Amino writes as a decimal string. */
function uint64(value: unknown): string | null {
  const text = amount(value);
  return text !== null && BigInt(text) <= U64_MAX ? text : null;
}

/** A pool or proposal id. Neither 0 exists, so a 0 means the field was never set. */
function id(value: unknown): string | null {
  const text = uint64(value);
  return text !== null && text !== "0" ? text : null;
}

/** zunia-core `validate_denom`: 3 to 128 characters, a letter, then letters, digits and `/ : . _ -`. */
function denom(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9/:._-]{2,127}$/.test(value) ? value : null;
}

function coin(value: unknown, aboveZero = false): Coin | null {
  const raw = fields(value);
  if (!raw) return null;
  const name = denom(raw.denom);
  const units = aboveZero ? positive(raw.amount) : amount(raw.amount);
  return name !== null && units !== null ? { denom: name, amount: units } : null;
}

/**
 * A coin in the spelling the chain's Amino JSON gives it, a valid denom and a canonical amount,
 * or null. What a fee or a contract call's coins must be before the prompt names them.
 */
export const aminoCoin = (value: unknown): Coin | null => coin(value);

/** A u64 in the spelling the chain's Amino JSON gives it (a gas limit), or null. */
export const aminoUint64 = (value: unknown): string | null => uint64(value);

/** A coin as the kernel writes it in a sentence: `1000000 uatom`. */
const coinText = (value: Coin): string => `${value.amount} ${value.denom}`;

/**
 * An address a user can compare by eye: printable ASCII, no space, no control or bidi character.
 * zunia-core `is_renderable_address`. An IBC receiver is held to this alone: it lives on another
 * chain, and packet-forward and EVM receivers are not always bech32.
 */
function renderable(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return null;
  }
  return value;
}

/** An account or a validator of the chain signing: 20 bytes of bech32 (zunia-core `decode_bech32`). */
function account(value: unknown): string | null {
  const text = renderable(value);
  if (text === null) return null;
  try {
    const { words } = bech32.decode(text as `${string}1${string}`);
    return bech32.fromWords(words).length === 20 ? text : null;
  } catch {
    return null;
  }
}

function delegation(verb: "Delegate" | "Undelegate", preposition: "to" | "from") {
  return (value: Fields): Description | null => {
    const validator = account(value.validator_address);
    const staked = coin(value.amount);
    return account(value.delegator_address) && validator && staked
      ? { summary: `${verb} ${coinText(staked)} ${preposition} ${validator}` }
      : null;
  };
}

function redelegation(value: Fields): Description | null {
  const from = account(value.validator_src_address);
  const to = account(value.validator_dst_address);
  const staked = coin(value.amount);
  return account(value.delegator_address) && from && to && staked
    ? { summary: `Redelegate ${coinText(staked)} from ${from} to ${to}` }
    : null;
}

function rewardClaim(value: Fields): Description | null {
  const validator = account(value.validator_address);
  return account(value.delegator_address) && validator ? { summary: `Claim staking rewards from ${validator}` } : null;
}

/**
 * `VoteOption` 1 to 4 under the kernel's labels (zunia-core msg.rs `VoteOption::label`). Amino
 * writes the number, as the chain does when it rebuilds the document; the enum name is read
 * too, since dApps written before that was settled send it.
 */
const VOTE_LABELS: ReadonlyMap<unknown, string> = new Map<unknown, string>([
  [1, "Yes"],
  ["VOTE_OPTION_YES", "Yes"],
  [2, "Abstain"],
  ["VOTE_OPTION_ABSTAIN", "Abstain"],
  [3, "No"],
  ["VOTE_OPTION_NO", "No"],
  [4, "No with veto"],
  ["VOTE_OPTION_NO_WITH_VETO", "No with veto"],
]);

/** gov v1beta1, or gov v1, which adds a `metadata` string the prompt does not show. */
function vote(withMetadata: boolean) {
  return (value: Fields): Description | null => {
    const proposal = id(value.proposal_id);
    if (!proposal || !account(value.voter)) return null;
    if ("metadata" in value && !(withMetadata && typeof value.metadata === "string")) return null;
    const label = VOTE_LABELS.get(value.option);
    // An option outside the enum is named as such and gated, never read as a default: "Yes" by
    // mistake is the worst reading there is. The kernel does the same for the direct form.
    return label
      ? { summary: `Vote ${label} on proposal ${proposal}` }
      : { summary: `Vote on proposal ${proposal} with an unrecognised option`, unknown: true };
  };
}

/**
 * The timeout fields of a transfer are not in the sentence, but they are signed, and the chain
 * reads them: a height or a timestamp it could not read is not a transfer this prompt describes.
 */
function readableTimeout(value: Fields): boolean {
  const height = value.timeout_height === undefined ? {} : fields(value.timeout_height);
  if (!height) return false;
  const counters = [height.revision_number, height.revision_height, value.timeout_timestamp];
  return counters.every((counter) => counter === undefined || uint64(counter) !== null);
}

function transfer(value: Fields): Description | null {
  const channel = renderable(value.source_channel);
  const token = coin(value.token);
  const receiver = renderable(value.receiver);
  if (!renderable(value.source_port) || !channel || !token || !account(value.sender) || !receiver) return null;
  const memo = value.memo ?? "";
  if (!readableTimeout(value) || typeof memo !== "string") return null;
  return {
    summary: `IBC transfer ${coinText(token)} to ${receiver} over ${channel}`,
    recipient: receiver,
    // The kernel's detail for the direct form. The packet memo is not in the sentence, and
    // packet-forward or ibc-hooks instructions in it can move the tokens on from the receiver.
    detail: {
      kind: "ibc-transfer",
      sourceChannel: channel,
      receiver,
      token: { denom: token.denom, amount: token.amount },
      memo,
    },
  };
}

interface Hop {
  readonly pool: string;
  /** The denom out of the pool for an exact-in hop, into it for an exact-out hop. */
  readonly denom: string;
}

/** A route: 1 to {@link MAX_SWAP_HOPS} pools, no pool 0, every denom valid. */
function route(value: unknown, denomField: "token_out_denom" | "token_in_denom"): Hop[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SWAP_HOPS) return null;
  const hops: Hop[] = [];
  for (const item of value) {
    const hop = fields(item);
    const pool = hop && id(hop.pool_id);
    const name = hop && denom(hop[denomField]);
    if (!pool || !name) return null;
    hops.push({ pool, denom: name });
  }
  return hops;
}

const poolIds = (hops: readonly Hop[]): string => hops.map((hop) => hop.pool).join(" → ");

/** `pool 3586`, or `pools 1 → 3586` (zunia-core msg.rs `describe_hops`). */
const through = (hops: readonly Hop[]): string => `${hops.length === 1 ? "pool" : "pools"} ${poolIds(hops)}`;

interface Leg {
  readonly hops: Hop[];
  /** The leg's part of the input (exact-in) or of the output (exact-out). */
  readonly share: string;
}

/** `2 routes (pools 3498; 3586)` (zunia-core msg.rs `describe_split`). */
function throughSplit(legs: readonly Leg[]): string {
  const pools = legs.reduce((count, leg) => count + leg.hops.length, 0);
  return `${legs.length} ${legs.length === 1 ? "route" : "routes"} (${pools === 1 ? "pool" : "pools"} ${legs
    .map((leg) => poolIds(leg.hops))
    .join("; ")})`;
}

/**
 * A split swap's legs: 1 to {@link MAX_SWAP_SPLITS}, each a route with a share above zero, all
 * agreeing on the denom `end` reads (what comes out for exact-in, what goes in for exact-out),
 * and no two over the same pools, which the chain refuses as duplicate routes. zunia-core
 * `validate_split_route_swap_exact_amount_in` and `_out`.
 */
function split(
  value: unknown,
  denomField: "token_out_denom" | "token_in_denom",
  shareField: "token_in_amount" | "token_out_amount",
  end: (hops: readonly Hop[]) => string,
): Leg[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SWAP_SPLITS) return null;
  const legs: Leg[] = [];
  for (const item of value) {
    const leg = fields(item);
    const hops = leg && route(leg.pools, denomField);
    const share = leg && positive(leg[shareField]);
    if (!hops || !share) return null;
    const first = legs[0];
    if (first && end(first.hops) !== end(hops)) return null;
    const pools = JSON.stringify(hops);
    if (legs.some((earlier) => JSON.stringify(earlier.hops) === pools)) return null;
    legs.push({ hops, share });
  }
  return legs;
}

/** The legs' shares added up, exactly: a split swap carries no total of its own. */
const total = (legs: readonly Leg[]): string => legs.reduce((sum, leg) => sum + BigInt(leg.share), 0n).toString();

const lastDenom = (hops: readonly Hop[]): string => hops[hops.length - 1]?.denom ?? "";
const firstDenom = (hops: readonly Hop[]): string => hops[0]?.denom ?? "";

function swapExactIn(value: Fields): Description | null {
  const hops = route(value.routes, "token_out_denom");
  const tokenIn = coin(value.token_in, true);
  const minimum = positive(value.token_out_min_amount);
  if (!account(value.sender) || !hops || !tokenIn || !minimum) return null;
  return { summary: `Swap ${coinText(tokenIn)} for at least ${minimum} ${lastDenom(hops)} through ${through(hops)}` };
}

function splitExactIn(value: Fields): Description | null {
  const legs = split(value.routes, "token_out_denom", "token_in_amount", lastDenom);
  const denomIn = denom(value.token_in_denom);
  const minimum = positive(value.token_out_min_amount);
  if (!account(value.sender) || !legs || !denomIn || !minimum) return null;
  const out = lastDenom(legs[0]?.hops ?? []);
  return { summary: `Swap ${total(legs)} ${denomIn} for at least ${minimum} ${out} through ${throughSplit(legs)}` };
}

// Exact-out names its ceiling first: it is the only price limit the message carries, as the
// floor is for exact-in.
function swapExactOut(value: Fields): Description | null {
  const hops = route(value.routes, "token_in_denom");
  const maximum = positive(value.token_in_max_amount);
  const tokenOut = coin(value.token_out, true);
  if (!account(value.sender) || !hops || !maximum || !tokenOut) return null;
  return {
    summary: `Swap at most ${maximum} ${firstDenom(hops)} for exactly ${coinText(tokenOut)} through ${through(hops)}`,
  };
}

function splitExactOut(value: Fields): Description | null {
  const legs = split(value.routes, "token_in_denom", "token_out_amount", firstDenom);
  const denomOut = denom(value.token_out_denom);
  const maximum = positive(value.token_in_max_amount);
  if (!account(value.sender) || !legs || !denomOut || !maximum) return null;
  const spent = firstDenom(legs[0]?.hops ?? []);
  return {
    summary: `Swap at most ${maximum} ${spent} for exactly ${total(legs)} ${denomOut} through ${throughSplit(legs)}`,
  };
}

/* -------------------------------------------------------------------------- *
 * dApp messages (zunia-core crates/cosmos/src/dapp.rs)
 * -------------------------------------------------------------------------- */

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
/** `1.0` as a `LegacyDec` scaled by 10^18. */
const DEC_ONE = 10n ** 18n;

/**
 * An `int64` Amino writes as a decimal string (a tick, a height), canonical. Amino omits a zero,
 * so a missing field is `"0"`.
 */
function int64(value: unknown): string | null {
  if (value === undefined) return "0";
  if (typeof value !== "string" || !/^(?:0|-?[1-9]\d*)$/.test(value)) return null;
  const number = BigInt(value);
  return number >= I64_MIN && number <= I64_MAX ? value : null;
}

/** A u64 Amino omits when it is 0: missing reads as `"0"`. */
function uint64OrZero(value: unknown): string | null {
  return value === undefined ? "0" : uint64(value);
}

/** An amount Amino always writes (`math.Int`): missing is not a number. */
const intAmount = amount;

/** zunia-core `good_coin`: a valid denom and a canonical amount, non-zero unless `allowZero`. */
const goodCoin = (value: unknown, allowZero = false): Coin | null => coin(value, !allowZero);

/**
 * zunia-core `good_coins`: between `min` and `max` coins, each valid and non-zero, no denom
 * twice. Amino omits an empty list, so a missing one is empty.
 */
function goodCoins(value: unknown, min: number, max: number): Coin[] | null {
  if (value === undefined) return min === 0 ? [] : null;
  if (!Array.isArray(value) || value.length < min || value.length > max) return null;
  const coins: Coin[] = [];
  for (const item of value) {
    const checked = goodCoin(item);
    if (!checked || coins.some((earlier) => earlier.denom === checked.denom)) return null;
    coins.push(checked);
  }
  return coins;
}

const coinsText = (coins: readonly Coin[]): string => coins.map(coinText).join(", ");

/** The bech32 prefix and payload length of an address, lower-cased as the kernel does. */
function bech32Parts(text: string): { prefix: string; bytes: number } | null {
  try {
    const { prefix, words } = bech32.decode(text as `${string}1${string}`);
    return { prefix: prefix.toLowerCase(), bytes: bech32.fromWords(words).length };
  } catch {
    return null;
  }
}

/**
 * An address that may be module-derived under the signer's prefix, a contract, a recipient, a
 * new owner or admin: 20 or 32 bytes, and the signer's prefix (zunia-core `validate_contract_address`).
 */
function derived(value: unknown, signer: string): string | null {
  const text = renderable(value);
  const parts = text === null ? null : bech32Parts(text);
  const own = bech32Parts(signer);
  return text !== null && parts && own && parts.prefix === own.prefix && (parts.bytes === 20 || parts.bytes === 32)
    ? text
    : null;
}

/** `position 5`, or `positions 5, 6, 7` (zunia-core dapp.rs `positions_text`). */
const positionsText = (ids: readonly string[]): string =>
  `${ids.length === 1 ? "position" : "positions"} ${ids.join(", ")}`;

/** zunia-core `good_ids`: at least one id, none of them 0, none twice. */
function positionIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const ids: string[] = [];
  for (const item of value) {
    const checked = id(item);
    if (!checked || ids.includes(checked)) return null;
    ids.push(checked);
  }
  return ids;
}

/** The message's own signer field, 20 bytes of bech32. */
const signerOf = (value: Fields, key = "sender"): string | null => account(value[key]);

/** `sender` and a validator, the two accounts of a superfluid delegation. */
function delegator(value: Fields): { sender: string; validator: string } | null {
  const sender = signerOf(value);
  const validator = account(value.val_addr);
  return sender && validator ? { sender, validator } : null;
}

function createPosition(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const lower = int64(value.lower_tick);
  const upper = int64(value.upper_tick);
  const provided = goodCoins(value.tokens_provided, 1, 2);
  const min0 = intAmount(value.token_min_amount0);
  const min1 = intAmount(value.token_min_amount1);
  if (!signerOf(value) || !pool || lower === null || upper === null || BigInt(lower) >= BigInt(upper)) return null;
  if (!provided || min0 === null || min1 === null) return null;
  return {
    summary: `Create a concentrated liquidity position in pool ${pool} between ticks ${lower} and ${upper} with ${coinsText(provided)}, accepting at least ${min0} of the pool's token0 and ${min1} of its token1`,
  };
}

function addToPosition(value: Fields): Description | null {
  const position = id(value.position_id);
  const amount0 = intAmount(value.amount0);
  const amount1 = intAmount(value.amount1);
  const min0 = intAmount(value.token_min_amount0);
  const min1 = intAmount(value.token_min_amount1);
  if (!signerOf(value) || !position || amount0 === null || amount1 === null || min0 === null || min1 === null) {
    return null;
  }
  if (amount0 === "0" && amount1 === "0") return null;
  return {
    summary: `Add ${amount0} of the pool's token0 and ${amount1} of its token1 to concentrated liquidity position ${position}, using at least ${min0} and ${min1} of them; the message names no denoms`,
  };
}

/** An 18-place decimal as the LCD shows a `LegacyDec`: `5.000000000000000000`. */
const isDecDisplay = (value: unknown): value is string =>
  typeof value === "string" && /^\d+\.\d{18}$/.test(value);

function withdrawPosition(value: Fields): Description | null {
  const position = id(value.position_id);
  const liquidity = value.liquidity_amount;
  // Zero liquidity withdraws nothing.
  if (!signerOf(value) || !position || !isDecDisplay(liquidity) || /^[0.]*$/.test(liquidity)) return null;
  return {
    summary: `Withdraw ${liquidity} liquidity units (the message names no denom) from concentrated liquidity position ${position}`,
  };
}

function collect(what: "spread rewards" | "incentives") {
  return (value: Fields): Description | null => {
    const ids = positionIds(value.position_ids);
    return signerOf(value) && ids ? { summary: `Collect the ${what} of concentrated liquidity ${positionsText(ids)}` } : null;
  };
}

function transferPositions(value: Fields): Description | null {
  const ids = positionIds(value.position_ids);
  const sender = signerOf(value);
  const newOwner = sender ? derived(value.new_owner, sender) : null;
  if (!sender || !ids || !newOwner) return null;
  return {
    summary: `Transfer concentrated liquidity ${positionsText(ids)} to ${newOwner}`,
    recipient: newOwner,
  };
}

function joinPool(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const shares = positive(value.share_out_amount);
  const maxs = goodCoins(value.token_in_maxs, 1, 64);
  if (!signerOf(value) || !pool || !shares || !maxs) return null;
  return {
    summary: `Join pool ${pool} for exactly ${shares} gamm/pool/${pool} shares, paying at most ${coinsText(maxs)}`,
  };
}

function exitPool(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const shares = positive(value.share_in_amount);
  const mins = goodCoins(value.token_out_mins, 0, 64);
  if (!signerOf(value) || !pool || !shares || !mins) return null;
  return {
    summary: `Exit pool ${pool} by burning ${shares} gamm/pool/${pool} shares, ${
      mins.length === 0 ? "with no minimum amount out" : `receiving at least ${coinsText(mins)}`
    }`,
  };
}

function joinSwapExternAmountIn(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const tokenIn = goodCoin(value.token_in);
  const minimum = positive(value.share_out_min_amount);
  if (!signerOf(value) || !pool || !tokenIn || !minimum) return null;
  return {
    summary: `Join pool ${pool} with ${coinText(tokenIn)} alone, receiving at least ${minimum} gamm/pool/${pool} shares`,
  };
}

function exitSwapShareAmountIn(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const tokenOut = denom(value.token_out_denom);
  const shares = positive(value.share_in_amount);
  const minimum = positive(value.token_out_min_amount);
  if (!signerOf(value) || !pool || !tokenOut || !shares || !minimum) return null;
  return {
    summary: `Exit pool ${pool} by burning ${shares} gamm/pool/${pool} shares for ${tokenOut} alone, receiving at least ${minimum} ${tokenOut}`,
  };
}

function joinSwapShareAmountOut(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const tokenIn = denom(value.token_in_denom);
  const shares = positive(value.share_out_amount);
  const maximum = positive(value.token_in_max_amount);
  if (!signerOf(value) || !pool || !tokenIn || !shares || !maximum) return null;
  return {
    summary: `Join pool ${pool} with ${tokenIn} alone, paying at most ${maximum} ${tokenIn} for exactly ${shares} gamm/pool/${pool} shares`,
  };
}

function exitSwapExternAmountOut(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const tokenOut = goodCoin(value.token_out);
  const maximum = positive(value.share_in_max_amount);
  if (!signerOf(value) || !pool || !tokenOut || !maximum) return null;
  return {
    summary: `Exit pool ${pool} receiving exactly ${coinText(tokenOut)} alone, burning at most ${maximum} gamm/pool/${pool} shares`,
  };
}

const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * A lock's duration in whole seconds. Amino writes a `time.Duration` as nanoseconds in a
 * string; the kernel refuses a duration that is not whole seconds, and so does this.
 */
function durationSeconds(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const nanos = BigInt(value);
  return nanos <= I64_MAX && nanos % NANOS_PER_SECOND === 0n ? (nanos / NANOS_PER_SECOND).toString() : null;
}

function lockTokens(value: Fields): Description | null {
  const seconds = durationSeconds(value.duration);
  const coins = goodCoins(value.coins, 1, 64);
  return signerOf(value, "owner") && seconds && coins
    ? { summary: `Lock ${coinsText(coins)} for ${seconds} seconds` }
    : null;
}

function beginUnlocking(value: Fields): Description | null {
  const lock = id(value.ID);
  const coins = goodCoins(value.coins, 0, 64);
  if (!signerOf(value, "owner") || !lock || !coins) return null;
  return {
    summary:
      coins.length === 0
        ? `Begin unlocking all the tokens of lock ${lock}`
        : `Begin unlocking ${coinsText(coins)} from lock ${lock}`,
  };
}

function beginUnlockingAll(value: Fields): Description | null {
  const owner = signerOf(value, "owner");
  return owner ? { summary: `Begin unlocking every lock owned by ${owner}` } : null;
}

function superfluidDelegate(value: Fields): Description | null {
  const lock = id(value.lock_id);
  const parties = delegator(value);
  return lock && parties ? { summary: `Superfluid-delegate lock ${lock} to validator ${parties.validator}` } : null;
}

function lockOnly(verb: string) {
  return (value: Fields): Description | null => {
    const lock = id(value.lock_id);
    return signerOf(value) && lock ? { summary: `${verb} lock ${lock}` } : null;
  };
}

function lockAndSuperfluidDelegate(value: Fields): Description | null {
  const coins = goodCoins(value.coins, 1, 64);
  const parties = delegator(value);
  return coins && parties
    ? { summary: `Lock ${coinsText(coins)} and superfluid-delegate it to validator ${parties.validator}` }
    : null;
}

function superfluidUndelegateAndUnbondLock(value: Fields): Description | null {
  const lock = id(value.lock_id);
  const unbonded = goodCoin(value.coin);
  return signerOf(value) && lock && unbonded
    ? { summary: `Superfluid-undelegate lock ${lock} and unbond ${coinText(unbonded)} from it` }
    : null;
}

function fullRangeAndSuperfluidDelegate(value: Fields): Description | null {
  const pool = id(value.pool_id);
  const coins = goodCoins(value.coins, 1, 2);
  const parties = delegator(value);
  return pool && coins && parties
    ? {
        summary: `Create a full-range concentrated liquidity position in pool ${pool} with ${coinsText(coins)} and superfluid-delegate it to validator ${parties.validator}`,
      }
    : null;
}

function addToSuperfluidPosition(value: Fields): Description | null {
  const position = id(value.position_id);
  const first = goodCoin(value.token_desired0, true);
  const second = goodCoin(value.token_desired1, true);
  if (!signerOf(value) || !position || !first || !second) return null;
  if (first.amount === "0" && second.amount === "0") return null;
  return {
    summary: `Add ${coinText(first)} and ${coinText(second)} to superfluid concentrated liquidity position ${position}`,
  };
}

interface MultiSendEntry {
  readonly address: string;
  readonly coins: Coin[];
}

/** An input or an output: its address (as `account` or `derived` reads it) and 1 to 64 coins. */
function multiSendEntries(
  value: unknown,
  read: (address: unknown) => string | null,
): MultiSendEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: MultiSendEntry[] = [];
  for (const item of value) {
    const entry = fields(item);
    const address = entry ? read(entry.address) : null;
    const coins = entry ? goodCoins(entry.coins, 1, 64) : null;
    if (!address || !coins) return null;
    entries.push({ address, coins });
  }
  return entries;
}

/** Each denom's total across the entries, or null past the 256-bit ceiling of an amount. */
function totals(entries: readonly MultiSendEntry[]): Map<string, bigint> | null {
  const sums = new Map<string, bigint>();
  for (const entry of entries) {
    for (const item of entry.coins) {
      const sum = (sums.get(item.denom) ?? 0n) + BigInt(item.amount);
      if (sum.toString().length > 78) return null;
      sums.set(item.denom, sum);
    }
  }
  return sums;
}

function multiSend(value: Fields): Description | null {
  const inputs = multiSendEntries(value.inputs, account);
  const first = inputs?.[0];
  const outputs = first ? multiSendEntries(value.outputs, (address) => derived(address, first.address)) : null;
  if (!inputs || !outputs || inputs.length === 0 || outputs.length === 0) return null;
  const paid = totals(inputs);
  const received = totals(outputs);
  if (!paid || !received || paid.size !== received.size) return null;
  for (const [name, sum] of paid) if (received.get(name) !== sum) return null;

  // The one address outside the senders that gets paid, when there is exactly one.
  const outside = outputs.map((out) => out.address).filter((address) => inputs.every((input) => input.address !== address));
  const recipient = outside.length > 0 && outside.every((address) => address === outside[0]) ? outside[0] : undefined;
  const entry = (list: readonly MultiSendEntry[]) =>
    list.map(({ address, coins }) => ({ address, coins: coins.map(({ denom: name, amount: units }) => ({ denom: name, amount: units })) }));
  return {
    summary: `Send ${outputs.map((out) => `${coinsText(out.coins)} to ${out.address}`).join("; ")} in one multi-send paid by ${inputs.map((input) => `${input.address} (${coinsText(input.coins)})`).join("; ")}`,
    ...(recipient ? { recipient } : {}),
    detail: { kind: "multi-send", inputs: entry(inputs), outputs: entry(outputs) },
  };
}

function cancelUnbonding(value: Fields): Description | null {
  const validator = account(value.validator_address);
  const staked = goodCoin(value.amount);
  const height = int64(value.creation_height);
  if (!account(value.delegator_address) || !validator || !staked || height === null || BigInt(height) <= 0n) return null;
  return {
    summary: `Cancel the unbonding of ${coinText(staked)} from ${validator}, created at height ${height}`,
  };
}

function setWithdrawAddress(value: Fields): Description | null {
  const delegatorAddress = account(value.delegator_address);
  const to = delegatorAddress ? derived(value.withdraw_address, delegatorAddress) : null;
  return to ? { summary: `Set the address that receives your staking rewards to ${to}`, recipient: to } : null;
}

function withdrawCommission(value: Fields): Description | null {
  const validator = account(value.validator_address);
  return validator ? { summary: `Withdraw the commission of validator ${validator}` } : null;
}

function fundCommunityPool(value: Fields): Description | null {
  const coins = goodCoins(value.amount, 1, 64);
  return account(value.depositor) && coins ? { summary: `Fund the community pool with ${coinsText(coins)}` } : null;
}

function deposit(value: Fields): Description | null {
  // Unlike a vote, a deposit's proposal id is not checked against 0 by the kernel; Amino omits a 0.
  const proposal = uint64OrZero(value.proposal_id);
  const coins = goodCoins(value.amount, 1, 64);
  return account(value.depositor) && proposal !== null && coins
    ? { summary: `Deposit ${coinsText(coins)} on proposal ${proposal}` }
    : null;
}

/** A gov weight as `scaled_from_decimal` reads it: at most 18 places, the integer scaled by 10^18. */
function scaledDecimal(text: string): bigint | null {
  const [whole = "", fraction = "", ...rest] = text.split(".");
  if (rest.length > 0 || whole === "" || !/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 18) return null;
  if (text.endsWith(".")) return null;
  const scaled = BigInt(`${whole}${fraction.padEnd(18, "0")}`);
  return scaled.toString().length > 78 ? null : scaled;
}

/** `700000000000000000` as the 18-place decimal the LCD shows: `0.700000000000000000`. */
function decimalDisplay(scaled: bigint): string {
  const padded = scaled.toString().padStart(19, "0");
  return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
}

function voteWeighted(withMetadata: boolean) {
  return (value: Fields): Description | null => {
    const proposal = id(value.proposal_id);
    if (!proposal || !account(value.voter)) return null;
    if ("metadata" in value && !(withMetadata && typeof value.metadata === "string")) return null;
    if (!Array.isArray(value.options) || value.options.length === 0) return null;
    const words: string[] = [];
    const seen = new Set<string>();
    let sum = 0n;
    for (const item of value.options) {
      const entry = fields(item);
      const label = entry ? VOTE_LABELS.get(entry.option) : undefined;
      const weight = entry?.weight;
      // gov v1beta1's LegacyDec is always written with 18 places; v1 passes its string through.
      const scaled =
        typeof weight === "string" && (withMetadata || isDecDisplay(weight)) ? scaledDecimal(weight) : null;
      if (!label || seen.has(label) || scaled === null || scaled === 0n) return null;
      seen.add(label);
      sum += scaled;
      words.push(`${label} ${decimalDisplay(scaled)}`);
    }
    return sum === DEC_ONE ? { summary: `Vote ${words.join(", ")} on proposal ${proposal}` } : null;
  };
}

/** zunia-core `is_plain_type_url`: a leading slash, then letters, digits, dots and underscores. */
const plainTypeUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 256 && /^\/[A-Za-z0-9._]+$/.test(value);

function revokeAuthorization(value: Fields): Description | null {
  const granter = account(value.granter);
  const grantee = granter ? derived(value.grantee, granter) : null;
  return grantee && plainTypeUrl(value.msg_type_url)
    ? { summary: `Revoke the authorization given to ${grantee} for ${value.msg_type_url}` }
    : null;
}

function revokeAllowance(value: Fields): Description | null {
  const granter = account(value.granter);
  const grantee = granter ? derived(value.grantee, granter) : null;
  return grantee ? { summary: `Revoke the fee allowance given to ${grantee}` } : null;
}

/** A coin as a detail carries it. */
const coinDetail = (coins: readonly Coin[]): Coin[] => coins.map(({ denom: name, amount: units }) => ({ denom: name, amount: units }));

/** The contract message of an Amino document is the JSON itself; a missing one is not JSON. */
const hasContractMsg = (value: Fields): boolean => value.msg !== undefined;

/** The salt of an `MsgInstantiateContract2`: base64 in Amino, 1 to 64 bytes, shown as hex. */
function saltHex(value: unknown): string | null {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null;
  }
  const raw = atob(value);
  return raw.length >= 1 && raw.length <= 64
    ? Array.from(raw, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")
    : null;
}

function instantiate(withSalt: boolean) {
  return (value: Fields): Description | null => {
    const sender = signerOf(value);
    // Amino omits an empty admin: none.
    const adminText = value.admin === undefined || value.admin === "" ? null : value.admin;
    const admin = sender && adminText !== null ? derived(adminText, sender) : null;
    const code = id(value.code_id);
    const funds = goodCoins(value.funds, 0, 64);
    const label = value.label;
    if (!sender || (adminText !== null && !admin) || !code || !funds || !hasContractMsg(value)) return null;
    if (typeof label !== "string" || label === "") return null;
    let extra: { salt: string; fixMsg: boolean } | null = null;
    if (withSalt) {
      const salt = saltHex(value.salt);
      const fixMsg = value.fix_msg ?? false;
      if (salt === null || typeof fixMsg !== "boolean") return null;
      extra = { salt, fixMsg };
    }
    return {
      summary: `Instantiate code ${code} as a new contract${extra ? " at a salt-derived address" : ""}${
        admin ? ` with admin ${admin}` : " with no admin"
      }${funds.length > 0 ? `, sending ${coinsText(funds)}` : ""}`,
      ...(admin ? { recipient: admin } : {}),
      detail: {
        kind: "instantiate-contract",
        codeId: code,
        label,
        admin,
        msg: value.msg,
        funds: coinDetail(funds),
        ...(extra ?? {}),
      },
    };
  };
}

function migrateContract(value: Fields): Description | null {
  const sender = signerOf(value);
  const contract = sender ? derived(value.contract, sender) : null;
  const code = id(value.code_id);
  if (!contract || !code || !hasContractMsg(value)) return null;
  return {
    summary: `Migrate contract ${contract} to code ${code}`,
    detail: { kind: "migrate-contract", contract, codeId: code, msg: value.msg },
  };
}

function updateAdmin(value: Fields): Description | null {
  const sender = signerOf(value);
  const newAdmin = sender ? derived(value.new_admin, sender) : null;
  const contract = sender ? derived(value.contract, sender) : null;
  return newAdmin && contract
    ? { summary: `Make ${newAdmin} the admin of contract ${contract}`, recipient: newAdmin }
    : null;
}

function clearAdmin(value: Fields): Description | null {
  const sender = signerOf(value);
  const contract = sender ? derived(value.contract, sender) : null;
  return contract ? { summary: `Clear the admin of contract ${contract}, so nobody can migrate it again` } : null;
}

/**
 * The dApp messages of zunia-core's dapp.rs, by Amino name. Each is read under the kernel's
 * rules (`is_valid`, and the address checks of decode.rs `local_addresses_are_bech32`), and a
 * message that breaks one is not described, as the kernel demotes it to unknown.
 */
export const DAPP_DESCRIBERS: ReadonlyMap<string, (value: Fields) => Description | null> = new Map([
  ["osmosis/cl-create-position", createPosition],
  ["osmosis/cl-add-to-position", addToPosition],
  ["osmosis/cl-withdraw-position", withdrawPosition],
  ["osmosis/cl-col-sp-rewards", collect("spread rewards")],
  ["osmosis/cl-collect-incentives", collect("incentives")],
  ["osmosis/cl-transfer-positions", transferPositions],
  ["osmosis/gamm/join-pool", joinPool],
  ["osmosis/gamm/exit-pool", exitPool],
  ["osmosis/gamm/join-swap-extern-amount-in", joinSwapExternAmountIn],
  ["osmosis/gamm/exit-swap-share-amount-in", exitSwapShareAmountIn],
  ["osmosis/gamm/join-swap-share-amount-out", joinSwapShareAmountOut],
  ["osmosis/gamm/exit-swap-extern-amount-out", exitSwapExternAmountOut],
  ["osmosis/gamm/swap-exact-amount-in", swapExactIn],
  ["osmosis/gamm/swap-exact-amount-out", swapExactOut],
  ["osmosis/lockup/lock-tokens", lockTokens],
  ["osmosis/lockup/begin-unlock-period-lock", beginUnlocking],
  ["osmosis/lockup/begin-unlock-tokens", beginUnlockingAll],
  ["osmosis/superfluid-delegate", superfluidDelegate],
  ["osmosis/superfluid-undelegate", lockOnly("Superfluid-undelegate")],
  ["osmosis/lock-and-superfluid-delegate", lockAndSuperfluidDelegate],
  ["osmosis/superfluid-unbond-lock", lockOnly("Superfluid-unbond")],
  ["osmosis/superfluid-undelegate-unbond-lock", superfluidUndelegateAndUnbondLock],
  ["osmosis/sf-undelegate-and-unbond-lock", superfluidUndelegateAndUnbondLock],
  ["osmosis/full-range-and-sf-delegate", fullRangeAndSuperfluidDelegate],
  ["osmosis/add-to-cl-superfluid-position", addToSuperfluidPosition],
  ["cosmos-sdk/MsgMultiSend", multiSend],
  ["cosmos-sdk/MsgCancelUnbondingDelegation", cancelUnbonding],
  ["cosmos-sdk/MsgModifyWithdrawAddress", setWithdrawAddress],
  ["cosmos-sdk/MsgWithdrawValCommission", withdrawCommission],
  ["cosmos-sdk/MsgFundCommunityPool", fundCommunityPool],
  ["cosmos-sdk/MsgDeposit", deposit],
  ["cosmos-sdk/v1/MsgDeposit", deposit],
  ["cosmos-sdk/MsgVoteWeighted", voteWeighted(false)],
  ["cosmos-sdk/v1/MsgVoteWeighted", voteWeighted(true)],
  ["cosmos-sdk/MsgRevoke", revokeAuthorization],
  ["cosmos-sdk/MsgRevokeAllowance", revokeAllowance],
  ["wasm/MsgInstantiateContract", instantiate(false)],
  ["wasm/MsgInstantiateContract2", instantiate(true)],
  ["wasm/MsgMigrateContract", migrateContract],
  ["wasm/MsgUpdateAdmin", updateAdmin],
  ["wasm/MsgClearAdmin", clearAdmin],
]);

const DESCRIBERS: ReadonlyMap<string, (value: Fields) => Description | null> = new Map([
  ["cosmos-sdk/MsgDelegate", delegation("Delegate", "to")],
  ["cosmos-sdk/MsgUndelegate", delegation("Undelegate", "from")],
  ["cosmos-sdk/MsgBeginRedelegate", redelegation],
  ["cosmos-sdk/MsgWithdrawDelegationReward", rewardClaim],
  ["cosmos-sdk/MsgVote", vote(false)],
  ["cosmos-sdk/v1/MsgVote", vote(true)],
  ["cosmos-sdk/MsgTransfer", transfer],
  ["osmosis/poolmanager/swap-exact-amount-in", swapExactIn],
  ["osmosis/poolmanager/split-amount-in", splitExactIn],
  ["osmosis/poolmanager/swap-exact-amount-out", swapExactOut],
  ["osmosis/poolmanager/split-amount-out", splitExactOut],
  ...DAPP_DESCRIBERS,
]);

/**
 * The Amino types nothing reads, in either sign mode: they hand control of the account to
 * someone else or run nested messages (zunia-core dapp.rs, "Not here, on purpose"), so signing
 * one takes the blind-signing opt-in even though its name has "Msg" in it.
 */
const NEVER_READ_AMINO_TYPES: ReadonlySet<string> = new Set([
  "cosmos-sdk/MsgGrant",
  "cosmos-sdk/MsgExec",
  "cosmos-sdk/MsgGrantAllowance",
  "wasm/MsgStoreCode",
  "cosmos-sdk/MsgSubmitProposal",
  "cosmos-sdk/v1/MsgSubmitProposal",
]);

/**
 * Whether a message that {@link describeAminoMsg} did not describe must be gated: a type nothing
 * reads, or one of the dApp types that the kernel would have demoted to unknown for its shape.
 * Any other unrecognised type keeps the generic line, gated only when it has no "Msg" in its name.
 */
export function isGatedAminoType(type: string): boolean {
  return NEVER_READ_AMINO_TYPES.has(type) || type.startsWith("osmosis/smartaccount/") || DAPP_DESCRIBERS.has(type);
}

/** Every Amino type {@link describeAminoMsg} reads. */
export const DESCRIBED_AMINO_TYPES: readonly string[] = [...DESCRIBERS.keys()];

/**
 * The kernel's sentence for an Amino message of one of the types above, with a transfer's
 * recipient and detail; `unknown` only for a vote whose option is outside the enum. Null for
 * any other type, and for a message of these types that is not in the shape the chain's Amino
 * JSON gives it, which the caller shows with its generic summary.
 */
export function describeAminoMsg(type: string, value: unknown): DecodedTxMessage | null {
  const describe = DESCRIBERS.get(type);
  const body = fields(value);
  const described = describe && body ? describe(body) : null;
  return described ? { typeUrl: type, ...described } : null;
}

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
 * - `cosmos-sdk/MsgTransfer`, whose receiver is the message's recipient;
 * - the Osmosis poolmanager swaps `osmosis/poolmanager/swap-exact-amount-in`,
 *   `split-amount-in`, `swap-exact-amount-out` and `split-amount-out`.
 *
 * Only a message in the shape the chain's Amino JSON gives it is described. The checks are the
 * kernel's (`is_complete` in decode.rs, the swap rules in msg.rs), and stricter where the kernel
 * shows bytes as they are: every amount is a canonical integer string, every denom is valid,
 * every account and validator is a 20-byte bech32 address, every route has pools and no pool is
 * 0. Anything else returns null and the caller keeps the generic summary it always gave, which
 * still gates a type without "Msg" in it. A generic line is honest; a confident sentence about a
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
  if (!readableTimeout(value) || (value.memo !== undefined && typeof value.memo !== "string")) return null;
  return { summary: `IBC transfer ${coinText(token)} to ${receiver} over ${channel}`, recipient: receiver };
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
]);

/** Every Amino type {@link describeAminoMsg} reads. */
export const DESCRIBED_AMINO_TYPES: readonly string[] = [...DESCRIBERS.keys()];

/**
 * The kernel's sentence for an Amino message of one of the types above, with its recipient for
 * a transfer; `unknown` only for a vote whose option is outside the enum. Null for any other
 * type, and for a message of these types that is not in the shape the chain's Amino JSON gives
 * it, which the caller shows with its generic summary.
 */
export function describeAminoMsg(type: string, value: unknown): DecodedTxMessage | null {
  const describe = DESCRIBERS.get(type);
  const body = fields(value);
  const described = describe && body ? describe(body) : null;
  return described ? { typeUrl: type, ...described } : null;
}

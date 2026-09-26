/**
 * The CometBFT WebSocket dialect, as pure functions.
 *
 * A Cosmos node exposes a JSON-RPC subscription endpoint at `/websocket` on the
 * same host the chain registry lists as `rpc`. Subscribing to it is the only
 * way a wallet learns about an *incoming* transfer at the moment it happens:
 * every other path (LCD polling, an indexer) finds out later, by asking again.
 *
 * Nothing here touches the network, `browser.*`, or a clock. That is deliberate
 * - the framing and the event parsing are the parts that are easy to get subtly
 * wrong (base64 attributes on one CometBFT version, plain strings on the next;
 * a multi-coin `amount` string; a transfer the wallet itself sent coming back
 * as an "incoming" event), so they are separated from the socket and covered by
 * `lib/__tests__/realtime-protocol.test.ts`.
 */

/** Frames we send. CometBFT ignores unknown fields but not a wrong `method`. */
export interface RpcFrame {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "subscribe" | "unsubscribe" | "unsubscribe_all";
  readonly params: Record<string, unknown>;
}

/**
 * One subscription this wallet holds open.
 *
 * `direction` is fixed per subscription rather than derived per event: the
 * query is what decides which side of the transfer the address is on, so the
 * answer is known before any frame arrives and cannot be misread afterwards.
 */
export interface Subscription {
  readonly id: string;
  readonly chainId: string;
  readonly address: string;
  readonly direction: "received" | "sent";
  readonly query: string;
}

/**
 * `wss://` URL of a node's subscription endpoint, or `null` when the registry
 * row has no usable RPC.
 *
 * `http://` is upgraded to `ws://` and `https://` to `wss://` so a localhost
 * dev node keeps working; anything else (a bare host, an ftp URL, an empty
 * string) is refused rather than guessed at, because a wrong scheme here shows
 * up as a silent "realtime just never connects".
 */
export function websocketUrl(rpc: string | undefined): string | null {
  if (!rpc || rpc.trim().length === 0) return null;
  let url: URL;
  try {
    url = new URL(rpc.trim());
  } catch {
    return null;
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "wss:" && url.protocol !== "ws:") return null;
  // Registry rows are inconsistent about the trailing slash, and `//websocket`
  // 404s on several public nodes.
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/websocket`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Single-quote a value for a CometBFT query string.
 *
 * Bech32 addresses cannot contain a quote, so this can never be reached by an
 * address the wallet derived. It is here for the case that matters anyway: a
 * custom chain whose prefix the user typed, which reaches this function without
 * ever having been validated as bech32. An unescaped quote would not be an
 * injection into anything that signs - the query only ever selects which events
 * a node sends back - but it does produce a query the node rejects, which would
 * read as "realtime is broken on this chain" rather than "that address is not
 * valid".
 */
function quoted(value: string): string {
  return `'${value.replace(/'/g, "")}'`;
}

/**
 * The two queries that together cover everything that moves this address's
 * balance: coins arriving, and transactions it signed.
 *
 * Both are needed and neither is redundant. `transfer.recipient` catches a
 * payment from a stranger, a relayer delivering an IBC packet, and a reward
 * withdrawal - none of which this wallet signed. `message.sender` catches the
 * wallet's own outgoing transactions, including the ones signed on another
 * device from the same phrase, which is the case that otherwise leaves the
 * balance stale with no event to correct it.
 */
export function subscriptionsFor(
  chainId: string,
  address: string,
): Subscription[] {
  const escaped = quoted(address);
  return [
    {
      id: `${chainId}|${address}|in`,
      chainId,
      address,
      direction: "received",
      query: `tm.event='Tx' AND transfer.recipient=${escaped}`,
    },
    {
      id: `${chainId}|${address}|out`,
      chainId,
      address,
      direction: "sent",
      query: `tm.event='Tx' AND message.sender=${escaped}`,
    },
  ];
}

export function subscribeFrame(subscription: Subscription): RpcFrame {
  return {
    jsonrpc: "2.0",
    id: subscription.id,
    method: "subscribe",
    params: { query: subscription.query },
  };
}

export function unsubscribeAllFrame(): RpcFrame {
  return {
    jsonrpc: "2.0",
    id: "unsubscribe-all",
    method: "unsubscribe_all",
    params: {},
  };
}

/* -------------------------------------------------------------------------- *
 * Reading what comes back
 * -------------------------------------------------------------------------- */

/** One `denom`/`amount` pair pulled out of a transfer event. */
export interface MovedCoin {
  readonly denom: string;
  readonly amount: string;
}

/** A transaction the node told us about, reduced to what the wallet acts on. */
export interface TxNotice {
  readonly kind: "tx";
  readonly subscriptionId: string;
  readonly chainId: string;
  readonly address: string;
  readonly direction: "received" | "sent";
  readonly hash: string;
  readonly height: number;
  /** Coins credited to (or debited from) `address` in this transaction. */
  readonly coins: readonly MovedCoin[];
  /** The first `message.action` on the transaction, when the node reported one. */
  readonly action: string | null;
  /** False when the transaction was included but failed (non-zero code). */
  readonly succeeded: boolean;
}

export type ParsedFrame =
  | TxNotice
  | { readonly kind: "ack"; readonly subscriptionId: string }
  | {
      readonly kind: "error";
      readonly subscriptionId: string | null;
      readonly message: string;
    }
  | { readonly kind: "ignored" };

/**
 * CometBFT 0.34 base64-encodes every event attribute key and value; 0.37 and
 * later send them as plain strings. Both are in production across the chains
 * this wallet lists, and a node does not announce which it is, so every
 * attribute is read through here.
 *
 * The decode is only accepted when it round-trips: `"sender"` is itself valid
 * base64 (it decodes to bytes that re-encode differently), so a naive decode
 * would turn readable keys into mojibake on a modern node.
 */
export function decodeAttribute(value: string): string {
  if (value.length === 0) return value;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    return value;
  }
  try {
    const decoded = atob(value);
    // A key or value that came through as base64 is text; bytes outside the
    // printable ASCII range mean this was a plain string that merely looked
    // like base64 (a bech32 address, a denom).
    if (!/^[\x20-\x7e]*$/.test(decoded)) return value;
    if (btoa(decoded) !== value) return value;
    return decoded;
  } catch {
    return value;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Split an ICS20 / bank `amount` attribute into coins.
 *
 * The attribute is a comma-joined coin list (`"1000uatom,25uosmo"`) where each
 * entry is digits immediately followed by the denom, and the denom may itself
 * contain digits and slashes (`ibc/27394FB0…`, `factory/osmo1…/LAB`). Splitting
 * on the first non-digit is therefore the only correct rule; a regex on
 * `\d+([a-z]+)` drops every IBC and token-factory denom in the wallet.
 */
export function parseCoins(amount: string): MovedCoin[] {
  const coins: MovedCoin[] = [];
  for (const part of amount.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const split = trimmed.search(/[^0-9]/);
    if (split <= 0) continue;
    const value = trimmed.slice(0, split);
    const denom = trimmed.slice(split);
    if (denom.length === 0) continue;
    coins.push({ denom, amount: value });
  }
  return coins;
}

/**
 * Coins that moved to or from `address`, read from the flattened event map the
 * node sends alongside every matched transaction.
 *
 * The map is index-aligned: `transfer.recipient[i]` belongs with
 * `transfer.amount[i]`. A transaction with several transfers (a multi-send, a
 * swap that pays out and takes a fee) therefore has to be walked pairwise; a
 * naive "first amount" read reports the wrong number on exactly the
 * transactions where the number matters most.
 */
export function coinsForAddress(
  events: Record<string, readonly string[]>,
  address: string,
  direction: "received" | "sent",
): MovedCoin[] {
  const party = direction === "received" ? "transfer.recipient" : "transfer.sender";
  const parties = events[party] ?? [];
  const amounts = events["transfer.amount"] ?? [];
  const coins: MovedCoin[] = [];
  for (let i = 0; i < parties.length; i += 1) {
    if (parties[i] !== address) continue;
    const amount = amounts[i];
    if (typeof amount !== "string") continue;
    coins.push(...parseCoins(amount));
  }
  return merged(coins);
}

/** One entry per denom, summed, so a UI never shows the same token twice. */
function merged(coins: readonly MovedCoin[]): MovedCoin[] {
  const totals = new Map<string, bigint>();
  for (const coin of coins) {
    let value: bigint;
    try {
      value = BigInt(coin.amount);
    } catch {
      continue;
    }
    totals.set(coin.denom, (totals.get(coin.denom) ?? 0n) + value);
  }
  return [...totals].map(([denom, amount]) => ({
    denom,
    amount: amount.toString(),
  }));
}

/** The flattened `result.events` map, with both attribute encodings handled. */
function normalizeEvents(raw: unknown): Record<string, string[]> {
  const source = asRecord(raw);
  if (!source) return {};
  const out: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!Array.isArray(value)) continue;
    out[decodeAttribute(key)] = value
      .filter((entry): entry is string => typeof entry === "string")
      .map(decodeAttribute);
  }
  return out;
}

/**
 * Turn one frame off the socket into something the caller can act on.
 *
 * Every shape a node can send is accounted for, and anything unrecognised is
 * `ignored` rather than thrown: a wallet must not drop a live subscription
 * because a node added a field.
 */
export function parseFrame(raw: string, chainId: string): ParsedFrame {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return { kind: "ignored" };
  }
  const envelope = asRecord(message);
  if (!envelope) return { kind: "ignored" };

  const id = typeof envelope.id === "string" ? envelope.id : null;

  const error = asRecord(envelope.error);
  if (error) {
    const data = typeof error.data === "string" ? error.data : null;
    const text = typeof error.message === "string" ? error.message : "RPC error";
    return { kind: "error", subscriptionId: id, message: data ? `${text}: ${data}` : text };
  }

  const result = asRecord(envelope.result);
  if (!result) return { kind: "ignored" };

  // A subscribe call is answered with an empty result before any event flows.
  if (Object.keys(result).length === 0) {
    return id ? { kind: "ack", subscriptionId: id } : { kind: "ignored" };
  }

  const events = normalizeEvents(result.events);
  const hash = events["tx.hash"]?.[0];
  if (!id || !hash) return { kind: "ignored" };

  const [, address = "", suffix = ""] = id.split("|");
  const direction = suffix === "out" ? "sent" : "received";

  const data = asRecord(result.data);
  const value = asRecord(data?.value);
  const txResult = asRecord(value?.TxResult);
  const inner = asRecord(txResult?.result);
  // `tx.height` is a string in the event map; TxResult carries it as a string
  // too. Either is fine, neither is guaranteed, so both are tried.
  const height = Number(
    events["tx.height"]?.[0] ?? (typeof txResult?.height === "string" ? txResult.height : "0"),
  );
  const code = inner?.code;
  const succeeded = code === undefined || code === 0;

  return {
    kind: "tx",
    subscriptionId: id,
    chainId,
    address,
    direction,
    hash,
    height: Number.isFinite(height) ? height : 0,
    coins: coinsForAddress(events, address, direction),
    action: events["message.action"]?.[0] ?? null,
    succeeded,
  };
}

/* -------------------------------------------------------------------------- *
 * Reconnection
 * -------------------------------------------------------------------------- */

/** Backoff ceiling. Past this a node is down, not busy, and polling covers it. */
export const MAX_BACKOFF_MS = 60_000;
const BASE_BACKOFF_MS = 1_000;

/**
 * Delay before retry number `attempt` (0-based), with full jitter.
 *
 * Jitter is not decoration here: every install of this wallet watches the same
 * handful of public RPC hosts, so a node restarting would otherwise be met by
 * every wallet reconnecting on the same schedule. `random` is injectable so the
 * test can assert the bounds rather than the draw.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempt));
  return Math.round(BASE_BACKOFF_MS + random() * Math.max(0, ceiling - BASE_BACKOFF_MS));
}

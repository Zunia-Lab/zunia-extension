/**
 * What a Send moves, and what the recipient ends up holding.
 *
 * The Send screen names everything from {@link TokenIdentity}: the token being
 * sent (with the exponent its amount is typed and signed with), who issued
 * it, and, for a transfer to another chain, the denom that lands there. That
 * last one is where wallets mislead: Noble USDC held on Injective and sent
 * straight to Osmosis does not arrive as Osmosis's USDC.n (`ibc/498A…`) but as
 * a voucher of a voucher, `ibc/` + sha256("transfer/channel-122/transfer/
 * channel-148/uusdc"), which no registry names and few apps accept.
 * {@link sendArrival} says which case a plan is, works the denom out again
 * from the token's own hash-checked trace, and never states a denom the route
 * plan could not compute.
 *
 * Display only. Nothing here builds or changes a signed denom, amount,
 * channel or memo: message denoms are the exact bank denoms, and amounts are
 * converted with the exponent the balance row has always given them.
 */

import { TRANSFER_PORT } from "@zunialab/interchain";

import { heldTokenIdentity, type TokenBalance } from "./balances";
import { findCatalogEntry } from "./chain-catalog";
import { CANONICAL_CHANNEL_ROUTES } from "./interchain";
import { EMPTY_PICKER_MEMORY, readPickerMemory, type PickerMemory } from "./picker";
import type { ManualChannel } from "./route-plan";
import { STORAGE_KEYS } from "./storage-keys";
import { amountFieldText, formatTokenAmount, type AmountIdentity } from "./token-amount";
import {
  ibcDenomFor,
  identityOf,
  shortDenom,
  tokenTableRows,
  tokenText,
  type TokenIdentity,
} from "./token-identity";

/** The swap venue, whose canonical vouchers every identity already knows. */
const OSMOSIS = "osmosis-1";

/* -------------------------------------------------------------------------- *
 * The token being sent
 * -------------------------------------------------------------------------- */

/**
 * The identity a held row is sent with: its names, logo and seal from
 * {@link heldTokenIdentity}, and the row's own exponent, which is what its
 * amounts are shown with, what a typed amount is converted with and what Max
 * writes. For every token whose decimals are known that is the exponent Send
 * has always converted with (the row's `decimals`), so a typed "1.5" signs the
 * same base units as before. When the row does not know them the exponent is
 * 0, `decimalsKnown` is false, and only Max can be used
 * (lib/token-amount.ts `canTypeAmount`).
 *
 * Only the exponent may differ from `heldTokenIdentity`, and the spelling of
 * the denom. The exponent does for a chain's own coin whose catalog exponent
 * the token table disputes: the balance row, the chain-level row and Earn keep
 * the catalog's, and so does Send. The denom and the key are always the row's
 * exact bank denom, which picker ids and picker memory are matched against
 * (an `ibc/` hash the table lists in another case is still this denom).
 */
export function sendTokenIdentity(
  chainId: string,
  token: Pick<TokenBalance, "denom" | "decimals" | "decimalsKnown">,
): TokenIdentity {
  const identity = heldTokenIdentity(chainId, token);
  const decimalsKnown =
    token.decimalsKnown !== false && Number.isSafeInteger(token.decimals) && token.decimals >= 0;
  const decimals = decimalsKnown ? token.decimals : 0;
  const key = `${chainId}:${token.denom}`;
  if (
    identity.decimals === decimals &&
    identity.decimalsKnown === decimalsKnown &&
    identity.denom === token.denom &&
    identity.key === key
  ) {
    return identity;
  }
  return { ...identity, key, denom: token.denom, decimals, decimalsKnown };
}

/**
 * The amount a review or receipt states: every digit that is signed
 * (`1.1234567`, never cut to six places), or `12340000 base units` when the
 * decimals are unknown. Never compact, never rounded.
 */
export function exactAmountText(units: string | bigint, identity: AmountIdentity): string {
  return identity.decimalsKnown
    ? amountFieldText(units, identity)
    : formatTokenAmount(units, identity, "confirm");
}

/**
 * The "Issued on" line: the chain that issued the token (`Noble` for USDC.n
 * wherever it is held), `Noble (not verified)` when the origin is claimed but
 * not proven (a chain the user added, a walk over a channel the registry does
 * not name), or `Unknown` when nothing traces it.
 */
export function issuerText(identity: TokenIdentity): string {
  if (identity.provenance === "unknown" || !identity.originChainId) return "Unknown";
  const name = identity.originChainName ?? identity.originChainId;
  return identity.proven ? name : `${name} (not verified)`;
}

/**
 * A pending transfer's label, as Activity, the resume banner and the arrival
 * notification show it: `10 USDC.n (Osmosis) → Noble`. The ticker says what
 * the token is, the chains say where it was and where it goes;
 * `12340000 base units IBC·498A (Osmosis) → Noble` when nothing names it.
 */
export function transferLabel(
  units: string | bigint,
  sent: TokenIdentity,
  destChainName: string,
): string {
  const amount = formatTokenAmount(units, sent, "history");
  return `${amount} ${sent.ticker} (${sent.heldOnChainName}) → ${destChainName}`;
}

/* -------------------------------------------------------------------------- *
 * Picker memory
 * -------------------------------------------------------------------------- */

/**
 * Send's token picker remembered a token by its bare denom until 0.1.3. It
 * now keeps `${chainId}:${denom}`, the identity key Swap's pickers use too, so
 * favorites carry over and `uusdc` on Noble is not `uusdc` on Axelar.
 *
 * An id equal to one of `denoms` (the tokens Send offers on `chainId`) becomes
 * that chain's key: the old picker only ever listed the selected chain's
 * tokens. Every other id, a key or a bare denom this chain does not hold, is
 * kept as it is for the chain it belongs to. A repeated id keeps its first
 * place.
 */
export function migrateTokenIds(
  ids: readonly string[],
  chainId: string,
  denoms: Iterable<string>,
): string[] {
  const offered = new Set(denoms);
  const out: string[] = [];
  for (const id of ids) {
    const next = offered.has(id) ? `${chainId}:${id}` : id;
    if (!out.includes(next)) out.push(next);
  }
  return out;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** {@link migrateTokenIds} over favorites and recents; `null` when nothing changes. */
export function migrateTokenMemory(
  memory: PickerMemory,
  chainId: string,
  denoms: Iterable<string>,
): PickerMemory | null {
  const offered = [...denoms];
  const favorites = migrateTokenIds(memory.favorites, chainId, offered);
  const recents = migrateTokenIds(memory.recents, chainId, offered);
  if (sameIds(favorites, memory.favorites) && sameIds(recents, memory.recents)) return null;
  return { ...memory, favorites, recents };
}

/**
 * Rewrite the stored token picks {@link migrateTokenMemory} moves, once, so a
 * favorite toggled afterwards toggles the key it is shown under. Writes only
 * when something changes. Never throws: until it lands, the picker reads the
 * old ids through {@link migrateTokenIds} anyway.
 */
export async function migrateStoredTokenMemory(
  chainId: string,
  denoms: readonly string[],
): Promise<boolean> {
  if (!chainId || denoms.length === 0) return false;
  try {
    const stored = await browser.storage.local.get(STORAGE_KEYS.pickerMemory);
    const all = readPickerMemory(stored[STORAGE_KEYS.pickerMemory]);
    const next = migrateTokenMemory(all.token ?? EMPTY_PICKER_MEMORY, chainId, denoms);
    if (!next) return false;
    await browser.storage.local.set({ [STORAGE_KEYS.pickerMemory]: { ...all, token: next } });
    return true;
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- *
 * Pinned channels
 * -------------------------------------------------------------------------- */

let registryEnds: Map<string, string> | null = null;

/** The far end of a registry channel (lib/ibc-channels.generated.ts), or null. */
function registryEnd(sourceChainId: string, destChainId: string, channelId: string): string | null {
  registryEnds ??= new Map(
    CANONICAL_CHANNEL_ROUTES.map((route) => [
      `${route.sourceChainId}>${route.destChainId}:${route.channelId}`,
      route.counterpartyChannelId,
    ]),
  );
  return registryEnds.get(`${sourceChainId}>${destChainId}:${channelId}`) || null;
}

/**
 * Pins with the registry's far end added where the registry names the
 * channel and the pin carries none.
 *
 * Send pins the route it previews. A pinned channel replaces the cached link
 * in the engine's graph, far end included, and without the far end the
 * engine cannot compute the denom a wrapped token arrives as: every transfer
 * that wraps would read "could not be computed". The far end only names what
 * arrives. The message carries the leaving channel alone, so nothing signed
 * changes, and the channel check reads the far end from the chains for
 * itself. A pin that already names a far end, or uses another port, is kept
 * as it is.
 */
export function withRegistryEnds(pins: readonly ManualChannel[]): ManualChannel[] {
  return pins.map((pin) => {
    if (pin.counterpartyChannelId || (pin.port && pin.port !== TRANSFER_PORT)) return pin;
    const far = registryEnd(pin.fromChainId, pin.toChainId, pin.channelId);
    return far ? { ...pin, counterpartyChannelId: far } : pin;
  });
}

/**
 * The engine's note on a channel it was told to use (zunia-sdk route.ts),
 * after `channel-750 on Osmosis`. It cannot tell a pin from a channel a
 * person typed.
 */
export const ENGINE_ENTERED_BY_HAND = "was entered by hand and has not been checked";

/**
 * A plan's notes as Send shows them under the route.
 *
 * Send pins the route it previews, and the engine reads every pin as a
 * channel typed by hand that nobody checked. For the screen's own pin that
 * is wrong twice over: nobody typed it, and the plan has just checked it on
 * both chains (the route marks it verified; a channel that fails its check
 * blocks the plan with its own reason). So the note is dropped for those
 * pins, and kept for a leg the user entered a channel on. Notes that do not
 * match the engine's wording are all kept: should it change, the note shows
 * again rather than anything being hidden.
 */
export function routeNotes(
  warnings: readonly string[],
  screenPins: readonly ManualChannel[],
  userPins: readonly ManualChannel[],
): string[] {
  const leg = (pin: ManualChannel) => `${pin.fromChainId}>${pin.toChainId}`;
  const typed = new Set(userPins.map(leg));
  const own = new Set<string>();
  for (const pin of screenPins) {
    if (typed.has(leg(pin))) continue;
    for (const name of new Set([chainNameOf(pin.fromChainId), pin.fromChainId])) {
      own.add(`${pin.channelId} on ${name} ${ENGINE_ENTERED_BY_HAND}`);
    }
  }
  return warnings.filter((note) => !own.has(note));
}

/* -------------------------------------------------------------------------- *
 * What arrives
 * -------------------------------------------------------------------------- */

/**
 * The engine's words when it could not compute the denom a transfer arrives
 * as (zunia-sdk route.ts). Its plan then carries a stand-in, the unwrapped
 * input or the input itself, which must never be shown as what arrives.
 */
export const ENGINE_UNCOMPUTED_OUTPUT = "The denom the recipient ends up with could not be computed";

/** The engine's words for a plan that sends a voucher onward instead of unwinding it. */
export const ENGINE_DOUBLE_WRAP = "This sends a wrapped token onward instead of unwinding it";

/**
 * One channel the packet crosses, in travel order: what the route plan's
 * `candidate.links` carry. The counterparty channel is the one the receiving
 * chain prefixes the trace with; without it the arriving denom cannot be
 * worked out here.
 */
export interface ArrivalLink {
  readonly channelId: string;
  readonly port?: string;
  readonly counterpartyChannelId?: string;
  readonly counterpartyPortId?: string;
}

export interface SendArrivalInput {
  /** The chain the transfer is signed on: `plan.plan.sourceChainId`. */
  readonly sourceChainId: string;
  /** The exact bank denom sent: `plan.plan.inputDenom`. */
  readonly inputDenom: string;
  readonly destChainId: string;
  /** `plan.plan.outputDenom`: the engine's answer, or its stand-in when it had none. */
  readonly outputDenom: string;
  /** The plan's warnings (`RoutePlanView.warnings`), where the engine says it had no answer. */
  readonly warnings?: readonly string[];
  /** `plan.candidate.links`, so the denom can be worked out again from the token's trace. */
  readonly links?: readonly ArrivalLink[];
  /**
   * The identity being sent, when the screen has it (with the row's
   * exponent); `identityOf(sourceChainId, inputDenom)` otherwise.
   */
  readonly sent?: TokenIdentity;
}

/**
 * - `native`: the token goes home and arrives as its issuer's own denom
 *   (USDC.n from Osmosis to Noble arrives as `uusdc`).
 * - `named`: it arrives as the voucher the destination knows the asset by:
 *   the registry's (USDC.n from Noble to Osmosis is `ibc/498A…`), or one this
 *   wallet proved over registry channels.
 * - `rewrapped`: a voucher sent onward instead of home, so it arrives wrapped
 *   twice, as a denom no registry names.
 * - `unnamed`: wrapped once, as a voucher nothing names yet; warned only when
 *   the destination knows the asset under another denom.
 * - `unknown`: the plan could not compute the denom. Nothing is stated.
 */
export type ArrivalKind = "native" | "named" | "rewrapped" | "unnamed" | "unknown";

export interface ArrivalWarning {
  readonly title: string;
  readonly body: string;
}

export interface SendArrival {
  readonly kind: ArrivalKind;
  /** The exact denom the recipient ends up holding. `null` when it could not be computed. */
  readonly denom: string | null;
  /** That denom as the destination names it; `null` with {@link denom}. */
  readonly identity: TokenIdentity | null;
  /**
   * The denom the destination knows the sent asset by, when the registry gives
   * one: `uusdc` on Noble and `ibc/498A…` on Osmosis for USDC.n. Equal to
   * {@link denom} when the transfer delivers it.
   */
  readonly listedDenom: string | null;
  /** The "Arrives as" value: `USDC.n · Native on Noble`, `Re-wrapped USDC.n · on Osmosis`. */
  readonly text: string;
  /** Shown under the row when the token arrives as something else than it reads. */
  readonly warning: ArrivalWarning | null;
}

/** A denom on its way: its trace path and the denom it started as. */
interface Trace {
  readonly path: string;
  readonly base: string;
}

const isIbc = (denom: string): boolean => denom.startsWith("ibc/");

/** `ibc/` hashes compare without case, as the chains treat them; every other denom exactly. */
function denomKey(denom: string): string {
  return isIbc(denom) ? `ibc/${denom.slice(4).toUpperCase()}` : denom;
}

function sameDenom(a: string, b: string): boolean {
  return denomKey(a) === denomKey(b);
}

/** A packet denom (`transfer/channel-0/uatom`): the sender's trace, not a bank denom. */
const PACKET_PATH = /^[^/]+\/(?:channel-\d+|\d{2}-[a-z][a-z0-9]*-\d+)\//;

function splitHops(path: string): { port: string; channel: string }[] {
  const parts = path.split("/").filter((part) => part.length > 0);
  const hops: { port: string; channel: string }[] = [];
  for (let index = 0; index + 1 < parts.length; index += 2) {
    hops.push({ port: parts[index] ?? "", channel: parts[index + 1] ?? "" });
  }
  return hops;
}

function joinHops(hops: readonly { port: string; channel: string }[]): string {
  return hops.map((hop) => `${hop.port}/${hop.channel}`).join("/");
}

function hopCount(path: string): number {
  return splitHops(path).length;
}

/**
 * The trace of the denom being sent, when its identity proves one that
 * hashes back to it: the identity's own path and origin denom, or the token
 * table's row (whose base can sit further back, as Picasso's ETH does). A
 * local denom has no trace to prove. `null` when nothing hashes back.
 */
function traceOf(identity: TokenIdentity): Trace | null {
  const { denom } = identity;
  if (!isIbc(denom)) return PACKET_PATH.test(denom) ? null : { path: "", base: denom };
  const candidates: Trace[] = [];
  if (identity.path && identity.originDenom) {
    candidates.push({ path: identity.path, base: identity.originDenom });
  }
  for (const row of tokenTableRows(identity.heldOnChainId)) {
    if (row.path && row.baseDenom && sameDenom(row.denom, denom)) {
      candidates.push({ path: row.path, base: row.baseDenom });
    }
  }
  return candidates.find((trace) => sameDenom(ibcDenomFor(trace.path, trace.base), denom)) ?? null;
}

/**
 * Move a trace across one channel, the way ICS20 does and the engine's
 * planner computes it: back the way it came unwraps one hop, anything else
 * wraps under the receiving end's port and channel. `null` when that end is
 * not known.
 */
function stepTrace(trace: Trace, link: ArrivalLink): Trace | null {
  const port = link.port ?? TRANSFER_PORT;
  const hops = splitHops(trace.path);
  const first = hops[0];
  if (first && first.port === port && first.channel === link.channelId) {
    return { path: joinHops(hops.slice(1)), base: trace.base };
  }
  if (!link.counterpartyChannelId) return null;
  return {
    path: joinHops([
      { port: link.counterpartyPortId ?? TRANSFER_PORT, channel: link.counterpartyChannelId },
      ...hops,
    ]),
    base: trace.base,
  };
}

function denomOfTrace(trace: Trace): string {
  return trace.path ? ibcDenomFor(trace.path, trace.base) : trace.base;
}

/**
 * The denom the destination knows `sent`'s asset by: the issuer's own denom
 * at home, the canonical voucher on Osmosis, else the most direct proven
 * table row on that chain. Only for a proven asset: an unproven claim of
 * origin is no ground for "this is not the real one".
 */
function listedDenomOn(destChainId: string, sent: TokenIdentity): string | null {
  if (sent.provenance === "unknown" || !sent.proven || !sent.originChainId || !sent.originDenom) {
    return null;
  }
  if (sent.originChainId === destChainId) return sent.originDenom;
  if (destChainId === OSMOSIS) return sent.osmosisDenom;
  let best: { denom: string; hops: number } | null = null;
  for (const row of tokenTableRows(destChainId)) {
    if (!row.path) continue;
    const listed = identityOf(destChainId, row.denom);
    if (
      !listed.proven ||
      listed.originChainId !== sent.originChainId ||
      listed.originDenom !== sent.originDenom
    ) {
      continue;
    }
    const hops = hopCount(row.path);
    if (!best || hops < best.hops) best = { denom: row.denom, hops };
  }
  return best?.denom ?? null;
}

type Computed =
  | { readonly denom: string; readonly path: string | null }
  | { readonly denom: null; readonly reason: "uncomputed" | "disagrees" };

/**
 * The denom that arrives, worked out twice when it can be: from the token's
 * own hash-checked trace stepped along the plan's channels, and by the
 * engine. Ours is the answer whenever it exists; the engine's is taken when
 * ours cannot be computed, unless the engine said it had none either. When
 * both exist and differ, neither is stated.
 */
function arrivingDenom(input: SendArrivalInput, sent: TokenIdentity): Computed {
  const engineGaveUp = (input.warnings ?? []).some((warning) =>
    warning.startsWith(ENGINE_UNCOMPUTED_OUTPUT),
  );
  const links = input.links ?? [];
  let trace = links.length > 0 ? traceOf(sent) : null;
  for (const link of links) {
    if (!trace) break;
    trace = stepTrace(trace, link);
  }
  if (trace) {
    const denom = denomOfTrace(trace);
    if (!engineGaveUp && !sameDenom(denom, input.outputDenom)) {
      return { denom: null, reason: "disagrees" };
    }
    return { denom, path: trace.path };
  }
  if (engineGaveUp) return { denom: null, reason: "uncomputed" };
  return { denom: input.outputDenom, path: null };
}

function chainNameOf(chainId: string): string {
  return findCatalogEntry(chainId)?.chainName ?? chainId;
}

/** `USDC.n · Native on Noble`, `USDC.n · Noble USDC · on Osmosis`. */
function namedText(identity: TokenIdentity): string {
  return `${identity.ticker} · ${tokenText(identity, "row")}`;
}

/**
 * What a transfer of `sent` delivers on `destChainId`, from its route plan.
 *
 * - Osmosis `ibc/498A…` (USDC.n) to Noble unwinds to `uusdc`: `native`,
 *   "USDC.n · Native on Noble".
 * - Noble USDC held on Injective (`ibc/2CBC…`, channel-148) sent to Osmosis
 *   over Injective channel-8 arrives under Osmosis channel-122 as
 *   `ibc/` + sha256("transfer/channel-122/transfer/channel-148/uusdc"):
 *   `rewrapped`, with a warning that Osmosis knows USDC.n as `ibc/498A…`.
 * - A plan whose engine could not compute the denom: `unknown`, no denom.
 */
export function sendArrival(input: SendArrivalInput): SendArrival {
  // The screen's identity carries the row's exponent; it names this denom on
  // this chain or it is not used.
  const sent =
    input.sent &&
    input.sent.heldOnChainId === input.sourceChainId &&
    sameDenom(input.sent.denom, input.inputDenom)
      ? input.sent
      : identityOf(input.sourceChainId, input.inputDenom);
  const destName = chainNameOf(input.destChainId);
  const listedDenom = listedDenomOn(input.destChainId, sent);
  const computed = arrivingDenom(input, sent);

  if (computed.denom === null) {
    return {
      kind: "unknown",
      denom: null,
      identity: null,
      listedDenom,
      text: "Could not be computed",
      warning: {
        title: "Arrival not known",
        body:
          computed.reason === "disagrees"
            ? `The route plan and Zunia's own check disagree on the denom this becomes on ${destName}, so neither is shown. It may arrive as a token no registry names.`
            : `Zunia could not work out the denom this becomes on ${destName}. It may arrive as a token no registry names.`,
      },
    };
  }

  const denom = computed.denom;
  const identity = identityOf(input.destChainId, denom);
  const base = { denom, identity, listedDenom };

  // Home: the trace unwound completely, so the denom is the issuer's own.
  if (!isIbc(denom)) {
    return { ...base, kind: "native", text: namedText(identity), warning: null };
  }

  const named = sent.provenance !== "unknown";
  const asset = named ? sent.ticker : "voucher";
  const listedIsDelivered = listedDenom !== null && sameDenom(listedDenom, denom);
  const registryNames =
    identity.proven && (identity.provenance === "table" || identity.provenance === "catalog");
  if (listedIsDelivered || registryNames) {
    return { ...base, kind: "named", text: namedText(identity), warning: null };
  }

  const hops = computed.path !== null ? hopCount(computed.path) : null;
  const doubled =
    hops !== null
      ? hops >= 2
      : (input.warnings ?? []).some((warning) => warning.startsWith(ENGINE_DOUBLE_WRAP));
  const known =
    listedDenom !== null && named
      ? `${destName} lists ${sent.ticker} as ${shortDenom(listedDenom)}. `
      : "";
  const home =
    named && sent.originChainId && sent.originChainId !== input.sourceChainId
      ? sent.originChainId === input.destChainId
        ? ""
        : ` To receive ${sent.ticker} on ${destName}, send it to ${sent.originChainName ?? sent.originChainId} first.`
      : "";

  if (doubled) {
    return {
      ...base,
      kind: "rewrapped",
      text: `Re-wrapped ${asset} · on ${destName}`,
      warning: {
        title: "Arrives as a different token",
        body: `${known}Sent this way it arrives as ${shortDenom(denom)}, a re-wrapped voucher that no registry names, so wallets and apps may not accept it.${home}`,
      },
    };
  }

  // Wrapped once. A voucher this wallet proved over registry channels is
  // the asset under a name of its own; anything else is new to the chain.
  if (listedDenom === null && identity.proven) {
    return { ...base, kind: "named", text: namedText(identity), warning: null };
  }
  return {
    ...base,
    kind: "unnamed",
    text: named ? `${sent.ticker} voucher · on ${destName}` : `Unnamed voucher · on ${destName}`,
    warning:
      listedDenom !== null && named
        ? {
            title: "Arrives as a different token",
            body: `${known}This route delivers ${shortDenom(denom)} instead, a voucher that no registry names, so wallets and apps may not accept it.`,
          }
        : null,
  };
}

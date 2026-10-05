/**
 * How an amount of one denom reads, for the history, the transaction detail
 * and the signing prompt. Every name comes from lib/token-identity.ts; this
 * module only decides which identity a denom from those surfaces refers to.
 */

import { uniqueIssuerOf } from "./chain-catalog";
import { formatUnitsExact, shortDenom } from "./format";
import { identityOf, type TokenIdentity } from "./token-identity";

/** How to show an amount of one denom. */
export interface CoinDisplay {
  symbol: string;
  decimals: number;
  /** False when nothing names the denom; amounts are then raw base units. */
  known: boolean;
}

/** `transfer/channel-0/uosmo` is `uosmo` after the hops that carried it. */
export function baseDenomOf(denom: string): string {
  return denom.replace(/^(?:[a-z0-9._-]+\/channel-\d+\/)+/i, "");
}

const named = (identity: TokenIdentity | undefined): identity is TokenIdentity =>
  identity !== undefined && identity.provenance !== "unknown" && identity.decimalsKnown;

/**
 * The identity a denom from a message or a fee refers to on `chainId`.
 *
 * A bank denom (`uatom`, `ibc/…`, `erc20:…`) is the holding chain's own, so
 * {@link identityOf} answers. A packet denom is not: `transfer/channel-141/uosmo`
 * is the sender's trace, and its channel numbers belong to the sender, so
 * mapping them from the receiving chain would name the wrong issuer (the same
 * mistake as naming every `uusdc` after Axelar). Such a denom, and a bare base
 * denom the holding chain does not issue, is named only when exactly one
 * registry chain issues its base ({@link uniqueIssuerOf}); otherwise it stays
 * unknown. History derives the receiving chain's local denom first, which is
 * exact.
 */
function displayIdentity(chainId: string, denom: string): TokenIdentity | undefined {
  const base = baseDenomOf(denom);
  if (base === denom) {
    const own = identityOf(chainId, denom);
    if (named(own) || denom.startsWith("ibc/")) return own;
  }
  if (base.startsWith("ibc/")) return undefined;
  const issuer = uniqueIssuerOf(base);
  // The exact spelling the message carries, on its issuer: the catalog's own
  // spelling may differ in case (Injective's erc20 rows), and that is another,
  // empty denom.
  return issuer ? identityOf(issuer.entry.chainId, base) : undefined;
}

export function coinDisplay(chainId: string, denom: string): CoinDisplay {
  const identity = displayIdentity(chainId, denom);
  if (named(identity)) {
    return { symbol: identity.ticker, decimals: identity.decimals, known: true };
  }
  return { symbol: shortDenom(denom), decimals: 0, known: false };
}

/** Gas floor for an IBC transfer of an `erc20:` bank denom, before the user's adjustment. */
export const ERC20_IBC_GAS_FLOOR = "800000";

export function erc20TransferGasFloor(
  msgs: readonly { typeUrl: string; value: object }[],
): string | null {
  for (const msg of msgs) {
    if (msg.typeUrl !== "/ibc.applications.transfer.v1.MsgTransfer") continue;
    const token = "token" in msg.value ? (msg.value as { token?: unknown }).token : undefined;
    if (!token || typeof token !== "object" || Array.isArray(token)) continue;
    const denom = (token as { denom?: unknown }).denom;
    if (typeof denom !== "string" || denom.length === 0) continue;
    const base = baseDenomOf(denom);
    if (/^erc20:/i.test(denom) || /^erc20:/i.test(base)) return ERC20_IBC_GAS_FLOOR;
  }
  return null;
}

/** Raise simulated gas to the floor before `estimateFee` applies the user's adjustment. */
export function applyGasFloor(simulated: string, floor: string | null): string {
  if (!floor) return simulated;
  try {
    return BigInt(simulated) >= BigInt(floor) ? simulated : floor;
  } catch {
    return floor;
  }
}

/** `1.5 ATOM`, or raw base units and the denom when the denom has no name. */
export function formatCoin(amount: string, display: CoinDisplay): string {
  const value = display.known
    ? formatUnitsExact(amount, display.decimals, Math.min(display.decimals, 6))
    : amount;
  return `${value} ${display.symbol}`;
}

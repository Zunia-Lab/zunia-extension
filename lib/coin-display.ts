/**
 * How an amount of one denom reads, from the chain catalog alone. Shared by
 * the history, the transaction detail and the signing prompt.
 */

import { findCatalogByMinimalDenom, findCatalogEntry } from "./chain-catalog";
import { formatUnitsExact, shortDenom } from "./format";

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

/**
 * The ticker and decimals for `denom` as seen on `chainId`: the chain's own
 * coins first, then a coin some catalog chain issues. An `ibc/` voucher stays
 * unnamed here; the popup names the ones the wallet holds from its balances.
 */
export function coinDisplay(chainId: string, denom: string): CoinDisplay {
  const entry = findCatalogEntry(chainId);
  if (entry?.coinMinimalDenom === denom) {
    return { symbol: entry.coinDenom, decimals: entry.coinDecimals, known: true };
  }
  if (entry?.feeMinimalDenom === denom) {
    return { symbol: entry.feeDenom, decimals: entry.feeDecimals, known: true };
  }
  const base = baseDenomOf(denom);
  const issuer = base.startsWith("ibc/") ? undefined : findCatalogByMinimalDenom(base);
  if (issuer) {
    return issuer.coinMinimalDenom.toLowerCase() === base.toLowerCase()
      ? { symbol: issuer.coinDenom, decimals: issuer.coinDecimals, known: true }
      : { symbol: issuer.feeDenom, decimals: issuer.feeDecimals, known: true };
  }
  return { symbol: shortDenom(denom), decimals: 0, known: false };
}

/** `1.5 ATOM`, or raw base units and the denom when the denom has no name. */
export function formatCoin(amount: string, display: CoinDisplay): string {
  const value = display.known
    ? formatUnitsExact(amount, display.decimals, Math.min(display.decimals, 6))
    : amount;
  return `${value} ${display.symbol}`;
}

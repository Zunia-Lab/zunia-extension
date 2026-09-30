/**
 * How an amount of one denom reads, from the chain catalog alone. Shared by
 * the history, the transaction detail and the signing prompt.
 */

import {
  displayCoinSymbol,
  findCatalogEntry,
  findCurrency,
  type CatalogEntry,
} from "./chain-catalog";
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
function shown(entry: CatalogEntry, coinDenom: string, decimals: number): CoinDisplay {
  return {
    symbol: displayCoinSymbol(coinDenom, entry.bech32Prefix),
    decimals,
    known: true,
  };
}

export function coinDisplay(chainId: string, denom: string): CoinDisplay {
  const entry = findCatalogEntry(chainId);
  if (entry) {
    const onChain = findCurrency(denom);
    if (onChain && onChain.entry.chainId === entry.chainId) {
      return shown(entry, onChain.currency.coinDenom, onChain.currency.coinDecimals);
    }
    if (entry.feeMinimalDenom === denom) {
      return shown(entry, entry.feeDenom, entry.feeDecimals);
    }
  }
  const base = baseDenomOf(denom);
  if (!base.startsWith("ibc/")) {
    const issued = findCurrency(base);
    if (issued) {
      return shown(issued.entry, issued.currency.coinDenom, issued.currency.coinDecimals);
    }
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

/**
 * Coins priced from one exchange market, as an exception.
 *
 * Prices normally come from CoinGecko through the coin's `coinGeckoId` in the
 * catalog. A coin no aggregator lists yet would stay unpriced, so a chain here
 * is priced from a single spot market instead, and only while it has no
 * CoinGecko id: the day one appears in the catalog, the aggregator wins.
 *
 * One market is a thinner signal than an aggregate, so the wallet always says
 * where such a price comes from (`SpotPrice.source`), next to the price.
 *
 * The market's quote currency is USDT; lib/prices.ts converts it to the user's
 * currency with CoinGecko's Tether price. Reads go through the same opt-in as
 * every price and balance (Settings → Live balances), with no new permission:
 * the optional `https://*\/*` host access already covers the exchange's API.
 */

export interface ExchangePriceSource {
  /** Exchange whose public API answers for the market. */
  readonly exchange: "coinstore";
  /** Name shown beside the price. */
  readonly name: string;
  /** Market symbol in the exchange's API. */
  readonly market: string;
  /** Market as people read it. */
  readonly pair: string;
  /** The market's public page, linked from the price. */
  readonly url: string;
}

/** By chain id: the native coin of that chain is priced from this market. */
export const EXCHANGE_PRICE_SOURCES: Readonly<Record<string, ExchangePriceSource>> = {
  // SAF, Safrochain's coin: on Coinstore's SAF/USDT market, not on CoinGecko yet.
  "safrochain-1": {
    exchange: "coinstore",
    name: "Coinstore",
    market: "SAFUSDT",
    pair: "SAF/USDT",
    url: "https://www.coinstore.com/spot/SAFUSDT",
  },
};

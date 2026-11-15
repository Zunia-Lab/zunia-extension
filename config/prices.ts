/**
 * Coins priced from one on-chain pool, as an exception.
 *
 * Prices normally come from CoinGecko through the coin's `coinGeckoId` in the
 * catalog. A coin no aggregator lists yet would stay unpriced, so a chain here
 * is priced from its pool on Osmosis instead, read from the chain itself, and
 * only while it has no CoinGecko id: the day one appears in the catalog, the
 * aggregator wins. No exchange is involved: the price is the pool's own spot
 * price, and the 24h change compares it with the pool's time-weighted price
 * over the hour a day ago (Osmosis's twap module).
 *
 * One pool is a thinner signal than an aggregate, so the wallet always says
 * where such a price comes from (`SpotPrice.source`), next to the price.
 *
 * The pool's quote asset is USDC; lib/prices.ts converts it to the user's
 * currency with CoinGecko's USDC price. Reads go through the same opt-in as
 * every price and balance (Settings → Live balances), with no new permission:
 * the optional `https://*\/*` host access already covers the Osmosis LCD.
 */

export interface PoolPriceSource {
  /** Chain the pool lives on; its catalog LCD answers the reads. */
  readonly chainId: "osmosis-1";
  readonly poolId: string;
  /** The priced coin, as the pool holds it. */
  readonly baseDenom: string;
  /** What the price is counted in, as the pool holds it. */
  readonly quoteDenom: string;
  /** CoinGecko id of the quote asset, to convert into the user's currency. */
  readonly quoteGeckoId: string;
  /** Name shown beside the price. */
  readonly name: string;
  /** The pool as people read it. */
  readonly pair: string;
  /** The pool's public page, linked from the price. */
  readonly url: string;
}

/** By chain id: the native coin of that chain is priced from this pool. */
export const POOL_PRICE_SOURCES: Readonly<Record<string, PoolPriceSource>> = {
  // SAF, Safrochain's coin: Osmosis pool 3600, SAF against alloyed USDC.
  "safrochain-1": {
    chainId: "osmosis-1",
    poolId: "3600",
    baseDenom: "ibc/DBAA4846F611A7603EFCE6F9F46F4F561D48B1F492A576022F000614A17089CE",
    quoteDenom: "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC",
    quoteGeckoId: "usd-coin",
    name: "Osmosis",
    pair: "SAF/USDC",
    url: "https://app.osmosis.zone/pool/3600",
  },
};

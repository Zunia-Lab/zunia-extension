import { describe, expect, it } from "vitest";
import type { ChainBalance, TokenBalance } from "../balances";
import { assetValues, homeAssets, type HomeAssetChain } from "../home-assets";
import { allocationSlices, computePortfolio, toWholeCoins } from "../portfolio";
import type { PriceMap } from "../prices";

const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";

const OSMOSIS: HomeAssetChain = {
  chainId: "osmosis-1",
  chainName: "Osmosis",
  network: "mainnet",
  coinDenom: "OSMO",
  coinMinimalDenom: "uosmo",
  coinDecimals: 6,
};
const HUB: HomeAssetChain = {
  chainId: "cosmoshub-4",
  chainName: "Cosmos Hub",
  network: "mainnet",
  coinDenom: "ATOM",
  coinMinimalDenom: "uatom",
  coinDecimals: 6,
};
const SAFRO: HomeAssetChain = {
  chainId: "safrochain-1",
  chainName: "Safrochain",
  network: "mainnet",
  coinDenom: "SAF",
  coinMinimalDenom: "usaf",
  coinDecimals: 6,
};

function coin(denom: string, amount: string, symbol: string): TokenBalance {
  return { denom, amount, kind: "native", symbol, displayName: symbol, decimals: 6, decimalsKnown: true };
}

function voucher(denom: string, amount: string): TokenBalance {
  return { denom, amount, kind: "ibc", symbol: "?", displayName: "?", decimals: 6, decimalsKnown: true };
}

function chainBalance(
  chainId: string,
  native: TokenBalance,
  parts: { staked?: string; rewards?: string; tokens?: TokenBalance[] } = {},
): ChainBalance {
  return {
    chainId,
    available: native.amount,
    staked: parts.staked ?? "0",
    rewards: parts.rewards ?? "0",
    denom: native.denom,
    decimals: 6,
    symbol: native.symbol,
    tokens: [...(native.amount === "0" ? [] : [native]), ...(parts.tokens ?? [])],
  };
}

const PRICES: PriceMap = {
  "osmosis-1": { price: 0.5, change24h: 1.5 },
  "noble-1": { price: 1, change24h: 0.01 },
  "axelar-dojo-1": { price: 0.3, change24h: -2 },
  "cosmoshub-4": { price: 4, change24h: -1 },
};

const BALANCES: Record<string, ChainBalance> = {
  "osmosis-1": chainBalance("osmosis-1", coin("uosmo", "2000000", "OSMO"), {
    staked: "4000000",
    rewards: "500000",
    tokens: [voucher(USDC_N_ON_OSMOSIS, "3000000"), voucher(USDC_AXL_ON_OSMOSIS, "5000000")],
  }),
  "safrochain-1": chainBalance("safrochain-1", coin("usaf", "10000000", "SAF")),
  // Nothing available, but staking: the coin is still held.
  "cosmoshub-4": chainBalance("cosmoshub-4", coin("uatom", "0", "ATOM"), { staked: "250000" }),
};

describe("computePortfolio", () => {
  const rows = homeAssets([OSMOSIS, HUB, SAFRO], BALANCES, PRICES);
  const totals = computePortfolio(BALANCES, PRICES, assetValues(rows));

  it("adds up the rows Home lists, plus what is staked and earned", () => {
    const listed = rows.reduce((sum, row) => sum + (row.fiatValue ?? 0), 0);
    // OSMO 2 x 0.5, USDC.n 3 x 1; staked 4 OSMO + 0.25 ATOM; rewards 0.5 OSMO.
    expect(listed).toBeCloseTo(4, 9);
    expect(totals.staked).toBeCloseTo(2 + 1, 9);
    expect(totals.claimable).toBeCloseTo(0.25, 9);
    expect(totals.total).toBeCloseTo(listed + totals.staked + totals.claimable, 9);
  });

  it("leaves out and counts the holdings with no trusted price", () => {
    // OSMO (with its stake), USDC.n and the staked ATOM are priced; Axelar's
    // USDC (not Noble's coin, not AXL) and SAF (no price feed) are not.
    expect(totals.pricedAssets).toBe(3);
    expect(totals.unpricedAssets).toBe(2);
    expect(totals.pricedChains).toBe(2);
  });

  it("weights the 24h change by what is priced", () => {
    const osmo = (1 + 2 + 0.25) * 1.5;
    const usdc = 3 * 0.01;
    const atom = 1 * -1;
    expect(totals.change24h).toBeCloseTo((osmo + usdc + atom) / totals.total, 9);
  });

  it("values each chain with the tokens held on it", () => {
    const osmosis = totals.byChain.find((chain) => chain.chainId === "osmosis-1");
    expect(osmosis?.value).toBeCloseTo(1 + 2 + 0.25 + 3, 9);
    expect(osmosis?.amount).toBeCloseTo(2 + 4 + 0.5, 9);
    expect(totals.byChain.find((chain) => chain.chainId === "safrochain-1")?.value).toBeNull();
    expect(totals.byChain[0]?.chainId).toBe("osmosis-1");
    const slices = allocationSlices(totals);
    expect(slices.reduce((sum, slice) => sum + slice.share, 0)).toBeCloseTo(1, 9);
  });

  it("values a chain from its balance when Home has no row for it", () => {
    const alone = computePortfolio(BALANCES, PRICES);
    // OSMO 2 + staked 2 + rewards 0.25, and the staked ATOM; no token rows.
    expect(alone.total).toBeCloseTo(1 + 2 + 0.25 + 1, 9);
    expect(alone.pricedAssets).toBe(2);
    expect(alone.unpricedAssets).toBe(1);
  });

  it("counts a priced chain with nothing held, so the total reads 0 and not unknown", () => {
    const empty = { "osmosis-1": chainBalance("osmosis-1", coin("uosmo", "0", "OSMO")) };
    const zero = computePortfolio(empty, PRICES, assetValues(homeAssets([OSMOSIS], empty, PRICES)));
    expect(zero.total).toBe(0);
    expect(zero.pricedChains).toBe(1);
    expect(zero.pricedAssets).toBe(0);
    expect(zero.unpricedAssets).toBe(0);
    expect(zero.change24h).toBeNull();
  });

  it("ignores the zero placeholder of a chain whose balance is not read yet", () => {
    const placeholders = assetValues(homeAssets([OSMOSIS, SAFRO], {}, PRICES));
    const none = computePortfolio({}, PRICES, placeholders);
    expect(none.total).toBe(0);
    expect(none.pricedAssets + none.unpricedAssets).toBe(0);
  });
});

describe("toWholeCoins", () => {
  it("scales base units for display", () => {
    expect(toWholeCoins("1234567", 6)).toBeCloseTo(1.234567, 9);
    expect(toWholeCoins("-5", 1)).toBeCloseTo(-0.5, 9);
    expect(toWholeCoins("0", 6)).toBe(0);
    expect(toWholeCoins("12", 0)).toBe(12);
  });
});

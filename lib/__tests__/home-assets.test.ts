import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityAmountText, assetRowLabel } from "../../entrypoints/popup/screens/HomeScreen";
import { msgIbcTransfer, msgSend } from "../amino-tx";
import type { ChainBalance, TokenBalance } from "../balances";
import { catalogIconFor, findCatalogEntry } from "../chain-catalog";
import { activityAmount as activityScreenAmount, describeMessage, type ActivityItem } from "../chain-queries";
import {
  activityAmountParts,
  assetSubtitle,
  assetValues,
  groupHomeAssets,
  groupedSubtitle,
  homeAssets,
  listAmount,
  priceChainOf,
  tokenSpotPrice,
  type HomeAssetChain,
} from "../home-assets";
import { computePortfolio } from "../portfolio";
import type { PriceMap } from "../prices";
import { identityOf } from "../token-identity";

/* Denoms from the token audit (fixtures/token-identity/audit-traces.json). */
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_N_ON_INJECTIVE = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const USDC_INJ_ON_OSMOSIS = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_INJ = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
/** Picasso's ETH: its trace unwinds to `wei`, which is also Stratos's coin. */
const ETH_PICA_ON_OSMOSIS = "ibc/A23E590BA7E0D808706FB5085A449B3B9D6864AE4DDE7DAF936243CEBB2A3D43";
/** AtomOne's fee coin: AtomOne's price is ATONE's, not PHOTON's. */
const PHOTON_ON_OSMOSIS = "ibc/D6E02C5AE8A37FC2E3AB1FC8AC168878ADB870549383DFFEA9FD020C234520A7";
const ALL_USDC =
  "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
/** Osmosis's alloyed SHIB: the catalog and Osmosis disagree on its exponent, so it stays unknown. */
const ALL_SHIB =
  "factory/osmo1f588gk9dazpsueevdl2w6wfkmfmhg5gdvg2uerdlzl0atkasqhsq59qc6a/alloyed/allSHIB";
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
/** Axelar's USDC from Polygon: the longest registry ticker, `USDC.axl.polygon`. */
const POLYGON_USDC = "ibc/231FD77ECCB2DB916D314019DA30FE013202833386B1908A191D16989AD80B5A";

const OSMOSIS: HomeAssetChain = {
  chainId: "osmosis-1",
  chainName: "Osmosis",
  network: "mainnet",
  coinDenom: "OSMO",
  coinMinimalDenom: "uosmo",
  coinDecimals: 6,
  iconUrl: "/osmo.png",
};

const INJECTIVE: HomeAssetChain = {
  chainId: "injective-1",
  chainName: "Injective",
  network: "mainnet",
  coinDenom: "INJ",
  coinMinimalDenom: "inj",
  coinDecimals: 18,
  iconUrl: "/inj.png",
};

const SAFRO: HomeAssetChain = {
  chainId: "safrochain-1",
  chainName: "Safrochain",
  network: "mainnet",
  coinDenom: "SAF",
  coinMinimalDenom: "usaf",
  coinDecimals: 6,
};

/**
 * A bank row as the 0.1.2 reader labelled it. Home must not trust these
 * labels: every name, logo, decimal and price comes from the identity.
 */
function held(denom: string, amount: string, extras: Partial<TokenBalance> = {}): TokenBalance {
  return {
    denom,
    amount,
    kind: denom.startsWith("ibc/") ? "ibc" : denom.startsWith("factory/") ? "factory" : "other",
    symbol: "USDC.axl",
    displayName: "USDC.axl/IBC",
    decimals: 6,
    originChainName: "Axelar",
    baseDenom: "uusdc",
    ...extras,
  };
}

function native(denom: string, amount: string, symbol: string, decimals = 6): TokenBalance {
  return { denom, amount, kind: "native", symbol, displayName: symbol, decimals };
}

function balance(chainId: string, coin: TokenBalance, tokens: TokenBalance[] = []): ChainBalance {
  return {
    chainId,
    available: coin.amount,
    staked: "0",
    rewards: "0",
    denom: coin.denom,
    decimals: coin.decimals,
    symbol: coin.symbol,
    tokens: [coin, ...tokens],
  };
}

const PRICES: PriceMap = {
  "osmosis-1": { price: 0.5, change24h: 1.5 },
  "noble-1": { price: 1, change24h: 0.01 },
  "axelar-dojo-1": { price: 0.3, change24h: -2 },
  "cosmoshub-4": { price: 4, change24h: -1 },
  "stratos-1": { price: 0.1, change24h: 3 },
  "atomone-1": { price: 2.5, change24h: 4 },
  "injective-1": { price: 20, change24h: 2 },
  "centauri-1": { price: 0.01, change24h: 0 },
};

describe("subtitles", () => {
  it("names Noble USDC held on Osmosis by its origin, not as Axelar's", () => {
    const identity = identityOf("osmosis-1", USDC_N_ON_OSMOSIS);
    expect(identity.ticker).toBe("USDC.n");
    expect(assetSubtitle(identity)).toBe("Noble USDC · on Osmosis");
    expect(groupedSubtitle(identity)).toBe("Noble USDC");
    expect(assetSubtitle(identityOf("injective-1", USDC_N_ON_INJECTIVE))).toBe(
      "Noble USDC · on Injective",
    );
  });

  it("names Injective's own USDC as native there, and by its origin on Osmosis", () => {
    const identity = identityOf("injective-1", USDC_INJ);
    expect(identity.ticker).toBe("USDC.inj");
    expect(assetSubtitle(identity)).toBe("Native on Injective");
    // Under Injective's header: what it is, without repeating where.
    expect(groupedSubtitle(identity)).toBe("Injective USDC");
    const voucher = identityOf("osmosis-1", USDC_INJ_ON_OSMOSIS);
    expect(voucher.ticker).toBe("USDC.inj");
    expect(assetSubtitle(voucher)).toBe("Injective USDC · on Osmosis");
  });

  it("leaves the chain's own coin bare under its header and says native elsewhere", () => {
    const osmo = identityOf("osmosis-1", "uosmo");
    expect(assetSubtitle(osmo)).toBe("Native on Osmosis");
    expect(groupedSubtitle(osmo)).toBeNull();
  });

  it("names an alloy, and keeps an unknown token's short denom", () => {
    const alloy = identityOf("osmosis-1", ALL_USDC);
    expect(assetSubtitle(alloy)).toBe("Alloyed USDC · Osmosis only");
    // Under Osmosis's header, "Osmosis only" is the location part.
    expect(groupedSubtitle(alloy)).toBe("Alloyed USDC");
    const unknown = identityOf("osmosis-1", UNLISTED);
    expect(assetSubtitle(unknown)).toBe("Unknown origin · on Osmosis · ibc/0123…ABCDEF");
    expect(groupedSubtitle(unknown)).toBe("Unknown origin · ibc/0123…ABCDEF");
  });
});

describe("homeAssets", () => {
  const balances: Record<string, ChainBalance> = {
    "osmosis-1": balance("osmosis-1", native("uosmo", "3908419", "OSMO"), [
      held(USDC_N_ON_OSMOSIS, "12340000"),
      held(ATOM_ON_OSMOSIS, "1000000", { symbol: "ATOM", displayName: "ATOM/IBC" }),
      // As the reader returns a voucher it could not trace: no exponent.
      held(UNLISTED, "777", {
        symbol: "IBC·0123",
        displayName: "IBC·0123",
        decimals: 0,
        decimalsKnown: false,
      }),
    ]),
    "injective-1": balance("injective-1", native("inj", "0", "INJ", 18), [
      held(USDC_INJ, "5000000", { kind: "other", symbol: "USDC", displayName: "USDC" }),
    ]),
  };
  const rows = homeAssets([OSMOSIS, INJECTIVE, SAFRO], balances, PRICES);
  const row = (denom: string) => rows.find((asset) => asset.token.denom === denom)!;

  it("names every row from its identity, never from the reader's labels", () => {
    const usdc = row(USDC_N_ON_OSMOSIS);
    expect(usdc.identity.ticker).toBe("USDC.n");
    expect(usdc.subtitle).toBe("Noble USDC · on Osmosis");
    expect(usdc.kindLabel).toBe("IBC");
    expect(usdc.key).toBe(`osmosis-1:${USDC_N_ON_OSMOSIS}`);
    const atom = row(ATOM_ON_OSMOSIS);
    expect(atom.identity.ticker).toBe("ATOM");
    expect(atom.subtitle).toBe("Cosmos Hub ATOM · on Osmosis");
    const inj = row(USDC_INJ);
    expect(inj.identity.ticker).toBe("USDC.inj");
    expect(inj.subtitle).toBe("Native on Injective");
    expect(inj.kindLabel).toBe("ERC-20");
    for (const asset of rows) {
      expect(asset.subtitle).not.toContain("/IBC");
      expect(asset.identity.ticker).not.toContain("/IBC");
    }
  });

  it("never draws a chain logo as a non-native token's logo", () => {
    const icons = new Set(
      ["osmosis-1", "injective-1", "noble-1", "axelar-dojo-1", "cosmoshub-4"].map((chainId) =>
        catalogIconFor(findCatalogEntry(chainId)!),
      ),
    );
    for (const denom of [USDC_N_ON_OSMOSIS, ATOM_ON_OSMOSIS, USDC_INJ, UNLISTED]) {
      expect(icons.has(row(denom).identity.logoUrl ?? undefined)).toBe(false);
    }
    expect(row(USDC_N_ON_OSMOSIS).identity.logoUrl).toMatch(/usdc\.png$/);
    expect(row(UNLISTED).identity.logoUrl).toBeNull();
  });

  it("shows the seal only for a proven identity", () => {
    expect(row(USDC_N_ON_OSMOSIS).identity.proven).toBe(true);
    expect(row(UNLISTED).identity.proven).toBe(false);
  });

  it("keeps a zero native, sorts by value, and ranks the unpriced by kind and ticker", () => {
    expect(rows.map((asset) => asset.identity.ticker)).toEqual([
      // Priced, largest value first: 12.34 USDC.n at 1, 1 ATOM at 4, 3.9 OSMO at 0.5.
      "USDC.n",
      "ATOM",
      "OSMO",
      // Unpriced holdings.
      "IBC·0123",
      "USDC.inj",
      // Zero natives last.
      "INJ",
      "SAF",
    ]);
  });

  it("prices each row through its identity's origin", () => {
    expect(row("uosmo").fiatValue).toBeCloseTo(3.908419 * 0.5, 9);
    expect(row("uosmo").change24h).toBe(1.5);
    expect(row(USDC_N_ON_OSMOSIS).fiatValue).toBeCloseTo(12.34, 9);
    expect(row(USDC_N_ON_OSMOSIS).change24h).toBe(0.01);
    expect(row(ATOM_ON_OSMOSIS).fiatValue).toBeCloseTo(4, 9);
    // Injective's price is INJ's; its erc20 USDC is not INJ.
    expect(row(USDC_INJ).fiatValue).toBeNull();
    expect(row(USDC_INJ).change24h).toBeNull();
    // Nothing names the voucher, so nothing prices it, whatever the reader said.
    expect(row(UNLISTED).fiatValue).toBeNull();
  });

  it("keeps an untraced voucher in base units, with no price", () => {
    const unknown = row(UNLISTED);
    expect(unknown.identity.ticker).toBe("IBC·0123");
    expect(unknown.identity.decimalsKnown).toBe(false);
    expect(unknown.identity.decimals).toBe(0);
    expect(unknown.fiatValue).toBeNull();
  });

  it("names rows through the function the screen passes", () => {
    // The popup passes a copy of heldTokenIdentity that it replaces when new
    // token facts land; whatever it answers is what the row shows and prices.
    const asked: string[] = [];
    const [usdc] = homeAssets(
      [OSMOSIS],
      { "osmosis-1": balance("osmosis-1", native("uosmo", "0", "OSMO"), [held(UNLISTED, "5")]) },
      PRICES,
      (chainId, token) => {
        asked.push(`${chainId}:${token.denom}`);
        return identityOf("osmosis-1", token.denom === UNLISTED ? USDC_N_ON_OSMOSIS : token.denom);
      },
    ).filter((asset) => asset.token.denom === UNLISTED);
    expect(asked).toContain(`osmosis-1:${UNLISTED}`);
    expect(usdc?.identity.ticker).toBe("USDC.n");
    expect(usdc?.fiatValue).toBeCloseTo(0.000005, 12);
  });

  it("keeps decimals the reader took from the chain's metadata for an unknown token", () => {
    const [asset] = homeAssets(
      [OSMOSIS],
      {
        "osmosis-1": {
          ...balance("osmosis-1", native("uosmo", "0", "OSMO")),
          tokens: [held(UNLISTED, "5000000", { decimals: 6, decimalsKnown: true })],
        },
      },
      PRICES,
    ).filter((candidate) => candidate.token.denom === UNLISTED);
    expect(asset?.identity.decimalsKnown).toBe(true);
    expect(asset?.identity.decimals).toBe(6);
    // Known decimals still give no origin to price it by.
    expect(asset?.fiatValue).toBeNull();
  });
});

describe("prices", () => {
  const spot = (chainId: string, denom: string, extras: Partial<TokenBalance> = {}) =>
    tokenSpotPrice(held(denom, "1000000", extras), chainId, PRICES);

  it("does not price Axelar USDC as Noble's or as AXL", () => {
    // The 0.1.2 rule priced it by `uusdc`, which Noble also issues.
    expect(spot("osmosis-1", USDC_AXL_ON_OSMOSIS)).toBeUndefined();
    expect(priceChainOf(identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS))).toBeNull();
  });

  it("prices Noble USDC by Noble wherever it is held", () => {
    expect(spot("osmosis-1", USDC_N_ON_OSMOSIS)).toEqual(PRICES["noble-1"]);
    expect(spot("injective-1", USDC_N_ON_INJECTIVE)).toEqual(PRICES["noble-1"]);
    expect(spot("noble-1", "uusdc", { kind: "native" })).toEqual(PRICES["noble-1"]);
  });

  it("does not price Picasso's ETH as Stratos's coin", () => {
    // Its trace unwinds to `wei`, Stratos's minimal denom.
    expect(findCatalogEntry("stratos-1")?.coinMinimalDenom).toBe("wei");
    expect(spot("osmosis-1", ETH_PICA_ON_OSMOSIS, { baseDenom: "wei" })).toBeUndefined();
  });

  it("does not price a chain's fee coin at the chain's staking coin price", () => {
    expect(spot("osmosis-1", PHOTON_ON_OSMOSIS)).toBeUndefined();
    expect(spot("atomone-1", "uphoton")).toBeUndefined();
    expect(spot("atomone-1", "uatone", { kind: "native" })).toEqual(PRICES["atomone-1"]);
  });

  it("does not price Injective's USDC at INJ's price, at home or on Osmosis", () => {
    expect(spot("injective-1", USDC_INJ)).toBeUndefined();
    expect(spot("osmosis-1", USDC_INJ_ON_OSMOSIS)).toBeUndefined();
  });

  it("prices ATOM on Osmosis by the Hub and a staking coin by its own chain", () => {
    expect(spot("osmosis-1", ATOM_ON_OSMOSIS)).toEqual(PRICES["cosmoshub-4"]);
    expect(spot("osmosis-1", "uosmo", { kind: "native" })).toEqual(PRICES["osmosis-1"]);
  });

  it("ignores the row's base denom: an unknown voucher of `uusdc` is not priced", () => {
    // The WP-C probe: an uncatalogued chain's `uusdc` read as 12,340,000 USD.
    expect(spot("osmosis-1", UNLISTED, { baseDenom: "uusdc", decimals: 0, decimalsKnown: false })).toBeUndefined();
    expect(spot("osmosis-1", UNLISTED, { baseDenom: "uusdc", decimals: 6, decimalsKnown: true })).toBeUndefined();
  });

  it("never values a token whose decimals are unknown", () => {
    const atom = identityOf("osmosis-1", ATOM_ON_OSMOSIS);
    expect(priceChainOf(atom)).toBe("cosmoshub-4");
    expect(priceChainOf({ ...atom, decimals: 0, decimalsKnown: false })).toBeNull();
    const osmo = identityOf("osmosis-1", "uosmo");
    expect(priceChainOf({ ...osmo, decimals: 0, decimalsKnown: false })).toBeNull();
  });

  it("never prices an unproven identity, such as a walk over a look-alike chain", () => {
    const usdc = identityOf("osmosis-1", USDC_N_ON_OSMOSIS);
    expect(priceChainOf({ ...usdc, provenance: "channel-walk", proven: false })).toBeNull();
  });

  it("does not price an asset whose price id is not the origin chain's", () => {
    const atom = identityOf("osmosis-1", ATOM_ON_OSMOSIS);
    expect(priceChainOf({ ...atom, coinGeckoId: "something-else" })).toBeNull();
  });

  it("does not invent a price for factory tokens", () => {
    expect(spot("osmosis-1", "factory/osmo1abc/usdc", { kind: "factory" })).toBeUndefined();
    expect(spot("osmosis-1", ALL_USDC, { kind: "factory" })).toBeUndefined();
  });
});

describe("groupHomeAssets", () => {
  it("keeps chain order and reports spendable count per group", () => {
    const rows = homeAssets(
      [OSMOSIS, SAFRO],
      {
        "osmosis-1": balance("osmosis-1", native("uosmo", "1000000", "OSMO"), [
          held(ATOM_ON_OSMOSIS, "1", { symbol: "ATOM", displayName: "ATOM" }),
        ]),
      },
      {},
    );
    const groups = groupHomeAssets(rows, ["safrochain-1", "osmosis-1"]);
    expect(groups.map((group) => group.chainId)).toEqual(["safrochain-1", "osmosis-1"]);
    expect(groups[1]?.spendable).toBe(2);
    expect(groups[1]?.fiatValue).toBeNull();
    const atom = rows.find((row) => row.token.denom === ATOM_ON_OSMOSIS)!;
    expect(groupedSubtitle(atom.identity)).toBe("Cosmos Hub ATOM");
  });
});

describe("assetValues", () => {
  it("hands the headline each row's value as shown, and which rows are held", () => {
    const rows = homeAssets(
      [OSMOSIS, SAFRO],
      {
        "osmosis-1": balance("osmosis-1", native("uosmo", "2000000", "OSMO"), [
          held(USDC_N_ON_OSMOSIS, "3000000"),
          held(USDC_AXL_ON_OSMOSIS, "5000000"),
        ]),
      },
      PRICES,
    );
    const values = assetValues(rows);
    expect(values).toHaveLength(4);
    const byValue = (chainId: string, staking: boolean) =>
      values.filter((value) => value.chainId === chainId && value.staking === staking);
    expect(byValue("osmosis-1", true)).toEqual([
      { chainId: "osmosis-1", staking: true, held: true, value: 1, change24h: 1.5 },
    ]);
    expect(byValue("safrochain-1", true)).toEqual([
      { chainId: "safrochain-1", staking: true, held: false, value: null, change24h: null },
    ]);
    expect(byValue("osmosis-1", false).map((value) => value.value)).toEqual([3, null]);
  });
});

describe("listAmount", () => {
  it("keeps a known amount on one line, under the list policy", () => {
    const osmo = identityOf("osmosis-1", "uosmo");
    expect(listAmount("123456789", osmo, false)).toEqual({ figure: "123.45", words: null });
    expect(listAmount("20340000000", osmo, false)).toEqual({ figure: "20.34k", words: null });
    expect(listAmount("123456789", osmo, true)).toEqual({ figure: "••••", words: null });
  });

  it("stacks base units of a token whose decimals are unknown, never compacted", () => {
    const unknown = identityOf("osmosis-1", UNLISTED);
    expect(listAmount("12340000", unknown, false)).toEqual({ figure: "12340000", words: "base units" });
    expect(listAmount("1", unknown, false)).toEqual({ figure: "1", words: "base unit" });
    expect(listAmount("1000000000000000000000000", unknown, false).figure).toBe(
      "1000000000000000000000000",
    );
    expect(listAmount("12340000", unknown, true)).toEqual({ figure: "••••", words: null });
  });
});

describe("activityAmountParts", () => {
  const ME = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  /** A history row as the reader builds it, from the message itself. */
  function history(message: Record<string, unknown>, chainId = "osmosis-1"): ActivityItem {
    const { kind, title, subtitle, amount, denom, decimals, symbol, decimalsKnown, provenance } = describeMessage(
      message,
      ME,
      chainId,
    );
    return {
      chainId,
      hash: "H",
      timestamp: 0,
      success: true,
      kind,
      title,
      subtitle,
      decimals,
      symbol,
      ...(amount !== undefined ? { amount } : {}),
      ...(denom !== undefined ? { denom } : {}),
      ...(decimalsKnown !== undefined ? { decimalsKnown } : {}),
      ...(provenance !== undefined ? { provenance } : {}),
    };
  }
  const send = (denom: string, amount: string, outgoing: boolean) =>
    history({
      "@type": "/cosmos.bank.v1beta1.MsgSend",
      from_address: outgoing ? ME : "osmo1sender",
      to_address: outgoing ? "osmo1receiver" : ME,
      amount: [{ denom, amount }],
    });
  const delegate = history({
    "@type": "/cosmos.staking.v1beta1.MsgDelegate",
    delegator_address: ME,
    validator_address: "osmovaloper1x",
    amount: { denom: "uosmo", amount: "1500000" },
  });
  /** The reader's row for a voucher nothing names, whose chain metadata gave 6 decimals. */
  const metadataBalances = {
    "osmosis-1": balance("osmosis-1", native("uosmo", "0", "OSMO"), [
      held(UNLISTED, "12340000", { symbol: "IBC·0123", displayName: "IBC·0123", decimals: 6, decimalsKnown: true }),
    ]),
  };

  it("signs and formats a named coin under the history policy", () => {
    expect(activityAmountParts(send("uosmo", "12345678", true))).toEqual({
      figure: "-12.345",
      words: null,
      unit: { ticker: "OSMO", family: "OSMO" },
      text: "-12.345 OSMO",
    });
    expect(activityAmountParts(send("uosmo", "20345000000", false))?.figure).toBe("+20.345k");
    // The unit is the ticker the title names, its suffix whole.
    expect(activityAmountParts(send(USDC_N_ON_OSMOSIS, "1500000", false))).toEqual({
      figure: "+1.5",
      words: null,
      unit: { ticker: "USDC.n", family: "USDC" },
      text: "+1.5 USDC.n",
    });
  });

  it("never reads a delegation as money coming in", () => {
    // 0.1.3's first cut read `+1.5 OSMO` on Home and `1.5 OSMO` on Activity.
    expect(delegate.kind).toBe("staking");
    const parts = activityAmountParts(delegate);
    expect(parts?.figure).not.toMatch(/^\+/);
    expect(parts?.text).toBe(activityScreenAmount(delegate, "history")?.text);
    expect(parts?.unit?.ticker).toBe("OSMO");
  });

  it("shows a denom nothing names in base units, never scaled by a guess", () => {
    const amount = activityAmountParts(send(UNLISTED, "12340000", false));
    expect(amount).toEqual({
      figure: "+12340000",
      words: "base units",
      unit: { ticker: "ibc/0123…ABCDEF", family: "ibc/0123…ABCDEF" },
      text: "+12340000 base units ibc/0123…ABCDEF",
    });
    expect(activityAmountParts(send(UNLISTED, "1", false))).toMatchObject({ figure: "+1", words: "base unit" });
    // A disputed exponent stays unknown, however large the amount.
    expect(activityAmountParts(send(ALL_SHIB, "1000000000000000000000000", false))).toMatchObject({
      figure: "+1000000000000000000000000",
      words: "base units",
      unit: { ticker: "allSHIB" },
    });
  });

  it("reads a held coin nothing names on the scale its balance row uses", () => {
    const sent = send(UNLISTED, "2340000", true);
    // Home's asset row for that balance reads 12.34, so the history reads 2.34, not 2340000.
    const [row] = homeAssets([OSMOSIS], metadataBalances, PRICES).filter((asset) => asset.token.denom === UNLISTED);
    expect(listAmount(row!.token.amount, row!.identity, false)).toEqual({ figure: "12.34", words: null });
    expect(activityAmountParts(sent, metadataBalances)).toEqual({
      figure: "-2.34",
      words: null,
      unit: { ticker: "ibc/0123…ABCDEF", family: "ibc/0123…ABCDEF" },
      text: "-2.34 ibc/0123…ABCDEF",
    });
    // Without the balance, nothing proves the exponent.
    expect(activityAmountParts(sent)).toMatchObject({ figure: "-2340000", words: "base units" });
  });

  it("reads exactly as the Activity screen does", () => {
    const rows = [
      send("uosmo", "12345678", true),
      send(USDC_N_ON_OSMOSIS, "1500000", false),
      send(UNLISTED, "12340000", false),
      send(UNLISTED, "2340000", true),
      send(ALL_SHIB, "1000000000000000000000000", false),
      delegate,
      history({
        "@type": "/cosmos.staking.v1beta1.MsgUndelegate",
        delegator_address: ME,
        validator_address: "osmovaloper1x",
        amount: { denom: "uosmo", amount: "2000000" },
      }),
      history({
        "@type": "/ibc.applications.transfer.v1.MsgTransfer",
        sender: ME,
        receiver: "noble1receiver",
        source_channel: "channel-750",
        token: { denom: USDC_N_ON_OSMOSIS, amount: "2500000" },
      }),
    ];
    for (const row of rows) {
      for (const balances of [undefined, metadataBalances]) {
        const parts = activityAmountParts(row, balances);
        const screen = activityScreenAmount(row, "history", balances ? { balances } : {});
        expect(parts?.text, row.title).toBe(screen?.text);
        // The parts are that text, split for layout and nothing else.
        expect([parts?.figure, parts?.words, parts?.unit?.ticker].filter(Boolean).join(" ")).toBe(screen?.text);
      }
    }
  });

  it("shows nothing when the row moved nothing", () => {
    expect(activityAmountParts({ ...delegate, amount: undefined })).toBeNull();
    expect(activityAmountParts({ ...delegate, amount: "0" })).toBeNull();
    expect(
      activityAmountParts(
        history({ "@type": "/cosmos.gov.v1beta1.MsgVote", proposal_id: "1", voter: ME, option: "VOTE_OPTION_YES" }),
      ),
    ).toBeNull();
  });
});

describe("rows for screen readers", () => {
  const rows = homeAssets(
    [OSMOSIS],
    {
      "osmosis-1": balance("osmosis-1", native("uosmo", "123456789", "OSMO"), [
        held(USDC_N_ON_OSMOSIS, "12340000"),
        held(UNLISTED, "12340000", { symbol: "IBC·0123", displayName: "IBC·0123", decimals: 0, decimalsKnown: false }),
      ]),
    },
    PRICES,
  );
  const label = (denom: string, hidden = false) => {
    const row = rows.find((asset) => asset.token.denom === denom)!;
    const fiat = row.fiatValue === null ? null : `$${row.fiatValue.toFixed(2)}`;
    return assetRowLabel(row.identity, listAmount(row.token.amount, row.identity, hidden), fiat, hidden);
  };

  it("says the ticker whole, where the token comes from and sits, the seal, then the amount", () => {
    // The row's own text reads the ticker in two pieces (`USDC` `.n`) and the seal has no words.
    expect(label(USDC_N_ON_OSMOSIS)).toBe("USDC.n, USDC from Noble, on Osmosis, verified, 12.34, $12.34");
    expect(label("uosmo")).toBe("OSMO, native on Osmosis, verified, 123.45, $61.73");
    expect(label(UNLISTED)).toBe("IBC·0123, Unknown token ibc/0123…ABCDEF, on Osmosis, 12340000 base units");
  });

  it("never reads a hidden amount or its value", () => {
    expect(label(USDC_N_ON_OSMOSIS, true)).toBe("USDC.n, USDC from Noble, on Osmosis, verified, amount hidden");
    expect(label(USDC_N_ON_OSMOSIS, true)).not.toContain("•");
  });
});

describe("ActivityAmountText", () => {
  const item = (amount: string, denom: string, symbol: string, extras: Partial<ActivityItem> = {}): ActivityItem => ({
    chainId: "osmosis-1",
    hash: "H",
    kind: "received",
    title: `Receive ${symbol}`,
    subtitle: "from osmo1sender",
    amount,
    denom,
    decimals: 6,
    symbol,
    decimalsKnown: true,
    provenance: "table",
    timestamp: 0,
    success: true,
    ...extras,
  });
  const html = (row: ActivityItem, hidden = false) =>
    renderToStaticMarkup(createElement(ActivityAmountText, { item: row, hidden }));

  it("gives screen readers the unit as one word, and keeps the full text as the tooltip", () => {
    const markup = html(item("20345000000", POLYGON_USDC, "USDC.axl.polygon"));
    expect(markup).toContain('title="+20.345k USDC.axl.polygon"');
    expect(markup).toContain('<span class="sr-only">USDC.axl.polygon</span>');
    // The two-piece ticker is drawn for the eye only.
    expect(markup).toMatch(/<span aria-hidden="true"[^>]*><span class="flex[^"]*">.*USDC<\/span>/);
  });

  it("lets the words and an unnamed coin's short denom wrap apart, rather than cut", () => {
    const markup = html(
      item("12340000", UNLISTED, "IBC·0123", { decimals: 0, decimalsKnown: false, provenance: "unknown" }),
    );
    expect(markup).toContain(">+12340000<");
    expect(markup).toMatch(/<span class="[^"]*whitespace-nowrap[^"]*">base units<\/span>/);
    expect(markup).toContain('<span class="sr-only">ibc/0123…ABCDEF</span>');
  });

  it("shows only the mask when amounts are hidden, and nothing for a row that moved nothing", () => {
    const markup = html(item("12340000", USDC_N_ON_OSMOSIS, "USDC.n"), true);
    expect(markup).toContain("••••");
    expect(markup).not.toContain("USDC");
    expect(html(item("0", "uosmo", "OSMO"))).toBe("");
  });
});

/* -------------------------------------------------------------------------- *
 * Display only
 * -------------------------------------------------------------------------- */

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** What SendScreen signs for a Home row's token: the bank's exact denom and base units (lib/amino-tx.ts). */
const USDC_INJ_SEND =
  '{"type":"cosmos-sdk/MsgSend","value":{"from_address":"inj1from","to_address":"inj1to",' +
  '"amount":[{"denom":"erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a","amount":"5000000"}]}}';
const USDC_N_TRANSFER =
  '{"type":"cosmos-sdk/MsgTransfer","value":{"source_port":"transfer","source_channel":"channel-750",' +
  '"token":{"denom":"ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4","amount":"12340000"},' +
  '"sender":"osmo1from","receiver":"noble1to","timeout_height":{},"timeout_timestamp":"1791202200000000000",' +
  '"memo":"{\\"forward\\":{\\"receiver\\":\\"cosmos1to\\",\\"port\\":\\"transfer\\",\\"channel\\":\\"channel-4\\"}}"}}';

describe("display only: Home never changes what Send and Swap sign", () => {
  it("reads the balances without writing to them, and hands on the bank's own rows", () => {
    const balances = deepFreeze({
      "osmosis-1": balance("osmosis-1", native("uosmo", "3908419", "OSMO"), [
        held(USDC_N_ON_OSMOSIS, "12340000"),
        held(UNLISTED, "777", { symbol: "IBC·0123", displayName: "IBC·0123", decimals: 0, decimalsKnown: false }),
        held(ALL_SHIB, "1000000000000000000000000", { kind: "factory", decimals: 0, decimalsKnown: false }),
      ]),
      "injective-1": balance("injective-1", native("inj", "1500000000000000000", "INJ", 18), [
        held(USDC_INJ, "5000000", { kind: "other", symbol: "USDC.inj", displayName: "USDC.inj" }),
      ]),
    } satisfies Record<string, ChainBalance>);
    const prices = deepFreeze({ ...PRICES });
    const before = JSON.stringify(balances);

    // Everything Home and a chain's page compute from them; a write to a frozen row throws.
    const rows = homeAssets([OSMOSIS, INJECTIVE, SAFRO], balances, prices);
    computePortfolio(balances, prices, assetValues(rows));
    groupHomeAssets(rows, ["osmosis-1", "injective-1"]);
    for (const row of rows) {
      listAmount(row.token.amount, row.identity, false);
      assetSubtitle(row.identity);
      groupedSubtitle(row.identity);
      tokenSpotPrice(row.token, row.chainId, prices);
    }
    expect(JSON.stringify(balances)).toBe(before);

    // Each row carries the bank's own object: Send signs its denom and converts with its decimals.
    for (const row of rows) {
      const bank = balances[row.chainId as keyof typeof balances]?.tokens.find((token) => token.denom === row.token.denom);
      if (bank) expect(row.token).toBe(bank);
      expect(row.key).toBe(`${row.chainId}:${row.token.denom}`);
      expect(row.identity.denom).toBe(row.token.denom);
    }

    // The exact case of the erc20 denom, never the catalog's lowercase (which hashes elsewhere).
    const usdcInj = rows.find((row) => row.identity.ticker === "USDC.inj" && row.chainId === "injective-1")!;
    expect(
      JSON.stringify(
        msgSend({
          fromAddress: "inj1from",
          toAddress: "inj1to",
          amount: [{ denom: usdcInj.token.denom, amount: usdcInj.token.amount }],
        }),
      ),
    ).toBe(USDC_INJ_SEND);
    // A voucher signs its own ibc/ denom, not its origin's `uusdc`; the channel and the packet memo pass through.
    const usdcN = rows.find((row) => row.identity.ticker === "USDC.n" && row.chainId === "osmosis-1")!;
    expect(usdcN.identity.originDenom).toBe("uusdc");
    expect(
      JSON.stringify(
        msgIbcTransfer({
          sourceChannel: "channel-750",
          token: { denom: usdcN.token.denom, amount: usdcN.token.amount },
          sender: "osmo1from",
          receiver: "noble1to",
          timeoutTimestamp: "1791202200000000000",
          memo: '{"forward":{"receiver":"cosmos1to","port":"transfer","channel":"channel-4"}}',
        }),
      ),
    ).toBe(USDC_N_TRANSFER);
    // Amounts are signed in base units as the bank holds them, never the figure Home shows.
    expect(listAmount(usdcN.token.amount, usdcN.identity, false).figure).toBe("12.34");
    expect(usdcN.token.amount).toBe("12340000");
  });
});

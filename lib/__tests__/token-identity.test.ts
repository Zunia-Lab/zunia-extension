import fs from "node:fs";
import path from "node:path";

import { InterchainError } from "@zunialab/interchain";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allCatalogEntries,
  catalogIconFor,
  chainTicker,
  feeTicker,
  findCatalogEntry,
  findCurrencyOn,
  setCustomCatalogEntries,
  uniqueIssuerOf,
  type CatalogEntry,
} from "../chain-catalog";
import { coinDisplay } from "../coin-display";
import { searchItems } from "../picker";
import {
  channelCounterpartyOf,
  familyOf,
  ibcDenomFor,
  identityOf,
  osmosisDenomOf,
  shortDenom,
  tickerFor,
  tokenKeywords,
  tokenKindLabel,
  tokenTableRows,
  tokenText,
  type DenomTraceResolver,
  type TokenIdentity,
} from "../token-identity";
import { TOKEN_REGISTRY_SOURCES } from "../token-registry.generated";
import audit from "./fixtures/token-identity/audit-traces.json";

const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const USDC_INJ_ON_OSMOSIS = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_N_ON_INJECTIVE = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const ALL_USDC = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
/** Eureka ETH as the Hub holds it, and its Osmosis voucher over channel-0. */
const HUB_EUREKA_ETH = "ibc/C0B53D3D23827AE38058BED0BDCD554229278AF530A8D265FCF6DFF7C4B2ADFF";
const EUREKA_ETH_ON_OSMOSIS = "ibc/20850C646CDDDC2270E9BBDB08558B5FEE57B647EC6827F41096AABFD8A0471B";
/** Picasso's voucher of Ethereum ETH, the issuer side of ETH.pica. */
const PICASSO_ETH = "ibc/F9D075D4079FC56A9C49B601E54A45292C319D8B0E8CC0F8439041130AA7166C";
const WORMHOLE_SOLANA_USDC =
  "factory/wormhole14ejqjyq8um4p3xfqj74yld5waqljf88fz25yxnma0cngspxe3les00fpjx/HJk1XMDRNUbRrpKkNZYui7SwWDMjXZAsySzqgyNcQoU3";
/** A voucher nothing lists. */
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

afterEach(() => {
  setCustomCatalogEntries([]);
  vi.unstubAllGlobals();
});

/** A custom chain as custom-chains.ts stores it. */
function customChain(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    chainId: "my-osmo-fork-1",
    chainName: "My Osmosis Fork",
    bech32Prefix: "osmo",
    coinType: 118,
    network: "testnet",
    coinDenom: "OSMO",
    coinMinimalDenom: "uosmo",
    coinDecimals: 6,
    feeDenom: "OSMO",
    feeMinimalDenom: "uosmo",
    feeDecimals: 6,
    inCosmosRegistry: false,
    ...overrides,
  };
}

describe("the audit's vouchers", () => {
  it("hash to their denoms, and the table holds each live trace", () => {
    for (const trace of audit.traces) {
      expect(ibcDenomFor(trace.path, trace.baseDenom)).toBe(trace.denom);
      const row = tokenTableRows(trace.chainId).find((candidate) => candidate.denom === trace.denom);
      expect(row, trace.denom).toBeDefined();
      expect(row?.path).toBe(trace.path);
      expect(row?.baseDenom).toBe(trace.baseDenom);
    }
  });

  it("map each first-hop channel to the chain at its other end", () => {
    for (const channel of audit.channels) {
      expect(channelCounterpartyOf(channel.chainId, channel.channelId), channel.channelId).toBe(
        channel.counterpartyChainId,
      );
    }
    expect(channelCounterpartyOf("osmosis-1", "channel-999999")).toBeNull();
  });

  it("read as the naming table, proven, with known decimals", () => {
    for (const expected of audit.naming) {
      const identity = identityOf(expected.chainId, expected.denom);
      expect(
        {
          ticker: identity.ticker,
          originChainId: identity.originChainId,
          originDenom: identity.originDenom,
        },
        `${expected.chainId}:${expected.denom}`,
      ).toEqual({
        ticker: expected.ticker,
        originChainId: expected.originChainId,
        originDenom: expected.originDenom,
      });
      expect(identity.provenance).not.toBe("unknown");
      expect(identity.proven).toBe(true);
      expect(identity.decimalsKnown).toBe(true);
      expect(identity.key).toBe(`${expected.chainId}:${expected.denom}`);
    }
  });

  it("never reads Noble USDC as Axelar's, nor Picasso ETH as STOS", () => {
    const noble = identityOf("osmosis-1", USDC_N_ON_OSMOSIS);
    const axelar = identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS);
    expect(noble.ticker).not.toBe(axelar.ticker);
    expect(noble.originChainName).toBe("Noble");
    expect(axelar.originChainName).toBe("Axelar");
    expect(identityOf("injective-1", USDC_N_ON_INJECTIVE).ticker).toBe("USDC.n");
    const eth = identityOf("osmosis-1", "ibc/A23E590BA7E0D808706FB5085A449B3B9D6864AE4DDE7DAF936243CEBB2A3D43");
    expect(eth.ticker).toBe("ETH.pica");
    expect(eth.family).toBe("ETH");
    expect(eth.decimals).toBe(18);
  });
});

describe("USDC.inj", () => {
  it("keeps the mixed-case erc20 origin that hashes to the voucher Osmosis trades", () => {
    const onOsmosis = identityOf("osmosis-1", USDC_INJ_ON_OSMOSIS);
    expect(onOsmosis.originDenom).toBe(USDC_INJ_ERC20);
    expect(ibcDenomFor("transfer/channel-122", USDC_INJ_ERC20)).toBe(USDC_INJ_ON_OSMOSIS);
    expect(osmosisDenomOf("injective-1", USDC_INJ_ERC20)).toBe(USDC_INJ_ON_OSMOSIS);

    // The catalog's lowercase spelling is a different, empty denom.
    const lowercase = USDC_INJ_ERC20.toLowerCase();
    expect(ibcDenomFor("transfer/channel-122", lowercase)).toBe(
      "ibc/D3B2A035362AF6B16BE95236AD85D408259B3611CA220781ECB7922C60ED7436",
    );
    expect(osmosisDenomOf("injective-1", lowercase)).toBeNull();

    const onInjective = identityOf("injective-1", USDC_INJ_ERC20);
    expect(onInjective.ticker).toBe("USDC.inj");
    expect(onInjective.osmosisDenom).toBe(USDC_INJ_ON_OSMOSIS);
    expect(onInjective.kind).toBe("erc20");
  });

  it("does not lend its name to another spelling of the erc20 denom", () => {
    // The catalog's lowercase row would match through case-folding, but bank
    // denoms are case-sensitive: that spelling holds nothing, and a plan
    // built from it would trade ibc/D3B2…, not USDC.inj.
    for (const spelling of [USDC_INJ_ERC20.toLowerCase(), "erc20:0xA00C59fF5a080D2b954d0c75e46E22a0c371235a"]) {
      const identity = identityOf("injective-1", spelling);
      expect(identity, spelling).toMatchObject({ provenance: "unknown", proven: false, decimalsKnown: false });
      expect(identity.ticker, spelling).not.toBe("USDC.inj");
      expect(identity.osmosisDenom, spelling).toBeNull();
    }
  });

  it("gives the Osmosis row the issuer's channel pair for delivery to Injective", () => {
    const row = tokenTableRows("osmosis-1").find((candidate) => candidate.denom === USDC_INJ_ON_OSMOSIS);
    expect(row).toMatchObject({
      originChainId: "injective-1",
      originDenom: USDC_INJ_ERC20,
      channelId: "channel-122",
      counterpartyChainId: "injective-1",
      counterpartyChannelId: "channel-8",
      verified: true,
      stable: true,
    });
  });
});

describe("the issuer's own denom", () => {
  /** The ticker before the per-chain collision guard (DGN·CD64 is Osmosis-only). */
  const unguarded = (identity: TokenIdentity) =>
    tickerFor({
      family: identity.family,
      originChainId: identity.originChainId,
      bridge: identity.bridge,
      sourceNetwork: identity.sourceNetwork,
      alloyed: identity.alloyed,
    });

  it("reads exactly like the voucher that proves it, on every issuer", () => {
    // Delivery to the issuer shows the issuer's denom, so it must be named,
    // proven and spelled like the Osmosis row, catalog listing or not.
    let checked = 0;
    for (const row of tokenTableRows("osmosis-1")) {
      if (!row.channelId || row.counterpartyChainId !== row.originChainId) continue;
      const onOsmosis = identityOf("osmosis-1", row.denom);
      const atIssuer = identityOf(row.originChainId, row.originDenom);
      const label = `${row.originChainId}:${row.originDenom}`;
      expect(atIssuer.proven, label).toBe(true);
      // One issuer wherever it is held, even through a relay (LBTC is
      // Lombard's on Osmosis too, although Osmosis lists it as the Hub's).
      expect([atIssuer.originChainId, atIssuer.originDenom], label).toEqual([
        onOsmosis.originChainId,
        onOsmosis.originDenom,
      ]);
      expect(unguarded(atIssuer), label).toBe(unguarded(onOsmosis));
      expect(atIssuer.decimalsKnown && atIssuer.decimals, label).toBe(onOsmosis.decimalsKnown && onOsmosis.decimals);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(250);
  });

  it("names issuer denoms the catalog does not list or names its own way", () => {
    expect(identityOf("axelar-dojo-1", "polygon-uusdt")).toMatchObject({
      ticker: "USDT.axl.polygon",
      decimals: 6,
      provenance: "table",
      proven: true,
      kind: "other",
    });
    expect(identityOf("centauri-1", PICASSO_ETH)).toMatchObject({
      ticker: "ETH.pica",
      originChainId: "centauri-1",
      path: "transfer/channel-52",
      decimals: 18,
    });
    // Not USDC.wormhole from the bech32 prefix: the bridge's tag, as on Osmosis.
    expect(identityOf("wormchain", WORMHOLE_SOLANA_USDC).ticker).toBe("USDC.wh.sol");
    const wormholeUsdc = findCatalogEntry("wormchain")?.currencies?.find((currency) => currency.coinDenom === "USDC");
    expect(wormholeUsdc && identityOf("wormchain", wormholeUsdc.coinMinimalDenom).ticker).toBe("USDC.wh");
    // Relayed: Osmosis lists LBTC as the Hub's; the issuer is Lombard.
    const lbtc = tokenTableRows("osmosis-1").find((row) => row.aliases.includes("LBTC") || row.family === "LBTC");
    expect(lbtc?.originChainId).toBe("cosmoshub-4");
    const lbtcOnOsmosis = identityOf("osmosis-1", lbtc?.denom ?? "");
    expect(lbtcOnOsmosis).toMatchObject({ originChainId: "ledger-mainnet-1", originDenom: "uclbtc" });
    expect(lbtcOnOsmosis.hopChainIds).toEqual(["cosmoshub-4", "ledger-mainnet-1"]);
    expect(tokenText(lbtcOnOsmosis, "row")).toBe("Lombard Ledger LBTC · on Osmosis");
    // Terra lists ROAR by its bare contract, IBC spells it `cw20:`: one token.
    const roar = "terra1lxx40s29qvkrcj8fsa3yzyehy7w50umdvvnls2r830rys6lu2zns63eelv";
    expect(identityOf("phoenix-1", roar).ticker).toBe("ROAR");
    expect(identityOf("phoenix-1", `cw20:${roar}`).ticker).toBe("ROAR");
  });

  it("names the Hub's Eureka tokens, which no channel walk can", () => {
    const row = tokenTableRows("cosmoshub-4").find((candidate) => candidate.denom === HUB_EUREKA_ETH);
    expect(row).toMatchObject({
      originChainId: "cosmoshub-4",
      originDenom: HUB_EUREKA_ETH,
      path: "transfer/08-wasm-1369",
      channelId: null,
      counterpartyChainId: null,
    });
    expect(row && ibcDenomFor(row.path, row.baseDenom)).toBe(HUB_EUREKA_ETH);
    expect(identityOf("cosmoshub-4", HUB_EUREKA_ETH)).toMatchObject({
      ticker: "ETH.eureka",
      bridge: "eureka",
      provenance: "table",
      proven: true,
      decimals: 18,
      osmosisDenom: EUREKA_ETH_ON_OSMOSIS,
    });
    expect(identityOf("osmosis-1", EUREKA_ETH_ON_OSMOSIS)).toMatchObject({
      ticker: "ETH.eureka",
      originChainId: "cosmoshub-4",
      originDenom: HUB_EUREKA_ETH,
    });
    // A light-client hop is not a channel: the map gains nothing from it.
    expect(channelCounterpartyOf("cosmoshub-4", "08-wasm-1369")).toBeNull();
  });
});

describe("tickers", () => {
  it("name each chain's staking coin by the identity rule", () => {
    const ticker = (chainId: string) => {
      const entry = findCatalogEntry(chainId);
      if (!entry) throw new Error(chainId);
      return chainTicker(entry);
    };
    expect(ticker("cosmoshub-4")).toBe("ATOM");
    expect(ticker("noble-1")).toBe("USDC.n");
    expect(ticker("axelar-dojo-1")).toBe("AXL");
    expect(ticker("osmosis-1")).toBe("OSMO");
    expect(ticker("injective-1")).toBe("INJ");
    expect(ticker("phoenix-1")).toBe("LUNA");
    expect(ticker("columbus-5")).toBe("LUNC");
    const atomOne = findCatalogEntry("atomone-1");
    expect(atomOne && feeTicker(atomOne)).toBe("PHOTON");
  });

  it("never tag a chain that pays gas in someone else's coin", () => {
    // Initia L2s pay in INIT: bridged by OPinit (`l2/…`) or as a voucher.
    // Neither issued it, so neither reads `INIT.init` after its own prefix.
    for (const chainId of ["intergaze-1", "moo-1"]) {
      const entry = findCatalogEntry(chainId);
      expect(entry && chainTicker(entry), chainId).toBe("INIT");
    }
    const intergaze = findCatalogEntry("intergaze-1");
    expect(intergaze && identityOf("intergaze-1", intergaze.coinMinimalDenom).ticker).toBe("INIT");
  });

  it("match the naming table for every variant", () => {
    const viaOrigin = (originChainId: string, originDenom: string) => {
      const denom = osmosisDenomOf(originChainId, originDenom);
      if (!denom) throw new Error(`${originChainId}:${originDenom} has no Osmosis voucher`);
      return identityOf("osmosis-1", denom).ticker;
    };
    const snapshot = {
      "USDC (Noble)": viaOrigin("noble-1", "uusdc"),
      "USDC (Injective)": viaOrigin("injective-1", USDC_INJ_ERC20),
      "USDC (Axelar)": viaOrigin("axelar-dojo-1", "uusdc"),
      "USDC (Axelar, Polygon)": viaOrigin("axelar-dojo-1", "polygon-uusdc"),
      "USDC (Axelar, Avalanche)": viaOrigin("axelar-dojo-1", "avalanche-uusdc"),
      "USDC (Gravity)": viaOrigin("gravity-bridge-3", "gravity0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"),
      "USDC (alloy)": identityOf("osmosis-1", ALL_USDC).ticker,
      "USDT (Kava)": viaOrigin("kava_2222-10", "erc20/tether/usdt"),
      "USDT (Axelar)": viaOrigin("axelar-dojo-1", "uusdt"),
      "USDT (Axelar, Arbitrum)": viaOrigin("axelar-dojo-1", "arbitrum-uusdt"),
      "USDT (Peggy)": viaOrigin("injective-1", "peggy0xdAC17F958D2ee523a2206206994597C13D831ec7"),
      "USDT (Gravity)": viaOrigin("gravity-bridge-3", "gravity0xdAC17F958D2ee523a2206206994597C13D831ec7"),
      "ETH (Axelar)": viaOrigin("axelar-dojo-1", "weth-wei"),
      "ETH (Axelar, Arbitrum)": viaOrigin("axelar-dojo-1", "arbitrum-weth-wei"),
      "ETH (Gravity)": viaOrigin("gravity-bridge-3", "gravity0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
      "ETH (Picasso)": viaOrigin(
        "centauri-1",
        "ibc/F9D075D4079FC56A9C49B601E54A45292C319D8B0E8CC0F8439041130AA7166C",
      ),
      "USDC (Wormhole, Solana)": viaOrigin("wormchain", WORMHOLE_SOLANA_USDC),
      "WBTC (Axelar)": viaOrigin("axelar-dojo-1", "wbtc-satoshi"),
      "WBTC (Osmosis)": identityOf(
        "osmosis-1",
        "factory/osmo1z0qrq605sjgcqpylfl4aa6s90x738j7m58wyatt0tdzflg2ha26q67k743/wbtc",
      ).ticker,
      "DAI (Axelar)": viaOrigin("axelar-dojo-1", "dai-wei"),
      "ATOM (Hub)": viaOrigin("cosmoshub-4", "uatom"),
      "stATOM (Stride)": viaOrigin("stride-1", "stuatom"),
      "LUNA (Terra)": viaOrigin("phoenix-1", "uluna"),
      "AXL (Axelar)": viaOrigin("axelar-dojo-1", "uaxl"),
    };
    expect(snapshot).toEqual({
      "USDC (Noble)": "USDC.n",
      "USDC (Injective)": "USDC.inj",
      "USDC (Axelar)": "USDC.axl",
      "USDC (Axelar, Polygon)": "USDC.axl.polygon",
      "USDC (Axelar, Avalanche)": "USDC.axl.avax",
      "USDC (Gravity)": "USDC.grv",
      "USDC (alloy)": "allUSDC",
      "USDT (Kava)": "USDT.kava",
      "USDT (Axelar)": "USDT.axl",
      "USDT (Axelar, Arbitrum)": "USDT.axl.arb",
      "USDT (Peggy)": "USDT.peggy",
      "USDT (Gravity)": "USDT.grv",
      "ETH (Axelar)": "ETH.axl",
      "ETH (Axelar, Arbitrum)": "ETH.axl.arb",
      "ETH (Gravity)": "ETH.grv",
      "ETH (Picasso)": "ETH.pica",
      "USDC (Wormhole, Solana)": "USDC.wh.sol",
      "WBTC (Axelar)": "WBTC.axl",
      "WBTC (Osmosis)": "WBTC.osmo",
      "DAI (Axelar)": "DAI.axl",
      "ATOM (Hub)": "ATOM",
      "stATOM (Stride)": "stATOM",
      "LUNA (Terra)": "LUNA",
      "AXL (Axelar)": "AXL",
    });
  });

  it("apply the rule from origin, bridge and network", () => {
    expect(tickerFor({ family: "USDC", originChainId: "osmosis-1", alloyed: true })).toBe("allUSDC");
    expect(tickerFor({ family: "USDC", originChainId: "noble-1" })).toBe("USDC.n");
    expect(tickerFor({ family: "USDC", originChainId: "axelar-dojo-1", bridge: "axl", sourceNetwork: "polygon" })).toBe(
      "USDC.axl.polygon",
    );
    // The network only separates multi-issuer families; WAVAX comes from one place.
    expect(tickerFor({ family: "WAVAX", originChainId: "axelar-dojo-1", bridge: "axl", sourceNetwork: "avax" })).toBe(
      "WAVAX.axl",
    );
    expect(tickerFor({ family: "ATOM", originChainId: "cosmoshub-4" })).toBe("ATOM");
    expect(tickerFor({ family: "ATOM", originChainId: "thorchain-1" })).toBe("ATOM.thor");
    expect(tickerFor({ family: "ETH", originChainId: "injective-1", bridge: "peggy" })).toBe("ETH.peggy");
    expect(tickerFor({ family: "USDC", originChainId: null })).toBe("USDC");
    // A testnet is never an issuer, so it is never tagged.
    expect(tickerFor({ family: "OSMO", originChainId: "osmo-test-5" })).toBe("OSMO");
  });

  it("strip issuer decorations down to the family", () => {
    expect(familyOf("axlUSDC")).toBe("USDC");
    expect(familyOf("PolygonUSDC.axl")).toBe("USDC");
    expect(familyOf("USDC.e.matic.axl")).toBe("USDC");
    expect(familyOf("USDC.n")).toBe("USDC");
    expect(familyOf("solana.USDC.wh")).toBe("USDC");
    expect(familyOf("avalanche.USDC.wh")).toBe("USDC");
    expect(familyOf("USDt")).toBe("USDT");
    expect(familyOf("WETH")).toBe("ETH");
    expect(familyOf("wETH")).toBe("ETH");
    expect(familyOf("ETH.BASE")).toBe("ETH");
    expect(familyOf("stATOM")).toBe("stATOM");
    expect(familyOf("wstETH")).toBe("wstETH");
    expect(familyOf("DGN.old")).toBe("DGN.old");
  });

  it("leave no two denoms on one chain with the same ticker", () => {
    const denomsByChain = new Map<string, Set<string>>();
    const add = (chainId: string, denom: string) => {
      const set = denomsByChain.get(chainId) ?? new Set<string>();
      set.add(denom);
      denomsByChain.set(chainId, set);
    };
    for (const row of tokenTableRows()) {
      add(row.heldOnChainId, row.denom);
      // The issuer's own denom too: delivery to the issuer shows it.
      if (row.channelId && row.counterpartyChainId === row.originChainId) add(row.originChainId, row.originDenom);
    }
    for (const chainId of [...denomsByChain.keys()]) {
      for (const currency of findCatalogEntry(chainId)?.currencies ?? []) {
        if (!currency.coinMinimalDenom.startsWith("ibc/")) add(chainId, currency.coinMinimalDenom);
      }
    }
    expect(denomsByChain.size).toBeGreaterThan(100);
    for (const [chainId, denoms] of denomsByChain) {
      const byTicker = new Map<string, string[]>();
      for (const denom of denoms) {
        // One CW20 under the catalog's bare spelling and IBC's `cw20:` one.
        if (denom.startsWith("cw20:") && denoms.has(denom.slice("cw20:".length))) continue;
        const { ticker } = identityOf(chainId, denom);
        byTicker.set(ticker, [...(byTicker.get(ticker) ?? []), denom]);
      }
      const shared = [...byTicker.entries()].filter(([, list]) => list.length > 1);
      expect(shared, chainId).toEqual([]);
    }
  });
});

describe("custom chains and testnets", () => {
  it("cannot rename OSMO, and are never proven", () => {
    setCustomCatalogEntries([customChain({})]);
    const osmosis = findCatalogEntry("osmosis-1");
    expect(osmosis && chainTicker(osmosis)).toBe("OSMO");
    expect(identityOf("osmosis-1", "uosmo").ticker).toBe("OSMO");
    expect(identityOf("osmosis-1", "uosmo").proven).toBe(true);

    const custom = findCatalogEntry("my-osmo-fork-1");
    expect(custom && chainTicker(custom)).toBe("OSMO");
    const forked = identityOf("my-osmo-fork-1", "uosmo");
    expect(forked.ticker).toBe("OSMO");
    expect(forked.testnet).toBe(true);
    expect(forked.proven).toBe(false);
  });

  it("keep a mainnet asset's name on a chain the user added, unproven", () => {
    // stargaze-1 is not bundled, so a user may add it; the table still knows
    // the vouchers held there, which stay their issuers' tokens.
    setCustomCatalogEntries([
      customChain({ chainId: "stargaze-1", chainName: "My Stargaze", bech32Prefix: "stars", network: "mainnet" }),
    ]);
    const row = tokenTableRows("stargaze-1").find((candidate) => candidate.originChainId === "osmosis-1");
    expect(row).toBeDefined();
    const held = identityOf("stargaze-1", row?.denom ?? "");
    expect(held).toMatchObject({ originChainId: "osmosis-1", testnet: true, proven: false });
    expect(held.name.startsWith("Osmosis ")).toBe(true);
    expect(tokenText(held, "row")).toBe(`${held.name} · on My Stargaze`);
  });

  it("show a testnet coin under its own symbol", () => {
    const testnet = allCatalogEntries().find((entry) => entry.chainId === "osmo-test-5");
    expect(testnet).toBeDefined();
    const identity = identityOf("osmo-test-5", testnet?.coinMinimalDenom ?? "");
    expect(identity.ticker).toBe(testnet?.coinDenom);
    expect(identity.testnet).toBe(true);
  });

  it("only name a base denom by an issuer when exactly one registry chain issues it", () => {
    expect(uniqueIssuerOf("uusdc")).toBeUndefined();
    expect(uniqueIssuerOf("uluna")).toBeUndefined();
    expect(uniqueIssuerOf("uatom")?.entry.chainId).toBe("cosmoshub-4");
    // Stratos calls its coin `wei`; that does not make it Ethereum's issuer.
    expect(uniqueIssuerOf("wei")).toBeUndefined();
    setCustomCatalogEntries([customChain({ chainId: "mine-1", coinMinimalDenom: "uatom" })]);
    expect(uniqueIssuerOf("uatom")?.entry.chainId).toBe("cosmoshub-4");
  });
});

describe("unknown and unproven identities", () => {
  it("leave an unlisted voucher unknown, in base units", () => {
    const identity = identityOf("osmosis-1", UNLISTED);
    expect(identity).toMatchObject({
      provenance: "unknown",
      proven: false,
      originChainId: null,
      originDenom: null,
      decimals: 0,
      decimalsKnown: false,
      logoUrl: null,
      ticker: "IBC·0123",
      kind: "ibc",
    });
    expect(tokenText(identity, "row")).toBe("Unknown origin · on Osmosis · ibc/0123…ABCDEF");
  });

  it("know where an unlisted local token was minted but not its name", () => {
    const identity = identityOf("osmosis-1", "factory/osmo1creator/uflower");
    expect(identity).toMatchObject({
      provenance: "native",
      originChainId: "osmosis-1",
      ticker: "uflower",
      proven: false,
      decimalsKnown: false,
      kind: "factory",
    });
  });

  it("name a legacy Peggy denom from the Ethereum contract it embeds", () => {
    const identity = identityOf("injective-1", "peggy0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
    expect(identity).toMatchObject({ ticker: "USDC.peggy", decimals: 6, bridge: "peggy", proven: true });
  });

  it("read a contract denom only on the chain whose bridge mints it", () => {
    // Injective's testnet bridges Sepolia, where 0xA0b8… is not USDC.
    for (const chainId of ["injective-888", "osmosis-1"]) {
      const identity = identityOf(chainId, "peggy0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
      expect(identity.proven, chainId).toBe(false);
      expect(identity.ticker, chainId).not.toMatch(/^USDC/);
    }
  });

  it("treat a packet path as a path, not a bank denom", () => {
    expect(identityOf("osmosis-1", "transfer/channel-750/uusdc").provenance).toBe("unknown");
    // Eureka hops name a light client; the denom is still the sender's trace.
    expect(
      identityOf("cosmoshub-4", "transfer/08-wasm-1369/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2").provenance,
    ).toBe("unknown");
  });

  it("never let a token nobody lists wear a listed token's ticker", () => {
    // Anyone can mint factory/<self>/USDC.n and airdrop it.
    const cases: [string, string, string][] = [
      ["osmosis-1", "factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/USDC.n", "USDC.n"],
      ["osmosis-1", "factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/OSMO", "OSMO"],
      ["osmosis-1", "factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/allUSDC", "allUSDC"],
      ["osmosis-1", "factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/atom", "ATOM"],
      ["injective-1", "factory/inj1qyqszqgpqyqszqgpqyqszqgpqyqszqgpvk3zns/USDC.inj", "USDC.inj"],
    ];
    for (const [chainId, denom, real] of cases) {
      const identity = identityOf(chainId, denom);
      expect(identity.ticker.toUpperCase(), denom).not.toBe(real.toUpperCase());
      expect(identity.ticker, denom).toMatch(/·[0-9A-F]{4}$/);
      expect(identity.name, denom).toMatch(/^Unlisted /);
      expect(identity.proven, denom).toBe(false);
    }
    expect(identityOf("osmosis-1", USDC_N_ON_OSMOSIS).ticker).toBe("USDC.n");
    // A name nobody else uses stays readable.
    expect(identityOf("osmosis-1", "factory/osmo1creator/uflower").ticker).toBe("uflower");
  });

  it("never throw", () => {
    expect(identityOf("", "").provenance).toBe("unknown");
    expect(identityOf("not-a-chain", "ibc/XYZ").provenance).toBe("unknown");
  });
});

describe("logos", () => {
  it("never use a chain icon for a token that is not that chain's coin", () => {
    const icons = new Set(
      allCatalogEntries().flatMap((entry) => [catalogIconFor(entry), entry.iconUrl, entry.iconPath]).filter(Boolean),
    );
    const identities: TokenIdentity[] = [
      ...tokenTableRows().map((row) => identityOf(row.heldOnChainId, row.denom)),
      // The issuers' own denoms, named from the vouchers that prove them.
      ...tokenTableRows().map((row) => identityOf(row.originChainId, row.originDenom)),
      ...audit.naming.map((row) => identityOf(row.chainId, row.denom)),
    ];
    let checked = 0;
    for (const identity of identities) {
      if (!identity.logoUrl || identity.kind === "native") continue;
      checked += 1;
      expect(icons.has(identity.logoUrl), identity.key).toBe(false);
      expect(identity.logoUrl, identity.key).not.toMatch(/\/chain\.(png|svg)$/);
    }
    expect(checked).toBeGreaterThan(300);
    expect(identityOf("osmosis-1", USDC_N_ON_OSMOSIS).logoUrl).toMatch(/usdc\.(png|svg)$/);
  });
});

describe("text", () => {
  it("separates the issuer from the location", () => {
    const onOsmosis = identityOf("osmosis-1", USDC_INJ_ON_OSMOSIS);
    expect(tokenText(onOsmosis, "pill")).toBe("on Osmosis");
    expect(tokenText(onOsmosis, "row")).toBe("Injective USDC · on Osmosis");
    expect(tokenText(onOsmosis, "sentence")).toBe("USDC.inj (Injective USDC) on Osmosis");
    expect(tokenText(onOsmosis, "a11y")).toBe("USDC from Injective, on Osmosis");

    const atHome = identityOf("injective-1", USDC_INJ_ERC20);
    expect(tokenText(atHome, "pill")).toBe("on Injective");
    expect(tokenText(atHome, "row")).toBe("Native on Injective");
    expect(tokenText(atHome, "sentence")).toBe("USDC.inj on Injective");
    expect(tokenText(atHome, "a11y")).toBe("USDC.inj, native on Injective");

    expect(tokenText(identityOf("osmosis-1", USDC_N_ON_OSMOSIS), "row")).toBe("Noble USDC · on Osmosis");
    expect(tokenText(identityOf("injective-1", USDC_N_ON_INJECTIVE), "a11y")).toBe("USDC from Noble, on Injective");
    expect(tokenText(identityOf("osmosis-1", ALL_USDC), "row")).toBe("Alloyed USDC · Osmosis only");
    expect(identityOf("osmosis-1", osmosisDenomOf("axelar-dojo-1", "polygon-uusdc") ?? "").name).toBe(
      "Axelar USDC from Polygon",
    );
    const unknown = identityOf("osmosis-1", UNLISTED);
    expect(tokenText(unknown, "a11y")).toBe("Unknown token ibc/0123…ABCDEF, on Osmosis");
    expect(tokenText(unknown, "sentence")).toBe("unknown token ibc/0123…ABCDEF on Osmosis");
  });

  it("makes every name users have seen searchable", () => {
    const rows = [
      identityOf("osmosis-1", USDC_N_ON_OSMOSIS),
      identityOf("osmosis-1", USDC_INJ_ON_OSMOSIS),
      identityOf("injective-1", USDC_INJ_ERC20),
      identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS),
      identityOf("osmosis-1", "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2"),
    ].map((identity) => ({
      id: identity.key,
      label: identity.ticker,
      sublabel: tokenText(identity, "row"),
      keywords: tokenKeywords(identity),
    }));
    const find = (query: string) => searchItems(rows, query).map((row) => row.id);
    expect(find("usdc injective")).toEqual([`osmosis-1:${USDC_INJ_ON_OSMOSIS}`, `injective-1:${USDC_INJ_ERC20}`]);
    expect(find("usdc noble")).toEqual([`osmosis-1:${USDC_N_ON_OSMOSIS}`]);
    expect(find("usdc.noble")).toEqual([`osmosis-1:${USDC_N_ON_OSMOSIS}`]);
    expect(find("axlusdc")).toEqual([`osmosis-1:${USDC_AXL_ON_OSMOSIS}`]);
    expect(find("usdc.eth.axl")).toEqual([`osmosis-1:${USDC_AXL_ON_OSMOSIS}`]);
  });

  it("shortens every long denom one way", () => {
    expect(shortDenom(USDC_N_ON_OSMOSIS)).toBe("ibc/498A…6BA6E4");
    expect(shortDenom(USDC_INJ_ERC20)).toBe("erc20:0xa00C…235a");
    expect(shortDenom("peggy0xdAC17F958D2ee523a2206206994597C13D831ec7")).toBe("peggy0xdAC1…1ec7");
    expect(shortDenom("factory/osmo1abcdefghijklmnop/uflower")).toBe("factory/osmo1a…mnop/uflower");
    expect(shortDenom("uatom")).toBe("uatom");
  });

  it("labels every kind", () => {
    expect(
      (["native", "ibc", "factory", "erc20", "peggy", "cw20", "other"] as const).map(tokenKindLabel),
    ).toEqual(["Native", "IBC", "Factory", "ERC-20", "Peggy", "CW20", "Asset"]);
  });
});

describe("coinDisplay", () => {
  it("names a held voucher by its trace", () => {
    expect(coinDisplay("osmosis-1", USDC_N_ON_OSMOSIS)).toEqual({ symbol: "USDC.n", decimals: 6, known: true });
    expect(coinDisplay("injective-1", USDC_N_ON_INJECTIVE)).toEqual({ symbol: "USDC.n", decimals: 6, known: true });
    expect(coinDisplay("osmosis-1", USDC_AXL_ON_OSMOSIS)).toEqual({ symbol: "USDC.axl", decimals: 6, known: true });
  });

  it("no longer guesses an issuer from a base denom several chains use", () => {
    expect(coinDisplay("noble-1", "transfer/channel-750/uusdc").known).toBe(false);
    const eth = coinDisplay("osmosis-1", "transfer/channel-1279/transfer/channel-52/wei");
    expect(eth.known).toBe(false);
    expect(eth.symbol).not.toBe("STOS");
    expect(coinDisplay("centauri-1", "wei").known).toBe(false);
  });

  it("still names a base denom exactly one registry chain issues", () => {
    expect(coinDisplay("osmosis-1", "uatom")).toEqual({ symbol: "ATOM", decimals: 6, known: true });
    expect(coinDisplay("osmosis-1", "transfer/channel-141/uosmo")).toEqual({ symbol: "OSMO", decimals: 6, known: true });
  });

  it("names a packet denom by the exact spelling it carries, not the catalog's", () => {
    // Injective USDC sent to Osmosis, and the same coin coming home: the
    // catalog lists it in lowercase, which is another (empty) denom.
    const usdcInj = { symbol: "USDC.inj", decimals: 6, known: true };
    expect(coinDisplay("osmosis-1", USDC_INJ_ERC20)).toEqual(usdcInj);
    expect(coinDisplay("injective-1", `transfer/channel-122/${USDC_INJ_ERC20}`)).toEqual(usdcInj);
    expect(coinDisplay("osmosis-1", USDC_INJ_ERC20.toLowerCase()).known).toBe(false);
  });
});

describe("the generated table", () => {
  it("is pinned and within its size budget", () => {
    expect(TOKEN_REGISTRY_SOURCES.osmosisAssetlists).toMatch(/^[0-9a-f]{40}$/);
    expect(TOKEN_REGISTRY_SOURCES.chainRegistry).toMatch(/^[0-9a-f]{40}$/);
    const file = path.resolve(__dirname, "../token-registry.generated.ts");
    expect(fs.statSync(file).size).toBeLessThanOrEqual(150 * 1024);
  });

  it("holds only vouchers whose trace hashes to their denom", () => {
    const vouchers = tokenTableRows().filter((row) => row.path);
    expect(vouchers.length).toBeGreaterThan(300);
    for (const row of vouchers) {
      expect(ibcDenomFor(row.path, row.baseDenom), `${row.heldOnChainId}:${row.denom}`).toBe(row.denom);
    }
  });

  it("trusts decimals only where the catalog and the table agree", () => {
    for (const row of tokenTableRows()) {
      const catalog = findCurrencyOn(row.originChainId, row.originDenom)?.currency.coinDecimals;
      const identity = identityOf(row.heldOnChainId, row.denom);
      if (catalog === undefined || catalog === row.decimals) {
        expect(identity.decimals, identity.key).toBe(row.decimals);
        expect(identity.decimalsKnown, identity.key).toBe(true);
      } else {
        expect(identity.decimalsKnown, identity.key).toBe(false);
        expect(identity.decimals, identity.key).toBe(0);
      }
    }
  });

  it("names each issuer's denom one hop back, proven by the trace", () => {
    // A hop is a channel, or a light client for Eureka (`transfer/08-wasm-1369`).
    const startsWithHop = /^[^/]+\/(?:channel-\d+|\d{2}-[a-z][a-z0-9]*-\d+)\//;
    let oneHopBack = 0;
    for (const row of tokenTableRows().filter((candidate) => candidate.path)) {
      if (row.originChainId === row.heldOnChainId) {
        // Minted here over a light client (the Hub's Eureka tokens): the row
        // names itself and claims no channel or counterparty chain.
        expect(row.originDenom, row.denom).toBe(row.denom);
        expect(row.channelId, row.denom).toBeNull();
        expect(row.counterpartyChainId, row.denom).toBeNull();
        continue;
      }
      // Only a first hop that lands on the issuer promises "one hop back"; a
      // hub row naming its ultimate base says so with another counterparty.
      if (row.counterpartyChainId !== row.originChainId) continue;
      // One hop: the trace's base. More (Picasso ETH, an Eureka client hop):
      // the voucher the rest of the path makes on the issuer.
      const rest = [...row.path.split("/").slice(2), row.baseDenom].join("/");
      expect(row.originDenom, row.denom).toBe(startsWithHop.test(rest) ? ibcDenomFor("", rest) : rest);
      oneHopBack += 1;
    }
    expect(oneHopBack).toBeGreaterThan(300);
  });
});

describe("identifyHeld", () => {
  /** The facts cache lives in module state, so each case loads a fresh copy. */
  async function freshModule() {
    vi.resetModules();
    const writes: unknown[] = [];
    let stored: Record<string, unknown> = {};
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (value: Record<string, unknown>) => {
            writes.push(value);
            stored = { ...stored, ...value };
          },
        },
        onChanged: { addListener: () => undefined },
      },
    });
    const identity = await import("../token-identity");
    return { identity, writes, setStored: (value: Record<string, unknown>) => (stored = value) };
  }

  /** A Noble USDC voucher on Akash, over a channel no table lists. */
  const AKASH_USDC = ibcDenomFor("transfer/channel-999", "uusdc");

  function resolverAnswering(
    answer: Record<string, { baseDenom: string; path: string; originChainId: string | null }>,
  ): DenomTraceResolver & { calls: string[][] } {
    const calls: string[][] = [];
    return {
      calls,
      identifyDenoms: async (_chainId, denoms) => {
        calls.push([...denoms]);
        return new Map(denoms.filter((denom) => answer[denom]).map((denom) => [denom, answer[denom]!]));
      },
    };
  }

  it("walks an unlisted voucher once and names it from its origin", async () => {
    const { identity, writes } = await freshModule();
    const resolver = resolverAnswering({
      [AKASH_USDC]: { baseDenom: "uusdc", path: "transfer/channel-999", originChainId: "noble-1" },
    });
    const found = await identity.identifyHeld("akashnet-2", [AKASH_USDC, "uakt"], { resolver });
    const usdc = found.get(AKASH_USDC);
    expect(usdc).toMatchObject({
      ticker: "USDC.n",
      provenance: "channel-walk",
      // Named from the walk, but channel-999 is no canonical channel: not proven.
      proven: false,
      originChainId: "noble-1",
      osmosisDenom: USDC_N_ON_OSMOSIS,
      decimals: 6,
    });
    expect(usdc && identity.tokenText(usdc, "row")).toBe("Noble USDC · on Akash");
    expect(found.get("uakt")?.ticker).toBe("AKT");
    expect(resolver.calls).toEqual([[AKASH_USDC]]);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ "zunia.tokenIdentity": { version: 1 } });

    await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    expect(resolver.calls).toHaveLength(1);
    expect(identity.identityOf("akashnet-2", AKASH_USDC).ticker).toBe("USDC.n");
  });

  it("proves a walk only when every hop crossed a registry-canonical channel", async () => {
    const { identity } = await freshModule();
    // Agoric's canonical channel to Noble is channel-62; channel-63 leads to Kava.
    const canonical = ibcDenomFor("transfer/channel-62", "uusdc");
    const lookalike = ibcDenomFor("transfer/channel-4242", "uusdc");
    const calls: string[][] = [];
    const resolver: DenomTraceResolver = {
      identifyDenoms: async (_chainId, denoms) => {
        calls.push([...denoms]);
        const rows = new Map<string, { baseDenom: string; path: string; originChainId: string | null; hopChainIds?: readonly (string | null)[] }>();
        if (denoms.includes(canonical)) {
          rows.set(canonical, { baseDenom: "uusdc", path: "transfer/channel-62", originChainId: "noble-1", hopChainIds: ["noble-1"] });
        }
        if (denoms.includes(lookalike)) {
          // A fresh channel to a chain whose light client claims to be noble-1.
          rows.set(lookalike, { baseDenom: "uusdc", path: "transfer/channel-4242", originChainId: "noble-1", hopChainIds: ["noble-1"] });
        }
        return rows;
      },
    };
    const found = await identity.identifyHeld("agoric-3", [canonical, lookalike], { resolver });
    expect(found.get(canonical)).toMatchObject({ provenance: "channel-walk", proven: true });
    expect(found.get(lookalike)).toMatchObject({ provenance: "channel-walk", proven: false });
    expect(calls).toHaveLength(1);
  });

  it("rejects a trace whose hash does not match, and asks about it once", async () => {
    const { identity, writes } = await freshModule();
    const resolver = resolverAnswering({
      [AKASH_USDC]: { baseDenom: "uatom", path: "transfer/channel-999", originChainId: "cosmoshub-4" },
    });
    const found = await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    expect(found.get(AKASH_USDC)?.provenance).toBe("unknown");
    expect(writes).toHaveLength(0);
    await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    expect(resolver.calls).toHaveLength(1);
  });

  it("asks nothing about denoms the table or the catalog already name", async () => {
    const { identity } = await freshModule();
    const resolver: DenomTraceResolver = {
      identifyDenoms: async () => {
        throw new Error("should not be asked");
      },
    };
    const found = await identity.identifyHeld("osmosis-1", [USDC_N_ON_OSMOSIS, "uosmo", ALL_USDC], { resolver });
    expect([...found.values()].map((entry) => entry.ticker)).toEqual(["USDC.n", "OSMO", "allUSDC"]);
  });

  it("does not remember a miss while live reads are off", async () => {
    const { identity } = await freshModule();
    let calls = 0;
    const resolver: DenomTraceResolver = {
      identifyDenoms: async () => {
        calls += 1;
        throw new InterchainError("reads-disabled", "reads are off");
      },
    };
    await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    expect(calls).toBe(2);
  });

  it("tags a second route of an asset the chain already lists", async () => {
    const { identity } = await freshModule();
    const canonical = identity
      .tokenTableRows("juno-1")
      .find((row) => row.originChainId === "noble-1" && row.originDenom === "uusdc");
    expect(canonical).toBeDefined();
    const detour = ibcDenomFor("transfer/channel-999", "uusdc");
    const resolver = resolverAnswering({
      [detour]: { baseDenom: "uusdc", path: "transfer/channel-999", originChainId: "noble-1" },
    });
    await identity.identifyHeld("juno-1", [detour], { resolver });
    expect(identity.identityOf("juno-1", canonical?.denom ?? "").ticker).toBe("USDC.n");
    expect(identity.identityOf("juno-1", detour).ticker).toBe(`USDC.n·${detour.slice(4, 8)}`);
  });

  it("re-checks stored facts on hydrate and drops a forged one", async () => {
    const { identity, setStored } = await freshModule();
    const forged = ibcDenomFor("transfer/channel-998", "uusdc");
    setStored({
      "zunia.tokenIdentity": {
        version: 1,
        facts: {
          [`akashnet-2:${AKASH_USDC}`]: { o: "noble-1", b: "uusdc", p: "transfer/channel-999", at: 1 },
          // Claims Axelar's base for a hash that is really channel-998/uusdc.
          [`akashnet-2:${forged}`]: { o: "axelar-dojo-1", b: "uaxl", p: "transfer/channel-998", at: 1 },
        },
      },
    });
    await identity.hydrateTokenIdentities();
    expect(identity.identityOf("akashnet-2", AKASH_USDC).ticker).toBe("USDC.n");
    expect(identity.identityOf("akashnet-2", forged).provenance).toBe("unknown");
  });

  it("asks one batch per read and leaves the rest for the next, not for a miss", async () => {
    const { identity } = await freshModule();
    const vouchers = Array.from({ length: 40 }, (_, index) => ibcDenomFor(`transfer/channel-${5000 + index}`, "uusdc"));
    const batches: number[] = [];
    const resolver: DenomTraceResolver = {
      // Like the engine: answers at most `maxLookups` and leaves the rest out.
      identifyDenoms: async (_chainId, denoms, options) => {
        batches.push(denoms.length);
        const answered = denoms.slice(0, options?.maxLookups ?? 32);
        return new Map(
          answered.map((denom) => [
            denom,
            { baseDenom: "uusdc", path: `transfer/channel-${5000 + vouchers.indexOf(denom)}`, originChainId: "noble-1" },
          ]),
        );
      },
    };
    await identity.identifyHeld("akashnet-2", vouchers, { resolver });
    await identity.identifyHeld("akashnet-2", vouchers, { resolver });
    expect(batches).toEqual([32, 8]);
    expect(vouchers.filter((denom) => identity.identityOf("akashnet-2", denom).originChainId === "noble-1")).toHaveLength(40);
  });

  it("records no miss when the read is cancelled", async () => {
    const { identity } = await freshModule();
    const controller = new AbortController();
    const cancelling: DenomTraceResolver = {
      identifyDenoms: async () => {
        controller.abort();
        return new Map();
      },
    };
    await expect(
      identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver: cancelling, signal: controller.signal }),
    ).rejects.toThrow();
    const resolver = resolverAnswering({
      [AKASH_USDC]: { baseDenom: "uusdc", path: "transfer/channel-999", originChainId: "noble-1" },
    });
    await identity.identifyHeld("akashnet-2", [AKASH_USDC], { resolver });
    expect(resolver.calls).toHaveLength(1);
    expect(identity.identityOf("akashnet-2", AKASH_USDC).ticker).toBe("USDC.n");
  });

  it("never proves a testnet walk that claims a mainnet issuer", async () => {
    const { identity } = await freshModule();
    const voucher = ibcDenomFor("transfer/channel-7", "uusdc");
    const resolver = resolverAnswering({
      [voucher]: { baseDenom: "uusdc", path: "transfer/channel-7", originChainId: "noble-1" },
    });
    await identity.identifyHeld("osmo-test-5", [voucher], { resolver });
    const walked = identity.identityOf("osmo-test-5", voucher);
    expect(walked).toMatchObject({ originChainId: "noble-1", testnet: true, proven: false });
  });

  it("does not dress a walked token nobody lists as a variant of a real one", async () => {
    const { identity } = await freshModule();
    const base = "factory/neutron1qyqszqgpqyqszqgpqyqszqgpqyqszqgpz3jc3a/USDC.n";
    const impostor = ibcDenomFor("transfer/channel-874", base);
    const resolver = resolverAnswering({
      [impostor]: { baseDenom: base, path: "transfer/channel-874", originChainId: "neutron-1" },
    });
    await identity.identifyHeld("osmosis-1", [impostor], { resolver });
    const walked = identity.identityOf("osmosis-1", impostor);
    expect(walked.provenance).toBe("channel-walk");
    expect(walked.proven).toBe(false);
    expect(walked.ticker).toMatch(/^USDC\.n·[0-9A-F]{4}$/);
    expect(walked.name).toBe("Unlisted Neutron token");
    expect(identity.identityOf("osmosis-1", USDC_N_ON_OSMOSIS).ticker).toBe("USDC.n");
  });

  it("reads an alloy held off Osmosis as a voucher, not as 'Neutron only'", async () => {
    const { identity } = await freshModule();
    const voucher = ibcDenomFor("transfer/channel-10", ALL_USDC);
    const resolver = resolverAnswering({
      [voucher]: { baseDenom: ALL_USDC, path: "transfer/channel-10", originChainId: "osmosis-1" },
    });
    await identity.identifyHeld("neutron-1", [voucher], { resolver });
    const held = identity.identityOf("neutron-1", voucher);
    expect(held.ticker).toBe("allUSDC");
    expect(identity.tokenText(held, "row")).toBe("Alloyed USDC · on Neutron");
    expect(identity.tokenText(identity.identityOf("osmosis-1", ALL_USDC), "row")).toBe("Alloyed USDC · Osmosis only");
  });

  it("ignores a stored record from another version", async () => {
    const { identity, setStored } = await freshModule();
    setStored({
      "zunia.tokenIdentity": {
        version: 0,
        facts: { [`akashnet-2:${AKASH_USDC}`]: { o: "noble-1", b: "uusdc", p: "transfer/channel-999", at: 1 } },
      },
    });
    await identity.hydrateTokenIdentities();
    expect(identity.identityOf("akashnet-2", AKASH_USDC).provenance).toBe("unknown");
  });
});

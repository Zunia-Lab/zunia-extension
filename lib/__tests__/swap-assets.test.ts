import { afterEach, describe, expect, it } from "vitest";

import {
  allCatalogEntries,
  catalogIconFor,
  findCatalogEntry,
  setCustomCatalogEntries,
  type CatalogEntry,
} from "../chain-catalog";
import { isCanonicalChannel } from "../interchain";
import { osmosisSwapAssets, parseOsmosisTokenMetadata, type OsmosisAsset } from "../osmosis-assets";
import { pickerSections } from "../picker";
import {
  buyOptions,
  expectedVenueDenoms,
  pickerFields,
  sellOptions,
  type AssetOption,
  type HeldBalance,
  type SwapChain,
} from "../swap-assets";
import { ibcDenomFor, identityOf } from "../token-identity";
import {
  SAME_TOKEN_REASON,
  SELF_REASON,
  TESTNET_REASON,
  notTradedReason,
  parseRouterState,
  type XcsRouteTable,
} from "../xcs-routes";
import sqs from "./fixtures/swap/sqs-tokens-metadata.json";
import wallet from "./fixtures/swap/wallet.json";
import live from "./fixtures/swap/xcs-route-table.json";

const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_N_ON_INJECTIVE = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E";
const USDC_AXL = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const chains: SwapChain[] = wallet.chains.map(({ chainId }) => {
  const entry = findCatalogEntry(chainId);
  if (!entry) throw new Error(`${chainId} is not in the catalog`);
  return { chainId, entry };
});
const balances: Record<string, HeldBalance> = wallet.balances;
const osmosis: OsmosisAsset[] = osmosisSwapAssets(parseOsmosisTokenMetadata(sqs));
const routes: XcsRouteTable = {
  xcsContract: live.xcsContract,
  swapContract: live.swapContract,
  routes: parseRouterState(live.pages.flatMap((page) => page.body.models)),
  readAt: 0,
};

const sell = sellOptions(chains, balances, osmosis);

function held(key: string): AssetOption {
  const option = sell.find((row) => row.key === key);
  if (!option) throw new Error(`${key} is not held`);
  return option;
}

function row(options: readonly AssetOption[], key: string): AssetOption {
  const option = options.find((candidate) => candidate.key === key);
  if (!option) throw new Error(`${key} is not offered`);
  return option;
}

function buy(from: AssetOption | null, overrides: { routes?: XcsRouteTable | null; osmosis?: OsmosisAsset[] } = {}) {
  return buyOptions(chains, balances, { from, osmosis: overrides.osmosis ?? osmosis, routes: overrides.routes === undefined ? routes : overrides.routes });
}

/** What the picker's search returns, as options. */
function search(options: readonly AssetOption[], query: string): AssetOption[] {
  const byKey = new Map(options.map((option) => [option.key, option]));
  const [results] = pickerSections(options.map(pickerFields), { query });
  return (results?.items ?? []).map((item) => byKey.get(item.id)!);
}

/** What the picker lists before any search. */
function listed(options: readonly AssetOption[]): string[] {
  return pickerSections(options.map(pickerFields), { query: "" }).flatMap((section) => section.items.map((item) => item.id));
}

afterEach(() => {
  setCustomCatalogEntries([]);
});

describe("sellOptions", () => {
  it("lists every non-zero balance once, on the chain that holds it", () => {
    expect(sell.map((option) => option.key)).toEqual([
      "safrochain-1:usaf",
      "cosmoshub-4:uatom",
      "osmosis-1:uosmo",
      `osmosis-1:${USDC_N}`,
      `osmosis-1:${UNLISTED}`,
      "injective-1:inj",
      `injective-1:${USDC_N_ON_INJECTIVE}`,
      "safro-testnet-1:usaf",
    ]);
    for (const option of sell) {
      expect(option.held).toBe(true);
      expect(option.amount).toBe(
        balances[option.chainId]?.tokens.find((token) => token.denom === option.denom)?.amount,
      );
      expect(option).toMatchObject({ executable: "unknown", disabledReason: null, searchOnly: false });
    }
    expect(row(sell, "safro-testnet-1:usaf").testnet).toBe(true);
    expect(row(sell, "safrochain-1:usaf").testnet).toBe(false);
  });

  it("names a held Noble USDC USDC.n wherever it sits, whatever the balance reader called it", () => {
    for (const key of [`osmosis-1:${USDC_N}`, `injective-1:${USDC_N_ON_INJECTIVE}`]) {
      const option = held(key);
      expect(option.symbol).toBe("USDC.n");
      expect(option.label).toBe("USDC.n");
      expect(option.identity.originChainId).toBe("noble-1");
      expect(option.verified).toBe(true);
      expect(option).toMatchObject({ decimals: 6, decimalsKnown: true });
    }
    expect(pickerFields(held(`osmosis-1:${USDC_N}`)).sublabel).toBe("Noble USDC · on Osmosis");
    expect(pickerFields(held(`injective-1:${USDC_N_ON_INJECTIVE}`)).sublabel).toBe("Noble USDC · on Injective");
    expect(pickerFields(held("cosmoshub-4:uatom"))).toMatchObject({ label: "ATOM", sublabel: "Native on Cosmos Hub" });
  });

  it("keeps a token nothing names in base units, so only Max can spend it", () => {
    const unknown = held(`osmosis-1:${UNLISTED}`);
    expect(unknown).toMatchObject({ symbol: "IBC·0123", decimals: 0, decimalsKnown: false, verified: false });
    expect(unknown.iconUrl).toBeUndefined();
    expect(pickerFields(unknown).sublabel).toBe("Unknown origin · on Osmosis · ibc/0123…ABCDEF");
  });

  it("takes the balance reader's exponent only for a token whose identity is unknown", () => {
    const osmo = wallet.balances["osmosis-1"];
    const reporting = (patch: Record<string, { decimals: number; decimalsKnown?: boolean }>): Record<string, HeldBalance> => ({
      ...balances,
      "osmosis-1": { ...osmo, tokens: osmo.tokens.map((token) => ({ ...token, ...patch[token.denom] })) },
    });
    // The chain's metadata is the reader's last resort for a token nothing names.
    const named = sellOptions(chains, reporting({ [UNLISTED]: { decimals: 6, decimalsKnown: true } }), osmosis);
    const filled = row(named, `osmosis-1:${UNLISTED}`);
    expect(filled).toMatchObject({ decimals: 6, decimalsKnown: true });
    // The identity the amount helpers read says the same, so the balance shown
    // and the amount Max converts use one scale (12.34, not 12340000 units
    // converted at 6 decimals into a million times the balance).
    expect(filled.identity).toMatchObject({ decimals: 6, decimalsKnown: true, provenance: "unknown" });
    // Never over an identity: the table's 6 stands against a reader's 18.
    const wrong = sellOptions(chains, reporting({ [USDC_N]: { decimals: 18, decimalsKnown: true } }), osmosis);
    expect(row(wrong, `osmosis-1:${USDC_N}`)).toMatchObject({ decimals: 6, decimalsKnown: true });
    expect(row(wrong, `osmosis-1:${USDC_N}`).identity).toBe(identityOf("osmosis-1", USDC_N));
    // A guess the reader does not vouch for, or an absurd one, is not an exponent.
    for (const patch of [{ decimals: 6 }, { decimals: 6, decimalsKnown: false }, { decimals: 99, decimalsKnown: true }]) {
      const rows = sellOptions(chains, reporting({ [UNLISTED]: patch }), osmosis);
      expect(row(rows, `osmosis-1:${UNLISTED}`)).toMatchObject({ decimals: 0, decimalsKnown: false });
      expect(row(rows, `osmosis-1:${UNLISTED}`).identity).toMatchObject({ decimals: 0, decimalsKnown: false });
    }
  });

  it("makes the exponent unknown wherever SQS disagrees with the table about it", () => {
    const disagreeing = osmosis.map((asset) => (asset.denom === USDC_N ? { ...asset, decimals: 18 } : asset));
    const rows = sellOptions(chains, balances, disagreeing);
    for (const key of [`osmosis-1:${USDC_N}`, `injective-1:${USDC_N_ON_INJECTIVE}`]) {
      expect(row(rows, key)).toMatchObject({ decimals: 0, decimalsKnown: false });
      // Through the identity too: a helper given `option.identity` must not
      // allow typing, or show 1.234567, while the row says base units only.
      expect(row(rows, key).identity).toMatchObject({ decimals: 0, decimalsKnown: false, ticker: "USDC.n" });
    }
    expect(row(rows, "osmosis-1:uosmo")).toMatchObject({ decimals: 6, decimalsKnown: true });
    // The To side as well: Noble's own USDC, delivered home, has the same veto.
    const to = buyOptions(chains, balances, { from: held("osmosis-1:uosmo"), osmosis: disagreeing, routes });
    expect(row(to, "noble-1:uusdc")).toMatchObject({ decimals: 0, decimalsKnown: false });
    expect(row(to, "noble-1:uusdc").identity).toMatchObject({ decimals: 0, decimalsKnown: false });
  });

  it("gives every row one exponent: the row's and its identity's always agree", () => {
    const disagreeing = osmosis.map((asset) => (asset.denom === USDC_N ? { ...asset, decimals: 18 } : asset));
    const osmo = wallet.balances["osmosis-1"];
    const reported: Record<string, HeldBalance> = {
      ...balances,
      "osmosis-1": {
        ...osmo,
        tokens: osmo.tokens.map((token) => (token.denom === UNLISTED ? { ...token, decimalsKnown: true } : token)),
      },
    };
    const lists = [sell, sellOptions(chains, reported, disagreeing)];
    for (const listing of [osmosis, disagreeing]) {
      for (const from of [null, ...sell]) lists.push(buyOptions(chains, reported, { from, osmosis: listing, routes }));
    }
    let patched = 0;
    for (const options of lists) {
      for (const option of options) {
        expect([option.identity.decimals, option.identity.decimalsKnown], option.key).toEqual([
          option.decimals,
          option.decimalsKnown,
        ]);
        // Only the exponent may differ from the token's own identity.
        const own = identityOf(option.chainId, option.denom);
        if (option.identity !== own) patched += 1;
        expect({ ...option.identity, decimals: 0, decimalsKnown: false }).toEqual({
          ...own,
          decimals: 0,
          decimalsKnown: false,
        });
      }
    }
    expect(patched).toBeGreaterThan(0);
  });

  it("uses a token logo, and a chain logo only for that chain's own coin", () => {
    const usdc = held(`osmosis-1:${USDC_N}`);
    expect(usdc.iconUrl).toBeTruthy();
    expect(usdc.iconUrl).not.toBe(usdc.chainIconUrl);
    expect(held("osmosis-1:uosmo").chainIconUrl).toBe(catalogIconFor(findCatalogEntry("osmosis-1")!));
  });
});

describe("buyOptions", () => {
  const atomFrom = held("cosmoshub-4:uatom");
  const osmoFrom = held("osmosis-1:uosmo");

  it("merges held rows, chain coins, Osmosis rows and deliveries home, one row per key", () => {
    const rows = buy(atomFrom);
    const keys = rows.map((option) => option.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of [
      "cosmoshub-4:uatom",
      `injective-1:${USDC_N_ON_INJECTIVE}`,
      "akashnet-2:uakt",
      `osmosis-1:${USDC_INJ}`,
      `injective-1:${USDC_INJ_ERC20}`,
      "axelar-dojo-1:uusdc",
      "noble-1:uusdc",
    ]) {
      expect(keys).toContain(key);
    }
    for (const asset of osmosis) expect(keys).toContain(`osmosis-1:${asset.denom}`);
    // A held row keeps its balance when another source offers the same key.
    expect(row(rows, `osmosis-1:${USDC_N}`)).toMatchObject({ held: true, amount: "1234567" });
  });

  it("offers no LP share, zero-supply token, unstable variant or unlisted preview", () => {
    const offered = new Set(buy(atomFrom).map((option) => option.key));
    const proven = new Set(osmosis.map((asset) => asset.denom));
    const junk = Object.keys(sqs).filter((denom) => !proven.has(denom));
    expect(junk).toHaveLength(25);
    for (const denom of junk) expect(offered.has(`osmosis-1:${denom}`)).toBe(false);
  });

  it("never offers a token nothing names unless the wallet holds it", () => {
    const rows = buy(osmoFrom);
    for (const option of rows) {
      if (!option.held) expect(option.identity.provenance).not.toBe("unknown");
    }
    expect(rows.some((option) => option.key === `osmosis-1:${UNLISTED}`)).toBe(true);
  });

  it("shows only the From's network: no testnet row for a mainnet From, only testnet rows for a testnet From", () => {
    const mainnet = buy(atomFrom);
    expect(mainnet.every((option) => !option.testnet)).toBe(true);
    expect(mainnet.some((option) => option.key === "safro-testnet-1:usaf")).toBe(false);
    expect(buy(null).every((option) => !option.testnet)).toBe(true);

    const testnet = buy(held("safro-testnet-1:usaf"));
    expect(testnet.length).toBeGreaterThan(1);
    expect(testnet.every((option) => option.testnet)).toBe(true);
    expect(testnet.some((option) => option.chainId === "osmosis-1")).toBe(false);
    expect(row(testnet, "safro-testnet-1:usaf").disabledReason).toBe(TESTNET_REASON);
    expect(testnet.every((option) => option.disabledReason === TESTNET_REASON && option.searchOnly)).toBe(true);
  });

  it("delivers home with the table's exact denom, which hashes to the Osmosis voucher", () => {
    const rows = buy(atomFrom);
    const injective = row(rows, `injective-1:${USDC_INJ_ERC20}`);
    expect(injective.denom).toBe(USDC_INJ_ERC20);
    expect(ibcDenomFor("transfer/channel-122", injective.denom)).toBe(USDC_INJ);
    expect(injective.identity.osmosisDenom).toBe(USDC_INJ);
    // The catalog's lowercase spelling hashes elsewhere and is never offered.
    expect(rows.some((option) => option.key === `injective-1:${USDC_INJ_ERC20.toLowerCase()}`)).toBe(false);

    const homes: string[] = [];
    for (const asset of osmosis) {
      const home = rows.find(
        (option) => option.chainId === asset.row.originChainId && option.denom === asset.row.originDenom,
      );
      if (!home || asset.row.originChainId === "osmosis-1") continue;
      homes.push(asset.symbol);
      expect(home.identity.osmosisDenom).toBe(asset.denom);
      // One plain hop: the voucher is the hash of the channel and the delivered
      // denom. Longer traces (an Eureka client hop inside the base) are proven
      // hop by hop by the table instead.
      const oneHop = asset.row.path.split("/").length === 2 && asset.row.baseDenom === asset.row.originDenom;
      if (oneHop) expect(ibcDenomFor(asset.row.path, home.denom)).toBe(asset.denom);
    }
    // 86 deliveries over canonical channels, plus Archway's ARCH, offered as
    // Archway's own coin: Osmosis's voucher of it came over channel-1429, which
    // the registry does not mark canonical.
    expect(homes).toHaveLength(87);
    const offCanonical = osmosis.filter(
      (asset) =>
        homes.includes(asset.symbol) && !isCanonicalChannel("osmosis-1", asset.row.originChainId, asset.row.channelId ?? ""),
    );
    expect(offCanonical.map((asset) => asset.symbol)).toEqual(["ARCH"]);
    // Juno's CW20s (GLTO, NETA, NRIDE) are not bank denoms: never delivered home.
    expect(rows.some((option) => option.denom.startsWith("cw20:"))).toBe(false);
  });

  it("finds USDC.inj on Injective and on Osmosis for 'usdc injective', each with its own token logo", () => {
    const results = search(buy(atomFrom), "usdc injective");
    expect(results.map((option) => option.key)).toEqual(
      expect.arrayContaining([`injective-1:${USDC_INJ_ERC20}`, `osmosis-1:${USDC_INJ}`]),
    );
    // Every hit is a USDC from or on Injective: the held Noble USDC there is the third.
    expect(results.map((option) => option.key).sort()).toEqual(
      [`injective-1:${USDC_INJ_ERC20}`, `osmosis-1:${USDC_INJ}`, `injective-1:${USDC_N_ON_INJECTIVE}`].sort(),
    );
    const injective = row(results, `injective-1:${USDC_INJ_ERC20}`);
    const voucher = row(results, `osmosis-1:${USDC_INJ}`);
    expect(pickerFields(injective)).toMatchObject({ label: "USDC.inj", sublabel: "Native on Injective" });
    expect(pickerFields(voucher)).toMatchObject({ label: "USDC.inj", sublabel: "Injective USDC · on Osmosis" });
    for (const option of [injective, voucher]) {
      expect(option.iconUrl).toBeTruthy();
      expect(option.iconUrl).not.toBe(option.chainIconUrl);
      expect(option.iconUrl).not.toBe(catalogIconFor(findCatalogEntry(option.chainId)!));
      expect(option.iconUrl).not.toBe(catalogIconFor(findCatalogEntry("osmosis-1")!));
    }
  });

  it("finds the USDC.n rows for 'usdc noble', through the USDC.noble alias and the origin", () => {
    const rows = buy(atomFrom);
    const results = search(rows, "usdc noble");
    expect(results.map((option) => option.key).sort()).toEqual(
      ["noble-1:uusdc", `osmosis-1:${USDC_N}`, `injective-1:${USDC_N_ON_INJECTIVE}`].sort(),
    );
    expect(results.every((option) => option.symbol === "USDC.n")).toBe(true);
    expect(search(rows, "usdc.noble").map((option) => option.key)).toContain(`osmosis-1:${USDC_N}`);
  });

  it("with From OSMO on Osmosis: USDC.inj, USDC.n and USDC.axl can be bought on every chain; the table only says which the contract reaches", () => {
    const rows = buy(osmoFrom);
    // The contract has no route to USDC.inj or USDC.n. Osmosis's own pools swap
    // them, on Osmosis or with a transfer after the swap, so the rows are offered.
    for (const key of [
      `injective-1:${USDC_INJ_ERC20}`,
      `osmosis-1:${USDC_INJ}`,
      "noble-1:uusdc",
      `osmosis-1:${USDC_N}`,
      `injective-1:${USDC_N_ON_INJECTIVE}`,
    ]) {
      expect(row(rows, key)).toMatchObject({ executable: "no", disabledReason: null, searchOnly: false });
    }
    // Both on Osmosis is a swap in its pools, not a refusal.
    for (const key of ["axelar-dojo-1:uusdc", `osmosis-1:${USDC_AXL}`]) {
      expect(row(rows, key)).toMatchObject({ executable: "yes", disabledReason: null, searchOnly: false });
    }
    expect(row(rows, "osmosis-1:uosmo").disabledReason).toBe(SELF_REASON);
    // A coin Osmosis does not trade is still refused, with its own reason.
    expect(row(rows, "safrochain-1:usaf")).toMatchObject({
      disabledReason: notTradedReason("SAF"),
      searchOnly: true,
    });
    // The search lists every USDC row, all of them pickable.
    const usdc = search(rows, "usdc");
    expect(usdc.map((option) => option.key)).toEqual(
      expect.arrayContaining([
        `injective-1:${USDC_INJ_ERC20}`,
        `osmosis-1:${USDC_INJ}`,
        `osmosis-1:${USDC_AXL}`,
        "axelar-dojo-1:uusdc",
      ]),
    );
    expect(usdc.every((option) => option.disabledReason === null)).toBe(true);
  });

  it("orders held rows, then what the contract reaches, then the rest; the list shows only pickable rows", () => {
    const rows = buy(osmoFrom);
    const group = (option: AssetOption) =>
      option.disabledReason !== null ? 3 : option.held ? 0 : option.executable === "yes" ? 1 : 2;
    const groups = rows.map(group);
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    expect(rows[0]?.held).toBe(true);
    // Held rows keep the balance order, the ones on Osmosis included: OSMO
    // swaps into them in Osmosis's pools. Then what the contract reaches reads
    // alphabetically, each token at home before its Osmosis row. MARS.old and
    // STARS.og have routes but no row: Osmosis flags their vouchers unstable
    // and Mars and Stargaze are not bundled chains.
    expect(rows.filter((option) => group(option) === 0).map((option) => option.key)).toEqual([
      "cosmoshub-4:uatom",
      `osmosis-1:${USDC_N}`,
      `osmosis-1:${UNLISTED}`,
      "injective-1:inj",
      `injective-1:${USDC_N_ON_INJECTIVE}`,
    ]);
    const reachable = rows.filter((option) => group(option) === 1);
    expect(reachable.map((option) => `${option.symbol}@${option.chainId === "osmosis-1" ? "osmosis" : "home"}`)).toEqual([
      "AKT@home",
      "AKT@osmosis",
      "ATOM@osmosis",
      "AXL@home",
      "AXL@osmosis",
      "CRO@home",
      "CRO@osmosis",
      "DAI.axl@home",
      "DAI.axl@osmosis",
      "ETH.axl@home",
      "ETH.axl@osmosis",
      "EVMOS@home",
      "IST@home",
      "IST@osmosis",
      "JKL@home",
      "JKL@osmosis",
      "JUNO@home",
      "JUNO@osmosis",
      "SCRT@home",
      "SCRT@osmosis",
      "stOSMO@home",
      "stOSMO@osmosis",
      "STRD@home",
      "STRD@osmosis",
      "USDC.axl@home",
      "USDC.axl@osmosis",
      "WBTC.axl@home",
      "WBTC.axl@osmosis",
    ]);

    const shown = new Set(listed(rows));
    for (const option of rows) {
      expect(shown.has(option.key)).toBe(option.disabledReason === null);
      expect(option.searchOnly).toBe(option.disabledReason !== null);
    }
  });

  it("gates no route when the route table is unreadable", () => {
    const rows = buy(atomFrom, { routes: null });
    expect(rows.every((option) => option.executable === "unknown")).toBe(true);
    const disabled = rows.filter((option) => option.disabledReason !== null);
    expect(disabled.map((option) => [option.key, option.disabledReason])).toEqual([
      ["cosmoshub-4:uatom", SELF_REASON],
      [`osmosis-1:${ATOM}`, SAME_TOKEN_REASON],
    ]);
    expect(row(rows, `injective-1:${USDC_INJ_ERC20}`)).toMatchObject({ disabledReason: null, searchOnly: false });
    // With the table, the contract cannot take ATOM to USDC.inj, but the row
    // stays: ATOM moves to Osmosis first, then swaps in its pools.
    expect(row(buy(atomFrom), `injective-1:${USDC_INJ_ERC20}`)).toMatchObject({
      executable: "no",
      disabledReason: null,
    });
  });

  it("without SQS offers held rows and chain coins only, and nothing is gated without a From", () => {
    const rows = buy(null, { osmosis: [] });
    expect(rows.some((option) => option.chainId === "osmosis-1" && !option.held && option.denom !== "uosmo")).toBe(false);
    expect(rows.some((option) => option.key === `injective-1:${USDC_INJ_ERC20}`)).toBe(false);
    expect(rows.every((option) => option.disabledReason === null && !option.searchOnly)).toBe(true);
  });

  it("signs only denoms taken verbatim from the bank, the catalog's chain coins, SQS or the table", () => {
    // Identity is display only: what a row signs (chainId, denom) is copied,
    // never rebuilt from a ticker or a case-folded catalog string.
    const sources = new Set<string>();
    for (const [chainId, balance] of Object.entries(balances)) {
      for (const token of balance.tokens) sources.add(`${chainId}:${token.denom}`);
    }
    for (const entry of allCatalogEntries()) sources.add(`${entry.chainId}:${entry.coinMinimalDenom}`);
    for (const asset of osmosis) {
      sources.add(`osmosis-1:${asset.denom}`);
      sources.add(`${asset.row.originChainId}:${asset.row.originDenom}`);
    }
    for (const from of [null, ...sell]) {
      for (const option of buyOptions(chains, balances, { from, osmosis, routes })) {
        expect(sources.has(`${option.chainId}:${option.denom}`), option.key).toBe(true);
        expect(option.key).toBe(`${option.chainId}:${option.denom}`);
        expect(option.identity.key).toBe(option.key);
      }
    }
  });

  it("never delivers to a chain the user added, even under a bundled chain's id", () => {
    const shadow: CatalogEntry = { ...findCatalogEntry("injective-1")!, chainName: "My Injective", inCosmosRegistry: false };
    setCustomCatalogEntries([shadow]);
    const rows = buy(atomFrom);
    expect(rows.some((option) => option.key === `injective-1:${USDC_INJ_ERC20}`)).toBe(false);
  });
});

describe("expectedVenueDenoms", () => {
  it("names both sides on Osmosis, from the held denom there or the canonical voucher", () => {
    const rows = buy(held("cosmoshub-4:uatom"));
    expect(expectedVenueDenoms(held("cosmoshub-4:uatom"), row(rows, "axelar-dojo-1:uusdc"))).toEqual({
      expectedVenueInputDenom: ATOM,
      expectedVenueOutputDenom: USDC_AXL,
    });
    expect(expectedVenueDenoms(held(`osmosis-1:${USDC_N}`), row(rows, `injective-1:${USDC_INJ_ERC20}`))).toEqual({
      expectedVenueInputDenom: USDC_N,
      expectedVenueOutputDenom: USDC_INJ,
    });
    // Safrochain's SAF is not on Osmosis: that half of the check is left out.
    expect(expectedVenueDenoms(held("safrochain-1:usaf"), row(rows, "axelar-dojo-1:uusdc"))).toEqual({
      expectedVenueOutputDenom: USDC_AXL,
    });
  });
});

/**
 * The shared token presentation (WP-B): the amount policy in lib/token-amount.ts,
 * and the words, picker rows and ticker layout of
 * entrypoints/popup/components/TokenLabel.tsx.
 *
 * Identities come from the real identityOf on the bundled table, so these
 * strings are what the popup shows. Components are checked through their
 * pure helpers and element props; only TokenLabel is rendered, since it uses
 * no hooks (the UI package's TokenLogo does, and resolves its own React copy
 * outside the popup's bundler aliases).
 */

import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  TokenLabel,
  networkTag,
  provenanceLabel,
  showsLocationBadge,
  tickerParts,
  tokenA11yName,
  tokenLocationText,
  tokenPickerItem,
  tokenSubtitle,
  tokenTooltip,
} from "../../entrypoints/popup/components/TokenLabel";
import {
  catalogIconFor,
  findCatalogEntry,
  setCustomCatalogEntries,
  type CatalogEntry,
} from "../chain-catalog";
import { formatUnits } from "../format";
import { searchItems } from "../picker";
import {
  BASE_UNITS,
  MAX_ONLY_NOTE,
  amountFieldText,
  amountUnit,
  canTypeAmount,
  formatTokenAmount,
  type TokenAmountVariant,
} from "../token-amount";
import { identityOf, tokenTableRows, type TokenIdentity } from "../token-identity";

const USDC_INJ_ERC20 = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const USDC_INJ_ON_OSMOSIS = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const USDC_AXL_ON_OSMOSIS = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const USDC_AXL_POLYGON_ON_OSMOSIS = "ibc/231FD77ECCB2DB916D314019DA30FE013202833386B1908A191D16989AD80B5A";
/** Midas mBTC as the Hub holds it over Eureka, the longest registry ticker. */
const MBTC_MIDAS_ON_HUB = "ibc/62F1A800DCE1AA0FD47B3592DEBB7A8956A383A14A4F756E4881AEA927B21671";
const ALL_USDC = "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC";
/** A voucher nothing lists. */
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const usdcN = () => identityOf("osmosis-1", USDC_N_ON_OSMOSIS);
const usdcInjHome = () => identityOf("injective-1", USDC_INJ_ERC20);
const usdcInjOnOsmosis = () => identityOf("osmosis-1", USDC_INJ_ON_OSMOSIS);
const usdcAxlPolygon = () => identityOf("osmosis-1", USDC_AXL_POLYGON_ON_OSMOSIS);
const unknown = () => identityOf("osmosis-1", UNLISTED);
/** A named token whose decimals nobody proved (the catalog and the table disagree, as for allSHIB). */
const namedNoDecimals = (): TokenIdentity => ({ ...usdcN(), decimals: 0, decimalsKnown: false });

const VARIANTS: readonly TokenAmountVariant[] = ["list", "picker", "confirm", "history"];
/** A compact magnitude suffix right after a digit: `12.34M`, `20.34k`, `2.10Bn`. */
const COMPACT = /\d(?:k|M|Bn)\b/;

afterEach(() => {
  setCustomCatalogEntries([]);
});

/** A chain the user added, as custom-chains.ts stores it. */
function customChain(overrides: Partial<CatalogEntry>): CatalogEntry {
  return {
    chainId: "mine-1",
    chainName: "Mine",
    bech32Prefix: "mine",
    coinType: 118,
    network: "mainnet",
    coinDenom: "MINE",
    coinMinimalDenom: "umine",
    coinDecimals: 6,
    feeDenom: "MINE",
    feeMinimalDenom: "umine",
    feeDecimals: 6,
    inCosmosRegistry: false,
    ...overrides,
  };
}

/** The text inside a picker row's trailing node. */
function trailingText(node: ReactNode): string | null {
  if (!isValidElement<{ children: string }>(node)) return null;
  return node.props.children;
}

describe("formatTokenAmount with unknown decimals", () => {
  it("shows raw base units where formatUnits(…, 0) reads as millions", () => {
    expect(unknown().decimalsKnown).toBe(false);
    // What every history row did with an unnamed voucher before this policy.
    expect(formatUnits("12340000", 0)).toBe("12.34M");
    for (const variant of VARIANTS) {
      expect(formatTokenAmount("12340000", unknown(), variant), variant).toBe("12340000 base units");
    }
  });

  it("never adds a k, M or Bn suffix, at any size", () => {
    for (const amount of ["999", "12340", "12340000", "12340000000", "123456789012345678901234567890"]) {
      for (const variant of VARIANTS) {
        const text = formatTokenAmount(amount, unknown(), variant);
        expect(text, `${variant} ${amount}`).toBe(`${amount} ${BASE_UNITS}`);
        expect(text).not.toMatch(COMPACT);
      }
    }
  });

  it("keeps base units for a named token whose decimals are unknown", () => {
    expect(formatTokenAmount("12340000", namedNoDecimals(), "list")).toBe("12340000 base units");
  });

  it("keeps the sign, and reads text that is not an integer as 0", () => {
    expect(formatTokenAmount("-12340000", unknown(), "history")).toBe("-12340000 base units");
    expect(formatTokenAmount(" 0012340000 ", unknown(), "list")).toBe("12340000 base units");
    expect(formatTokenAmount("12.5", unknown(), "list")).toBe("0 base units");
  });
});

describe("formatTokenAmount with known decimals", () => {
  it("gives 12.34 for 12340000 at 6 decimals", () => {
    expect(usdcN().decimals).toBe(6);
    expect(formatTokenAmount("12340000", usdcN(), "list")).toBe("12.34");
    expect(formatTokenAmount("12340000", usdcN(), "picker")).toBe("12.34");
    expect(formatTokenAmount("12340000", usdcN(), "confirm")).toBe("12.34");
    // History trims trailing zeros: Activity reads "-12.34 USDC.n" (WP-F), as today.
    expect(formatTokenAmount("12340000", usdcN(), "history")).toBe("12.34");
  });

  it("uses each variant's precision", () => {
    // list: two decimals, padded, compact; history: up to three, trimmed, compact.
    expect(formatTokenAmount("20340000000", usdcN(), "list")).toBe("20.34k");
    expect(formatTokenAmount("20340000000", usdcN(), "history")).toBe("20.34k");
    expect(formatTokenAmount("20345600000", usdcN(), "history")).toBe("20.345k");
    expect(formatTokenAmount("1000000000000", usdcN(), "history")).toBe("1M");
    expect(formatTokenAmount("1500000000000", usdcN(), "list")).toBe("1.50M");
    expect(formatTokenAmount("12500000", usdcN(), "list")).toBe("12.50");
    // picker and confirm: exact, up to six decimals, trailing zeros trimmed, never compact.
    expect(formatTokenAmount("20340000000", usdcN(), "picker")).toBe("20340");
    expect(formatTokenAmount("1234567891", usdcN(), "confirm")).toBe("1234.567891");
    expect(formatTokenAmount("12500000", usdcN(), "picker")).toBe("12.5");
  });

  it("cuts an 18-decimal amount at each variant's digits, never rounding up", () => {
    const inj = identityOf("injective-1", "inj");
    expect(inj.decimals).toBe(18);
    expect(formatTokenAmount("1234567890123456789", inj, "picker")).toBe("1.234567");
    expect(formatTokenAmount("1234567890123456789", inj, "confirm")).toBe("1.234567");
    expect(formatTokenAmount("1234567890123456789", inj, "list")).toBe("1.23");
    expect(formatTokenAmount("1234567890123456789", inj, "history")).toBe("1.234");
  });

  it("keeps the sign and accepts a bigint", () => {
    expect(formatTokenAmount("-12340000", usdcN(), "list")).toBe("-12.34");
    expect(formatTokenAmount("-12340000", usdcN(), "history")).toBe("-12.34");
    expect(formatTokenAmount(12_340_000n, usdcN(), "list")).toBe("12.34");
  });
});

describe("formatTokenAmount digits", () => {
  it("stays exact for amounts a float cannot hold, with no exponent", () => {
    // 9007199254740995 whole tokens: above 2^53, where a float rounded it up to …996.
    expect(formatTokenAmount("9007199254740995123456", usdcN(), "confirm")).toBe("9007199254740995.123456");
    expect(formatTokenAmount("9007199254740995000000", usdcN(), "picker")).toBe("9007199254740995");
    // Above 10^21 a float printed "1.2345678901234569e+23.56789".
    const huge = "123456789012345678901234567890";
    expect(formatTokenAmount(huge, usdcN(), "confirm")).toBe("123456789012345678901234.56789");
    expect(formatTokenAmount(huge, usdcN(), "list")).toBe("123456789012345.67Bn");
    expect(formatTokenAmount(`1${"0".repeat(36)}`, usdcN(), "history")).toBe(`1${"0".repeat(21)}Bn`);
    for (const variant of VARIANTS) {
      expect(formatTokenAmount(huge, usdcN(), variant), variant).not.toMatch(/e[+-]?\d/);
    }
  });

  it("cuts in every variant, so no surface shows more than there is", () => {
    expect(formatTokenAmount("999999", usdcN(), "list")).toBe("0.99");
    expect(formatTokenAmount("1999999", usdcN(), "list")).toBe("1.99");
    expect(formatTokenAmount("1999999", usdcN(), "history")).toBe("1.999");
    // Just under a thousand stays in its unit, never "1000.00" or "1000.00k".
    expect(formatTokenAmount("999999999", usdcN(), "list")).toBe("999.99");
    expect(formatTokenAmount("999999999999", usdcN(), "list")).toBe("999.99k");
    expect(formatTokenAmount("999999999999", usdcN(), "history")).toBe("999.999k");
    expect(formatTokenAmount("999999999999999", usdcN(), "list")).toBe("999.99M");
  });

  it("never shows a non-zero amount as zero", () => {
    const inj = identityOf("injective-1", "inj");
    // 123 aINJ, and an Injective fee of 0.00008 INJ, read "<…" at each variant's precision.
    expect(formatTokenAmount("123", inj, "confirm")).toBe("<0.000001");
    expect(formatTokenAmount("123", inj, "picker")).toBe("<0.000001");
    expect(formatTokenAmount("80000000000000", inj, "history", { unit: true })).toBe("<0.001 INJ");
    expect(formatTokenAmount("-80000000000000", inj, "history")).toBe("-<0.001");
    expect(formatTokenAmount("4", usdcN(), "list")).toBe("<0.01");
    // The smallest amount each variant shows as a number.
    expect(formatTokenAmount("1000000000000", inj, "confirm")).toBe("0.000001");
    expect(formatTokenAmount("1000000000000000", inj, "history")).toBe("0.001");
    expect(formatTokenAmount("10000", usdcN(), "list")).toBe("0.01");
    // Zero is still zero.
    expect(formatTokenAmount("0", usdcN(), "list")).toBe("0.00");
    expect(formatTokenAmount("0", usdcN(), "history")).toBe("0");
    expect(formatTokenAmount("-0", inj, "confirm")).toBe("0");
  });

  it("says one base unit in the singular", () => {
    expect(formatTokenAmount("1", unknown(), "picker")).toBe("1 base unit");
    expect(formatTokenAmount("-1", unknown(), "history", { unit: true })).toBe("-1 base unit ibc/0123…ABCDEF");
    expect(formatTokenAmount("10", unknown(), "picker")).toBe("10 base units");
  });
});

describe("amountFieldText", () => {
  /** The screens' conversion of a field (interchain-ui.tsx toBaseUnits), restated so a lib suite needs no screen. */
  function fieldUnits(text: string, decimals: number): bigint | null {
    if (!/^\d*\.?\d*$/.test(text) || text === "" || text === ".") return null;
    const [whole = "0", fraction = ""] = text.split(".");
    if (fraction.length > decimals) return null;
    return BigInt(whole + fraction.padEnd(decimals, "0"));
  }

  it("gives Max a text that converts back to the exact balance", () => {
    const inj = identityOf("injective-1", "inj");
    for (const raw of ["0", "1", "123", "1234567890123456789", "9007199254740993", "123456789012345678901234567890"]) {
      for (const scale of [inj, usdcN(), unknown()]) {
        const text = amountFieldText(raw, scale);
        expect(text, `${raw} at ${scale.decimals}`).toMatch(/^\d+(\.\d+)?$/);
        expect(fieldUnits(text, scale.decimals), `${raw} at ${scale.decimals}`).toBe(BigInt(raw));
      }
    }
    expect(amountFieldText("1234567890123456789", inj)).toBe("1.234567890123456789");
    expect(amountFieldText(12_340_000n, usdcN())).toBe("12.34");
  });

  it("holds the raw integer when the decimals are unknown, however large", () => {
    // Max is the only input such a field takes. Today's Max path, formatUnitsExact(raw, 0),
    // goes through a float: 1234567890123456789 came back as 1234567890123456800 (more than
    // is held), and 10^29 as "1.2345678901234568e+29", which the field cannot parse.
    for (const raw of ["1234567890123456789", "123456789012345678901234567890"]) {
      expect(amountFieldText(raw, unknown())).toBe(raw);
      expect(fieldUnits(amountFieldText(raw, unknown()), unknown().decimals)).toBe(BigInt(raw));
    }
  });

  it("gives 0 for text that is not a balance", () => {
    expect(amountFieldText("-5", usdcN())).toBe("0");
    expect(amountFieldText("12.5", usdcN())).toBe("0");
    expect(amountFieldText("", usdcN())).toBe("0");
  });
});

describe("formatTokenAmount units and hidden mode", () => {
  it("appends the ticker, or the short denom of a token nothing names", () => {
    expect(formatTokenAmount("12340000", usdcN(), "history", { unit: true })).toBe("12.34 USDC.n");
    expect(formatTokenAmount("-12340000", usdcN(), "history", { unit: true })).toBe("-12.34 USDC.n");
    expect(formatTokenAmount("12340000", unknown(), "history", { unit: true })).toBe(
      "12340000 base units ibc/0123…ABCDEF",
    );
    expect(formatTokenAmount("12340000", namedNoDecimals(), "confirm", { unit: true })).toBe(
      "12340000 base units USDC.n",
    );
    expect(amountUnit(usdcN())).toBe("USDC.n");
    expect(amountUnit(unknown())).toBe("ibc/0123…ABCDEF");
  });

  it("masks the whole text in hidden mode", () => {
    for (const variant of VARIANTS) {
      for (const identity of [usdcN(), unknown()]) {
        expect(formatTokenAmount("12340000", identity, variant, { hidden: true })).toBe("••••");
        expect(formatTokenAmount("12340000", identity, variant, { hidden: true, unit: true })).toBe("••••");
      }
    }
  });
});

describe("typed amounts", () => {
  it("are allowed only when the decimals are known; otherwise Max only", () => {
    expect(canTypeAmount(usdcN())).toBe(true);
    expect(canTypeAmount(unknown())).toBe(false);
    expect(canTypeAmount(namedNoDecimals())).toBe(false);
    expect(MAX_ONLY_NOTE).toMatch(/Max/);
  });
});

describe("ticker layout", () => {
  it("splits the family part, which may truncate, from the suffix, which may not", () => {
    expect(tickerParts(usdcAxlPolygon())).toEqual({ head: "USDC", tail: ".axl.polygon" });
    expect(tickerParts(identityOf("cosmoshub-4", MBTC_MIDAS_ON_HUB))).toEqual({
      head: "mBTC.midas",
      tail: ".eureka",
    });
    expect(tickerParts(unknown())).toEqual({ head: "IBC", tail: "·0123" });
    expect(tickerParts(identityOf("osmosis-1", ALL_USDC))).toEqual({ head: "allUSDC", tail: "" });
    expect(tickerParts({ ticker: "STARS.legacy", family: "STARS.legacy" })).toEqual({
      head: "STARS",
      tail: ".legacy",
    });
    // An impostor's hash mark stays in the part that is never cut.
    expect(tickerParts({ ticker: "USDC.n·3F5B", family: "USDC" })).toEqual({ head: "USDC", tail: ".n·3F5B" });
    expect(tickerParts({ ticker: "ATOM1KLFG", family: "ATOM" })).toEqual({ head: "ATOM1KLFG", tail: "" });
  });

  it("renders the suffix outside the truncating span", () => {
    const html = renderToStaticMarkup(createElement(TokenLabel, { identity: usdcAxlPolygon() }));
    expect(html).toContain('<span class="min-w-0 truncate">USDC</span>');
    const tail = /<span dir="rtl" class="([^"]*)"><bdi dir="ltr">\.axl\.polygon<\/bdi><\/span>/.exec(html);
    expect(tail?.[1]).toContain("shrink-0");
    expect(tail?.[1]).not.toContain("truncate");
    expect(html).toContain("Axelar USDC from Polygon · on Osmosis");
  });

  it("keeps an inline ticker wider than its line inside the line", () => {
    // An unlisted token's ticker is its free-text subdenom: this one is about 350px wide.
    const meme = identityOf("osmosis-1", `factory/osmo1evil/${"MyMemeCoin".repeat(5)}`);
    const html = renderToStaticMarkup(createElement(TokenLabel, { identity: meme, variant: "inline" }));
    // The subtitle gives way first (the ticker does not shrink for it), but the ticker is
    // capped at the line, so its own family part truncates instead of running over the
    // label beside it ("Buys" on the swap confirm screen).
    const ticker = /^<span class="[^"]*"><span class="([^"]*)">/.exec(html)?.[1] ?? "";
    expect(ticker.split(" ")).toEqual(expect.arrayContaining(["shrink-0", "max-w-full", "min-w-0"]));
  });

  it("tags a testnet and a user-added chain, and nothing on a mainnet", () => {
    expect(renderToStaticMarkup(createElement(TokenLabel, { identity: identityOf("osmo-test-5", "uosmo") }))).toContain(
      ">Testnet</span>",
    );
    expect(renderToStaticMarkup(createElement(TokenLabel, { identity: usdcN() }))).not.toContain("Testnet");
  });
});

describe("token words", () => {
  it("name the ticker, then origin and location in words, in the accessible name", () => {
    // The plan's words follow the visible ticker, which a voice user says (WCAG 2.5.3).
    expect(tokenA11yName(usdcInjOnOsmosis())).toBe("USDC.inj, USDC from Injective, on Osmosis");
    expect(tokenA11yName(usdcN())).toBe("USDC.n, USDC from Noble, on Osmosis");
    expect(tokenA11yName(usdcInjHome(), "delivered")).toBe("USDC.inj, USDC from Injective, delivered on Injective");
    expect(tokenA11yName(usdcInjHome())).toBe("USDC.inj, native on Injective");
    expect(tokenA11yName(identityOf("osmosis-1", ALL_USDC))).toBe("allUSDC, Alloyed USDC, on Osmosis");
    expect(tokenA11yName(unknown(), "held")).toBe("IBC·0123, Unknown token ibc/0123…ABCDEF, held on Osmosis");
    // An unknown token whose ticker is its short denom says it once.
    const lowercase = identityOf("injective-1", USDC_INJ_ERC20.toLowerCase());
    expect(tokenA11yName(lowercase)).toBe("Unknown token erc20:0xa00c…235a, on Injective");
  });

  it("tell a bridged token's source network apart in the accessible name, wherever it sits", () => {
    expect(tokenA11yName(identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS))).toBe("USDC.axl, USDC from Axelar, on Osmosis");
    expect(tokenA11yName(usdcAxlPolygon())).toBe("USDC.axl.polygon, Axelar USDC from Polygon, on Osmosis");
    // Delivered on the issuer, where Swap's origin-delivery rows land: these were all
    // "USDC from Axelar, delivered on Axelar".
    expect(tokenA11yName(identityOf("axelar-dojo-1", "uusdc"), "delivered")).toBe(
      "USDC.axl, USDC from Axelar, delivered on Axelar",
    );
    expect(tokenA11yName(identityOf("axelar-dojo-1", "polygon-uusdc"), "delivered")).toBe(
      "USDC.axl.polygon, Axelar USDC from Polygon, delivered on Axelar",
    );
    expect(tokenA11yName(identityOf("axelar-dojo-1", "avalanche-uusdc"), "held")).toBe(
      "USDC.axl.avax, Axelar USDC from Avalanche, held on Axelar",
    );
  });

  it("never give two tokens on one chain the same accessible name, at any location", () => {
    // Every table identity, plus the issuer-side identity of each Osmosis row Swap delivers home.
    const identities = new Map<string, TokenIdentity>();
    for (const row of tokenTableRows()) {
      const held = identityOf(row.heldOnChainId, row.denom);
      identities.set(held.key, held);
      if (row.counterpartyChainId !== null && row.counterpartyChainId === row.originChainId) {
        const issuer = identityOf(row.originChainId, row.originDenom);
        identities.set(issuer.key, issuer);
      }
    }
    // WP-A's guard tags a second route of a ticker on one chain (USDC.n·XXXX); its words match the first.
    const secondRoute: TokenIdentity = {
      ...usdcN(),
      key: `osmosis-1:${UNLISTED}`,
      denom: UNLISTED,
      ticker: "USDC.n·0123",
    };
    identities.set(secondRoute.key, secondRoute);
    expect(identities.size).toBeGreaterThan(700);
    for (const location of ["on", "delivered", "held"] as const) {
      const owners = new Map<string, string>();
      for (const identity of identities.values()) {
        const name = tokenA11yName(identity, location);
        // The visible ticker is always in the name.
        expect(` ${name.replace(/,/g, " ")} `, name).toContain(` ${identity.ticker} `);
        const owner = owners.get(name);
        expect(owner === undefined || owner === identity.key, `${location}: "${name}" for ${owner} and ${identity.key}`).toBe(true);
        owners.set(name, identity.key);
      }
    }
    expect(tokenA11yName(secondRoute)).toBe("USDC.n·0123, USDC from Noble, on Osmosis");
  });

  it("say testnet or custom chain when the chain name does not", () => {
    expect(tokenA11yName(identityOf("osmo-test-5", "uosmo"))).toBe("OSMO, native on Osmosis Testnet");
    setCustomCatalogEntries([customChain({})]);
    const mine = identityOf("mine-1", "umine");
    expect(networkTag(mine)).toBe("Custom");
    expect(tokenA11yName(mine)).toMatch(/, custom chain$/);
  });

  it("word the location for a balance, a destination and a source", () => {
    expect(tokenLocationText(usdcInjOnOsmosis())).toBe("on Osmosis");
    expect(tokenLocationText(usdcInjOnOsmosis(), "delivered")).toBe("Delivered on Osmosis");
    expect(tokenLocationText(usdcInjOnOsmosis(), "held")).toBe("Held on Osmosis");
    expect(tokenSubtitle(usdcInjOnOsmosis())).toBe("Injective USDC · on Osmosis");
    expect(tokenSubtitle(usdcInjHome())).toBe("Native on Injective");
    expect(tokenSubtitle(usdcInjHome(), "delivered")).toBe("Injective USDC · delivered on Injective");
    expect(tokenSubtitle(unknown(), "delivered")).toBe("Unknown origin · delivered on Osmosis · ibc/0123…ABCDEF");
    expect(tokenTooltip(usdcAxlPolygon())).toBe("USDC.axl.polygon · Axelar USDC from Polygon · on Osmosis");
  });

  it("label the seal by provenance, and only for a proven identity", () => {
    expect(provenanceLabel(identityOf("osmosis-1", "uosmo"))).toBe("Verified: issued on Osmosis");
    expect(provenanceLabel(usdcInjHome())).toBe("Verified: listed in the chain registry");
    expect(provenanceLabel(usdcN())).toBe("Verified: IBC path matches the registry");
    expect(provenanceLabel({ ...usdcN(), provenance: "channel-walk" })).toBe("Verified: IBC path traced to Noble");
    expect(provenanceLabel({ ...usdcN(), proven: false })).toBeNull();
    expect(provenanceLabel(unknown())).toBeNull();
  });

  it("badge the location chain away from the origin, or always when asked", () => {
    expect(showsLocationBadge(usdcInjHome())).toBe(false);
    expect(showsLocationBadge(usdcInjOnOsmosis())).toBe(true);
    expect(showsLocationBadge(unknown())).toBe(true);
    expect(showsLocationBadge(usdcInjHome(), "always")).toBe(true);
    expect(showsLocationBadge(usdcInjOnOsmosis(), "never")).toBe(false);
  });

  it("tag only testnets and user-added chains", () => {
    expect(networkTag(usdcN())).toBeNull();
    expect(networkTag(identityOf("osmo-test-5", "uosmo"))).toBe("Testnet");
    setCustomCatalogEntries([customChain({ chainId: "mine-test-1", network: "testnet" })]);
    expect(networkTag(identityOf("mine-test-1", "umine"))).toBe("Testnet");
  });
});

describe("tokenPickerItem", () => {
  it("builds the row from the identity, keyed like picker memory", () => {
    const identity = usdcInjOnOsmosis();
    const item = tokenPickerItem(identity, { amount: "12340000", locationChain: true });
    expect(item.id).toBe(`osmosis-1:${USDC_INJ_ON_OSMOSIS}`);
    expect(item.id).toBe(identity.key);
    expect(item.label).toBe("USDC.inj");
    expect(item.sublabel).toBe("Injective USDC · on Osmosis");
    expect(item.keywords).toEqual(
      expect.arrayContaining(["Injective", "injective-1", "Osmosis", "osmosis-1", USDC_INJ_ON_OSMOSIS, USDC_INJ_ERC20]),
    );
    expect(trailingText(item.trailing)).toBe("12.34");
    expect(item.disabled).toBeUndefined();
    expect(item.searchOnly).toBeUndefined();
  });

  it("draws the token logo with the location badge, never a chain icon as the logo", () => {
    const identity = usdcInjOnOsmosis();
    const icon = tokenPickerItem(identity, { locationChain: true }).icon;
    expect(isValidElement(icon)).toBe(true);
    const props = (icon as { props: { identity: TokenIdentity; size: number; locationBadge: string } }).props;
    expect(props.identity).toBe(identity);
    expect(props.locationBadge).toBe("always");
    expect(props.size).toBe(24);
    // The avatar draws identity.logoUrl as the token; neither chain's icon may be it.
    expect(identity.logoUrl).toBeTruthy();
    for (const chainId of ["osmosis-1", "injective-1"]) {
      expect(identity.logoUrl).not.toBe(catalogIconFor(findCatalogEntry(chainId)!));
    }
    const home = tokenPickerItem(usdcInjHome()).icon as { props: { locationBadge: string } };
    expect(home.props.locationBadge).toBe("auto");
  });

  it("is found by origin and location words, and by the aliases users know", () => {
    const items = [
      tokenPickerItem(usdcInjHome()),
      tokenPickerItem(usdcInjOnOsmosis()),
      tokenPickerItem(usdcN()),
      tokenPickerItem(identityOf("osmosis-1", USDC_AXL_ON_OSMOSIS)),
    ];
    expect(searchItems(items, "usdc injective").map((item) => item.id)).toEqual([
      `injective-1:${USDC_INJ_ERC20}`,
      `osmosis-1:${USDC_INJ_ON_OSMOSIS}`,
    ]);
    expect(searchItems(items, "usdc noble").map((item) => item.label)).toEqual(["USDC.n"]);
    expect(searchItems(items, "usdc.noble").map((item) => item.label)).toEqual(["USDC.n"]);
    expect(searchItems(items, "axlusdc").map((item) => item.label)).toEqual(["USDC.axl"]);
  });

  it("disables a row with its reason and marks search-only rows", () => {
    const reason = "Zunia's Osmosis swap contract has no route from OSMO to USDC.inj yet.";
    const disabled = tokenPickerItem(usdcInjOnOsmosis(), { disabledReason: reason, searchOnly: true });
    expect(disabled.disabled).toBe(true);
    // PickerSheet shows the reason in place of the subtitle, so the location leads it:
    // USDC.inj on Injective and on Osmosis share this reason.
    expect(disabled.disabledReason).toBe(`On Osmosis · ${reason}`);
    expect(tokenPickerItem(usdcInjHome(), { disabledReason: reason }).disabledReason).toBe(`On Injective · ${reason}`);
    expect(disabled.searchOnly).toBe(true);
    expect(tokenPickerItem(usdcInjOnOsmosis(), { disabledReason: null }).disabled).toBeUndefined();
  });

  it("shows a balance only when there is one, masked when balances are hidden", () => {
    expect(trailingText(tokenPickerItem(usdcN(), { amount: "12340000", hidden: true }).trailing)).toBe("••••");
    expect(tokenPickerItem(usdcN(), { amount: "0" }).trailing).toBeNull();
    expect(tokenPickerItem(usdcN(), { amount: 0n }).trailing).toBeNull();
    expect(tokenPickerItem(usdcN()).trailing).toBeNull();
    expect(tokenPickerItem(usdcN(), { amount: "n/a" }).trailing).toBeNull();
    expect(trailingText(tokenPickerItem(unknown(), { amount: "12340000" }).trailing)).toBe("12340000 base units");
    expect(trailingText(tokenPickerItem(identityOf("injective-1", "inj"), { amount: "1234567890123456789" }).trailing)).toBe(
      "1.234567",
    );
  });

  it("says custom chain in the subtitle and keywords when the chain name does not", () => {
    setCustomCatalogEntries([customChain({})]);
    const item = tokenPickerItem(identityOf("mine-1", "umine"));
    expect(item.sublabel).toMatch(/ · Custom chain$/);
    expect(item.keywords).toContain("Custom");
    expect(tokenPickerItem(identityOf("osmo-test-5", "uosmo")).sublabel).toBe("Native on Osmosis Testnet");
  });
});

import { describe, expect, it } from "vitest";

import { parseOsmosisTokenMetadata } from "../osmosis-assets";

const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";

describe("parseOsmosisTokenMetadata", () => {
  it("keeps listed tokens keyed by denom, sorted by symbol", () => {
    const assets = parseOsmosisTokenMetadata({
      uosmo: { name: "Osmosis", symbol: "OSMO", decimals: 6, preview: false },
      [ATOM]: { name: "Cosmos Hub", symbol: "ATOM", decimals: 6, preview: false },
    });
    expect(assets).toEqual([
      { denom: ATOM, symbol: "ATOM", name: "Cosmos Hub", decimals: 6 },
      { denom: "uosmo", symbol: "OSMO", name: "Osmosis", decimals: 6 },
    ]);
  });

  it("drops preview tokens and rows that do not parse", () => {
    const assets = parseOsmosisTokenMetadata({
      "factory/osmo1x/new": { symbol: "NEW", decimals: 6, preview: true },
      "factory/osmo1x/unflagged": { symbol: "UNF", decimals: 6 },
      "1bad": { symbol: "BAD", decimals: 6, preview: false },
      unamed: { symbol: "", decimals: 6, preview: false },
      ufrac: { symbol: "FRAC", decimals: 6.5, preview: false },
      uhuge: { symbol: "HUGE", decimals: 99, preview: false },
      ustr: { symbol: "STR", decimals: "6", preview: false },
      unull: null,
    });
    expect(assets).toEqual([]);
  });

  it("falls back to the symbol for a missing name and bounds long text", () => {
    const [short, long] = parseOsmosisTokenMetadata({
      ushort: { symbol: "A", decimals: 18, preview: false },
      ulong: { symbol: "X".repeat(40), name: "Y".repeat(90), decimals: 6, preview: false },
    });
    expect(short?.name).toBe("A");
    expect(long?.symbol).toHaveLength(24);
    expect(long?.name).toHaveLength(48);
  });

  it("answers an unexpected body with an empty list", () => {
    expect(parseOsmosisTokenMetadata(null)).toEqual([]);
    expect(parseOsmosisTokenMetadata([{ symbol: "OSMO" }])).toEqual([]);
    expect(parseOsmosisTokenMetadata("tokens")).toEqual([]);
  });
});

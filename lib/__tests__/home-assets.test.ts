import { describe, expect, it } from "vitest";
import type { ChainBalance, TokenBalance } from "../balances";
import {
  assetSubtitle,
  groupHomeAssets,
  groupedSubtitle,
  homeAssets,
  tokenKindLabel,
  tokenSpotPrice,
} from "../home-assets";

const OSMOSIS = {
  chainId: "osmosis-1",
  chainName: "Osmosis",
  network: "mainnet" as const,
  coinDenom: "OSMO",
  coinMinimalDenom: "uosmo",
  coinDecimals: 6,
  iconUrl: "/osmo.png",
};

const SAFRO = {
  chainId: "safrochain-1",
  chainName: "Safrochain",
  network: "mainnet" as const,
  coinDenom: "SAF",
  coinMinimalDenom: "usaf",
  coinDecimals: 6,
};

function native(amount: string, extras: Partial<TokenBalance> = {}): TokenBalance {
  return {
    denom: "uosmo",
    amount,
    kind: "native",
    symbol: "OSMO",
    displayName: "OSMO",
    decimals: 6,
    ...extras,
  };
}

describe("tokenKindLabel", () => {
  it("names each held kind in a short badge", () => {
    expect(tokenKindLabel("native")).toBe("Native");
    expect(tokenKindLabel("ibc")).toBe("IBC");
    expect(tokenKindLabel("factory")).toBe("Factory");
    expect(tokenKindLabel("other")).toBe("Asset");
  });
});

describe("assetSubtitle", () => {
  it("names the origin chain for an unwound IBC token", () => {
    expect(
      assetSubtitle(
        {
          denom: "ibc/ABC",
          amount: "1",
          kind: "ibc",
          symbol: "ATOM",
          displayName: "ATOM/IBC",
          decimals: 6,
          originChainName: "Cosmos Hub",
        },
        "Osmosis",
      ),
    ).toBe("Osmosis · Cosmos Hub");
  });

  it("clips a factory path instead of dumping the creator address", () => {
    const subtitle = assetSubtitle(
      {
        denom: "factory/addr_safro1verylongcreator/udyma",
        amount: "1",
        kind: "factory",
        symbol: "DYMA",
        displayName: "DYMA",
        decimals: 6,
      },
      "Safrochain",
    );
    expect(subtitle.startsWith("Safrochain · factory/")).toBe(true);
    expect(subtitle).not.toContain("addr_safro1verylongcreator");
  });
});

describe("homeAssets", () => {
  it("lifts IBC and factory next to the native, and keeps a zero native", () => {
    const balances: Record<string, ChainBalance> = {
      "osmosis-1": {
        chainId: "osmosis-1",
        available: "3908419",
        staked: "0",
        rewards: "0",
        denom: "uosmo",
        decimals: 6,
        symbol: "OSMO",
        tokens: [
          native("3908419"),
          {
            denom: "ibc/ATOM",
            amount: "1000000",
            kind: "ibc",
            symbol: "ATOM",
            displayName: "ATOM/IBC",
            decimals: 6,
            originChainName: "Cosmos Hub",
            baseDenom: "uatom",
          },
          {
            denom: "factory/osmo1abc/usdc",
            amount: "5000000",
            kind: "factory",
            symbol: "USDC",
            displayName: "USDC",
            decimals: 6,
          },
        ],
      },
      "safrochain-1": {
        chainId: "safrochain-1",
        available: "0",
        staked: "0",
        rewards: "0",
        denom: "usaf",
        decimals: 6,
        symbol: "SAF",
        tokens: [
          {
            denom: "usaf",
            amount: "0",
            kind: "native",
            symbol: "SAF",
            displayName: "SAF",
            decimals: 6,
          },
        ],
      },
    };

    const rows = homeAssets([OSMOSIS, SAFRO], balances, {
      "osmosis-1": { price: 0.036, change24h: 0.89 },
    });

    expect(rows.map((row) => row.token.symbol)).toEqual(["OSMO", "ATOM", "USDC", "SAF"]);
    expect(rows[0]?.fiatValue).toBeCloseTo(3.908419 * 0.036, 6);
    expect(rows[0]?.change24h).toBe(0.89);
    expect(rows[1]?.subtitle).toBe("Osmosis · Cosmos Hub");
    expect(rows[1]?.kindLabel).toBe("IBC");
    expect(rows[2]?.kindLabel).toBe("Factory");
    expect(rows[3]?.token.amount).toBe("0");
  });
});

describe("groupHomeAssets", () => {
  it("keeps chain order and reports spendable count per group", () => {
    const rows = homeAssets(
      [OSMOSIS, SAFRO],
      {
        "osmosis-1": {
          chainId: "osmosis-1",
          available: "1000000",
          staked: "0",
          rewards: "0",
          denom: "uosmo",
          decimals: 6,
          symbol: "OSMO",
          tokens: [
            native("1000000"),
            {
              denom: "ibc/ATOM",
              amount: "1",
              kind: "ibc",
              symbol: "ATOM",
              displayName: "ATOM/IBC",
              decimals: 6,
              originChainName: "Cosmos Hub",
            },
          ],
        },
      },
      {},
    );
    const groups = groupHomeAssets(rows, ["safrochain-1", "osmosis-1"]);
    expect(groups.map((group) => group.chainId)).toEqual([
      "safrochain-1",
      "osmosis-1",
    ]);
    expect(groups[1]?.spendable).toBe(2);
    expect(groupedSubtitle(rows.find((row) => row.token.kind === "ibc")!.token)).toBe(
      "Cosmos Hub",
    );
  });
});

describe("tokenSpotPrice", () => {
  it("does not invent a 24h for factory tokens", () => {
    expect(
      tokenSpotPrice(
        {
          denom: "factory/x/y",
          amount: "1",
          kind: "factory",
          symbol: "Y",
          displayName: "Y",
          decimals: 6,
        },
        "osmosis-1",
        { "osmosis-1": { price: 1, change24h: 2 } },
      ),
    ).toBeUndefined();
  });
});

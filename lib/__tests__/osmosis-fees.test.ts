import { describe, expect, it } from "vitest";

import {
  BASE_FEE_HEADROOM,
  OSMOSIS_BASE_DENOM,
  feeTokenAmount,
  fetchBaseFee,
  fetchFeeTokens,
  osmosisFeeOptions,
  parseDecimal,
  preferredFeeToken,
  type FeeTokenOption,
} from "../osmosis-fees";
import type { TokenBalance } from "../balances";

const ONE = 10n ** 18n;

function token(patch: Partial<TokenBalance> & { denom: string }): TokenBalance {
  return {
    amount: "0",
    kind: "ibc",
    symbol: patch.denom.toUpperCase(),
    displayName: patch.denom,
    decimals: 6,
    ...patch,
  };
}

describe("parseDecimal", () => {
  it("reads the chain's eighteen-place decimal strings exactly", () => {
    expect(parseDecimal("1.000000000000000000")).toBe(ONE);
    expect(parseDecimal("0.030000000000000000")).toBe(3n * 10n ** 16n);
    expect(parseDecimal("46.885077530000000000")).toBe(46_885_077_530_000_000_000n);
  });

  it("accepts a bare integer", () => {
    expect(parseDecimal("7")).toBe(7n * ONE);
  });

  it("refuses anything that is not a positive decimal", () => {
    expect(parseDecimal("")).toBeNull();
    expect(parseDecimal("-1")).toBeNull();
    expect(parseDecimal("1e18")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
  });
});

describe("feeTokenAmount", () => {
  const baseFee = parseDecimal("0.030000000000000000")!;

  it("prices gas in OSMO itself, with the headroom applied", () => {
    // 250000 gas x 0.03 uosmo = 7500 uosmo, x1.25 headroom = 9375.
    expect(
      feeTokenAmount({ gas: 250_000n, baseFee, spotPrice: ONE, headroom: BASE_FEE_HEADROOM }),
    ).toBe("9375");
  });

  it("divides by the spot price, the inverse of the chain's own conversion", () => {
    // ATOM is worth ~46.885 uosmo per uatom, so the same gas costs ~200 uatom.
    const spotPrice = parseDecimal("46.885077530000000000")!;
    expect(feeTokenAmount({ gas: 250_000n, baseFee, spotPrice, headroom: 1.25 })).toBe(
      "200",
    );
  });

  it("rounds up, because a fee one base unit short is refused outright", () => {
    const spotPrice = parseDecimal("46.885077530000000000")!;
    const exact = (250_000n * baseFee * 1250n) / (1000n * spotPrice);
    expect(BigInt(feeTokenAmount({ gas: 250_000n, baseFee, spotPrice })!)).toBeGreaterThan(
      exact - 1n,
    );
  });

  it("refuses to divide by a drained pool's zero price", () => {
    expect(feeTokenAmount({ gas: 250_000n, baseFee, spotPrice: 0n })).toBeNull();
  });

  it("refuses a zero gas limit or a zero base fee", () => {
    expect(feeTokenAmount({ gas: 0n, baseFee, spotPrice: ONE })).toBeNull();
    expect(feeTokenAmount({ gas: 250_000n, baseFee: 0n, spotPrice: ONE })).toBeNull();
  });
});

describe("fetchFeeTokens", () => {
  it("reads the REST spelling of the pool id, which is poolID not pool_id", async () => {
    const get = async () => ({
      fee_tokens: [
        { denom: "ibc/ATOM", poolID: "1" },
        { denom: "factory/osmo1x/LAB", poolID: "1655" },
      ],
    });
    expect(await fetchFeeTokens(get)).toEqual([
      { denom: "ibc/ATOM", poolId: "1" },
      { denom: "factory/osmo1x/LAB", poolId: "1655" },
    ]);
  });

  it("drops rows with no denom rather than producing an unusable option", async () => {
    const get = async () => ({ fee_tokens: [{ poolID: "1" }, null, { denom: "" }] });
    expect(await fetchFeeTokens(get)).toEqual([]);
  });

  it("returns nothing for a body it does not recognise", async () => {
    expect(await fetchFeeTokens(async () => ({}))).toEqual([]);
    expect(await fetchFeeTokens(async () => null)).toEqual([]);
  });
});

describe("fetchBaseFee", () => {
  it("reads the current EIP base fee", async () => {
    const fee = await fetchBaseFee(async () => ({ base_fee: "0.030000000000000000" }));
    expect(fee).toBe(3n * 10n ** 16n);
  });

  it("returns null rather than a guess when the field is missing", async () => {
    expect(await fetchBaseFee(async () => ({}))).toBeNull();
  });
});

describe("osmosisFeeOptions", () => {
  const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
  const UNLISTED = "ibc/NOTACCEPTED";

  function lcd(overrides: Record<string, unknown> = {}) {
    return async (path: string): Promise<unknown> => {
      if (path.startsWith("/osmosis/txfees/v1beta1/fee_tokens")) {
        return { fee_tokens: [{ denom: ATOM, poolID: "1" }] };
      }
      if (path.startsWith("/osmosis/txfees/v1beta1/cur_eip_base_fee")) {
        return { base_fee: "0.030000000000000000" };
      }
      if (path.startsWith("/osmosis/txfees/v1beta1/spot_price_by_denom")) {
        return { spot_price: "46.885077530000000000" };
      }
      return overrides[path] ?? null;
    };
  }

  it("offers only what the user holds and the chain accepts", async () => {
    const options = await osmosisFeeOptions({
      get: lcd(),
      gas: "250000",
      tokens: [
        token({ denom: OSMOSIS_BASE_DENOM, symbol: "OSMO", amount: "1000000", kind: "native" }),
        token({ denom: ATOM, symbol: "ATOM", amount: "5000000" }),
        token({ denom: UNLISTED, symbol: "NOPE", amount: "9999999" }),
      ],
    });
    expect(options.map((row) => row.symbol)).toEqual(["OSMO", "ATOM"]);
  });

  it("puts OSMO first and prices each option from the chain's numbers", async () => {
    const [osmo, atom] = await osmosisFeeOptions({
      get: lcd(),
      gas: "250000",
      tokens: [
        token({ denom: ATOM, symbol: "ATOM", amount: "5000000" }),
        token({ denom: OSMOSIS_BASE_DENOM, symbol: "OSMO", amount: "1000000", kind: "native" }),
      ],
    });
    expect(osmo).toMatchObject({ denom: OSMOSIS_BASE_DENOM, amount: "9375", affordable: true });
    expect(atom).toMatchObject({ denom: ATOM, amount: "200", affordable: true });
  });

  it("labels a balance too small to cover the fee instead of hiding it", async () => {
    const [osmo] = await osmosisFeeOptions({
      get: lcd(),
      gas: "250000",
      tokens: [
        token({ denom: OSMOSIS_BASE_DENOM, symbol: "OSMO", amount: "10", kind: "native" }),
      ],
    });
    expect(osmo).toMatchObject({ affordable: false, held: "10", amount: "9375" });
  });

  it("drops a denom whose price cannot be read rather than showing it unpriced", async () => {
    const get = async (path: string): Promise<unknown> => {
      if (path.startsWith("/osmosis/txfees/v1beta1/fee_tokens")) {
        return { fee_tokens: [{ denom: ATOM, poolID: "1" }] };
      }
      if (path.startsWith("/osmosis/txfees/v1beta1/cur_eip_base_fee")) {
        return { base_fee: "0.030000000000000000" };
      }
      throw new Error("spot price endpoint down");
    };
    const options = await osmosisFeeOptions({
      get,
      gas: "250000",
      tokens: [token({ denom: ATOM, symbol: "ATOM", amount: "5000000" })],
    });
    expect(options).toEqual([]);
  });

  it("offers nothing when the base fee cannot be read, rather than inventing one", async () => {
    const get = async (path: string): Promise<unknown> =>
      path.startsWith("/osmosis/txfees/v1beta1/fee_tokens")
        ? { fee_tokens: [{ denom: ATOM, poolID: "1" }] }
        : {};
    expect(
      await osmosisFeeOptions({
        get,
        gas: "250000",
        tokens: [token({ denom: ATOM, symbol: "ATOM", amount: "5000000" })],
      }),
    ).toEqual([]);
  });

  it("refuses a gas limit that is not a positive integer", async () => {
    for (const gas of ["0", "-1", "abc", ""]) {
      expect(
        await osmosisFeeOptions({ get: lcd(), gas, tokens: [token({ denom: ATOM })] }),
      ).toEqual([]);
    }
  });
});

describe("preferredFeeToken", () => {
  function option(patch: Partial<FeeTokenOption> & { denom: string }): FeeTokenOption {
    return {
      symbol: patch.denom,
      decimals: 6,
      amount: "100",
      held: "1000000",
      affordable: true,
      spotPrice: ONE.toString(),
      ...patch,
    };
  }

  it("prefers OSMO when there is enough of it", () => {
    const picked = preferredFeeToken([
      option({ denom: "ibc/ATOM" }),
      option({ denom: OSMOSIS_BASE_DENOM }),
    ]);
    expect(picked?.denom).toBe(OSMOSIS_BASE_DENOM);
  });

  it("falls back to the cheapest affordable token when OSMO will not cover it", () => {
    const picked = preferredFeeToken([
      option({ denom: OSMOSIS_BASE_DENOM, affordable: false }),
      option({ denom: "ibc/EXPENSIVE", amount: "100", spotPrice: (10n * ONE).toString() }),
      option({ denom: "ibc/CHEAP", amount: "100", spotPrice: (2n * ONE).toString() }),
    ]);
    expect(picked?.denom).toBe("ibc/CHEAP");
  });

  it("returns null when nothing held can pay, so the caller must say so", () => {
    expect(
      preferredFeeToken([option({ denom: OSMOSIS_BASE_DENOM, affordable: false })]),
    ).toBeNull();
    expect(preferredFeeToken([])).toBeNull();
  });
});

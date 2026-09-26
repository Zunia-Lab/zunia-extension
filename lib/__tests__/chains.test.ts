import { describe, expect, it } from "vitest";
import { chainJsonFor } from "../chains";

function parsed(chainId: string): Record<string, unknown> {
  return JSON.parse(chainJsonFor(chainId)) as Record<string, unknown>;
}

describe("chainJsonFor", () => {
  it("emits a Keplr ChainInfo the WASM kernel can parse for Safrochain", () => {
    const info = parsed("safrochain-1");
    const bip44 = info.bip44 as { coinType: number };
    const bech32 = info.bech32Config as { bech32PrefixAccAddr: string };
    const fees = info.feeCurrencies as Array<{ coinMinimalDenom: string }>;

    expect(info.chainId).toBe("safrochain-1");
    expect(info.chainName).toBe("Safrochain");
    expect(String(info.rpc)).toMatch(/^https:\/\//);
    expect(String(info.rest)).toMatch(/^https:\/\//);
    expect(bip44.coinType).toBe(118);
    expect(bech32.bech32PrefixAccAddr).toBe("addr_safro");
    expect(fees[0]?.coinMinimalDenom).toBe("usaf");
    expect(info.features).toEqual(["cosmwasm"]);
    expect(info.bech32Prefix).toBe("addr_safro");
    expect(info.coinType).toBe(118);
  });

  it("keeps a stub-shaped document for an unknown chain so JS derive still works", () => {
    const info = parsed("not-a-real-chain");
    expect(info.chainId).toBe("not-a-real-chain");
    expect(info.bech32Prefix).toBe("cosmos");
    expect(info.coinType).toBe(118);
    expect(String(info.rpc)).toMatch(/^https:\/\//);
    expect((info.feeCurrencies as unknown[]).length).toBe(1);
  });
});

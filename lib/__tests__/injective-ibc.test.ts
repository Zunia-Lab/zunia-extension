import { bech32 } from "@scure/base";
import { estimateFee } from "@zunialab/interchain";
import { describe, expect, it } from "vitest";

import { pubkeyTypeUrl } from "../amino-tx";
import {
  allCatalogEntries,
  chainTicker,
  currenciesOf,
  denomsMatch,
  displayCoinSymbol,
  ethPubKeyTypeUrlFor,
  findCatalogEntry,
} from "../chain-catalog";
import {
  applyGasFloor,
  coinDisplay,
  erc20TransferGasFloor,
  ERC20_IBC_GAS_FLOOR,
} from "../coin-display";
import { createLocalKernel, ethereumHexAddress } from "../kernel";

const KNOWN_INJ = "inj1n5sm83csgezypzlje2q9yc3dwagqnsp8f6x9nz";
const KNOWN_HEX = "0x9D21b3C7104644408bf2ca8052622d775009c027";
const USDC = "erc20:0xa00c59ff5a080d2b954d0c75e46e22a0c371235a";
const USDC_MIXED = "erc20:0xA00C59fF5a080D2b954d0c75e46E22a0c371235a";
/** The spelling Injective's bank holds (9.6M supply); the others hold nothing. */
const USDC_BANK = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
const WINJ = "erc20:0x0000000088827d2d103ee2d9a6b781773ae03ffb";
const PHRASE = `${"abandon ".repeat(11)}about`;

describe("injective account spelling", () => {
  it("is one 20-byte account in bech32 and EIP-55 hex", () => {
    expect(ethereumHexAddress(KNOWN_INJ)).toBe(KNOWN_HEX);
  });

  it("does not turn a coin-type-118 account into that inj address", () => {
    const kernel = createLocalKernel();
    const cosmos = kernel.deriveAddress(
      PHRASE,
      "",
      JSON.stringify({ bech32Prefix: "cosmos", coinType: 118 }),
      0,
    );
    const decoded = bech32.decode(cosmos.bech32Address as `${string}1${string}`);
    const swapped = bech32.encode("inj", decoded.words);
    const eth = kernel.deriveAddress(
      PHRASE,
      "",
      JSON.stringify({
        bech32Prefix: "inj",
        coinType: 60,
        features: ["eth-address-gen"],
      }),
      0,
    );
    expect(swapped).not.toBe(KNOWN_INJ);
    expect(swapped).not.toBe(eth.bech32Address);
    expect(ethereumHexAddress(eth.bech32Address)).not.toBe(KNOWN_HEX);
  });
});

describe("injective pubkey type", () => {
  it("comes from the chain document, not from the chain id", () => {
    expect(ethPubKeyTypeUrlFor("injective-1")).toBe(
      "/injective.crypto.v1beta1.ethsecp256k1.PubKey",
    );
    expect(ethPubKeyTypeUrlFor("injective-888")).toBe(
      "/injective.crypto.v1beta1.ethsecp256k1.PubKey",
    );
    expect(ethPubKeyTypeUrlFor("evmos_9001-2")).toBeUndefined();
    expect(pubkeyTypeUrl(true, ethPubKeyTypeUrlFor("injective-1"))).toBe(
      "/injective.crypto.v1beta1.ethsecp256k1.PubKey",
    );
    expect(pubkeyTypeUrl(true, ethPubKeyTypeUrlFor("evmos_9001-2"))).toBe(
      "/ethermint.crypto.v1.ethsecp256k1.PubKey",
    );
  });
});

describe("injective bank denoms", () => {
  it("matches erc20 and peggy denoms without caring about hex case", () => {
    expect(denomsMatch(USDC_MIXED, USDC)).toBe(true);
    expect(denomsMatch("peggy0xdAC17F958D2ee523a2206206994597C13D831ec7", "peggy0xdac17f958d2ee523a2206206994597c13d831ec7")).toBe(true);
    expect(denomsMatch("inj", "INJ")).toBe(false);

    // Matching is for finding the catalog row; naming is for the bank denom.
    // Bank denoms are case-sensitive, so only the spelling the token table
    // proves is USDC.inj. Another spelling is an empty denom (the lowercase
    // one hashes to ibc/D3B2…, not the ibc/794C… Osmosis trades) and must
    // not borrow the name.
    expect(coinDisplay("injective-1", USDC_BANK)).toEqual({ symbol: "USDC.inj", decimals: 6, known: true });
    expect(coinDisplay("injective-1", USDC_MIXED).known).toBe(false);
    expect(coinDisplay("injective-1", USDC).known).toBe(false);
    expect(coinDisplay("injective-1", WINJ)).toEqual({
      symbol: "wINJ",
      decimals: 18,
      known: true,
    });
    expect(displayCoinSymbol("wINJ", "inj")).toBe("wINJ");
  });

  it("tags a shared ticker by its issuer and keeps the home issuer bare", () => {
    // USDC is issued on several chains, so every issuer is tagged: Noble with
    // the ecosystem's "n", Injective's Circle mint with "inj", Gravity's
    // bridged copy with its bridge.
    const usdcIssuers = allCatalogEntries().filter(
      (entry) =>
        entry.network === "mainnet" &&
        currenciesOf(entry).some((currency) => currency.coinDenom === "USDC"),
    );
    expect(usdcIssuers.length).toBeGreaterThan(1);
    expect(displayCoinSymbol("USDC", "noble")).toBe("USDC.n");
    expect(displayCoinSymbol("USDC", "inj")).toBe("USDC.inj");
    expect(displayCoinSymbol("USDC", "gravity")).toBe("USDC.grv");
    expect(displayCoinSymbol("USDT", "inj")).toBe("USDT.peggy");

    const injective = findCatalogEntry("injective-1");
    const noble = findCatalogEntry("noble-1");
    expect(injective && chainTicker(injective)).toBe("INJ");
    expect(noble && chainTicker(noble)).toBe("USDC.n");
    expect(displayCoinSymbol("INJ", "inj")).toBe("INJ");
    expect(displayCoinSymbol("OSMO", "osmo")).toBe("OSMO");
    // The Hub's ATOM is home and bare; THORChain's pool ATOM is not.
    expect(displayCoinSymbol("ATOM", "cosmos")).toBe("ATOM");
    expect(displayCoinSymbol("ATOM", "thor")).toBe("ATOM.thor");
  });

  it("floors an erc20 IBC transfer at 800000 before adjustment and fees it in inj", () => {
    const transfer = (denom: string) => [
      {
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        value: { token: { denom, amount: "1" } },
      },
    ];
    expect(erc20TransferGasFloor(transfer(USDC_MIXED))).toBe(ERC20_IBC_GAS_FLOOR);
    expect(erc20TransferGasFloor(transfer(`transfer/channel-2/${USDC}`))).toBe(
      ERC20_IBC_GAS_FLOOR,
    );
    expect(erc20TransferGasFloor(transfer("inj"))).toBeNull();
    expect(erc20TransferGasFloor(transfer("ibc/ABCDEF"))).toBeNull();

    const gas = applyGasFloor("400000", erc20TransferGasFloor(transfer(USDC)));
    expect(gas).toBe("800000");
    expect(applyGasFloor("900000", ERC20_IBC_GAS_FLOOR)).toBe("900000");

    const estimate = estimateFee(
      gas,
      {
        chainId: "injective-1",
        chainName: "Injective",
        bech32Prefix: "inj",
        coinType: 60,
        coinDenom: "INJ",
        coinMinimalDenom: "inj",
        coinDecimals: 18,
        feeDenom: "INJ",
        feeMinimalDenom: "inj",
        feeDecimals: 18,
        gasPriceStep: { low: 1, average: 1, high: 1 },
      },
      "average",
      { gasAdjustment: 1.5 },
    );
    expect(estimate.amount[0]?.denom).toBe("inj");
    expect(BigInt(estimate.gasLimit)).toBeGreaterThanOrEqual(800_000n);
    expect(estimate.amount[0]?.denom).not.toBe(USDC);
  });
});

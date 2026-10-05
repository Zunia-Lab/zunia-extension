import { createHash } from "node:crypto";
import { Fragment, createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PACKET_TIMEOUT_MINUTES } from "../../config/interchain";
import { toBaseUnits } from "../../entrypoints/popup/screens/interchain-ui";
import {
  CopyDenom,
  mergePins,
  routePinsOf,
  sameChainMsgs,
  sendPickerItem,
} from "../../entrypoints/popup/screens/SendScreen";
import { msgSend } from "../amino-tx";
import { classifyToken, type BankMetadataFacts, type NativeCoin, type TokenBalance } from "../balances";
import { chainTicker, findCatalogEntry } from "../chain-catalog";
import { clearInterchainCaches } from "../interchain";
import type { PickerMemory } from "../picker";
import {
  buildTransferMsgFromPlan,
  pathHopViews,
  planTransfer,
  resetChannelChecks,
  type ManualChannel,
  type PlanInput,
  type RoutePlanView,
} from "../route-plan";
import {
  ENGINE_DOUBLE_WRAP,
  ENGINE_ENTERED_BY_HAND,
  ENGINE_UNCOMPUTED_OUTPUT,
  exactAmountText,
  issuerText,
  migrateStoredTokenMemory,
  migrateTokenIds,
  migrateTokenMemory,
  routeNotes,
  sendArrival,
  sendTokenIdentity,
  transferLabel,
  withRegistryEnds,
  type ArrivalLink,
} from "../send-arrival";
import { STORAGE_KEYS } from "../storage-keys";
import { amountFieldText, canTypeAmount } from "../token-amount";
import { ibcDenomFor, identityOf, tokenTableRows } from "../token-identity";
import { resolveTxMemo } from "../tx-memo";

/**
 * Send's display logic (lib/send-arrival.ts): what the recipient ends up
 * holding, the exponent a typed amount is signed with, and the picker's
 * memory. Identities are the real ones, from the bundled token table and
 * catalog; the last block plans real transfers against a fake IBC world.
 */

const OSMO_USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
const INJ_USDC_N = "ibc/2CBC2EA121AE42563B08028466F37B600F2D7D4282342DE938283CC3FB2BC00E";
const OSMO_USDC_AXL = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";
const OSMO_USDC_INJ = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const OSMO_ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const OSMO_ETH_PICA = "ibc/A23E590BA7E0D808706FB5085A449B3B9D6864AE4DDE7DAF936243CEBB2A3D43";
const USDC_INJ = "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a";
/** A voucher that no table row, trace or catalog names. */
const UNLISTED = `ibc/${"0123456789ABCDEF".repeat(4)}`;

function sha256Upper(text: string): string {
  return createHash("sha256").update(text).digest("hex").toUpperCase();
}

/**
 * Noble USDC held on Injective (trace transfer/channel-148/uusdc) sent to
 * Osmosis over Injective channel-8, which Osmosis receives on channel-122.
 */
const REWRAPPED = `ibc/${sha256Upper("transfer/channel-122/transfer/channel-148/uusdc")}`;

/** The registry's canonical channels (lib/ibc-channels.generated.ts), as plan links. */
const OSMOSIS_TO_NOBLE: ArrivalLink = { channelId: "channel-750", counterpartyChannelId: "channel-1" };
const NOBLE_TO_OSMOSIS: ArrivalLink = { channelId: "channel-1", counterpartyChannelId: "channel-750" };
const INJECTIVE_TO_OSMOSIS: ArrivalLink = { channelId: "channel-8", counterpartyChannelId: "channel-122" };
/** Injective's other channel to Osmosis, not the registry's. */
const INJECTIVE_TO_OSMOSIS_118: ArrivalLink = { channelId: "channel-6", counterpartyChannelId: "channel-118" };

/* -------------------------------------------------------------------------- *
 * What arrives
 * -------------------------------------------------------------------------- */

describe("sendArrival", () => {
  it("Osmosis USDC.n sent to Noble unwinds to uusdc, which is native USDC.n", () => {
    const arrival = sendArrival({
      sourceChainId: "osmosis-1",
      inputDenom: OSMO_USDC_N,
      destChainId: "noble-1",
      outputDenom: "uusdc",
      links: [OSMOSIS_TO_NOBLE],
    });
    expect(arrival.kind).toBe("native");
    expect(arrival.denom).toBe("uusdc");
    expect(arrival.identity).toMatchObject({
      ticker: "USDC.n",
      heldOnChainId: "noble-1",
      originChainId: "noble-1",
      proven: true,
    });
    expect(arrival.listedDenom).toBe("uusdc");
    expect(arrival.text).toBe("USDC.n · Native on Noble");
    expect(arrival.warning).toBeNull();
  });

  it("Noble USDC sent from Injective to Osmosis over channel-122 arrives re-wrapped, not as USDC.n", () => {
    expect(ibcDenomFor("transfer/channel-122/transfer/channel-148", "uusdc")).toBe(REWRAPPED);
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: INJ_USDC_N,
      destChainId: "osmosis-1",
      outputDenom: REWRAPPED,
      links: [INJECTIVE_TO_OSMOSIS],
    });
    expect(arrival.kind).toBe("rewrapped");
    expect(arrival.denom).toBe(REWRAPPED);
    expect(arrival.denom).not.toBe(OSMO_USDC_N);
    // Nothing names the voucher: it is not USDC.n, and never sealed.
    expect(arrival.identity?.ticker).not.toBe("USDC.n");
    expect(arrival.identity?.provenance).toBe("unknown");
    expect(arrival.identity?.proven).toBe(false);
    expect(arrival.listedDenom).toBe(OSMO_USDC_N);
    expect(arrival.text).toBe("Re-wrapped USDC.n · on Osmosis");
    expect(arrival.warning?.title).toBe("Arrives as a different token");
    expect(arrival.warning?.body).toBe(
      "Osmosis lists USDC.n as ibc/498A…6BA6E4. Sent this way it arrives as " +
        `ibc/${REWRAPPED.slice(4, 8)}…${REWRAPPED.slice(-6)}, a re-wrapped voucher that no registry ` +
        "names, so wallets and apps may not accept it. To receive USDC.n on Osmosis, send it to Noble first.",
    );
  });

  it("Noble USDC sent to Osmosis arrives as the USDC.n Osmosis lists", () => {
    const arrival = sendArrival({
      sourceChainId: "noble-1",
      inputDenom: "uusdc",
      destChainId: "osmosis-1",
      outputDenom: OSMO_USDC_N,
      links: [NOBLE_TO_OSMOSIS],
    });
    expect(arrival.kind).toBe("named");
    expect(arrival.denom).toBe(OSMO_USDC_N);
    expect(arrival.identity?.ticker).toBe("USDC.n");
    expect(arrival.text).toBe("USDC.n · Noble USDC · on Osmosis");
    expect(arrival.warning).toBeNull();
  });

  it("Injective USDC sent over the registry's channel arrives as the USDC.inj Osmosis trades", () => {
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: USDC_INJ,
      destChainId: "osmosis-1",
      outputDenom: OSMO_USDC_INJ,
      links: [INJECTIVE_TO_OSMOSIS],
    });
    expect(arrival.kind).toBe("named");
    expect(arrival.denom).toBe(OSMO_USDC_INJ);
    expect(arrival.text).toBe("USDC.inj · Injective USDC · on Osmosis");
    expect(arrival.warning).toBeNull();
  });

  it("warns when a channel delivers another voucher than the one the destination lists", () => {
    const delivered = ibcDenomFor("transfer/channel-118", USDC_INJ);
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: USDC_INJ,
      destChainId: "osmosis-1",
      outputDenom: delivered,
      links: [INJECTIVE_TO_OSMOSIS_118],
    });
    expect(arrival.kind).toBe("unnamed");
    expect(arrival.denom).toBe(delivered);
    expect(arrival.text).toBe("USDC.inj voucher · on Osmosis");
    expect(arrival.warning?.body).toContain("Osmosis lists USDC.inj as ibc/794C…476138.");
  });

  it("a token no registry lists anywhere arrives as a new voucher, without a warning", () => {
    const delivered = ibcDenomFor("transfer/channel-110497", "usaf");
    const arrival = sendArrival({
      sourceChainId: "safrochain-1",
      inputDenom: "usaf",
      destChainId: "osmosis-1",
      outputDenom: delivered,
      links: [{ channelId: "channel-1", counterpartyChannelId: "channel-110497" }],
    });
    expect(arrival.kind).toBe("unnamed");
    expect(arrival.denom).toBe(delivered);
    expect(arrival.listedDenom).toBeNull();
    expect(arrival.text).toBe("SAF voucher · on Osmosis");
    expect(arrival.warning).toBeNull();
  });

  it("never states the engine's stand-in when it could not compute the denom", () => {
    // The engine puts the input (or its unwrapped base) where it had no answer.
    for (const outputDenom of [UNLISTED, "uusdc"]) {
      const arrival = sendArrival({
        sourceChainId: "injective-1",
        inputDenom: UNLISTED,
        destChainId: "osmosis-1",
        outputDenom,
        warnings: [ENGINE_UNCOMPUTED_OUTPUT],
        links: [INJECTIVE_TO_OSMOSIS],
      });
      expect(arrival.kind).toBe("unknown");
      expect(arrival.denom).toBeNull();
      expect(arrival.identity).toBeNull();
      expect(arrival.text).toBe("Could not be computed");
      expect(arrival.text).not.toContain(outputDenom);
      expect(arrival.warning?.body).toBe(
        "Zunia could not work out the denom this becomes on Osmosis. It may arrive as a token no registry names.",
      );
    }
  });

  it("works the denom out from the token's own trace when the engine could not", () => {
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: INJ_USDC_N,
      destChainId: "osmosis-1",
      outputDenom: "uusdc",
      warnings: [ENGINE_UNCOMPUTED_OUTPUT],
      links: [INJECTIVE_TO_OSMOSIS],
    });
    expect(arrival.kind).toBe("rewrapped");
    expect(arrival.denom).toBe(REWRAPPED);
  });

  it("states neither denom when its own trace and the plan disagree", () => {
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: INJ_USDC_N,
      destChainId: "osmosis-1",
      outputDenom: OSMO_USDC_N,
      links: [INJECTIVE_TO_OSMOSIS],
    });
    expect(arrival.kind).toBe("unknown");
    expect(arrival.denom).toBeNull();
    expect(arrival.warning?.body).toContain("disagree");
  });

  it("without a counterparty channel, takes the engine's computed denom", () => {
    const arrival = sendArrival({
      sourceChainId: "osmosis-1",
      inputDenom: OSMO_USDC_N,
      destChainId: "noble-1",
      outputDenom: "uusdc",
    });
    expect(arrival.kind).toBe("native");
    expect(arrival.denom).toBe("uusdc");

    const wrapped = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: INJ_USDC_N,
      destChainId: "osmosis-1",
      outputDenom: REWRAPPED,
      warnings: [
        `${ENGINE_DOUBLE_WRAP}, so the recipient receives a double-wrapped denom`,
      ],
      links: [{ channelId: "channel-8" }],
    });
    expect(wrapped.kind).toBe("rewrapped");
    expect(wrapped.denom).toBe(REWRAPPED);
  });

  it("names a voucher of an unknown token by what it is not", () => {
    const arrival = sendArrival({
      sourceChainId: "injective-1",
      inputDenom: UNLISTED,
      destChainId: "osmosis-1",
      outputDenom: ibcDenomFor("transfer/channel-122", "uunknown"),
    });
    expect(arrival.kind).toBe("unnamed");
    expect(arrival.text).toBe("Unnamed voucher · on Osmosis");
    expect(arrival.warning).toBeNull();
  });

  it("uses the screen's identity only for the denom it names", () => {
    const other = identityOf("osmosis-1", OSMO_USDC_AXL);
    const arrival = sendArrival({
      sourceChainId: "osmosis-1",
      inputDenom: OSMO_USDC_N,
      destChainId: "noble-1",
      outputDenom: "uusdc",
      links: [OSMOSIS_TO_NOBLE],
      sent: other,
    });
    expect(arrival.kind).toBe("native");
    expect(arrival.identity?.ticker).toBe("USDC.n");
  });
});

/* -------------------------------------------------------------------------- *
 * Amounts: what is typed signs what it always did
 * -------------------------------------------------------------------------- */

function nativeOf(chainId: string): NativeCoin {
  const entry = findCatalogEntry(chainId);
  if (!entry) throw new Error(`${chainId} is not in the catalog`);
  return {
    denom: entry.coinMinimalDenom,
    symbol: chainTicker(entry),
    decimals: entry.coinDecimals,
    chainId,
  };
}

/** A row as the balance reader builds it (lib/balances.ts). */
function readerRow(
  chainId: string,
  denom: string,
  amount = "1000000000000000000000",
  metadata?: BankMetadataFacts,
): TokenBalance {
  return classifyToken(denom, amount, nativeOf(chainId), metadata ? { metadata } : {});
}

/** The chain's own coin as Send builds it before balances load. */
function handRow(chainId: string): TokenBalance {
  const native = nativeOf(chainId);
  return {
    denom: native.denom,
    amount: "0",
    kind: "native",
    symbol: native.symbol,
    displayName: native.symbol,
    decimals: native.decimals,
  };
}

describe("sendTokenIdentity and the amount it signs", () => {
  /**
   * Every token with known decimals and the exponent 0.1.2 converted it with
   * (the catalog's). A typed amount must still sign exactly those base units.
   */
  const KNOWN: ReadonlyArray<readonly [string, string, number, string]> = [
    ["osmosis-1", "uosmo", 6, "OSMO"],
    ["injective-1", "inj", 18, "INJ"],
    ["cosmoshub-4", "uatom", 6, "ATOM"],
    ["noble-1", "uusdc", 6, "USDC.n"],
    ["osmosis-1", OSMO_USDC_N, 6, "USDC.n"],
    ["injective-1", INJ_USDC_N, 6, "USDC.n"],
    ["osmosis-1", OSMO_USDC_AXL, 6, "USDC.axl"],
    ["injective-1", USDC_INJ, 6, "USDC.inj"],
    ["osmosis-1", OSMO_USDC_INJ, 6, "USDC.inj"],
    ["osmosis-1", OSMO_ATOM, 6, "ATOM"],
    ["osmosis-1", OSMO_ETH_PICA, 18, "ETH.pica"],
  ];
  const TYPED = ["1", "1.5", "0.1", "0.000001", "123456.789", "1000000"];

  it.each(KNOWN)("%s %s converts with %i decimals, as before", (chainId, denom, decimals, ticker) => {
    const row = readerRow(chainId, denom);
    expect(row.decimals).toBe(decimals);
    const scale = sendTokenIdentity(chainId, row);
    expect(scale.ticker).toBe(ticker);
    expect(scale.key).toBe(`${chainId}:${denom}`);
    expect(scale.decimalsKnown).toBe(true);
    expect(scale.decimals).toBe(decimals);
    expect(canTypeAmount(scale)).toBe(true);
    for (const text of TYPED) {
      // 0.1.2 converted with the row's decimals; so does Send now.
      expect(toBaseUnits(text, scale.decimals)).toBe(toBaseUnits(text, row.decimals));
    }
    // And the base units are what 1.5 of the token is.
    expect(toBaseUnits("1.5", scale.decimals)?.toString()).toBe(`15${"0".repeat(decimals - 1)}`);
    // A fraction finer than the token's exponent is refused, never rounded.
    expect(toBaseUnits(`0.${"0".repeat(decimals)}1`, scale.decimals)).toBeNull();
  });

  /**
   * The display-only invariant for a same-chain send: the message the screen
   * signs (its own `sameChainMsgs`, over the review it captured) is the one
   * 0.1.2 built from the same row and the same typed text, byte for byte. It
   * fails if the signed denom or amount changes.
   */
  it.each(KNOWN)("%s %s: the MsgSend Send signs is 0.1.2's, byte for byte", (chainId, denom) => {
    const FROM = "from1sender";
    const TO = "to1recipient";
    const row = readerRow(chainId, denom);
    const scale = sendTokenIdentity(chainId, row);
    const coinDecimals = findCatalogEntry(chainId)?.coinDecimals;
    for (const text of TYPED) {
      const units = toBaseUnits(text, scale.decimals);
      expect(units).not.toBeNull();
      const signed = sameChainMsgs(FROM, TO, { chainId, denom: row.denom, identity: scale, units: units! });
      // 0.1.2: the row's exact denom, the text over `token.decimals ?? coinDecimals ?? 6`.
      const legacyUnits = toBaseUnits(text, row.decimals ?? coinDecimals ?? 6);
      const legacy = [
        msgSend({
          fromAddress: FROM,
          toAddress: TO,
          amount: [{ denom: row.denom, amount: legacyUnits!.toString() }],
        }),
      ];
      expect(JSON.stringify(signed)).toBe(JSON.stringify(legacy));
    }
  });

  it("signs the reviewed USDC.n as its exact voucher and base units", () => {
    const row = readerRow("osmosis-1", OSMO_USDC_N, "12500000");
    const scale = sendTokenIdentity("osmosis-1", row);
    expect(
      sameChainMsgs("osmo1from", "osmo1to", {
        chainId: "osmosis-1",
        denom: row.denom,
        identity: scale,
        units: toBaseUnits("1.5", scale.decimals)!,
      }),
    ).toEqual([
      {
        type: "cosmos-sdk/MsgSend",
        value: {
          from_address: "osmo1from",
          to_address: "osmo1to",
          amount: [{ denom: OSMO_USDC_N, amount: "1500000" }],
        },
      },
    ]);
  });

  it("the chain's own coin, built before balances load, converts with the catalog's exponent", () => {
    for (const chainId of ["osmosis-1", "injective-1", "cosmoshub-4", "noble-1", "moo-1"]) {
      const row = handRow(chainId);
      const scale = sendTokenIdentity(chainId, row);
      expect(scale.decimals).toBe(row.decimals);
      expect(scale.decimalsKnown).toBe(true);
      expect(toBaseUnits("2.5", scale.decimals)).toBe(toBaseUnits("2.5", row.decimals));
    }
    // moo-1's coin is a voucher nothing proves, so its identity has no
    // exponent of its own; Send keeps converting with the catalog's.
    expect(identityOf("moo-1", handRow("moo-1").denom).decimalsKnown).toBe(false);
  });

  it("Max writes the exact balance, and the field converts back to it at any size", () => {
    const sizes = ["1", "999999", "1234567890123456789", "1234567890123456789012345678"];
    for (const [chainId, denom] of [
      ["injective-1", "inj"],
      ["osmosis-1", "uosmo"],
      ["osmosis-1", OSMO_ETH_PICA],
      ["osmosis-1", UNLISTED],
    ] as const) {
      for (const amount of sizes) {
        const scale = sendTokenIdentity(chainId, readerRow(chainId, denom, amount));
        for (const pct of [25n, 50n, 75n, 100n]) {
          const units = (BigInt(amount) * pct) / 100n;
          expect(toBaseUnits(amountFieldText(units, scale), scale.decimals)).toBe(units);
        }
      }
    }
  });

  it("a token whose decimals nobody knows takes only Max, in base units", () => {
    const row = readerRow("osmosis-1", UNLISTED, "12340000");
    expect(row.decimalsKnown).toBe(false);
    const scale = sendTokenIdentity("osmosis-1", row);
    expect(scale).toMatchObject({ decimals: 0, decimalsKnown: false, ticker: "IBC·0123" });
    expect(canTypeAmount(scale)).toBe(false);
    const text = amountFieldText(row.amount, scale);
    expect(text).toBe("12340000");
    expect(toBaseUnits(text, scale.decimals)).toBe(12340000n);
    // A typed fraction has no meaning in base units and does not convert.
    expect(toBaseUnits("1.5", scale.decimals)).toBeNull();
    expect(exactAmountText(12340000n, scale)).toBe("12340000 base units");
  });

  it("allSHIB, whose exponent the registries dispute, takes only Max too", () => {
    const shib = tokenTableRows("osmosis-1").find((row) => row.alloyed && row.family === "SHIB");
    expect(shib).toBeDefined();
    const scale = sendTokenIdentity("osmosis-1", readerRow("osmosis-1", shib!.denom));
    expect(scale.ticker).toBe("allSHIB");
    expect(canTypeAmount(scale)).toBe(false);
  });

  it("keys and names the row's exact bank denom, whatever case the table lists it in", () => {
    const lower = `ibc/${OSMO_USDC_N.slice(4).toLowerCase()}`;
    const scale = sendTokenIdentity("osmosis-1", readerRow("osmosis-1", lower, "1500000"));
    expect(scale.ticker).toBe("USDC.n");
    expect(scale.denom).toBe(lower);
    expect(scale.key).toBe(`osmosis-1:${lower}`);
    expect(toBaseUnits("1.5", scale.decimals)).toBe(1500000n);
  });

  it("an unnamed token whose chain metadata gives decimals uses them, as its balance row does", () => {
    const row = readerRow("osmosis-1", UNLISTED, "12340000", { name: "Blob", decimals: 8 });
    const scale = sendTokenIdentity("osmosis-1", row);
    expect(scale).toMatchObject({ decimals: 8, decimalsKnown: true });
    expect(toBaseUnits("1.5", scale.decimals)).toBe(150000000n);
  });
});

/* -------------------------------------------------------------------------- *
 * Words
 * -------------------------------------------------------------------------- */

describe("words", () => {
  it("Issued on names the issuer wherever the token is held", () => {
    expect(issuerText(identityOf("osmosis-1", OSMO_USDC_N))).toBe("Noble");
    expect(issuerText(identityOf("injective-1", INJ_USDC_N))).toBe("Noble");
    expect(issuerText(identityOf("noble-1", "uusdc"))).toBe("Noble");
    expect(issuerText(identityOf("osmosis-1", OSMO_USDC_INJ))).toBe("Injective");
    expect(issuerText(identityOf("osmosis-1", "uosmo"))).toBe("Osmosis");
    expect(issuerText(identityOf("osmosis-1", UNLISTED))).toBe("Unknown");
    expect(issuerText({ ...identityOf("osmosis-1", OSMO_USDC_N), proven: false })).toBe(
      "Noble (not verified)",
    );
  });

  it("an exact amount states every digit that is signed", () => {
    const eth = identityOf("osmosis-1", OSMO_ETH_PICA);
    expect(exactAmountText(1123456789012345678n, eth)).toBe("1.123456789012345678");
    expect(exactAmountText("1500000", identityOf("osmosis-1", OSMO_USDC_N))).toBe("1.5");
    expect(exactAmountText("12340000", identityOf("osmosis-1", UNLISTED))).toBe(
      "12340000 base units",
    );
  });

  it("a pending transfer is labelled with its ticker and both chains", () => {
    expect(transferLabel(10_000_000n, identityOf("osmosis-1", OSMO_USDC_N), "Noble")).toBe(
      "10 USDC.n (Osmosis) → Noble",
    );
    expect(transferLabel("1500000", identityOf("noble-1", "uusdc"), "Osmosis")).toBe(
      "1.5 USDC.n (Noble) → Osmosis",
    );
    expect(transferLabel("12340000", identityOf("osmosis-1", UNLISTED), "Noble")).toBe(
      "12340000 base units IBC·0123 (Osmosis) → Noble",
    );
  });
});

/* -------------------------------------------------------------------------- *
 * Picker memory
 * -------------------------------------------------------------------------- */

describe("token picker memory", () => {
  it("reads Send's old bare-denom picks as this chain's keys", () => {
    expect(
      migrateTokenIds(["uosmo", OSMO_USDC_N, "cosmoshub-4:uatom"], "osmosis-1", ["uosmo", OSMO_USDC_N]),
    ).toEqual(["osmosis-1:uosmo", `osmosis-1:${OSMO_USDC_N}`, "cosmoshub-4:uatom"]);
    // An erc20 denom has a colon of its own and still becomes a key.
    expect(migrateTokenIds([USDC_INJ], "injective-1", ["inj", USDC_INJ])).toEqual([
      `injective-1:${USDC_INJ}`,
    ]);
    // The key is the identity's, which Swap's options and tokenPickerItem use.
    expect(`osmosis-1:${OSMO_USDC_N}`).toBe(identityOf("osmosis-1", OSMO_USDC_N).key);
  });

  it("keeps other chains' ids as they are and lists a repeat once", () => {
    expect(
      migrateTokenIds(
        ["uatom", `osmosis-1:${OSMO_USDC_N}`, OSMO_USDC_N, "injective-1:inj"],
        "osmosis-1",
        ["uosmo", OSMO_USDC_N],
      ),
    ).toEqual(["uatom", `osmosis-1:${OSMO_USDC_N}`, "injective-1:inj"]);
  });

  it("reports no change when there is nothing to move", () => {
    const memory: PickerMemory = { favorites: ["osmosis-1:uosmo"], recents: ["uatom"] };
    expect(migrateTokenMemory(memory, "osmosis-1", ["uosmo"])).toBeNull();
    expect(migrateTokenMemory(memory, "cosmoshub-4", ["uatom"])).toEqual({
      favorites: ["osmosis-1:uosmo"],
      recents: ["cosmoshub-4:uatom"],
    });
  });

  describe("in storage", () => {
    let store: Map<string, unknown>;
    let writes: number;

    beforeEach(() => {
      store = new Map();
      writes = 0;
      vi.stubGlobal("browser", {
        storage: {
          local: {
            get: async (key: string) => ({ [key]: store.get(key) }),
            set: async (patch: Record<string, unknown>) => {
              writes += 1;
              for (const [k, v] of Object.entries(patch)) store.set(k, v);
            },
          },
        },
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("rewrites this chain's old picks once and leaves the rest", async () => {
      store.set(STORAGE_KEYS.pickerMemory, {
        chain: { favorites: ["osmosis-1"], recents: ["noble-1"] },
        token: { favorites: ["uosmo", "noble-1:uusdc"], recents: [OSMO_USDC_N, "uatom"] },
      });
      expect(await migrateStoredTokenMemory("osmosis-1", ["uosmo", OSMO_USDC_N])).toBe(true);
      expect(store.get(STORAGE_KEYS.pickerMemory)).toEqual({
        chain: { favorites: ["osmosis-1"], recents: ["noble-1"] },
        token: {
          favorites: ["osmosis-1:uosmo", "noble-1:uusdc"],
          recents: [`osmosis-1:${OSMO_USDC_N}`, "uatom"],
        },
      });
      expect(await migrateStoredTokenMemory("osmosis-1", ["uosmo", OSMO_USDC_N])).toBe(false);
      expect(writes).toBe(1);
    });

    it("writes nothing when there is no memory, and never throws", async () => {
      expect(await migrateStoredTokenMemory("osmosis-1", ["uosmo"])).toBe(false);
      expect(writes).toBe(0);
      vi.stubGlobal("browser", {
        storage: {
          local: {
            get: async () => {
              throw new Error("storage unavailable");
            },
            set: async () => undefined,
          },
        },
      });
      await expect(migrateStoredTokenMemory("osmosis-1", ["uosmo"])).resolves.toBe(false);
    });
  });
});

/* -------------------------------------------------------------------------- *
 * Pinned channels
 * -------------------------------------------------------------------------- */

describe("withRegistryEnds", () => {
  it("adds the far end of a registry channel, and only where a pin has none", () => {
    const pins: ManualChannel[] = [
      { fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-8" },
      { fromChainId: "osmosis-1", toChainId: "noble-1", channelId: "channel-750", verdict: "verified" },
      // Not a registry channel: nothing to add.
      { fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-6" },
      // A far end the user entered stays theirs.
      { fromChainId: "osmosis-1", toChainId: "noble-1", channelId: "channel-750", counterpartyChannelId: "channel-9" },
      // Another port is another channel end.
      { fromChainId: "osmosis-1", toChainId: "noble-1", channelId: "channel-750", port: "wasm.osmo1xyz" },
    ];
    expect(withRegistryEnds(pins)).toEqual([
      { ...pins[0], counterpartyChannelId: "channel-122" },
      { ...pins[1], counterpartyChannelId: "channel-1" },
      pins[2],
      pins[3],
      pins[4],
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * The screen's rows and buttons
 * -------------------------------------------------------------------------- */

function markup(node: ReactNode): string {
  return renderToStaticMarkup(createElement(Fragment, null, node));
}

describe("Send's picker rows", () => {
  function rowOf(chainId: string, denom: string, amount: string) {
    const token = readerRow(chainId, denom, amount);
    return { token, identity: sendTokenIdentity(chainId, token) };
  }

  it("names a row by its ticker as written, with the visual ticker hidden from assistive tech", () => {
    const item = sendPickerItem(rowOf("osmosis-1", OSMO_USDC_N, "12500000"), false);
    expect(item.id).toBe(`osmosis-1:${OSMO_USDC_N}`);
    expect(item.label).toBe("USDC.n");
    expect(item.sublabel).toBe("Noble USDC · on Osmosis");
    const label = markup(item.labelNode);
    // TokenTicker draws `USDC` and `.n` in two boxes, which assistive tech
    // reads as "USDC .n"; that drawing is hidden and the ticker said whole.
    expect(label.startsWith('<span aria-hidden="true"')).toBe(true);
    expect(label).toContain('<span class="sr-only">USDC.n</span>');
    expect(item.srNote).toBe("Verified: IBC path matches the registry");
    expect(markup(item.trailing)).toContain(">12.5<");
  });

  it("keeps a balance in base units to its own column, wrapped, so the ticker keeps its room", () => {
    const shib = tokenTableRows("osmosis-1").find((row) => row.alloyed && row.family === "SHIB");
    const item = sendPickerItem(rowOf("osmosis-1", shib!.denom, "5000000000000000000"), false);
    const trailing = markup(item.trailing);
    expect(trailing).toContain(">5000000000000000000 base units<");
    // At most 112px wide, and wrapped inside it, instead of a one-line
    // column that squeezed the ticker to `I…` at 360px.
    expect(trailing).toContain("max-w-[112px]");
    expect(trailing).toContain("[overflow-wrap:anywhere]");
    // Hidden balances stay hidden, and a zero balance shows nothing.
    expect(markup(sendPickerItem(rowOf("osmosis-1", shib!.denom, "5"), true).trailing)).toContain(
      ">••••<",
    );
    expect(sendPickerItem(rowOf("osmosis-1", OSMO_USDC_N, "0"), false).trailing ?? null).toBeNull();
  });

  it("a copy button is named by the short denom it shows; the tooltip and the clipboard keep it whole", () => {
    const html = markup(
      createElement(CopyDenom, { denom: OSMO_USDC_N, what: "Arrival denom", onCopy: () => undefined }),
    );
    expect(html).toContain('aria-label="Copy arrival denom ibc/498A…6BA6E4"');
    expect(html).toContain(`title="${OSMO_USDC_N}"`);
    expect(html).toContain(">ibc/498A…6BA6E4<");
  });
});

/* -------------------------------------------------------------------------- *
 * The real planner, on a fake IBC world
 * -------------------------------------------------------------------------- */

/**
 * The engine's planner, denom resolver and channel checks, against a fake
 * Osmosis, Injective and Noble behind `fetch` (live channel numbers, as in
 * lib/__tests__/swap-plan.test.ts). What the plan computes and what
 * {@link sendArrival} works out from the token's trace must agree.
 */
describe("arrival of a planned transfer", () => {
  const REST: Record<string, string> = {
    "osmosis-1": "https://lcd-osmosis.keplr.app",
    "injective-1": "https://lcd-injective.keplr.app",
    "noble-1": "https://lcd-noble.keplr.app",
  };

  interface FakeChannel {
    readonly channelId: string;
    readonly counterpartyChainId: string;
    readonly counterpartyChannelId: string;
    readonly clientId: string;
  }

  const channel = (
    channelId: string,
    counterpartyChainId: string,
    counterpartyChannelId: string,
    clientId: string,
  ): FakeChannel => ({ channelId, counterpartyChainId, counterpartyChannelId, clientId });

  const CHANNELS: Record<string, readonly FakeChannel[]> = {
    "osmosis-1": [
      channel("channel-122", "injective-1", "channel-8", "07-tendermint-1703"),
      channel("channel-750", "noble-1", "channel-1", "07-tendermint-2704"),
    ],
    "injective-1": [
      channel("channel-8", "osmosis-1", "channel-122", "07-tendermint-19"),
      channel("channel-148", "noble-1", "channel-31", "07-tendermint-152"),
    ],
    "noble-1": [
      channel("channel-1", "osmosis-1", "channel-750", "07-tendermint-0"),
      channel("channel-31", "injective-1", "channel-148", "07-tendermint-43"),
    ],
  };

  /** Denom traces each chain answers, by hash. */
  const TRACES: Record<string, Record<string, { path: string; base_denom: string }>> = {
    "osmosis-1": { [OSMO_USDC_N.slice(4)]: { path: "transfer/channel-750", base_denom: "uusdc" } },
    "injective-1": { [INJ_USDC_N.slice(4)]: { path: "transfer/channel-148", base_denom: "uusdc" } },
  };

  function respond(status: number, body: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  /** One chain's LCD, as much of it as planning a transfer reads. */
  function chainAnswer(chainId: string, url: URL): Response {
    const path = decodeURIComponent(url.pathname);
    const rows = CHANNELS[chainId] ?? [];
    const connectionOf = (row: FakeChannel) => `connection-for-${row.clientId}`;
    const notFound = respond(404, { code: 5, message: `${path}: not found`, details: [] });
    let match: RegExpMatchArray | null;
    if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer\/client_state$/))) {
      const row = rows.find((r) => r.channelId === match![1]);
      if (!row) return notFound;
      return respond(200, {
        identified_client_state: {
          client_id: row.clientId,
          client_state: {
            "@type": "/ibc.lightclients.tendermint.v1.ClientState",
            chain_id: row.counterpartyChainId,
          },
        },
      });
    }
    if ((match = path.match(/^\/ibc\/core\/channel\/v1\/channels\/([^/]+)\/ports\/transfer$/))) {
      const row = rows.find((r) => r.channelId === match![1]);
      if (!row) return notFound;
      return respond(200, {
        channel: {
          state: "STATE_OPEN",
          ordering: "ORDER_UNORDERED",
          counterparty: { port_id: "transfer", channel_id: row.counterpartyChannelId },
          connection_hops: [connectionOf(row)],
          version: "ics20-1",
        },
      });
    }
    if (path === "/ibc/core/channel/v1/channels") {
      return respond(200, {
        channels: rows.map((row) => ({
          state: "STATE_OPEN",
          ordering: "ORDER_UNORDERED",
          counterparty: { port_id: "transfer", channel_id: row.counterpartyChannelId },
          connection_hops: [connectionOf(row)],
          version: "ics20-1",
          port_id: "transfer",
          channel_id: row.channelId,
        })),
        pagination: { next_key: null, total: String(rows.length) },
      });
    }
    if ((match = path.match(/^\/ibc\/core\/connection\/v1\/connections\/(.+)$/))) {
      const row = rows.find((r) => connectionOf(r) === match![1]);
      if (!row) return notFound;
      return respond(200, { connection: { client_id: row.clientId, state: "STATE_OPEN" } });
    }
    if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_states\/(.+)$/))) {
      const row = rows.find((r) => r.clientId === match![1]);
      if (!row) return notFound;
      return respond(200, {
        client_state: {
          "@type": "/ibc.lightclients.tendermint.v1.ClientState",
          chain_id: row.counterpartyChainId,
        },
      });
    }
    if ((match = path.match(/^\/ibc\/core\/client\/v1\/client_status\/(.+)$/))) {
      const row = rows.find((r) => r.clientId === match![1]);
      return row ? respond(200, { status: "Active" }) : notFound;
    }
    if ((match = path.match(/^\/ibc\/apps\/transfer\/v1\/denom_traces\/([0-9A-F]{64})$/))) {
      const trace = TRACES[chainId]?.[match[1]!];
      return trace ? respond(200, { denom_trace: trace }) : notFound;
    }
    // What a gateway says for a route it does not serve.
    return respond(501, { code: 12, message: "Not Implemented", details: [] });
  }

  beforeEach(() => {
    const store = new Map<string, unknown>([["zunia.settings", { liveBalances: true }]]);
    vi.stubGlobal("fetch", async (input: string): Promise<Response> => {
      const url = new URL(String(input));
      const chainId = Object.entries(REST).find(([, rest]) => rest === url.origin)?.[0];
      if (!chainId) throw new Error(`unexpected request to ${url.href}`);
      return chainAnswer(chainId, url);
    });
    vi.stubGlobal("browser", {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: store.get(key) }),
          set: async (patch: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(patch)) store.set(k, v);
          },
          remove: async (key: string) => void store.delete(key),
        },
      },
      permissions: { contains: async () => true },
    });
    clearInterchainCaches();
    resetChannelChecks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    clearInterchainCaches();
    resetChannelChecks();
  });

  const ADDRESS: Record<string, string> = {
    "osmosis-1": "osmo1sender00000000000000000000000000000000",
    "injective-1": "inj1sender000000000000000000000000000000000",
    "noble-1": "noble1sender0000000000000000000000000000000",
  };

  async function planned(
    sourceChainId: string,
    destChainId: string,
    inputDenom: string,
    manualChannels?: readonly ManualChannel[],
  ): Promise<RoutePlanView> {
    const input: PlanInput = {
      sourceChainId,
      destChainId,
      inputDenom,
      amountBaseUnits: "1000000",
      sender: ADDRESS[sourceChainId] ?? "",
      recipient: ADDRESS[destChainId] ?? "",
      resolveAddresses: async () => ({}),
      ...(manualChannels ? { manualChannels } : {}),
    };
    const result = await planTransfer(input);
    expect(result.error).toBeNull();
    expect(result.best).not.toBeNull();
    return result.best!;
  }

  /** The "Arrives as" row, built from a plan the way the confirm screen builds it. */
  function arrivalOf(view: RoutePlanView) {
    return sendArrival({
      sourceChainId: view.plan.sourceChainId,
      inputDenom: view.plan.inputDenom,
      destChainId: view.plan.destChainId,
      outputDenom: view.plan.outputDenom,
      warnings: view.warnings,
      links: view.candidate.links,
    });
  }

  it("Osmosis USDC.n to Noble: the plan unwinds over channel-750 to native USDC.n", async () => {
    const view = await planned("osmosis-1", "noble-1", OSMO_USDC_N);
    expect(view.blockedReason).toBeNull();
    expect(view.plan.hops[0]?.channelId).toBe("channel-750");
    expect(view.plan.outputDenom).toBe("uusdc");
    const arrival = arrivalOf(view);
    expect(arrival.kind).toBe("native");
    expect(arrival.text).toBe("USDC.n · Native on Noble");
  });

  it("Injective USDC.n to Osmosis: the plan sends it onward, and it arrives re-wrapped", async () => {
    const view = await planned("injective-1", "osmosis-1", INJ_USDC_N);
    expect(view.blockedReason).toBeNull();
    expect(view.plan.hops[0]?.channelId).toBe("channel-8");
    expect(view.plan.outputDenom).toBe(REWRAPPED);
    expect(view.warnings.some((warning) => warning.startsWith(ENGINE_DOUBLE_WRAP))).toBe(true);
    const arrival = arrivalOf(view);
    expect(arrival.kind).toBe("rewrapped");
    expect(arrival.denom).toBe(REWRAPPED);
    expect(arrival.identity?.ticker).not.toBe("USDC.n");
    expect(arrival.warning?.title).toBe("Arrives as a different token");
  });

  it("Noble USDC to Osmosis: it arrives as the USDC.n Osmosis lists", async () => {
    const view = await planned("noble-1", "osmosis-1", "uusdc");
    expect(view.plan.outputDenom).toBe(OSMO_USDC_N);
    const arrival = arrivalOf(view);
    expect(arrival.kind).toBe("named");
    expect(arrival.text).toBe("USDC.n · Noble USDC · on Osmosis");
  });

  it("a route Send pins keeps its arrival only with the far end, and signs the same bytes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-05T12:00:00Z"));
    // The pin Send makes from the route it previews: no far end.
    const pin: ManualChannel = {
      fromChainId: "injective-1",
      toChainId: "osmosis-1",
      channelId: "channel-8",
    };
    const bare = await planned("injective-1", "osmosis-1", INJ_USDC_N, [pin]);
    expect(bare.warnings).toContain(ENGINE_UNCOMPUTED_OUTPUT);
    expect(arrivalOf(bare).kind).toBe("unknown");

    const ended = await planned("injective-1", "osmosis-1", INJ_USDC_N, withRegistryEnds([pin]));
    expect(ended.warnings).not.toContain(ENGINE_UNCOMPUTED_OUTPUT);
    expect(ended.plan.outputDenom).toBe(REWRAPPED);
    expect(arrivalOf(ended).kind).toBe("rewrapped");

    const free = await planned("injective-1", "osmosis-1", INJ_USDC_N);
    const signed = (view: RoutePlanView) =>
      JSON.stringify(
        buildTransferMsgFromPlan({
          view,
          sender: ADDRESS["injective-1"] ?? "",
          amountBaseUnits: "1000000",
        }),
      );
    expect(signed(ended)).toBe(signed(bare));
    expect(signed(free)).toBe(signed(bare));
    expect(signed(bare)).toContain('"source_channel":"channel-8"');
    expect(signed(bare)).toContain(`"denom":"${INJ_USDC_N}"`);
    vi.useRealTimers();
  });

  /** The route Send previews for a pair, as its channel cache would give it. */
  function previewOf(sourceChainId: string, destChainId: string, channelId: string) {
    return {
      hops: pathHopViews([
        { sourceChainId, destChainId, channelId, port: "transfer", state: "open" as const },
      ]),
    };
  }

  /**
   * The display-only invariant for a transfer, through the screen's own pin
   * code (`routePinsOf`, `mergePins`) and the real planner: what Send signs
   * now is what 0.1.2 signed, the route it previewed pinned without a far
   * end, byte for byte, and is pinned below field by field. It fails if a
   * signed denom, amount, channel, receiver, timeout or packet memo changes.
   */
  it.each([
    ["osmosis-1", "noble-1", OSMO_USDC_N, "channel-750"],
    ["injective-1", "osmosis-1", INJ_USDC_N, "channel-8"],
    ["noble-1", "osmosis-1", "uusdc", "channel-1"],
    ["injective-1", "osmosis-1", USDC_INJ, "channel-8"],
  ] as const)(
    "%s to %s: the MsgTransfer of %s is 0.1.2's, byte for byte",
    async (sourceChainId, destChainId, denom, channelId) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = Date.parse("2026-10-05T12:00:00Z");
      vi.setSystemTime(now);
      const sender = ADDRESS[sourceChainId] ?? "";
      const screen = routePinsOf(previewOf(sourceChainId, destChainId, channelId));
      expect(screen).toEqual([
        { fromChainId: sourceChainId, toChainId: destChainId, channelId, verdict: "verified" },
      ]);
      // 0.1.2 passed the screen's pins as they are; Send adds the far end.
      const legacy = await planned(sourceChainId, destChainId, denom, screen);
      const current = await planned(sourceChainId, destChainId, denom, mergePins(screen, []));
      // A channel the user entered on the leg, far end and all, signs the same too.
      const typed = await planned(
        sourceChainId,
        destChainId,
        denom,
        mergePins(screen, [
          {
            fromChainId: sourceChainId,
            toChainId: destChainId,
            channelId,
            counterpartyChannelId: withRegistryEnds(screen)[0]?.counterpartyChannelId ?? "",
          },
        ]),
      );
      const signed = (view: RoutePlanView) =>
        buildTransferMsgFromPlan({ view, sender, amountBaseUnits: "1500000" });
      expect(JSON.stringify(signed(current))).toBe(JSON.stringify(signed(legacy)));
      expect(JSON.stringify(signed(typed))).toBe(JSON.stringify(signed(legacy)));
      expect(signed(current)).toEqual({
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_port: "transfer",
          source_channel: channelId,
          token: { denom, amount: "1500000" },
          sender,
          receiver: ADDRESS[destChainId],
          timeout_height: { revision_number: "0", revision_height: "0" },
          timeout_timestamp: `${now + PACKET_TIMEOUT_MINUTES * 60_000}000000`,
          memo: "",
        },
      });
      vi.useRealTimers();
    },
  );

  it("the transaction memo names the token as the signing chain holds it, or names none", async () => {
    const memoOf = async (sourceChainId: string, destChainId: string, denom: string) => {
      const view = await planned(sourceChainId, destChainId, denom);
      const msgs = [
        buildTransferMsgFromPlan({
          view,
          sender: ADDRESS[sourceChainId] ?? "",
          amountBaseUnits: "1000000",
        }),
      ];
      return resolveTxMemo("", msgs, sourceChainId);
    };
    expect(await memoOf("osmosis-1", "noble-1", OSMO_USDC_N)).toBe("IBC transfer USDC.n · by Zunia-wallet");
    expect(await memoOf("injective-1", "osmosis-1", INJ_USDC_N)).toBe("IBC transfer USDC.n · by Zunia-wallet");
    expect(await memoOf("injective-1", "osmosis-1", USDC_INJ)).toBe("IBC transfer USDC.inj · by Zunia-wallet");
    // A voucher nothing names is not given a name on chain.
    expect(await memoOf("injective-1", "osmosis-1", UNLISTED)).toBe("IBC transfer · by Zunia-wallet");
  });

  it("does not call the route Send pinned on its own a channel typed by hand", async () => {
    const screen = routePinsOf(previewOf("injective-1", "osmosis-1", "channel-8"));
    const note = `channel-8 on Injective ${ENGINE_ENTERED_BY_HAND}`;
    const view = await planned("injective-1", "osmosis-1", INJ_USDC_N, mergePins(screen, []));
    // The engine's words, as the filter expects them.
    expect(view.warnings).toContain(note);
    const shown = routeNotes(view.warnings, screen, []);
    expect(shown).not.toContain(note);
    // Every other note stays, the double wrap among them.
    expect(shown).toEqual(view.warnings.filter((warning) => warning !== note));
    expect(shown.some((warning) => warning.startsWith(ENGINE_DOUBLE_WRAP))).toBe(true);

    // A channel the user entered on that leg keeps the note: it was typed.
    const user: ManualChannel[] = [
      { fromChainId: "injective-1", toChainId: "osmosis-1", channelId: "channel-8" },
    ];
    const typed = await planned("injective-1", "osmosis-1", INJ_USDC_N, mergePins(screen, user));
    expect(routeNotes(typed.warnings, screen, user)).toContain(note);
  });

  it("a voucher whose trace cannot be read: the plan's stand-in is never stated", async () => {
    const view = await planned("injective-1", "osmosis-1", UNLISTED);
    expect(view.warnings).toContain(ENGINE_UNCOMPUTED_OUTPUT);
    expect(view.plan.outputDenom).toBe(UNLISTED);
    const arrival = arrivalOf(view);
    expect(arrival.kind).toBe("unknown");
    expect(arrival.denom).toBeNull();
    expect(arrival.identity).toBeNull();
  });
});

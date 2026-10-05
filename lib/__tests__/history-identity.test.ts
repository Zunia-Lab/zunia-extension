/**
 * History, transaction detail and approval prompts named by TokenIdentity.
 *
 * The same coin has to read the same in a row's title, its amount, the detail
 * screen, a notice and an approval prompt. The cases are the ones 0.1.2 got
 * wrong: Noble USDC read as Axelar's `USDC.axl` because a received packet was
 * named from its sender-side `uusdc`, and a voucher nothing names read as
 * millions (`12.34M`) because its raw amount went through the compact
 * formatter with 0 decimals.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { bech32 } from "@scure/base";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HistoryAmountText } from "../../entrypoints/popup/screens/ActivityScreen";
import { TxAmount } from "../../entrypoints/popup/screens/TxDetailScreen";
import {
  activityAmount,
  activityAmountIdentity,
  activityAmountPieces,
  activityTokenIdentity,
  describeMessage,
  exactCoinText,
  isBankSpelling,
  parseTxDetail,
  receivedDenomOf,
  type ActivityItem,
  type DescribedMessage,
} from "../chain-queries";
import { serializeAminoSignDoc, type DecodedTxMessage } from "../kernel";
import { aminoCoins, buildSignSafety, decodeAminoSignDoc, resolvedCoinLine, summaryCoins } from "../signing";
import { ibcDenomFor, identityOf, tokenKeywords } from "../token-identity";

const ME_OSMO = "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
const OTHER_OSMO = "osmo1zgq2rswzqupqyqs3dqsdgq2rswzqupqyqs5c7ms0";
const ME_NOBLE = "noble1qyqszqgpqyqszqgpqyqszqgpqyqszqgpyk0ejh";
const OTHER_NOBLE = "noble1zgq2rswzqupqyqs3dqsdgq2rswzqupqyqs3ul7gm";

/** Noble USDC on Osmosis: `transfer/channel-750/uusdc`, channel-750 → noble-1. */
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
/** A voucher no table row or stored trace names. */
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64");

/** A MsgRecvPacket as the LCD's tx JSON spells it. */
function recvPacket(
  receiver: string,
  data: Record<string, unknown>,
  ends: { source_channel?: string; destination_channel: string; source_port?: string },
) {
  return {
    "@type": "/ibc.core.channel.v1.MsgRecvPacket",
    packet: {
      sequence: "42",
      ...(ends.source_channel ? { source_port: ends.source_port ?? "transfer", source_channel: ends.source_channel } : {}),
      destination_port: "transfer",
      destination_channel: ends.destination_channel,
      data: b64(data),
      timeout_height: { revision_number: "0", revision_height: "0" },
      timeout_timestamp: "1791202200000000000",
    },
    signer: "osmo1relayer",
  };
}

function asItem(chainId: string, described: DescribedMessage): ActivityItem {
  const { summary: _summary, channel: _channel, contract: _contract, proposalId: _p, vote: _v, ...rest } = described;
  return { chainId, hash: "ABC", timestamp: 0, success: true, ...rest };
}

describe("the denom a received packet credits", () => {
  it("is the voucher of destPort/destChannel/denom when the token travels away from home", () => {
    expect(
      receivedDenomOf("osmosis-1", "uusdc", {
        sourcePort: "transfer",
        sourceChannel: "channel-1",
        destinationPort: "transfer",
        destinationChannel: "channel-750",
      }),
    ).toBe(USDC_N_ON_OSMOSIS);
    // A multi-hop trace keeps its whole sender-side path under the new hop.
    expect(
      receivedDenomOf("osmosis-1", "transfer/channel-536/uusdc", {
        sourceChannel: "channel-141",
        destinationChannel: "channel-0",
      }),
    ).toBe(ibcDenomFor("transfer/channel-0", "transfer/channel-536/uusdc"));
  });

  it("drops the packet's own source prefix when the token comes home", () => {
    // Noble USDC returning from Osmosis to Noble over channel-1.
    expect(
      receivedDenomOf("noble-1", "transfer/channel-750/uusdc", {
        sourceChannel: "channel-750",
        destinationChannel: "channel-1",
      }),
    ).toBe("uusdc");
    // Coming one hop home leaves a trace: that is a voucher on the receiver.
    expect(
      receivedDenomOf("cosmoshub-4", "transfer/channel-0/transfer/channel-536/uusdc", {
        sourceChannel: "channel-0",
        destinationChannel: "channel-141",
      }),
    ).toBe(ibcDenomFor("", "transfer/channel-536/uusdc"));
    // A factory denom is a bank denom, not a trace, even with slashes.
    expect(
      receivedDenomOf("osmosis-1", "transfer/channel-874/factory/osmo1abc/foo", {
        sourceChannel: "channel-874",
        destinationChannel: "channel-1",
      }),
    ).toBe("factory/osmo1abc/foo");
  });

  it("counts an IBC v2 client id as a hop, as ibc-go v10 does: Eureka tokens come home to the Hub as vouchers", () => {
    // ETH.eureka is `transfer/08-wasm-1369/0xc02a…` on the Hub. Swapped into
    // on Osmosis and delivered back to the Hub over Osmosis channel-0, the Hub
    // credits its own voucher again, never the bare trace.
    const trace = "transfer/08-wasm-1369/0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
    const credited = receivedDenomOf("cosmoshub-4", `transfer/channel-0/${trace}`, {
      sourceChannel: "channel-0",
      destinationChannel: "channel-141",
    });
    expect(credited).toBe(ibcDenomFor("", trace));
    expect(identityOf("cosmoshub-4", credited!)).toMatchObject({ ticker: "ETH.eureka", proven: true });
    const hubMe = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpgq2rsw";
    const described = describeMessage(
      recvPacket(hubMe, { denom: `transfer/channel-0/${trace}`, amount: "1000000000000000000", sender: ME_OSMO, receiver: hubMe }, {
        source_channel: "channel-0",
        destination_channel: "channel-141",
      }),
      hubMe,
      "cosmoshub-4",
    );
    expect(described.title).toBe("Receive ETH.eureka over IBC");
    expect(activityAmount(asItem("cosmoshub-4", described), "history")?.text).toBe("+1 ETH.eureka");
    // A slash in a bank denom is not a hop: a creator address has no `-N`.
    expect(receivedDenomOf("osmosis-1", "transfer/channel-874/factory/osmo1abc/foo-1", {
      sourceChannel: "channel-874",
      destinationChannel: "channel-1",
    })).toBe("factory/osmo1abc/foo-1");
  });

  it("reads a missing source end from the registry's canonical channel, and otherwise names nothing", () => {
    // Osmosis channel-0 is the Hub's channel-141, whatever the packet omits.
    expect(receivedDenomOf("osmosis-1", "transfer/channel-141/uosmo", { destinationChannel: "channel-0" })).toBe("uosmo");
    expect(receivedDenomOf("osmosis-1", "uusdc", { destinationChannel: "channel-99999" })).toBeNull();
    expect(receivedDenomOf("osmosis-1", "uusdc", { sourceChannel: "channel-1" })).toBeNull();
  });
});

describe("history rows", () => {
  it("names a send and its amount from one identity: 'Send USDC.n', '-12.34 USDC.n'", () => {
    const noble = describeMessage(
      {
        "@type": "/cosmos.bank.v1beta1.MsgSend",
        from_address: ME_NOBLE,
        to_address: OTHER_NOBLE,
        amount: [{ denom: "uusdc", amount: "12340000" }],
      },
      ME_NOBLE,
      "noble-1",
    );
    expect(noble.title).toBe("Send USDC.n");
    expect(activityAmount(asItem("noble-1", noble), "history")?.text).toBe("-12.34 USDC.n");
    expect(noble.summary).toBe(`Send 12.34 USDC.n to ${OTHER_NOBLE.slice(0, 12)}…${OTHER_NOBLE.slice(-6)}`);

    const osmosis = describeMessage(
      {
        "@type": "/cosmos.bank.v1beta1.MsgSend",
        from_address: ME_OSMO,
        to_address: OTHER_OSMO,
        amount: [{ denom: USDC_N_ON_OSMOSIS, amount: "12340000" }],
      },
      ME_OSMO,
      "osmosis-1",
    );
    expect(osmosis.title).toBe("Send USDC.n");
    expect(osmosis).toMatchObject({ denom: USDC_N_ON_OSMOSIS, decimals: 6, decimalsKnown: true, proven: true });
    expect(activityAmount(asItem("osmosis-1", osmosis), "history")?.text).toBe("-12.34 USDC.n");
  });

  it("names Noble USDC arriving on Osmosis over channel-750 as USDC.n, by the voucher Osmosis credited", () => {
    const described = describeMessage(
      recvPacket(ME_OSMO, { denom: "uusdc", amount: "12340000", sender: ME_NOBLE, receiver: ME_OSMO }, {
        source_channel: "channel-1",
        destination_channel: "channel-750",
      }),
      ME_OSMO,
      "osmosis-1",
    );
    expect(described.title).toBe("Receive USDC.n over IBC");
    expect(described.denom).toBe(USDC_N_ON_OSMOSIS);
    expect(described.summary).toBe(
      `Receive 12.34 USDC.n over IBC from ${ME_NOBLE.slice(0, 12)}…${ME_NOBLE.slice(-6)} on channel-750`,
    );
    const item = asItem("osmosis-1", described);
    expect(activityAmount(item, "history")?.text).toBe("+12.34 USDC.n");
    expect(activityTokenIdentity(item)?.originChainId).toBe("noble-1");
  });

  it("names Noble USDC returning to Noble over channel-1 as USDC.n too", () => {
    const described = describeMessage(
      recvPacket(
        ME_NOBLE,
        { denom: "transfer/channel-750/uusdc", amount: "5000000", sender: ME_OSMO, receiver: ME_NOBLE },
        { source_channel: "channel-750", destination_channel: "channel-1" },
      ),
      ME_NOBLE,
      "noble-1",
    );
    expect(described.title).toBe("Receive USDC.n over IBC");
    expect(described.denom).toBe("uusdc");
    expect(activityAmount(asItem("noble-1", described), "history")?.text).toBe("+5 USDC.n");
  });

  it("reads an unknown denom in base units with its short denom, never as millions", () => {
    const described = describeMessage(
      recvPacket(ME_OSMO, { denom: "ufoo", amount: "12340000", sender: "foo1sender", receiver: ME_OSMO }, {
        source_channel: "channel-7",
        destination_channel: "channel-99999",
      }),
      ME_OSMO,
      "osmosis-1",
    );
    const local = ibcDenomFor("transfer/channel-99999", "ufoo");
    expect(described.denom).toBe(local);
    expect(described.provenance).toBe("unknown");
    expect(described.title).toBe(`Receive IBC·${local.slice(4, 8)} over IBC`);
    const text = activityAmount(asItem("osmosis-1", described), "history")?.text ?? "";
    expect(text).toBe(`+12340000 base units ibc/${local.slice(4, 8)}…${local.slice(-6)}`);
    expect(text).not.toMatch(/\d(k|M|Bn)\b/);

    const sent = describeMessage(
      {
        "@type": "/cosmos.bank.v1beta1.MsgSend",
        from_address: ME_OSMO,
        to_address: OTHER_OSMO,
        amount: [{ denom: UNLISTED, amount: "12340000" }],
      },
      ME_OSMO,
      "osmosis-1",
    );
    expect(sent.title).toBe("Send IBC·0123");
    expect(activityAmount(asItem("osmosis-1", sent), "history")?.text).toBe("-12340000 base units ibc/0123…ABCDEF");
    expect(sent.summary).toContain("12340000 base units ibc/0123…ABCDEF");
  });

  it("never names a coin by the packet's sender-side spelling when the credited denom is unknown", () => {
    // ICS20 v2 nests the token and its trace; the base alone is not the
    // receiver's denom, so nothing is looked up from it.
    const described = describeMessage(
      recvPacket(
        ME_OSMO,
        { tokens: [{ denom: { base: "uusdc", trace: [] }, amount: "7000000" }], sender: ME_NOBLE, receiver: ME_OSMO },
        { source_channel: "channel-1", destination_channel: "channel-750" },
      ),
      ME_OSMO,
      "osmosis-1",
    );
    expect(described.kind).toBe("ibc");
    expect(described.denom).toBeUndefined();
    expect(described.provenance).toBe("unknown");
    expect(described.title).not.toMatch(/USDC\.(n|axl)/);
    const item = asItem("osmosis-1", described);
    expect(activityAmount(item, "history")?.text).toBe("+7000000 base units uusdc");
    expect(activityTokenIdentity(item)).toBeNull();
  });

  it("names an IBC send by the voucher it spends", () => {
    const described = describeMessage(
      {
        "@type": "/ibc.applications.transfer.v1.MsgTransfer",
        source_port: "transfer",
        source_channel: "channel-750",
        token: { denom: USDC_N_ON_OSMOSIS, amount: "2500000" },
        sender: ME_OSMO,
        receiver: ME_NOBLE,
      },
      ME_OSMO,
      "osmosis-1",
    );
    expect(described.title).toBe("Send USDC.n over IBC");
    expect(activityAmount(asItem("osmosis-1", described), "history")?.text).toBe("-2.5 USDC.n");
  });

  it("scales an unnamed held coin by its balance row, as Home does, and masks hidden amounts", () => {
    const sent = asItem(
      "osmosis-1",
      describeMessage(
        {
          "@type": "/cosmos.bank.v1beta1.MsgSend",
          from_address: ME_OSMO,
          to_address: OTHER_OSMO,
          amount: [{ denom: UNLISTED, amount: "12340000" }],
        },
        ME_OSMO,
        "osmosis-1",
      ),
    );
    const balances = { "osmosis-1": { tokens: [{ denom: UNLISTED, decimals: 6, decimalsKnown: true }] } };
    expect(activityAmountIdentity(sent, balances)).toMatchObject({ decimals: 6, decimalsKnown: true });
    expect(activityAmount(sent, "history", { balances })?.text).toBe("-12.34 ibc/0123…ABCDEF");
    // A named coin keeps its own decimals whatever a row says.
    const named = asItem(
      "osmosis-1",
      describeMessage(
        {
          "@type": "/cosmos.bank.v1beta1.MsgSend",
          from_address: ME_OSMO,
          to_address: OTHER_OSMO,
          amount: [{ denom: USDC_N_ON_OSMOSIS, amount: "12340000" }],
        },
        ME_OSMO,
        "osmosis-1",
      ),
    );
    const wrong = { "osmosis-1": { tokens: [{ denom: USDC_N_ON_OSMOSIS, decimals: 18, decimalsKnown: true }] } };
    expect(activityAmount(named, "history", { balances: wrong })?.text).toBe("-12.34 USDC.n");
    expect(activityAmount(named, "history", { hidden: true })).toMatchObject({ text: "••••", unit: "" });
    expect(activityAmount({ ...named, amount: undefined }, "history")).toBeNull();
  });

  it("keeps the detail screen exact, and lets a search find the coin by any of its names", () => {
    const item = asItem(
      "osmosis-1",
      describeMessage(
        recvPacket(ME_OSMO, { denom: "uusdc", amount: "1234567891", sender: ME_NOBLE, receiver: ME_OSMO }, {
          source_channel: "channel-1",
          destination_channel: "channel-750",
        }),
        ME_OSMO,
        "osmosis-1",
      ),
    );
    expect(activityAmount(item, "confirm")).toMatchObject({ sign: "+", value: "1234.567891", unit: "USDC.n" });
    expect(activityAmount(item, "history")?.text).toBe("+1.234k USDC.n");
    const words = tokenKeywords(activityTokenIdentity(item)!).join(" ").toLowerCase();
    for (const word of ["usdc.n", "usdc.noble", "noble", "osmosis", USDC_N_ON_OSMOSIS.toLowerCase()]) {
      expect(words).toContain(word);
    }
  });

  it("reads a transaction's messages and packets with the same names", () => {
    const detail = parseTxDetail(
      {
        tx: {
          body: {
            memo: "",
            messages: [
              recvPacket(ME_OSMO, { denom: "uusdc", amount: "12340000", sender: ME_NOBLE, receiver: ME_OSMO }, {
                source_channel: "channel-1",
                destination_channel: "channel-750",
              }),
            ],
          },
          auth_info: { fee: { amount: [{ denom: "uosmo", amount: "5000" }] } },
        },
        tx_response: { txhash: "HASH", height: "1", code: 0, timestamp: "2026-10-05T10:00:00Z" },
      },
      "osmosis-1",
      ME_OSMO,
    );
    expect(detail?.messages[0]).toMatchObject({ title: "Receive USDC.n over IBC", kind: "ibc", channel: "channel-750" });
    expect(detail?.messages[0]?.summary).toContain("12.34 USDC.n");
  });
});

/* -------------------------------------------------------------------------- *
 * The history read, end to end, with the stored facts
 * -------------------------------------------------------------------------- */

/** Talis, an Injective token Osmosis's list does not carry, held on Osmosis over channel-122. */
const TALIS = "factory/inj1maeyvxfamtn8lfyxpjca8kuvauuf2qeu6gtxm3/Talis";
const TALIS_ON_OSMOSIS = ibcDenomFor("transfer/channel-122", TALIS);

describe("fetchActivity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("names a voucher another context proved, and every coin from the LCD's own JSON", async () => {
    vi.resetModules();
    const store = new Map<string, unknown>([
      ["zunia.settings", { liveBalances: true }],
      [
        "zunia.tokenIdentity",
        {
          version: 1,
          facts: {
            [`osmosis-1:${TALIS_ON_OSMOSIS}`]: {
              o: "injective-1",
              b: TALIS,
              p: "transfer/channel-122",
              h: ["injective-1"],
              at: 1,
            },
          },
        },
      ],
    ]);
    vi.stubGlobal("browser", {
      storage: {
        local: { get: async (key: string) => ({ [key]: store.get(key) }), set: async () => undefined },
        onChanged: { addListener: () => undefined },
      },
      permissions: { contains: async () => true },
    });
    const txs = [
      {
        txhash: "RECV",
        code: 0,
        timestamp: "2026-10-05T10:00:00Z",
        tx: {
          body: {
            messages: [
              { "@type": "/ibc.core.client.v1.MsgUpdateClient", client_id: "07-tendermint-1" },
              recvPacket(ME_OSMO, { denom: TALIS, amount: "3000000", sender: "inj1sender", receiver: ME_OSMO }, {
                source_channel: "channel-8",
                destination_channel: "channel-122",
              }),
            ],
          },
        },
      },
      {
        txhash: "SEND",
        code: 0,
        timestamp: "2026-10-05T09:00:00Z",
        tx: {
          body: {
            messages: [
              {
                "@type": "/cosmos.bank.v1beta1.MsgSend",
                from_address: ME_OSMO,
                to_address: OTHER_OSMO,
                amount: [{ denom: USDC_N_ON_OSMOSIS, amount: "12340000" }],
              },
            ],
          },
        },
      },
    ];
    vi.stubGlobal("fetch", async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname !== "/cosmos/tx/v1beta1/txs") throw new Error(`unexpected ${url.href}`);
      return new Response(JSON.stringify({ tx_responses: txs }), { status: 200 });
    });

    const { fetchActivity, activityAmount: amountOf } = await import("../chain-queries");
    const rows = await fetchActivity("osmosis-1", ME_OSMO);
    expect(rows.map((row) => [row.hash, row.title])).toEqual([
      ["RECV", "Receive Talis over IBC"],
      ["SEND", "Send USDC.n"],
    ]);
    expect(rows[0]).toMatchObject({ denom: TALIS_ON_OSMOSIS, provenance: "channel-walk", proven: true, decimals: 6 });
    expect(amountOf(rows[0]!, "history")?.text).toBe("+3 Talis");
    expect(amountOf(rows[1]!, "history")?.text).toBe("-12.34 USDC.n");
  });
});

/* -------------------------------------------------------------------------- *
 * Approval prompts
 * -------------------------------------------------------------------------- */

describe("the resolved line under an approval summary", () => {
  it("names a proven coin with its origin, its location and how it was proven", () => {
    expect(resolvedCoinLine("osmosis-1", { amount: "12340000", denom: USDC_N_ON_OSMOSIS })).toBe(
      "= 12.34 USDC.n · Noble → on Osmosis · verified by channel",
    );
    expect(resolvedCoinLine("osmosis-1", { amount: "1500000", denom: "uosmo" })).toBe(
      "= 1.5 OSMO · native on Osmosis · verified by registry",
    );
    expect(resolvedCoinLine("noble-1", { amount: "1", denom: "uusdc" })).toBe(
      "= 0.000001 USDC.n · native on Noble · verified by registry",
    );
  });

  it("says nothing for a coin whose identity is not proven", () => {
    expect(resolvedCoinLine("osmosis-1", { amount: "12340000", denom: UNLISTED })).toBeNull();
    // Anyone can mint factory/<self>/USDC.n; it never gets a reassuring line.
    expect(
      resolvedCoinLine("osmosis-1", { amount: "1", denom: `factory/${ME_OSMO}/USDC.n` }),
    ).toBeNull();
    // The catalog's lowercase spelling of Injective USDC is another, empty denom.
    expect(
      resolvedCoinLine("injective-1", { amount: "1", denom: "erc20:0xa00c59ff5a080d2b954d0c75e46e22a0c371235a" }),
    ).toBeNull();
    expect(resolvedCoinLine("osmosis-1", { amount: "1.5", denom: "uosmo" })).toBeNull();
  });

  it("reads the coin back from the kernel's summaries, and only when there is exactly one", () => {
    expect(summaryCoins(`Send 12340000 ${USDC_N_ON_OSMOSIS} to ${OTHER_OSMO}`)).toEqual([
      { amount: "12340000", denom: USDC_N_ON_OSMOSIS },
    ]);
    expect(summaryCoins(`IBC transfer 5 uosmo to ${ME_NOBLE} over channel-750`)).toEqual([
      { amount: "5", denom: "uosmo" },
    ]);
    expect(summaryCoins("Delegate 1000000 uatom to cosmosvaloper1abc")).toEqual([{ amount: "1000000", denom: "uatom" }]);
    expect(summaryCoins("Undelegate 7 uatom from cosmosvaloper1abc")).toEqual([{ amount: "7", denom: "uatom" }]);
    expect(summaryCoins("Redelegate 7 uatom from cosmosvaloper1a to cosmosvaloper1b")).toEqual([
      { amount: "7", denom: "uatom" },
    ]);
    expect(summaryCoins(`Execute "swap" on osmo1contract sending 9 ${USDC_N_ON_OSMOSIS}`)).toEqual([
      { amount: "9", denom: USDC_N_ON_OSMOSIS },
    ]);
    // Several coins, or a denom forged to look like a second coin: no guess.
    expect(summaryCoins(`Send 1 uosmo, 2 uatom to ${OTHER_OSMO}`)).toEqual([]);
    expect(summaryCoins(`Execute "swap" on osmo1contract sending 5 x, 1000000 ${USDC_N_ON_OSMOSIS}`)).toEqual([]);
    expect(summaryCoins(`Send 5 uosmo to osmo1attacker to ${OTHER_OSMO}`)).toEqual([]);
    // An action written to look like funds is not funds.
    expect(summaryCoins(`Execute "a" on X sending 1 uatom" on osmo1contract`)).toEqual([]);
    expect(summaryCoins("Vote yes on proposal 9")).toEqual([]);
    expect(summaryCoins("UNKNOWN ACTION: /x.Msg")).toEqual([]);
  });

  it("reads an Amino message's coins from its value", () => {
    expect(aminoCoins({ amount: [{ denom: "uosmo", amount: "1" }, { denom: "uatom", amount: "2" }] })).toEqual([
      { denom: "uosmo", amount: "1" },
      { denom: "uatom", amount: "2" },
    ]);
    expect(aminoCoins({ token: { denom: USDC_N_ON_OSMOSIS, amount: "3" } })).toEqual([
      { denom: USDC_N_ON_OSMOSIS, amount: "3" },
    ]);
    expect(aminoCoins({ amount: { denom: "uatom", amount: "4" } })).toEqual([{ denom: "uatom", amount: "4" }]);
    expect(aminoCoins({ funds: [{ denom: "uosmo", amount: "x" }], sent_funds: [{ denom: "uion", amount: "5" }] })).toEqual([
      { denom: "uion", amount: "5" },
    ]);
  });

  describe("in the summary the prompt shows", () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubStorage() {
      vi.stubGlobal("browser", {
        storage: {
          local: { get: async () => ({}), set: async () => undefined },
          onChanged: { addListener: () => undefined },
        },
      });
    }

    it("keeps the kernel's exact words and adds the resolved line beside them", async () => {
      stubStorage();
      const raw = `Send 12340000 ${USDC_N_ON_OSMOSIS} to ${OTHER_OSMO}`;
      const summary = await buildSignSafety({
        expectedChainId: "osmosis-1",
        decoded: {
          chainId: "osmosis-1",
          accountNumber: "0",
          messages: [
            { typeUrl: "", summary: raw },
            { typeUrl: "", summary: `Send 1 ${UNLISTED} to ${OTHER_OSMO}` },
            { typeUrl: "/x.Msg", summary: "UNKNOWN ACTION: /x.Msg", unknown: true },
          ],
          fee: { amount: "5000", denom: "uosmo", gas: "200000" },
        },
      });
      expect(summary.messages[0]).toEqual({ type: "", summary: raw, unknown: undefined });
      expect(summary.resolved).toEqual([["= 12.34 USDC.n · Noble → on Osmosis · verified by channel"], [], []]);
      expect(summary.fees[0]).toEqual({ label: "Fee", value: "0.005 OSMO" });
    });

    it("leaves a fee nothing names in its full spelling, and adds nothing when no coin is proven", async () => {
      stubStorage();
      const summary = await buildSignSafety({
        expectedChainId: "osmosis-1",
        decoded: {
          chainId: "osmosis-1",
          accountNumber: "0",
          messages: [{ typeUrl: "", summary: `Send 1 ${UNLISTED} to ${OTHER_OSMO}` }],
          fee: { amount: "5000", denom: UNLISTED, gas: "200000" },
        },
      });
      expect(summary.fees[0]).toEqual({ label: "Fee", value: `5000 ${UNLISTED}` });
      expect(summary).not.toHaveProperty("resolved");
      expect(exactCoinText("osmosis-1", "123456789", "uosmo")).toBe("123.456789 OSMO");
    });

    it("resolves Amino messages from their values, the summary text staying as before", async () => {
      stubStorage();
      const { decodeAminoSignDoc } = await import("../signing");
      const summary = await decodeAminoSignDoc("osmosis-1", {
        chain_id: "osmosis-1",
        memo: "",
        fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
        msgs: [
          {
            type: "cosmos-sdk/MsgSend",
            value: { from_address: ME_OSMO, to_address: OTHER_OSMO, amount: [{ denom: USDC_N_ON_OSMOSIS, amount: "12340000" }] },
          },
          {
            type: "cosmos-sdk/MsgTransfer",
            value: { token: { denom: "uosmo", amount: "1500000" }, receiver: ME_NOBLE, source_channel: "channel-750" },
          },
        ],
      });
      expect(summary.messages.map((message) => message.summary)).toEqual([
        `Send 12340000 ${USDC_N_ON_OSMOSIS} to ${OTHER_OSMO}`,
        "Message cosmos-sdk/MsgTransfer",
      ]);
      expect(summary.resolved).toEqual([
        ["= 12.34 USDC.n · Noble → on Osmosis · verified by channel"],
        ["= 1.5 OSMO · native on Osmosis · verified by registry"],
      ]);
    });
  });
});

describe("identities used above", () => {
  it("are the naming table's", () => {
    expect(identityOf("osmosis-1", USDC_N_ON_OSMOSIS)).toMatchObject({ ticker: "USDC.n", proven: true, provenance: "table" });
    expect(identityOf("noble-1", "uusdc")).toMatchObject({ ticker: "USDC.n", proven: true });
    expect(identityOf("injective-1", TALIS)).toMatchObject({ ticker: "Talis", proven: true, decimals: 6 });
    expect(identityOf("osmosis-1", TALIS_ON_OSMOSIS).provenance).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- *
 * Review regressions (wave 3)
 * -------------------------------------------------------------------------- */

describe("a history amount on a 360 px screen", () => {
  /** One token of an 18-decimal coin nothing names: a 19-digit figure in base units. */
  const wide = (): ActivityItem =>
    asItem(
      "osmosis-1",
      describeMessage(
        recvPacket(ME_OSMO, { denom: "wei", amount: "1000000000000000000", sender: ME_NOBLE, receiver: ME_OSMO }, {
          source_channel: "channel-7",
          destination_channel: "channel-99999",
        }),
        ME_OSMO,
        "osmosis-1",
      ),
    );

  it("splits into a figure, the base-units words and the unit, each wrapping as a whole", () => {
    const unknown = activityAmount(wide(), "history")!;
    expect(activityAmountPieces(unknown)).toEqual({
      figure: "+1000000000000000000",
      words: "base units",
      unit: unknown.unit,
    });
    expect(unknown.unit).toMatch(/^ibc\/[0-9A-F]{4}…[0-9A-F]{6}$/);
    const one = activityAmount({ ...wide(), amount: "1" }, "history")!;
    expect(activityAmountPieces(one)).toMatchObject({ figure: "+1", words: "base unit" });
    const named = asItem("osmosis-1", describeMessage(recvPacket(ME_OSMO, { denom: "uusdc", amount: "12340000", sender: ME_NOBLE, receiver: ME_OSMO }, { source_channel: "channel-1", destination_channel: "channel-750" }), ME_OSMO, "osmosis-1"));
    expect(activityAmountPieces(activityAmount(named, "history")!)).toEqual({ figure: "+12.34", words: null, unit: "USDC.n" });
    expect(activityAmountPieces(activityAmount(named, "history", { hidden: true })!)).toEqual({
      figure: "••••",
      words: null,
      unit: "",
    });
  });

  it("never keeps a long figure on one line that runs over the title, and reads the ticker whole", () => {
    // Kept on one unbreakable line, `+1000000000000000000 base units` is
    // wider than the amount column and is drawn over the row's title
    // (`Receive IBC·1404 over IBC`), hiding the token's name.
    const html = renderToStaticMarkup(createElement(HistoryAmountText, { amount: activityAmount(wide(), "history")! }));
    expect(html).not.toContain("whitespace-nowrap\">+1000000000000000000");
    expect(html).toMatch(/<span class="[^"]*\[overflow-wrap:anywhere\][^"]*">\+1000000000000000000<\/span>/);
    expect(html).toContain('<span class="whitespace-nowrap">base units</span>');
    // Screen readers get it in one piece; the split boxes are hidden from them.
    expect(html).toContain(`<span class="sr-only">+1000000000000000000 base units ${activityAmount(wide(), "history")!.unit}</span>`);
    expect(html).toContain('aria-hidden="true"');

    const polygon = asItem(
      "osmosis-1",
      describeMessage(
        {
          "@type": "/ibc.applications.transfer.v1.MsgTransfer",
          source_port: "transfer",
          source_channel: "channel-208",
          token: { denom: "ibc/231FD77ECCB2DB916D314019DA30FE013202833386B1908A191D16989AD80B5A", amount: "1234567891" },
          sender: ME_OSMO,
          receiver: "axelar1qyqszqgpqyqszqgpqyqszqgpqyqszqgpvs7mq0",
        },
        ME_OSMO,
        "osmosis-1",
      ),
    );
    // Not `USDC .axl.polygon`: the ticker's boxes are aria-hidden.
    const row = renderToStaticMarkup(createElement(HistoryAmountText, { amount: activityAmount(polygon, "history")! }));
    expect(row).toContain('<span class="sr-only">-1.234k USDC.axl.polygon</span>');
    const detail = renderToStaticMarkup(
      createElement(TxAmount, { amount: activityAmount(polygon, "confirm")!, family: "USDC" }),
    );
    expect(detail).toContain('<span class="sr-only">-1234.567891 USDC.axl.polygon</span>');
    expect(detail).toMatch(/<span aria-hidden="true"[^>]*>.*\.axl\.polygon<\/bdi>/);
    const big = renderToStaticMarkup(createElement(TxAmount, { amount: activityAmount(wide(), "confirm")!, family: "" }));
    expect(big).toMatch(/<span class="[^"]*\[overflow-wrap:anywhere\][^"]*">\+1000000000000000000<\/span>/);
  });
});

describe("an approval's amounts are exact", () => {
  it("keeps every digit of an 18-decimal coin in the line that says `=`, and in the fee", () => {
    // `= 1.234567 INJ` would state an equality that is not true.
    expect(resolvedCoinLine("injective-1", { amount: "1234567890123456789", denom: "inj" })).toBe(
      "= 1.234567890123456789 INJ · native on Injective · verified by registry",
    );
    expect(resolvedCoinLine("injective-1", { amount: "1", denom: "inj" })).toBe(
      "= 0.000000000000000001 INJ · native on Injective · verified by registry",
    );
    expect(exactCoinText("injective-1", "123456789012345", "inj")).toBe("0.000123456789012345 INJ");
    expect(exactCoinText("osmosis-1", "5000", "uosmo")).toBe("0.005 OSMO");
  });
});

describe("an approval names only the spelling a bank holds", () => {
  it("gives no resolved line, and no ticker on the fee, to a voucher hash in lowercase", () => {
    // ibc-go mints every voucher as `ibc/` + uppercase hex; the lookup reads
    // either case, so a site's `ibc/498a…` would otherwise read as USDC.n.
    const lower = `ibc/${USDC_N_ON_OSMOSIS.slice(4).toLowerCase()}`;
    expect(isBankSpelling(USDC_N_ON_OSMOSIS)).toBe(true);
    expect(isBankSpelling(lower)).toBe(false);
    expect(isBankSpelling("factory/osmo1abc/lower")).toBe(true);
    expect(resolvedCoinLine("osmosis-1", { amount: "1000000", denom: lower })).toBeNull();
    expect(resolvedCoinLine("osmosis-1", { amount: "1000000", denom: USDC_N_ON_OSMOSIS })).toBe(
      "= 1 USDC.n · Noble → on Osmosis · verified by channel",
    );
    expect(exactCoinText("osmosis-1", "5000", lower)).toBe(`5000 ${lower}`);
    expect(exactCoinText("osmosis-1", "5000", USDC_N_ON_OSMOSIS)).toBe("0.005 USDC.n");
  });
});

/* -------------------------------------------------------------------------- *
 * The prompt against the real kernel: what it shows, and what it signs
 * -------------------------------------------------------------------------- */

type Core = typeof import("@zunialab/core");

/** The Rust kernel the worker signs with, loaded from its wasm in this process. */
async function loadCore(): Promise<Core> {
  const dir = dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href)) as Core;
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  return core;
}

/** A bech32 address the kernel accepts (the fixtures above have no valid checksum). */
const address = (prefix: string, fill: number, bytes = 20): string =>
  bech32.encode(prefix, bech32.toWords(new Uint8Array(bytes).fill(fill)));

/** lib/kernel.ts's reading of `decode_direct_tx`, as the worker hands it to buildSignSafety. */
function decodedFor(core: Core, signDocHex: string) {
  const decoded = core.decodeDirectTx(signDocHex);
  return {
    chainId: decoded.chainId,
    accountNumber: "0",
    memo: decoded.memo,
    messages: decoded.summaries.map((summary): DecodedTxMessage => {
      const unknown = summary.startsWith("UNKNOWN ACTION:");
      return { typeUrl: "", summary, ...(unknown ? { unknown: true } : {}) };
    }),
  };
}

describe("approval prompts on the kernel's own summaries", () => {
  afterEach(() => vi.unstubAllGlobals());

  const PUBKEY = `02${"11".repeat(32)}`;
  const FEE = JSON.stringify({ amount: [{ denom: "uosmo", amount: "5000" }], gas_limit: "200000" });

  it("reads the coin of each one-coin kernel format back exactly, and keeps the summary verbatim", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({}), set: async () => undefined }, onChanged: { addListener: () => undefined } },
    });
    const core = await loadCore();
    const me = address("osmo", 1);
    const other = address("osmo", 2);
    const validator = address("osmovaloper", 3);
    const noble = address("noble", 5);
    const msgs = [
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { from_address: me, to_address: other, amount: [{ denom: USDC_N_ON_OSMOSIS, amount: "12340000" }] } },
      {
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_port: "transfer",
          source_channel: "channel-750",
          token: { denom: USDC_N_ON_OSMOSIS, amount: "5000000" },
          sender: me,
          receiver: noble,
          timeout_height: { revision_number: "0", revision_height: "0" },
          timeout_timestamp: "1791202200000000000",
          memo: "",
        },
      },
      { typeUrl: "/cosmos.staking.v1beta1.MsgDelegate", value: { delegator_address: me, validator_address: validator, amount: { denom: "uosmo", amount: "1500000" } } },
      // Two coins: the kernel joins them with ", ", which is never split.
      { typeUrl: "/cosmos.bank.v1beta1.MsgSend", value: { from_address: me, to_address: other, amount: [{ denom: "uosmo", amount: "1" }, { denom: USDC_N_ON_OSMOSIS, amount: "2" }] } },
    ];
    const hex = core.buildSignBytes("osmosis-1", JSON.stringify(msgs), FEE, "", 1n, 2n, PUBKEY, false, "direct");
    const decoded = decodedFor(core, hex);
    expect(decoded.messages.map((message) => message.summary)).toEqual([
      `Send 12340000 ${USDC_N_ON_OSMOSIS} to ${other}`,
      `IBC transfer 5000000 ${USDC_N_ON_OSMOSIS} to ${noble} over channel-750`,
      `Delegate 1500000 uosmo to ${validator}`,
      `Send 1 uosmo, 2 ${USDC_N_ON_OSMOSIS} to ${other}`,
    ]);
    const handed = JSON.stringify(decoded);
    const summary = await buildSignSafety({ expectedChainId: "osmosis-1", decoded });
    expect(JSON.stringify(decoded)).toBe(handed);
    // The kernel's words are the prompt's words; the resolved lines only add.
    expect(summary.messages.map((message) => message.summary)).toEqual(decoded.messages.map((message) => message.summary));
    expect(summary.resolved).toEqual([
      ["= 12.34 USDC.n · Noble → on Osmosis · verified by channel"],
      ["= 5 USDC.n · Noble → on Osmosis · verified by channel"],
      ["= 1.5 OSMO · native on Osmosis · verified by registry"],
      [],
    ]);
    // Describing the bytes never touches them: they still decode to the same transaction.
    expect(core.decodeDirectTx(hex).summaries).toEqual(decoded.messages.map((message) => message.summary));
  });

  it("leaves an Amino sign doc byte-identical, packet memo included", async () => {
    vi.stubGlobal("browser", {
      storage: { local: { get: async () => ({}), set: async () => undefined }, onChanged: { addListener: () => undefined } },
    });
    const packetMemo = '{"forward":{"receiver":"noble1x","port":"transfer","channel":"channel-1"}}';
    const doc = {
      chain_id: "osmosis-1",
      account_number: "7",
      sequence: "3",
      memo: "",
      fee: { amount: [{ denom: "uosmo", amount: "5000" }], gas: "200000" },
      msgs: [
        {
          type: "cosmos-sdk/MsgTransfer",
          value: {
            source_port: "transfer",
            source_channel: "channel-750",
            token: { denom: USDC_N_ON_OSMOSIS, amount: "1500000" },
            sender: ME_OSMO,
            receiver: ME_NOBLE,
            memo: packetMemo,
          },
        },
        { type: "cosmos-sdk/MsgSend", value: { from_address: ME_OSMO, to_address: OTHER_OSMO, amount: [{ denom: "uosmo", amount: "1" }] } },
      ],
    };
    const before = serializeAminoSignDoc(doc);
    const frozen = JSON.parse(JSON.stringify(doc)) as typeof doc;
    const freeze = (value: unknown): void => {
      if (value && typeof value === "object") {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(frozen);
    const summary = await decodeAminoSignDoc("osmosis-1", frozen);
    // Unfrozen too, as the worker passes it: a write a frozen doc would have
    // refused in silence shows up here.
    const live = JSON.parse(JSON.stringify(doc)) as typeof doc;
    await decodeAminoSignDoc("osmosis-1", live);
    expect(Buffer.from(serializeAminoSignDoc(live)).equals(Buffer.from(before))).toBe(true);
    expect(summary.resolved).toEqual([
      ["= 1.5 USDC.n · Noble → on Osmosis · verified by channel"],
      ["= 0.000001 OSMO · native on Osmosis · verified by registry"],
    ]);
    // The bytes the worker signs after the prompt: unchanged, the packet memo
    // and the exact denom, amount and channel with them.
    const after = serializeAminoSignDoc(frozen);
    expect(Buffer.from(after).equals(Buffer.from(before))).toBe(true);
    const signed = Buffer.from(after).toString("utf8");
    expect(signed).toContain(JSON.stringify(packetMemo));
    expect(signed).toContain(`"source_channel":"channel-750"`);
    expect(signed).toContain(`"token":{"amount":"1500000","denom":"${USDC_N_ON_OSMOSIS}"}`);
  });
});

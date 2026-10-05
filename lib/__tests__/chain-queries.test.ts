import { describe, expect, it } from "vitest";
import { messageActivityGlyph } from "../../../zunia-ui/packages/ui/src/wallet/activity";

import {
  baseDenomOf,
  coinDisplay,
  describeMessage,
  formatCoin,
  parseTxDetail,
  pickMessage,
  validatorWebsite,
} from "../chain-queries";
import { forwardChannelOf } from "../packet-tracking";

const ME = "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
const OTHER = "osmo1zgq2rswzqupqyqs3dqsdgq2rswzqupqyqs5c7ms0";
const HUB_SENDER = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpgq2rsw";
/** A voucher no table or trace names (ibc/2739… would read ATOM now). */
const VOUCHER = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

function recvPacket(receiver: string, denom: string, amount: string) {
  const data = { denom, amount, sender: HUB_SENDER, receiver };
  return {
    "@type": "/ibc.core.channel.v1.MsgRecvPacket",
    packet: {
      destination_channel: "channel-0",
      data: Buffer.from(JSON.stringify(data)).toString("base64"),
    },
  };
}

const UPDATE_CLIENT = {
  "@type": "/ibc.core.client.v1.MsgUpdateClient",
  client_id: "07-tendermint-1",
};

describe("messageActivityGlyph", () => {
  it("gives IBC client upkeep and unknown messages a mark", () => {
    expect(messageActivityGlyph("MsgUpdateClient")?.icon).toBe("↻");
    expect(messageActivityGlyph("/ibc.core.client.v1.MsgCreateClient")?.icon).toBe("↻");
    expect(messageActivityGlyph("MsgTimeout")?.icon).toBe("⏱");
    expect(messageActivityGlyph("MsgAcknowledgement")?.icon).toBe("↩");
    expect(messageActivityGlyph("MsgExecuteContract")?.icon).toBe("λ");
    expect(messageActivityGlyph("MsgSomethingNew")?.icon).toBe("✳");
    expect(messageActivityGlyph("MsgSend")).toBeNull();
    expect(messageActivityGlyph("MsgTransfer")).toBeNull();
  });
});

describe("baseDenomOf", () => {
  it("strips every port and channel pair in front of the base denom", () => {
    expect(baseDenomOf("transfer/channel-0/uatom")).toBe("uatom");
    expect(baseDenomOf("transfer/channel-0/transfer/channel-141/uosmo")).toBe("uosmo");
  });

  it("leaves vouchers and factory denoms alone", () => {
    expect(baseDenomOf(VOUCHER)).toBe(VOUCHER);
    expect(baseDenomOf("factory/osmo1abc/token")).toBe("factory/osmo1abc/token");
  });
});

describe("coinDisplay", () => {
  it("names the chain's own coin and a coin another catalog chain issues", () => {
    expect(coinDisplay("cosmoshub-4", "uatom")).toEqual({
      symbol: "ATOM",
      decimals: 6,
      known: true,
    });
    expect(coinDisplay("osmosis-1", "uatom")).toEqual({
      symbol: "ATOM",
      decimals: 6,
      known: true,
    });
    expect(coinDisplay("osmosis-1", "transfer/channel-141/uosmo")).toEqual({
      symbol: "OSMO",
      decimals: 6,
      known: true,
    });
  });

  it("keeps an unnamed denom in base units instead of guessing decimals", () => {
    const display = coinDisplay("osmosis-1", VOUCHER);
    expect(display.known).toBe(false);
    expect(display.decimals).toBe(0);
    expect(formatCoin("123", display)).toBe(`123 ${display.symbol}`);
  });

  it("formats a named coin in whole units", () => {
    expect(formatCoin("1500000", { symbol: "ATOM", decimals: 6, known: true })).toBe("1.5 ATOM");
  });
});

describe("pickMessage", () => {
  it("finds the delivery to this account inside a relayer transaction", () => {
    const mine = recvPacket(ME, "uatom", "2000000");
    const picked = pickMessage([UPDATE_CLIENT, recvPacket(OTHER, "uatom", "1"), mine], ME);
    expect(picked).toBe(mine);
  });

  it("skips relayer upkeep for the message the transaction is about", () => {
    const send = { "@type": "/cosmos.bank.v1beta1.MsgSend", from_address: ME };
    expect(pickMessage([UPDATE_CLIENT, send], ME)).toBe(send);
    expect(pickMessage([UPDATE_CLIENT], ME)).toBe(UPDATE_CLIENT);
  });
});

describe("describeMessage", () => {
  it("reads an IBC delivery to this account with the coin it carried", () => {
    const described = describeMessage(recvPacket(ME, "transfer/channel-141/uosmo", "2500000"), ME, "osmosis-1");
    expect(described.kind).toBe("ibc");
    expect(described.symbol).toBe("OSMO");
    expect(described.amount).toBe("2500000");
    expect(described.summary).toBe(
      `Receive 2.5 OSMO over IBC from ${HUB_SENDER.slice(0, 12)}…${HUB_SENDER.slice(-6)} on channel-0`,
    );
  });

  it("describes a delivery to someone else as relaying, with no amount", () => {
    const described = describeMessage(recvPacket(OTHER, "uatom", "1"), ME, "osmosis-1");
    expect(described.kind).toBe("other");
    expect(described.amount).toBeUndefined();
    expect(described.summary).toBe("Deliver an IBC packet on channel-0");
  });

  it("does not price a voucher it cannot name in the native coin", () => {
    const described = describeMessage(
      {
        "@type": "/cosmos.bank.v1beta1.MsgSend",
        from_address: ME,
        to_address: OTHER,
        amount: [{ denom: VOUCHER, amount: "42" }],
      },
      ME,
      "osmosis-1",
    );
    expect(described.kind).toBe("sent");
    expect(described.amount).toBe("-42");
    expect(described.denom).toBe(VOUCHER);
    expect(described.decimals).toBe(0);
    expect(described.symbol).not.toBe("OSMO");
  });

  it("names an IBC client update instead of leaving the row unmarked", () => {
    const described = describeMessage(UPDATE_CLIENT, ME, "osmosis-1");
    expect(described.kind).toBe("other");
    expect(described.title).toBe("Update Client");
    expect(described.summary).toContain("07-tendermint-1");
  });

  it("names governance votes", () => {
    const described = describeMessage(
      { "@type": "/cosmos.gov.v1beta1.MsgVote", proposal_id: "912", option: "VOTE_OPTION_NO_WITH_VETO" },
      ME,
      "osmosis-1",
    );
    expect(described.summary).toBe("Vote no with veto on proposal #912");
  });
});

describe("parseTxDetail", () => {
  const sendPacket = {
    type: "send_packet",
    attributes: [
      { key: "packet_sequence", value: "7" },
      { key: "packet_src_port", value: "transfer" },
      { key: "packet_src_channel", value: "channel-0" },
      { key: "packet_dst_port", value: "transfer" },
      { key: "packet_dst_channel", value: "channel-141" },
    ],
  };

  function body(code: number, rawLog = "") {
    return {
      tx: {
        body: {
          memo: "rent",
          messages: [
            {
              "@type": "/ibc.applications.transfer.v1.MsgTransfer",
              source_channel: "channel-0",
              receiver: HUB_SENDER,
              token: { denom: "uosmo", amount: "1000000" },
            },
          ],
        },
        auth_info: { fee: { amount: [{ denom: "uosmo", amount: "5000" }] } },
      },
      tx_response: {
        txhash: "ABC",
        height: "123456",
        code,
        raw_log: rawLog,
        timestamp: "2026-09-01T10:00:00Z",
        gas_wanted: "200000",
        gas_used: "150000",
        events: [sendPacket],
      },
    };
  }

  it("reads fees, gas, memo, messages and the packets sent", () => {
    const detail = parseTxDetail(body(0), "osmosis-1", ME);
    expect(detail).not.toBeNull();
    expect(detail?.success).toBe(true);
    expect(detail?.error).toBeNull();
    expect(detail?.memo).toBe("rent");
    expect(detail?.height).toBe("123456");
    expect(detail?.timestamp).toBe(Date.parse("2026-09-01T10:00:00Z"));
    expect(detail?.gasUsed).toBe("150000");
    expect(detail?.gasWanted).toBe("200000");
    expect(detail?.fee).toEqual([
      { denom: "uosmo", amount: "5000", symbol: "OSMO", decimals: 6, known: true },
    ]);
    expect(detail?.messages).toEqual([
      {
        type: "MsgTransfer",
        summary: `Send 1 OSMO over IBC to ${HUB_SENDER.slice(0, 12)}…${HUB_SENDER.slice(-6)} on channel-0`,
        kind: "ibc",
        title: "Send OSMO over IBC",
        from: ME,
        to: HUB_SENDER,
        channel: "channel-0",
      },
    ]);
    expect(detail?.packets).toHaveLength(1);
    expect(detail?.packets[0]?.sourceChannelId).toBe("channel-0");
  });

  it("keeps the chain's reason for a failure and no packets", () => {
    const detail = parseTxDetail(body(5, "insufficient funds"), "osmosis-1", ME);
    expect(detail?.success).toBe(false);
    expect(detail?.error).toBe("insufficient funds");
    expect(detail?.packets).toEqual([]);
  });

  it("returns null for a body with no transaction in it", () => {
    expect(parseTxDetail({ code: 5, message: "tx not found" }, "osmosis-1", ME)).toBeNull();
  });
});

describe("forwardChannelOf", () => {
  it("reads the next channel of a packet-forward memo", () => {
    expect(
      forwardChannelOf(JSON.stringify({ forward: { receiver: ME, port: "transfer", channel: "channel-141" } })),
    ).toBe("channel-141");
  });

  it("ignores memos that forward nothing", () => {
    expect(forwardChannelOf("")).toBeNull();
    expect(forwardChannelOf("thanks")).toBeNull();
    expect(forwardChannelOf(JSON.stringify({ wasm: { contract: "osmo1x" } }))).toBeNull();
    expect(forwardChannelOf(JSON.stringify({ forward: { channel: 3 } }))).toBeNull();
  });
});

describe("validatorWebsite", () => {
  it("accepts a host and an https url", () => {
    expect(validatorWebsite("validarios.io")).toBe("https://validarios.io/");
    expect(validatorWebsite("https://validarios.io/about")).toBe(
      "https://validarios.io/about",
    );
  });

  it("rejects empty and non-http schemes", () => {
    expect(validatorWebsite("")).toBeNull();
    expect(validatorWebsite("javascript:alert(1)")).toBeNull();
  });
});

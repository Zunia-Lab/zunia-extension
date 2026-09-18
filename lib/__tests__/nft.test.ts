import { describe, expect, it } from "vitest";

import { summarizeAminoMsgs } from "../signing";
import {
  buildCrossChainNftTransfer,
  buildSameChainNftTransfer,
  describeNftExecute,
  ics721Port,
  mediaTargetFor,
  nftChainSupport,
} from "../nft";

/**
 * These assertions guard the two places an NFT can be lost silently.
 *
 * The first is the wire shape. A CW721 execute is opaque bytes inside
 * `MsgExecuteContract`, so a renamed key does not fail at build time and does
 * not fail at signing time - it fails during contract execution, after the user
 * has approved and paid gas, with an error nobody can read. `send_nft` is worse
 * again: it carries two levels of base64 and the inner `IbcOutgoingMsg` is what
 * decides where the NFT ends up.
 *
 * The second is the approval screen's decoder. The kernel's own preview line
 * reads `Execute "transfer_nft" on <contract>`, which names neither the token
 * nor the recipient, so `describeNftExecute` is what turns the message into
 * informed consent. A decoder that quietly returns a partial answer would put
 * a confident, wrong sentence in front of a signature.
 */

const SAFRO = "safrochain-1";
const SENDER = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsender";
const COLLECTION = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqcollection";
const RECIPIENT = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrecipient";
const OSMO_RECIPIENT = "osmo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqrecipient";
const BRIDGE = "addr_safro1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqbridge";

function decodeMsgField(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("msg is not base64");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8")) as unknown;
}

describe("nftChainSupport", () => {
  it("allows a chain that declares cosmwasm", () => {
    expect(nftChainSupport("osmosis-1").supported).toBe(true);
    expect(nftChainSupport("osmosis-1").reason).toBeNull();
  });

  it("refuses a chain whose registry entry has no cosmwasm, and says which", () => {
    const support = nftChainSupport("cosmoshub-4");
    expect(support.supported).toBe(false);
    expect(support.reason).toContain('does not declare the "cosmwasm" feature');
  });

  it("tells 'declared no cosmwasm' apart from 'published no feature list'", () => {
    // `arctic-1` carries no `features` array in the registry. Absent is not the
    // same claim as declared-none, and the two sentences send a user to
    // different places, so they must not collapse into one.
    const support = nftChainSupport("arctic-1");
    expect(support.supported).toBe(false);
    expect(support.reason).toContain("publishes no capability list");
  });

  it("refuses a chain that is not in the wallet's list at all", () => {
    const support = nftChainSupport("not-a-chain-1");
    expect(support.supported).toBe(false);
    expect(support.reason).toContain("not in this wallet's chain list");
  });
});

describe("buildSameChainNftTransfer", () => {
  const msg = buildSameChainNftTransfer({
    chainId: SAFRO,
    sender: SENDER,
    collectionAddress: COLLECTION,
    tokenId: "42",
    recipient: RECIPIENT,
  });

  it("is a MsgExecuteContract against the collection, not the recipient", () => {
    expect(msg.typeUrl).toBe("/cosmwasm.wasm.v1.MsgExecuteContract");
    expect(msg.value.sender).toBe(SENDER);
    expect(msg.value.contract).toBe(COLLECTION);
  });

  it("carries no funds: a CW721 transfer costs nothing beyond gas", () => {
    expect(msg.value.funds).toEqual([]);
  });

  it("encodes exactly the transfer_nft the cw721 spec names", () => {
    expect(decodeMsgField(msg.value.msg)).toEqual({
      transfer_nft: { recipient: RECIPIENT, token_id: "42" },
    });
  });

  it("refuses a recipient on another chain", () => {
    // A well-formed address with the wrong prefix is the mistake that succeeds
    // on review and loses the token, so it has to fail before the preview.
    expect(() =>
      buildSameChainNftTransfer({
        chainId: SAFRO,
        sender: SENDER,
        collectionAddress: COLLECTION,
        tokenId: "42",
        recipient: OSMO_RECIPIENT,
      }),
    ).toThrow(/not a .* address/i);
  });

  it("refuses an empty token id", () => {
    expect(() =>
      buildSameChainNftTransfer({
        chainId: SAFRO,
        sender: SENDER,
        collectionAddress: COLLECTION,
        tokenId: "",
        recipient: RECIPIENT,
      }),
    ).toThrow(/token id/i);
  });
});

describe("buildCrossChainNftTransfer", () => {
  const msg = buildCrossChainNftTransfer({
    chainId: SAFRO,
    destChainId: "osmosis-1",
    sender: SENDER,
    collectionAddress: COLLECTION,
    tokenId: "7",
    recipient: OSMO_RECIPIENT,
    bridgeContract: BRIDGE,
    channelId: "channel-3",
  });

  it("executes send_nft on the collection and names the bridge as receiver", () => {
    const body = decodeMsgField(msg.value.msg) as {
      send_nft: { contract: string; token_id: string; msg: string };
    };
    expect(msg.value.contract).toBe(COLLECTION);
    expect(body.send_nft.contract).toBe(BRIDGE);
    expect(body.send_nft.token_id).toBe("7");
  });

  it("base64-encodes the IbcOutgoingMsg inside the already-base64 send_nft", () => {
    const body = decodeMsgField(msg.value.msg) as { send_nft: { msg: string } };
    const outgoing = JSON.parse(
      Buffer.from(body.send_nft.msg, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(outgoing.receiver).toBe(OSMO_RECIPIENT);
    expect(outgoing.channel_id).toBe("channel-3");
    // Always a timeout: a packet with none is never refunded.
    expect(outgoing.timeout).toHaveProperty("timestamp");
    // `memo` is Option<String> upstream, so it is omitted rather than nulled.
    expect(Object.keys(outgoing).includes("memo")).toBe(false);
  });

  it("checks the recipient against the destination chain's prefix, not the source's", () => {
    expect(() =>
      buildCrossChainNftTransfer({
        chainId: SAFRO,
        destChainId: "osmosis-1",
        sender: SENDER,
        collectionAddress: COLLECTION,
        tokenId: "7",
        recipient: RECIPIENT,
        bridgeContract: BRIDGE,
        channelId: "channel-3",
      }),
    ).toThrow(/not a .*Osmosis.* address/i);
  });
});

describe("ics721Port", () => {
  it("binds to the bridge contract, never to the transfer port", () => {
    // An ICS721 channel lives on `wasm.<bridge>`. Searching `transfer` finds
    // ICS20 channels that look plausible and send the NFT nowhere.
    expect(ics721Port(BRIDGE)).toBe(`wasm.${BRIDGE}`);
    expect(ics721Port(BRIDGE)).not.toBe("transfer");
  });
});

describe("describeNftExecute", () => {
  it("names the token, the collection and the new owner", () => {
    const described = describeNftExecute(
      buildSameChainNftTransfer({
        chainId: SAFRO,
        sender: SENDER,
        collectionAddress: COLLECTION,
        tokenId: "42",
        recipient: RECIPIENT,
      }),
    );
    expect(described).not.toBeNull();
    expect(described!.action).toEqual({
      kind: "transfer_nft",
      collectionAddress: COLLECTION,
      tokenId: "42",
      recipient: RECIPIENT,
    });
    expect(described!.warnings).toEqual([]);
  });

  it("reads the ICS721 destination out of the doubly-encoded payload", () => {
    const described = describeNftExecute(
      buildCrossChainNftTransfer({
        chainId: SAFRO,
        destChainId: "osmosis-1",
        sender: SENDER,
        collectionAddress: COLLECTION,
        tokenId: "7",
        recipient: OSMO_RECIPIENT,
        bridgeContract: BRIDGE,
        channelId: "channel-3",
      }),
    );
    expect(described).not.toBeNull();
    const action = described!.action;
    expect(action.kind).toBe("send_nft");
    if (action.kind !== "send_nft") throw new Error("unreachable");
    expect(action.receivingContract).toBe(BRIDGE);
    expect(action.ics721?.receiver).toBe(OSMO_RECIPIENT);
    expect(action.ics721?.channelId).toBe("channel-3");
  });

  it("warns when coins ride along, because a CW721 call takes none", () => {
    const base = buildSameChainNftTransfer({
      chainId: SAFRO,
      sender: SENDER,
      collectionAddress: COLLECTION,
      tokenId: "42",
      recipient: RECIPIENT,
    });
    const described = describeNftExecute({
      ...base,
      value: { ...base.value, funds: [{ denom: "usafro", amount: "1000000" }] },
    });
    expect(described!.warnings[0]).toContain("sends coins");
  });

  it("returns null rather than describing a message it cannot read", () => {
    // Null is what makes the approval screen say "Zunia could not read this".
    // A decoder that guessed would put a confident wrong sentence in front of
    // a signature, which is the failure this whole path exists to prevent.
    const notAnNft = {
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: {
        sender: SENDER,
        contract: COLLECTION,
        msg: Buffer.from(JSON.stringify({ increase_allowance: { amount: "1" } })).toString(
          "base64",
        ),
        funds: [],
      },
    };
    expect(describeNftExecute(notAnNft)).toBeNull();

    expect(
      describeNftExecute({
        typeUrl: "/cosmos.bank.v1beta1.MsgSend",
        value: { from_address: SENDER, to_address: RECIPIENT, amount: [] },
      }),
    ).toBeNull();

    // A transfer_nft missing its recipient is not "a transfer to nobody", it is
    // a message we cannot describe.
    expect(
      describeNftExecute({
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: {
          sender: SENDER,
          contract: COLLECTION,
          msg: Buffer.from(JSON.stringify({ transfer_nft: { token_id: "1" } })).toString(
            "base64",
          ),
          funds: [],
        },
      }),
    ).toBeNull();
  });
});

describe("mediaTargetFor", () => {
  it("rewrites ipfs:// through the configured gateways, in order", () => {
    const target = mediaTargetFor("ipfs://QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx/1.png");
    expect(target.url).toBe(
      "https://ipfs.io/ipfs/QmZ4tDuvesekSs4qM5ZBKpXiZGun7S2CYtEZRB3DYXkjGx/1.png",
    );
    expect(target.urls.length).toBeGreaterThan(1);
    expect(target.reason).toBeNull();
  });

  it("passes https through untouched", () => {
    expect(mediaTargetFor("https://example.org/a.png").url).toBe(
      "https://example.org/a.png",
    );
  });

  it("refuses plain http rather than quietly downgrading the connection", () => {
    const target = mediaTargetFor("http://example.org/a.png");
    expect(target.url).toBeNull();
    expect(target.reason).toContain("http");
  });

  it("says there is nothing to load rather than returning an empty string", () => {
    expect(mediaTargetFor(null).url).toBeNull();
    expect(mediaTargetFor(null).reason).toContain("no image reference");
  });
});

describe("summarizeAminoMsgs on a dApp CW721 request", () => {
  /**
   * The dApp path is where a user is most likely to meet an opaque CW721
   * transfer: a marketplace asks for a signature and the wallet has to say what
   * it does. Amino puts the ExecuteMsg in as a plain object, not base64, which
   * is why the decoder is shared rather than duplicated.
   */
  it("names the token and the new owner instead of the message type", () => {
    const [summary] = summarizeAminoMsgs([
      {
        type: "wasm/MsgExecuteContract",
        value: {
          sender: SENDER,
          contract: COLLECTION,
          msg: { transfer_nft: { recipient: RECIPIENT, token_id: "42" } },
          funds: [],
        },
      },
    ]);
    expect(summary!.summary).toContain("NFT 42");
    expect(summary!.summary).toContain(RECIPIENT);
    // Feeds the first-time-recipient warning, which is only honest when the
    // recipient was really decoded.
    expect(summary!.recipient).toBe(RECIPIENT);
  });

  it("says the destination mints a voucher for an ICS721 send", () => {
    const [summary] = summarizeAminoMsgs([
      {
        type: "wasm/MsgExecuteContract",
        value: {
          sender: SENDER,
          contract: COLLECTION,
          msg: {
            send_nft: {
              contract: BRIDGE,
              token_id: "7",
              msg: Buffer.from(
                JSON.stringify({ receiver: OSMO_RECIPIENT, channel_id: "channel-3" }),
              ).toString("base64"),
            },
          },
        },
      },
    ]);
    expect(summary!.summary).toContain("voucher");
    expect(summary!.summary).toContain("channel-3");
    // No recipient: the new holder is the bridge contract, not the receiver, so
    // the first-time-recipient warning must not fire on the far-side address.
    expect(summary!.recipient).toBeUndefined();
  });

  it("still names the action for a contract call it does not model", () => {
    const [summary] = summarizeAminoMsgs([
      {
        type: "wasm/MsgExecuteContract",
        value: {
          sender: SENDER,
          contract: COLLECTION,
          msg: { increase_allowance: { spender: RECIPIENT, amount: "1" } },
        },
      },
    ]);
    expect(summary!.summary).toBe(`Execute "increase_allowance" on ${COLLECTION}`);
  });
});

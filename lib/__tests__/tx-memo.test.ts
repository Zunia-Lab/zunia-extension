import { describe, expect, it } from "vitest";
import { msgDelegate, msgSend, msgVote, msgWithdrawReward } from "../amino-tx";
import { ZUNIA_WALLET_TAG, defaultTxMemo, resolveTxMemo } from "../tx-memo";

const ME = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpgq2rsw";

describe("resolveTxMemo", () => {
  it("keeps a user-written memo", () => {
    expect(resolveTxMemo(" rent ", [msgSend({
      fromAddress: ME,
      toAddress: ME,
      amount: [{ denom: "uatom", amount: "1" }],
    })])).toBe("rent");
  });

  it("fills an empty memo with a Zunia default", () => {
    const memo = resolveTxMemo("   ", [
      msgSend({
        fromAddress: ME,
        toAddress: ME,
        amount: [{ denom: "uatom", amount: "1" }],
      }),
    ]);
    expect(memo.endsWith(ZUNIA_WALLET_TAG)).toBe(true);
    expect(memo.startsWith("Send")).toBe(true);
  });
});

describe("defaultTxMemo", () => {
  it("names a send", () => {
    expect(
      defaultTxMemo([
        msgSend({
          fromAddress: ME,
          toAddress: ME,
          amount: [{ denom: "uatom", amount: "1" }],
        }),
      ]),
    ).toMatch(/^Send .+ · by Zunia-wallet$/);
  });

  it("names a stake", () => {
    expect(
      defaultTxMemo([
        msgDelegate({
          delegatorAddress: ME,
          validatorAddress: "cosmosvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a",
          amount: { denom: "uatom", amount: "1" },
        }),
      ]),
    ).toMatch(/^Stake .+ · by Zunia-wallet$/);
  });

  it("names a claim across several withdraw messages", () => {
    const one = msgWithdrawReward({
      delegatorAddress: ME,
      validatorAddress: "cosmosvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a",
    });
    expect(defaultTxMemo([one, one])).toBe(`Claim rewards · ${ZUNIA_WALLET_TAG}`);
  });

  it("names a vote with option and proposal", () => {
    expect(
      defaultTxMemo([
        msgVote({ proposalId: "42", voter: ME, option: "yes" }),
      ]),
    ).toBe(`Vote Yes on #42 · ${ZUNIA_WALLET_TAG}`);
  });

  it("names an IBC transfer", () => {
    expect(
      defaultTxMemo([
        {
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
          value: { token: { denom: "uosmo", amount: "1" }, memo: "" },
        },
      ]),
    ).toMatch(/^IBC transfer .+ · by Zunia-wallet$/);
  });

  it("names a swap from an ibc-hooks packet memo", () => {
    expect(
      defaultTxMemo([
        {
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            token: { denom: "uosmo", amount: "1" },
            memo: JSON.stringify({
              wasm: { contract: "osmo1x", msg: { osmosis_swap: {} } },
            }),
          },
        },
      ]),
    ).toMatch(/^Swap .+ · by Zunia-wallet$/);
  });

  it("names a packet-forward hop", () => {
    expect(
      defaultTxMemo([
        {
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            token: { denom: "uatom", amount: "1" },
            memo: JSON.stringify({
              forward: { receiver: ME, port: "transfer", channel: "channel-0" },
            }),
          },
        },
      ]),
    ).toMatch(/^IBC forward .+ · by Zunia-wallet$/);
  });

  it("names an NFT transfer from the wasm action", () => {
    expect(
      defaultTxMemo([
        {
          typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
          value: { msg: { transfer_nft: { recipient: ME, token_id: "1" } } },
        },
      ]),
    ).toBe(`NFT transfer · ${ZUNIA_WALLET_TAG}`);
  });

  it("falls back when the message is unknown", () => {
    expect(defaultTxMemo([{ typeUrl: "/cosmos.unknown.v1.MsgNope", value: {} }])).toBe(
      `Signed · ${ZUNIA_WALLET_TAG}`,
    );
  });
});

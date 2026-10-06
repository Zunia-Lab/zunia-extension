import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { bech32 } from "@scure/base";
import { afterEach, describe, expect, it } from "vitest";
import { msgDelegate, msgSend, msgVote, msgWithdrawReward } from "../amino-tx";
import { CHAIN_CATALOG, setCustomCatalogEntries, type CatalogEntry } from "../chain-catalog";
import { buildSwapFeeMsg } from "../swap-fee";
import { ZUNIA_WALLET_TAG, defaultTxMemo, resolveTxMemo, type MemoSourceMsg } from "../tx-memo";

const ME = "cosmos1qyqszqgpqyqszqgpqyqszqgpqyqszqgpgq2rsw";

/** Noble USDC on Osmosis (`transfer/channel-750/uusdc`). */
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
/** A voucher nothing names. */
const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

const send = (denom: string): MemoSourceMsg => ({
  typeUrl: "/cosmos.bank.v1beta1.MsgSend",
  value: { from_address: ME, to_address: ME, amount: [{ denom, amount: "1" }] },
});
const transfer = (denom: string, memo = ""): MemoSourceMsg => ({
  typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
  value: { token: { denom, amount: "1" }, memo },
});

/** Freeze a message all the way down, so any write to it throws. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/**
 * The 0.1.2 MsgTransfer for ATOM (Hub) → OSMO, with its ibc-hooks packet memo,
 * byte for byte (captured from the planner; see swap-plan.test.ts).
 */
const XCS_PACKET_MEMO =
  '{"wasm":{"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"msg":{"osmosis_swap":{"output_denom":"uosmo",' +
  '"slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},' +
  '"receiver":"osmo1sender00000000000000000000000000000000",' +
  '"on_failed_delivery":{"local_recovery_addr":"osmo1recovery000000000000000000000000000000"},' +
  '"next_memo":null}}}}';
const XCS_TRANSFER =
  '{"typeUrl":"/ibc.applications.transfer.v1.MsgTransfer","value":{"source_port":"transfer",' +
  '"source_channel":"channel-141","token":{"denom":"uatom","amount":"1000000"},' +
  '"sender":"cosmos1sender0000000000000000000000000000000",' +
  '"receiver":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs",' +
  '"timeout_height":{"revision_number":"0","revision_height":"0"},' +
  `"timeout_timestamp":"1791202200000000000","memo":${JSON.stringify(XCS_PACKET_MEMO)}}}`;

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

describe("chain-aware naming", () => {
  afterEach(() => setCustomCatalogEntries([]));

  it("names Noble's own USDC by the chain that signs: 'Send USDC.n'", () => {
    expect(resolveTxMemo("", [send("uusdc")], "noble-1")).toBe(`Send USDC.n · ${ZUNIA_WALLET_TAG}`);
    expect(defaultTxMemo([transfer("uusdc")], "noble-1")).toBe(`IBC transfer USDC.n · ${ZUNIA_WALLET_TAG}`);
  });

  it("names a voucher on the chain that holds it, never by its base denom", () => {
    expect(resolveTxMemo("", [transfer(USDC_N_ON_OSMOSIS)], "osmosis-1")).toBe(
      `IBC transfer USDC.n · ${ZUNIA_WALLET_TAG}`,
    );
    expect(resolveTxMemo("", [send("erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a")], "injective-1")).toBe(
      `Send USDC.inj · ${ZUNIA_WALLET_TAG}`,
    );
  });

  it("writes the generic phrase for anything it cannot prove", () => {
    // An unknown voucher: no bare hash is written on chain.
    expect(resolveTxMemo("", [transfer(UNLISTED)], "osmosis-1")).toBe(`IBC transfer · ${ZUNIA_WALLET_TAG}`);
    // Anyone's factory/<self>/USDC.n: its free text never reaches the memo.
    expect(
      resolveTxMemo("", [send("factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/USDC.n")], "osmosis-1"),
    ).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    // The catalog's lowercase spelling of Injective USDC is another, empty denom.
    expect(
      resolveTxMemo("", [send("erc20:0xa00c59ff5a080d2b954d0c75e46e22a0c371235a")], "injective-1"),
    ).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    // A packet path is not a bank denom.
    expect(resolveTxMemo("", [send("transfer/channel-0/uatom")], "osmosis-1")).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    // A chain the user added is not evidence of what its coins are.
    const osmosis = CHAIN_CATALOG.find((entry) => entry.chainId === "osmosis-1") as CatalogEntry;
    setCustomCatalogEntries([
      {
        ...osmosis,
        chainId: "mine-1",
        chainName: "Mine",
        bech32Prefix: "mine",
        coinDenom: "USDC",
        coinMinimalDenom: "umine",
        feeDenom: "USDC",
        feeMinimalDenom: "umine",
        currencies: [{ coinDenom: "USDC", coinMinimalDenom: "umine", coinDecimals: 6 }],
      },
    ]);
    expect(resolveTxMemo("", [send("umine")], "mine-1")).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
  });

  it("names nothing a base denom cannot pin to one issuer when no chain is given", () => {
    // uusdc is Noble's and Axelar's alike: 0.1.2 wrote 'Send USDC.axl' for both.
    expect(resolveTxMemo("", [send("uusdc")])).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    // uluna is LUNA on Terra and LUNC on Terra Classic.
    expect(resolveTxMemo("", [send("uluna")])).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    // A voucher names a path, and only its holding chain knows which.
    expect(resolveTxMemo("", [transfer(USDC_N_ON_OSMOSIS)])).toBe(`IBC transfer · ${ZUNIA_WALLET_TAG}`);
  });

  it("keeps a user-written memo whatever the chain", () => {
    expect(resolveTxMemo("  rent  ", [send("uusdc")], "noble-1")).toBe("rent");
  });
});

describe("Earn and Governance memos", () => {
  // Both screens resolve their memos without a chain; staking coins read as before.
  const stake = (type: string, denom: string): MemoSourceMsg => ({ type, value: { amount: { denom } } });

  it("name the staking coin as 0.1.2 did", () => {
    const cases: Array<[string, string]> = [
      ["uatom", "ATOM"],
      ["uosmo", "OSMO"],
      ["inj", "INJ"],
      ["uaxl", "AXL"],
      ["utia", "TIA"],
      ["untrn", "NTRN"],
      ["ustrd", "STRD"],
      ["ujuno", "JUNO"],
      ["uakt", "AKT"],
      ["adydx", "DYDX"],
      ["ukuji", "KUJI"],
    ];
    for (const [denom, ticker] of cases) {
      expect(resolveTxMemo("", [stake("cosmos-sdk/MsgDelegate", denom)])).toBe(`Stake ${ticker} · ${ZUNIA_WALLET_TAG}`);
      expect(resolveTxMemo("", [stake("cosmos-sdk/MsgUndelegate", denom)])).toBe(
        `Unstake ${ticker} · ${ZUNIA_WALLET_TAG}`,
      );
      expect(resolveTxMemo("", [stake("cosmos-sdk/MsgBeginRedelegate", denom)])).toBe(
        `Redelegate ${ticker} · ${ZUNIA_WALLET_TAG}`,
      );
      // The same words as when the chain is known.
      const chainId = CHAIN_CATALOG.find((entry) => entry.coinMinimalDenom === denom && entry.network === "mainnet")?.chainId;
      expect(resolveTxMemo("", [stake("cosmos-sdk/MsgDelegate", denom)], chainId)).toBe(
        `Stake ${ticker} · ${ZUNIA_WALLET_TAG}`,
      );
    }
  });

  it("keep their claim and vote wording", () => {
    const claim = msgWithdrawReward({
      delegatorAddress: ME,
      validatorAddress: "cosmosvaloper1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnrql8a",
    });
    expect(resolveTxMemo("", [claim, claim])).toBe(`Claim rewards · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [msgVote({ proposalId: "981", voter: ME, option: "no" })])).toBe(
      `Vote No on #981 · ${ZUNIA_WALLET_TAG}`,
    );
    expect(resolveTxMemo("", [{ typeUrl: "/cosmos.gov.v1beta1.MsgVote", value: { proposal_id: "42", option: 1 } }])).toBe(
      `Vote Yes on #42 · ${ZUNIA_WALLET_TAG}`,
    );
  });
});

describe("the packet memo inside MsgTransfer", () => {
  it("is read to choose the phrase and never written: the message stays byte-identical", () => {
    const msg = deepFreeze(JSON.parse(XCS_TRANSFER) as MemoSourceMsg & { value: { memo: string } });
    expect(resolveTxMemo("", [msg], "cosmoshub-4")).toBe(`Swap ATOM · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [msg])).toBe(`Swap ATOM · ${ZUNIA_WALLET_TAG}`);
    expect(JSON.stringify(msg)).toBe(XCS_TRANSFER);
    expect(msg.value.memo).toMatchInlineSnapshot(
      `"{"wasm":{"contract":"osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs","msg":{"osmosis_swap":{"output_denom":"uosmo","slippage":{"twap":{"slippage_percentage":"1","window_seconds":10}},"receiver":"osmo1sender00000000000000000000000000000000","on_failed_delivery":{"local_recovery_addr":"osmo1recovery000000000000000000000000000000"},"next_memo":null}}}}"`,
    );
  });

  it("keeps a forward hop's memo whole too", () => {
    const forward = '{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-1"}}';
    const msg = deepFreeze(transfer(USDC_N_ON_OSMOSIS, forward));
    const before = JSON.stringify(msg);
    expect(resolveTxMemo("", [msg], "osmosis-1")).toBe(`IBC forward USDC.n · ${ZUNIA_WALLET_TAG}`);
    expect(JSON.stringify(msg)).toBe(before);
    expect((msg.value as { memo: string }).memo).toBe(forward);
  });
});

/** ATOM on Osmosis (`transfer/channel-0/uatom`). */
const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";

/**
 * A crosschain-swaps call from funds already on Osmosis (Swap's venue-origin
 * path), shaped as the planner builds it: the ExecuteMsg in base64, one coin.
 */
const swapCall = (
  sold: string,
  bought: string,
  value: Record<string, unknown> = {},
): MemoSourceMsg & { value: Record<string, unknown> } => ({
  typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
  value: {
    sender: "osmo1sender00000000000000000000000000000000",
    contract: XCS,
    msg: Buffer.from(
      JSON.stringify({
        osmosis_swap: {
          output_denom: bought,
          slippage: { twap: { slippage_percentage: "1", window_seconds: 10 } },
          receiver: "cosmos1sender0000000000000000000000000000000",
          on_failed_delivery: { local_recovery_addr: "osmo1recovery000000000000000000000000000000" },
          next_memo: null,
        },
      }),
    ).toString("base64"),
    funds: [{ denom: sold, amount: "63000000" }],
    ...value,
  },
});

describe("a swap signed as one contract call on Osmosis", () => {
  it("names both tokens as Osmosis holds them: 'Swap OSMO to ATOM'", () => {
    expect(resolveTxMemo("", [swapCall("uosmo", ATOM_ON_OSMOSIS)], "osmosis-1")).toBe(
      `Swap OSMO to ATOM · ${ZUNIA_WALLET_TAG}`,
    );
    expect(resolveTxMemo("", [swapCall(USDC_N_ON_OSMOSIS, "uosmo")], "osmosis-1")).toBe(
      `Swap USDC.n to OSMO · ${ZUNIA_WALLET_TAG}`,
    );
    // A memo the user wrote is kept.
    expect(resolveTxMemo(" mine ", [swapCall("uosmo", ATOM_ON_OSMOSIS)], "osmosis-1")).toBe("mine");
  });

  it("keeps the generic text unless both tokens are proven", () => {
    const generic = `Contract call · ${ZUNIA_WALLET_TAG}`;
    // Either side a voucher nothing names, or anyone's factory/<self>/USDC.n.
    expect(resolveTxMemo("", [swapCall("uosmo", UNLISTED)], "osmosis-1")).toBe(generic);
    expect(resolveTxMemo("", [swapCall(UNLISTED, ATOM_ON_OSMOSIS)], "osmosis-1")).toBe(generic);
    expect(
      resolveTxMemo(
        "",
        [swapCall("factory/osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du/USDC.n", "uosmo")],
        "osmosis-1",
      ),
    ).toBe(generic);
    // Without the signing chain a voucher names nothing, so neither half is said.
    expect(resolveTxMemo("", [swapCall("uosmo", ATOM_ON_OSMOSIS)])).toBe(generic);
    // Not one coin: the contract refuses it, and the memo names nothing.
    expect(resolveTxMemo("", [swapCall("uosmo", ATOM_ON_OSMOSIS, { funds: [] })], "osmosis-1")).toBe(generic);
    expect(
      resolveTxMemo(
        "",
        [
          swapCall("uosmo", ATOM_ON_OSMOSIS, {
            funds: [
              { denom: "uosmo", amount: "1" },
              { denom: USDC_N_ON_OSMOSIS, amount: "1" },
            ],
          }),
        ],
        "osmosis-1",
      ),
    ).toBe(generic);
    // Another call on the same contract keeps its words.
    const call = (msg: unknown): MemoSourceMsg => ({
      typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
      value: { contract: XCS, msg: Buffer.from(JSON.stringify(msg)).toString("base64"), funds: [] },
    });
    expect(resolveTxMemo("", [call({ recover: {} })], "osmosis-1")).toBe(`Recover funds · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [call({ osmosis_swap: {}, recover: {} })], "osmosis-1")).toBe(generic);
    expect(resolveTxMemo("", [call({ set_route: {} })], "osmosis-1")).toBe(generic);
  });

  it("reads the call and writes nothing to it", () => {
    const msg = deepFreeze(swapCall("uosmo", ATOM_ON_OSMOSIS));
    const before = JSON.stringify(msg);
    expect(resolveTxMemo("", [msg], "osmosis-1")).toBe(`Swap OSMO to ATOM · ${ZUNIA_WALLET_TAG}`);
    expect(JSON.stringify(msg)).toBe(before);
  });

  it("leaves the packet memo path as it was: a swap over IBC names what leaves", () => {
    const msg = JSON.parse(XCS_TRANSFER) as MemoSourceMsg;
    expect(resolveTxMemo("", [msg], "cosmoshub-4")).toBe(`Swap ATOM · ${ZUNIA_WALLET_TAG}`);
  });
});

describe("a swap with Zunia's fee signed after it", () => {
  const TREASURY_OSMO = bech32.encode("osmo", bech32.toWords(new Uint8Array(20).fill(0x5a)));
  const TREASURY_HUB = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(0x5a)));
  const fee = (sender: string, recipient: string, denom: string, amount: bigint) =>
    buildSwapFeeMsg({ sender, recipient, denom, amount }) as MemoSourceMsg;

  it("names the swap, never the fee: 'Swap OSMO to ATOM', 'Swap ATOM'", () => {
    const call = swapCall("uosmo", ATOM_ON_OSMOSIS, { funds: [{ denom: "uosmo", amount: "62685000" }] });
    const osmoFee = fee("osmo1sender00000000000000000000000000000000", TREASURY_OSMO, "uosmo", 315_000n);
    expect(resolveTxMemo("", [call, osmoFee], "osmosis-1")).toBe(`Swap OSMO to ATOM · ${ZUNIA_WALLET_TAG}`);
    // The same memo as the swap alone: the fee changes nothing in it.
    expect(resolveTxMemo("", [call, osmoFee], "osmosis-1")).toBe(resolveTxMemo("", [call], "osmosis-1"));
    // On its own the fee would read as a send; beside the swap it is not named.
    expect(resolveTxMemo("", [osmoFee], "osmosis-1")).toBe(`Send OSMO · ${ZUNIA_WALLET_TAG}`);

    const transfer = JSON.parse(XCS_TRANSFER) as MemoSourceMsg;
    const hubFee = fee("cosmos1sender0000000000000000000000000000000", TREASURY_HUB, "uatom", 5_000n);
    expect(resolveTxMemo("", [transfer, hubFee], "cosmoshub-4")).toBe(`Swap ATOM · ${ZUNIA_WALLET_TAG}`);
    // A swap the memo cannot name keeps its generic words; the fee never stands in for it.
    const unnamed = swapCall("uosmo", UNLISTED);
    expect(resolveTxMemo("", [unnamed, osmoFee], "osmosis-1")).toBe(`Contract call · ${ZUNIA_WALLET_TAG}`);
    // A memo the user wrote is kept as it is.
    expect(resolveTxMemo(" mine ", [call, osmoFee], "osmosis-1")).toBe("mine");
  });

  it("reads both messages and writes to neither", () => {
    const msgs = deepFreeze([
      swapCall("uosmo", ATOM_ON_OSMOSIS),
      fee("osmo1sender00000000000000000000000000000000", TREASURY_OSMO, "uosmo", 315_000n),
    ]);
    const before = JSON.stringify(msgs);
    expect(resolveTxMemo("", msgs, "osmosis-1")).toBe(`Swap OSMO to ATOM · ${ZUNIA_WALLET_TAG}`);
    expect(JSON.stringify(msgs)).toBe(before);
  });
});

describe("Earn memos without a chain", () => {
  const stake = (denom: string): MemoSourceMsg => ({ type: "cosmos-sdk/MsgDelegate", value: { amount: { denom } } });

  it("name a stake by the chains whose staking coin the denom is", () => {
    // Only Noble stakes `uusdc`: 0.1.2 wrote Axelar's `USDC.axl` here, and a
    // lookup over every chain listing `uusdc` could only write `Stake`.
    expect(resolveTxMemo("", [stake("uusdc")])).toBe(`Stake USDC.n · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [stake("uusdc")])).toBe(resolveTxMemo("", [stake("uusdc")], "noble-1"));
    // CrossFi's coin keeps the name 0.1.2 wrote, although Mineplex lists `xfi` too.
    expect(resolveTxMemo("", [stake("xfi")])).toBe(`Stake XFI · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [stake("mpx")])).toBe(resolveTxMemo("", [stake("mpx")], "mineplex-mainnet-1"));
    // Terra and Terra Classic both stake `uluna`: no chain, no name.
    expect(resolveTxMemo("", [stake("uluna")])).toBe(`Stake · ${ZUNIA_WALLET_TAG}`);
  });

  it("do not stretch that rule to a send, which any chain listing the denom could sign", () => {
    expect(resolveTxMemo("", [send("uusdc")])).toBe(`Send · ${ZUNIA_WALLET_TAG}`);
    expect(resolveTxMemo("", [transfer("uusdc")])).toBe(`IBC transfer · ${ZUNIA_WALLET_TAG}`);
  });
});

/* -------------------------------------------------------------------------- *
 * What gets signed, through the real kernel
 * -------------------------------------------------------------------------- */

type Core = typeof import("@zunialab/core");

/** The Rust kernel the worker signs with, loaded from its wasm in this process. */
async function loadCore(): Promise<Core> {
  const dir = dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href)) as Core;
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  return core;
}

/** A bech32 address the kernel accepts. */
const address = (prefix: string, fill: number, bytes = 20): string =>
  bech32.encode(prefix, bech32.toWords(new Uint8Array(bytes).fill(fill)));

const hexOf = (text: string): string => Buffer.from(text, "utf8").toString("hex");

describe("the transaction a default memo goes into", () => {
  const PUBKEY = `02${"11".repeat(32)}`;
  const FEE = JSON.stringify({ amount: [{ denom: "uatom", amount: "5000" }], gas_limit: "250000" });

  it("signs the exact denom, amount, channel and packet memo it was given, whatever the memo says", async () => {
    const core = await loadCore();
    const hub = address("cosmos", 1);
    const xcs = address("osmo", 9, 32);
    const osmoSender = address("osmo", 1);
    const noble = address("noble", 5);
    // The 0.1.2 swap leg (ATOM on the Hub into the XCS contract) and an IBC
    // send of Noble USDC from Osmosis with a forward memo, as the planner
    // builds them.
    const cases = [
      {
        chainId: "cosmoshub-4",
        expected: `IBC transfer 1000000 uatom to ${xcs} over channel-141`,
        memoText: `Swap ATOM · ${ZUNIA_WALLET_TAG}`,
        withoutChain: `Swap ATOM · ${ZUNIA_WALLET_TAG}`,
        packetMemo: XCS_PACKET_MEMO,
        msg: {
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            source_port: "transfer",
            source_channel: "channel-141",
            token: { denom: "uatom", amount: "1000000" },
            sender: hub,
            receiver: xcs,
            timeout_height: { revision_number: "0", revision_height: "0" },
            timeout_timestamp: "1791202200000000000",
            memo: XCS_PACKET_MEMO,
          },
        },
      },
      {
        chainId: "osmosis-1",
        expected: `IBC transfer 2500000 ${USDC_N_ON_OSMOSIS} to ${noble} over channel-750`,
        memoText: `IBC forward USDC.n · ${ZUNIA_WALLET_TAG}`,
        // A voucher is named only by the chain that holds it.
        withoutChain: `IBC forward · ${ZUNIA_WALLET_TAG}`,
        packetMemo: '{"forward":{"receiver":"cosmos1pfm","port":"transfer","channel":"channel-536"}}',
        msg: {
          typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
          value: {
            source_port: "transfer",
            source_channel: "channel-750",
            token: { denom: USDC_N_ON_OSMOSIS, amount: "2500000" },
            sender: osmoSender,
            receiver: noble,
            timeout_height: { revision_number: "0", revision_height: "0" },
            timeout_timestamp: "1791202200000000000",
            memo: '{"forward":{"receiver":"cosmos1pfm","port":"transfer","channel":"channel-536"}}',
          },
        },
      },
    ];
    for (const { chainId, expected, memoText, withoutChain, packetMemo, msg } of cases) {
      const pristine = JSON.stringify([msg]);
      const msgs = deepFreeze(JSON.parse(pristine) as MemoSourceMsg[]);
      const memo = resolveTxMemo("", msgs, chainId);
      expect(memo).toBe(memoText);
      // Naming the memo read the messages and wrote nothing to them.
      expect(resolveTxMemo("", msgs)).toBe(withoutChain);
      expect(JSON.stringify(msgs)).toBe(pristine);
      // Unfrozen too, as the screens pass them: a write that a frozen object
      // would have refused in silence shows up here.
      const live = JSON.parse(pristine) as MemoSourceMsg[];
      resolveTxMemo("", live, chainId);
      resolveTxMemo("", live);
      expect(JSON.stringify(live)).toBe(pristine);
      const signed = core.buildSignBytes(chainId, JSON.stringify(msgs), FEE, memo, 1n, 2n, PUBKEY, false, "direct");
      expect(signed).toBe(core.buildSignBytes(chainId, pristine, FEE, memo, 1n, 2n, PUBKEY, false, "direct"));
      // The bytes carry the exact denom, amount and channel, and the packet
      // memo byte for byte; the default memo is the body memo, nothing else.
      const decoded = core.decodeDirectTx(signed);
      expect(decoded.summaries).toEqual([expected]);
      expect(decoded.memo).toBe(memoText);
      expect(signed).toContain(hexOf(packetMemo));
    }
  });

  it("signs a swap and its Zunia fee in one body, the swap first, under the swap's memo", async () => {
    const core = await loadCore();
    const hub = address("cosmos", 1);
    const xcs = address("osmo", 9, 32);
    const treasury = address("cosmos", 0x5a);
    const msgs = [
      {
        typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
        value: {
          source_port: "transfer",
          source_channel: "channel-141",
          token: { denom: "uatom", amount: "995000" },
          sender: hub,
          receiver: xcs,
          timeout_height: { revision_number: "0", revision_height: "0" },
          timeout_timestamp: "1791202200000000000",
          memo: XCS_PACKET_MEMO,
        },
      },
      buildSwapFeeMsg({ sender: hub, recipient: treasury, denom: "uatom", amount: 5_000n }),
    ];
    const memo = resolveTxMemo("", msgs, "cosmoshub-4");
    expect(memo).toBe(`Swap ATOM · ${ZUNIA_WALLET_TAG}`);
    const signed = core.buildSignBytes("cosmoshub-4", JSON.stringify(msgs), FEE, memo, 1n, 2n, PUBKEY, false, "direct");
    const decoded = core.decodeDirectTx(signed);
    // Both messages, in order: the transfer that runs the swap, then the fee.
    expect(decoded.summaries).toEqual([
      `IBC transfer 995000 uatom to ${xcs} over channel-141`,
      `Send 5000 uatom to ${treasury}`,
    ]);
    expect(decoded.memo).toBe(memo);
    expect(signed).toContain(hexOf(XCS_PACKET_MEMO));
  });
});

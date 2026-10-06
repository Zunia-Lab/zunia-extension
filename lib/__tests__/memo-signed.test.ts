import { bech32 } from "@scure/base";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tx-body memo a screen shows is the memo that is signed, and a default
 * memo names the token as the signing chain holds it (`Send USDC.n · by
 * Zunia-wallet` for Noble USDC on Noble, `IBC transfer USDC.n` for its
 * voucher on Osmosis).
 *
 * Both signing paths run for real: lib/tx-kernel.ts (Send's transfers, Swap
 * with its Zunia fee signed after it, NFTs) through the Rust kernel built from
 * its wasm, and lib/wallet-tx.ts (same-chain Send, Earn, Governance) through
 * the amino encoder. Only the network, the session and the settings are stood
 * in for. Each test reads the memo back out of what was signed or broadcast.
 */

const { calls, net, TEST_MNEMONIC } = vi.hoisted(() => ({
  TEST_MNEMONIC:
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  /** The memo each kernel call was handed, in call order. */
  calls: {
    simulate: [] as string[],
    preview: [] as string[],
    sign: [] as string[],
    /** Amino sign docs (hex of their JSON), as wallet-tx signs them. */
    amino: [] as string[],
  },
  net: {
    /** Base64 TxRaw handed to the engine broadcast (tx-kernel). */
    direct: [] as string[],
    /** TxRaw bytes handed to the REST broadcast (wallet-tx). */
    amino: [] as Uint8Array[],
    /** Errors the next REST broadcasts throw, first one first. */
    aminoFailures: [] as Error[],
  },
}));

vi.mock("../kernel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../kernel")>();
  const { readFileSync } = await import("node:fs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  // The Rust kernel the worker signs with, loaded from its wasm in this process.
  const dir = dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(
    /* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href
  )) as typeof import("@zunialab/core");
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  const local = actual.createLocalKernel();
  // Wired the way loadKernel adapts the wasm module: transactions in Rust,
  // keys and amino signatures in the JS kernel.
  const kernel: import("../kernel").ZuniaKernel = {
    ...local,
    status: { flavor: "wasm", version: core.kernelVersion(), canSignTransactions: true },
    signCosmos: (phrase, passphrase, chainJson, accountIndex, signBytesHex) => {
      calls.amino.push(signBytesHex);
      return local.signCosmos(phrase, passphrase, chainJson, accountIndex, signBytesHex);
    },
    buildSignBytes: (...args) => core.buildSignBytes(...args),
    assembleTxRaw: (...args) => core.assembleTxRaw(...args),
    buildSimulateTx: (...args) => {
      calls.simulate.push(args[3]);
      return core.buildSimulateTx(...args);
    },
    signTx: (...args) => {
      calls.sign.push(args[7]);
      return core.signTx(...args);
    },
    previewTx: (...args) => {
      calls.preview.push(args[3]);
      return core.previewTx(...args);
    },
  };
  return { ...actual, loadKernel: async () => kernel };
});

vi.mock("../session", () => ({
  getSessionMnemonic: async () => TEST_MNEMONIC,
  getActiveDerivationIndex: async () => 0,
  touchSession: async () => undefined,
}));

vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return { ...actual, getSettings: async () => actual.DEFAULT_SETTINGS };
});

vi.mock("../signing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../signing")>()),
  rememberRecipient: async () => undefined,
}));

vi.mock("../broadcast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../broadcast")>();
  return {
    ...actual,
    fetchAccountNumberSequence: async () => ({ accountNumber: "7", sequence: "3" }),
    broadcastTx: async (params: { txBytes: Uint8Array | string }) => {
      net.amino.push(params.txBytes as Uint8Array);
      const failure = net.aminoFailures.shift();
      if (failure) throw failure;
      return { txhash: "A1B2", code: 0, rawLog: "", success: true };
    },
    waitForInclusion: async (_chainId: string, txhash: string) => ({
      txhash,
      code: 0,
      rawLog: "",
      success: true,
    }),
  };
});

vi.mock("@zunialab/interchain", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@zunialab/interchain")>();
  return {
    ...actual,
    getAccount: async (_lcd: unknown, _chainId: string, address: string) => ({
      address,
      accountNumber: "7",
      sequence: "3",
      pubKey: null,
    }),
    simulate: async () => "100000",
    broadcast: async (_post: unknown, _chainId: string, txBytesBase64: string) => {
      net.direct.push(txBytesBase64);
      return { txHash: "C3D4", code: 0, success: true, rawLog: "", codespace: "", failure: null };
    },
    waitForTx: async () => ({ code: 0, rawLog: "" }),
  };
});

import { msgDelegate, msgUndelegate, msgVote, msgWithdrawReward, type AminoMsg, type StdFee } from "../amino-tx";
import { CHAIN_CATALOG } from "../chain-catalog";
import { chainJsonFor } from "../chains";
import { createLocalKernel } from "../kernel";
import { buildPoolSwapMsg } from "../pool-swap";
import { buildSwapFeeMsg } from "../swap-fee";
import { identityOf } from "../token-identity";
import { previewTx, signAndBroadcastTx, type TxPreview, type TxRequest } from "../tx-kernel";
import { ZUNIA_WALLET_TAG, resolveTxMemo, type MemoSourceMsg } from "../tx-memo";
import { signAndBroadcast } from "../wallet-tx";
import {
  sameChainMemo,
  sameChainMsgs,
  transferMemo,
  type ReviewedSend,
} from "../../entrypoints/popup/screens/SendScreen";

/** Noble USDC on Osmosis (`transfer/channel-750/uusdc`). */
const USDC_N_ON_OSMOSIS = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
/** A voucher nothing names. */
const UNLISTED = `ibc/${"0123456789ABCDEF".repeat(4)}`;

const tagged = (phrase: string) => `${phrase} · ${ZUNIA_WALLET_TAG}`;

const addresses = new Map<string, string>();

/** The wallet's own address on a chain, as the worker derives it from the session. */
function addressOn(chainId: string): string {
  let address = addresses.get(chainId);
  if (!address) {
    address = createLocalKernel().deriveAddress(TEST_MNEMONIC, "", chainJsonFor(chainId), 0).bech32Address;
    addresses.set(chainId, address);
  }
  return address;
}

/** Someone else on the same chain. */
function otherOn(chainId: string): string {
  const { prefix } = bech32.decode(addressOn(chainId) as `${string}1${string}`);
  return bech32.encode(prefix, bech32.toWords(new Uint8Array(20).fill(7)));
}

/** A test Zunia treasury on a chain, with that chain's own prefix. */
function treasuryOn(chainId: string): string {
  const { prefix } = bech32.decode(addressOn(chainId) as `${string}1${string}`);
  return bech32.encode(prefix, bech32.toWords(new Uint8Array(20).fill(0x5a)));
}

/** The Osmosis crosschain-swaps contract, as a 32-byte contract address. */
const XCS = bech32.encode("osmo", bech32.toWords(new Uint8Array(32).fill(9)));
const XCS_PACKET_MEMO = JSON.stringify({
  wasm: {
    contract: XCS,
    msg: {
      osmosis_swap: {
        output_denom: "uosmo",
        slippage: { twap: { slippage_percentage: "1", window_seconds: 10 } },
        receiver: "osmo1sender00000000000000000000000000000000",
        on_failed_delivery: "do_nothing",
      },
    },
  },
});

function transfer(fromChainId: string, channel: string, denom: string, receiver: string, packetMemo = "") {
  return {
    typeUrl: "/ibc.applications.transfer.v1.MsgTransfer",
    value: {
      source_port: "transfer",
      source_channel: channel,
      token: { denom, amount: "2500000" },
      sender: addressOn(fromChainId),
      receiver,
      timeout_height: { revision_number: "0", revision_height: "0" },
      timeout_timestamp: "1791202200000000000",
      memo: packetMemo,
    },
  };
}

/** ATOM on Osmosis (`transfer/channel-0/uatom`). */
const ATOM_ON_OSMOSIS = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
/** Injective's USDC on Osmosis (`transfer/channel-122/erc20:0xa00C…`). */
const USDC_INJ_ON_OSMOSIS = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";

/**
 * Swap's venue-origin message: funds already on `chainId` paid straight to
 * the crosschain-swaps contract in one `MsgExecuteContract`, its ExecuteMsg in
 * base64, as the planner builds it.
 */
function swapCall(chainId: string, sold: string, bought: string, receiver: string) {
  const body = {
    osmosis_swap: {
      output_denom: bought,
      slippage: { twap: { slippage_percentage: "1", window_seconds: 10 } },
      receiver,
      on_failed_delivery: { local_recovery_addr: addressOn(chainId) },
      next_memo: null,
    },
  };
  return {
    typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
    value: {
      sender: addressOn(chainId),
      contract: XCS,
      msg: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
      funds: [{ denom: sold, amount: "63000000" }],
    },
  };
}

function bankSend(chainId: string, denom: string) {
  return {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: {
      from_address: addressOn(chainId),
      to_address: otherOn(chainId),
      amount: [{ denom, amount: "1000000" }],
    },
  };
}

const hexOf = (text: string) => Buffer.from(text, "utf8").toString("hex");
const directTxHex = (index: number) => Buffer.from(net.direct[index] ?? "", "base64").toString("hex");
const aminoTxHex = (index: number) => Buffer.from(net.amino[index] ?? new Uint8Array()).toString("hex");
/** The memo inside an amino sign doc the JS kernel signed. */
const aminoMemo = (index: number) =>
  (JSON.parse(Buffer.from(calls.amino[index] ?? "", "hex").toString("utf8")) as { memo: string }).memo;

/**
 * What every confirm screen on the kernel path sends back to sign: the
 * preview's own numbers and memo. `memo: null` leaves the memo out.
 */
function signRequest(request: TxRequest, preview: TxPreview, memo: string | null = preview.preview.memo) {
  return {
    chainId: request.chainId,
    signerAddress: request.signerAddress,
    msgs: request.msgs,
    ...(memo === null ? {} : { memo }),
    fee: preview.fee,
    accountNumber: preview.accountNumber,
    sequence: preview.sequence,
    expectSignBytesHash: preview.preview.signBytesHash,
  };
}

beforeEach(() => {
  for (const list of Object.values(calls)) list.length = 0;
  net.direct.length = 0;
  net.amino.length = 0;
  net.aminoFailures.length = 0;
});

/* -------------------------------------------------------------------------- *
 * The kernel path: Swap, NFTs and Send's transfers
 * -------------------------------------------------------------------------- */

describe("tx-kernel: a default memo names the token on the signing chain, and is the memo signed", () => {
  const cases = [
    {
      what: "Noble USDC held on Osmosis, sent home",
      chainId: "osmosis-1",
      msg: () => transfer("osmosis-1", "channel-750", USDC_N_ON_OSMOSIS, addressOn("noble-1")),
      memo: tagged("IBC transfer USDC.n"),
      chainBlind: tagged("IBC transfer"),
    },
    {
      what: "Noble USDC swapped through the crosschain-swaps contract (Swap)",
      chainId: "noble-1",
      msg: () => transfer("noble-1", "channel-1", "uusdc", XCS, XCS_PACKET_MEMO),
      memo: tagged("Swap USDC.n"),
      // `uusdc` is Noble's and Axelar's: without the chain it names neither.
      chainBlind: tagged("Swap"),
    },
    {
      what: "OSMO swapped into ATOM by the crosschain-swaps contract, from funds already on Osmosis",
      chainId: "osmosis-1",
      msg: () => swapCall("osmosis-1", "uosmo", ATOM_ON_OSMOSIS, addressOn("cosmoshub-4")),
      memo: tagged("Swap OSMO to ATOM"),
      // ATOM on Osmosis is a voucher: without the chain, neither token is named.
      chainBlind: tagged("Contract call"),
    },
    {
      what: "a bank send of Noble USDC on Noble",
      chainId: "noble-1",
      msg: () => bankSend("noble-1", "uusdc"),
      memo: tagged("Send USDC.n"),
      chainBlind: tagged("Send"),
    },
    {
      what: "a voucher nothing proves",
      chainId: "osmosis-1",
      msg: () => transfer("osmosis-1", "channel-750", UNLISTED, addressOn("noble-1")),
      memo: tagged("IBC transfer"),
      chainBlind: tagged("IBC transfer"),
    },
  ];

  it.each(cases)("$what: shown and signed as `$memo`", async ({ chainId, msg, memo, chainBlind }) => {
    const request: TxRequest = { chainId, signerAddress: addressOn(chainId), msgs: [msg()] };
    // Why the chain is passed: the same messages, named without it.
    expect(resolveTxMemo("", request.msgs)).toBe(chainBlind);

    // Swap and NFT send no memo: the worker writes the default.
    const preview = await previewTx(request);
    expect(preview.preview.memo).toBe(memo);
    // Simulated, previewed and (below) signed with the same text.
    expect(calls.simulate).toEqual([memo]);
    expect(calls.preview).toEqual([memo]);

    // The confirm screens show `preview.preview.memo` and sign with it.
    const result = await signAndBroadcastTx(signRequest(request, preview));
    expect(result.success).toBe(true);
    expect(calls.sign).toEqual([memo]);
    expect(net.direct).toHaveLength(1);
    expect(directTxHex(0)).toContain(hexOf(memo));
    // The packet memo travels on the message, byte for byte, untouched; so
    // does a contract call's ExecuteMsg, which the body carries as raw bytes.
    const packetMemo = (request.msgs[0]?.value as { memo?: string }).memo;
    if (packetMemo) expect(directTxHex(0)).toContain(hexOf(packetMemo));
    const executeMsg = (request.msgs[0]?.value as { msg?: unknown }).msg;
    if (typeof executeMsg === "string") {
      expect(directTxHex(0)).toContain(Buffer.from(executeMsg, "base64").toString("hex"));
    }
  });

  it.each([
    {
      what: "OSMO swapped into ATOM from funds on Osmosis, Zunia's fee signed after the call",
      chainId: "osmosis-1",
      swap: () => swapCall("osmosis-1", "uosmo", ATOM_ON_OSMOSIS, addressOn("cosmoshub-4")),
      fee: { denom: "uosmo", amount: 315_000n },
      memo: tagged("Swap OSMO to ATOM"),
    },
    {
      what: "Noble USDC swapped over IBC, Zunia's fee paid on Noble after the transfer",
      chainId: "noble-1",
      swap: () => transfer("noble-1", "channel-1", "uusdc", XCS, XCS_PACKET_MEMO),
      fee: { denom: "uusdc", amount: 12_500n },
      memo: tagged("Swap USDC.n"),
    },
  ])("$what: one transaction, shown and signed as `$memo`", async ({ chainId, swap, fee, memo }) => {
    const treasury = treasuryOn(chainId);
    const msgs = [swap(), buildSwapFeeMsg({ sender: addressOn(chainId), recipient: treasury, ...fee })];
    const request: TxRequest = { chainId, signerAddress: addressOn(chainId), msgs };
    // The memo names the swap, exactly as for the swap alone.
    expect(resolveTxMemo("", msgs, chainId)).toBe(resolveTxMemo("", [msgs[0]!], chainId));

    const preview = await previewTx(request);
    expect(preview.preview.memo).toBe(memo);
    // Simulated with both messages, so the gas covers the fee's send too.
    expect(calls.simulate).toEqual([memo]);
    expect(calls.preview).toEqual([memo]);
    // The confirm screen lists the kernel's lines for both, the swap first.
    expect(preview.preview.summaries).toHaveLength(2);
    expect(preview.preview.summaries[1]).toBe(`Send ${fee.amount} ${fee.denom} to ${treasury}`);

    const result = await signAndBroadcastTx(signRequest(request, preview));
    expect(result.success).toBe(true);
    expect(calls.sign).toEqual([memo]);
    expect(net.direct).toHaveLength(1);
    // One body: the swap's bytes (its packet memo or its ExecuteMsg), then the
    // fee's recipient and amount, under the one memo.
    const tx = directTxHex(0);
    expect(tx).toContain(hexOf(memo));
    const packetMemo = (msgs[0]?.value as { memo?: string }).memo;
    if (packetMemo) expect(tx).toContain(hexOf(packetMemo));
    const executeMsg = (msgs[0]?.value as { msg?: unknown }).msg;
    if (typeof executeMsg === "string") expect(tx).toContain(Buffer.from(executeMsg, "base64").toString("hex"));
    expect(tx).toContain(hexOf(treasury));
    expect(tx.indexOf(hexOf(treasury))).toBeGreaterThan(tx.indexOf(hexOf(XCS)));
  });

  it.each([
    {
      what: "OSMO swapped into USDC.inj in Osmosis's own pools, split over two routes",
      split: true,
      deliver: false,
    },
    {
      what: "USDC.inj swapped into OSMO in Osmosis's own pools, one route through two pools",
      split: false,
      deliver: false,
    },
    {
      what: "OSMO swapped into USDC.inj in Osmosis's pools, then its floor sent home to Injective",
      split: true,
      deliver: true,
    },
  ])("$what: the swap, the fee and any transfer in one transaction, signed by the kernel", async ({ split, deliver }) => {
    const chainId = "osmosis-1";
    const me = addressOn(chainId);
    const treasury = treasuryOn(chainId);
    const sold = split ? "uosmo" : USDC_INJ_ON_OSMOSIS;
    const routes = split
      ? [
          { hops: [{ poolId: "3498", tokenOutDenom: USDC_INJ_ON_OSMOSIS }], inAmount: "5970000" },
          { hops: [{ poolId: "3586", tokenOutDenom: USDC_INJ_ON_OSMOSIS }], inAmount: "3980000" },
        ]
      : [
          {
            hops: [
              { poolId: "3497", tokenOutDenom: USDC_N_ON_OSMOSIS },
              { poolId: "1464", tokenOutDenom: "uosmo" },
            ],
            inAmount: "9950000",
          },
        ];
    const floor = split ? "349331" : "280000000";
    const homeTransfer = transfer(chainId, "channel-122", USDC_INJ_ON_OSMOSIS, addressOn("injective-1"));
    const msgs = [
      buildPoolSwapMsg({ sender: me, denom: sold, routes, minOut: floor }),
      buildSwapFeeMsg({ sender: me, recipient: treasury, denom: sold, amount: 50_000n }),
      ...(deliver
        ? [{ ...homeTransfer, value: { ...homeTransfer.value, token: { denom: USDC_INJ_ON_OSMOSIS, amount: floor } } }]
        : []),
    ];
    const memo = tagged(split ? "Swap OSMO to USDC.inj" : "Swap USDC.inj to OSMO");
    const request: TxRequest = { chainId, signerAddress: me, msgs };
    expect(resolveTxMemo("", msgs, chainId)).toBe(memo);

    const preview = await previewTx(request);
    expect(preview.preview.memo).toBe(memo);
    expect(calls.simulate).toEqual([memo]);
    // The kernel describes each message itself, the swap first, by its pools.
    expect(preview.preview.summaries).toHaveLength(msgs.length);
    expect(preview.preview.summaries[0]).toContain(split ? "3498" : "3497");
    expect(preview.preview.summaries[0]).toContain(floor);
    expect(preview.preview.summaries[1]).toBe(`Send 50000 ${sold} to ${treasury}`);

    const result = await signAndBroadcastTx(signRequest(request, preview));
    expect(result.success).toBe(true);
    expect(calls.sign).toEqual([memo]);
    const tx = directTxHex(0);
    const typeUrl = split
      ? "/osmosis.poolmanager.v1beta1.MsgSplitRouteSwapExactAmountIn"
      : "/osmosis.poolmanager.v1beta1.MsgSwapExactAmountIn";
    expect(tx).toContain(hexOf(typeUrl));
    expect(tx).toContain(hexOf(floor));
    // The swap first, then the fee, then the transfer that spends the swap's output.
    expect(tx.indexOf(hexOf(treasury))).toBeGreaterThan(tx.indexOf(hexOf(typeUrl)));
    if (deliver) {
      expect(tx.indexOf(hexOf("channel-122"))).toBeGreaterThan(tx.indexOf(hexOf(treasury)));
    }
  });

  it("refuses, in the kernel itself, a fee to another chain's address, and broadcasts nothing", async () => {
    // A Hub address on Osmosis: what a fee to a wrong-chain treasury would be.
    // The release test and lib/swap-fee.ts keep one from being configured; the
    // kernel refuses it at signing all the same.
    const chainId = "osmosis-1";
    const wrongChain = treasuryOn("cosmoshub-4");
    const request: TxRequest = {
      chainId,
      signerAddress: addressOn(chainId),
      msgs: [
        swapCall(chainId, "uosmo", ATOM_ON_OSMOSIS, addressOn("cosmoshub-4")),
        buildSwapFeeMsg({ sender: addressOn(chainId), recipient: wrongChain, denom: "uosmo", amount: 315_000n }),
      ],
    };
    const preview = await previewTx(request);
    await expect(signAndBroadcastTx(signRequest(request, preview))).rejects.toThrow(/invalid for this chain/);
    expect(net.direct).toEqual([]);
  });

  it("names the same default at both ends when the screen sends no memo to sign either", async () => {
    // A caller that leaves the memo out at both calls gets the chain-aware
    // default at both, so the sign-bytes hash still matches. Were one end
    // chain-blind, this would read `IBC transfer` on one side and refuse.
    const request: TxRequest = {
      chainId: "osmosis-1",
      signerAddress: addressOn("osmosis-1"),
      msgs: [transfer("osmosis-1", "channel-750", USDC_N_ON_OSMOSIS, addressOn("noble-1"))],
    };
    const preview = await previewTx(request);
    const sign = signRequest(request, preview, null);
    expect("memo" in sign).toBe(false);
    await expect(signAndBroadcastTx(sign)).resolves.toMatchObject({ success: true });
    expect(calls.sign).toEqual([tagged("IBC transfer USDC.n")]);
    expect(directTxHex(0)).toContain(hexOf(tagged("IBC transfer USDC.n")));
  });

  it("refuses to sign a memo other than the one previewed, and broadcasts nothing", async () => {
    const request: TxRequest = {
      chainId: "noble-1",
      signerAddress: addressOn("noble-1"),
      msgs: [bankSend("noble-1", "uusdc")],
    };
    const preview = await previewTx(request);
    await expect(signAndBroadcastTx(signRequest(request, preview, tagged("Send")))).rejects.toThrow(
      /changed between the approval screen and signing/,
    );
    expect(calls.sign).toEqual([]);
    expect(net.direct).toEqual([]);
  });

  it("keeps a memo the user wrote, trimmed, at both ends", async () => {
    const request: TxRequest = {
      chainId: "noble-1",
      signerAddress: addressOn("noble-1"),
      msgs: [bankSend("noble-1", "uusdc")],
      memo: "  invoice 42  ",
    };
    const preview = await previewTx(request);
    expect(preview.preview.memo).toBe("invoice 42");
    await signAndBroadcastTx(signRequest(request, preview));
    expect(calls.sign).toEqual(["invoice 42"]);
  });

  it("Send's transfer review: the memo it previews, shows and signs is one text", async () => {
    const chainId = "osmosis-1";
    const msgs = [transfer(chainId, "channel-750", USDC_N_ON_OSMOSIS, addressOn("noble-1"))];
    // As SendScreen.review() asks for its preview.
    const request: TxRequest = {
      chainId,
      signerAddress: addressOn(chainId),
      msgs,
      memo: resolveTxMemo("", msgs, chainId),
    };
    const preview = await previewTx(request);
    // The confirm screen's Memo row, which the sign button hands over as it is.
    const shown = transferMemo(preview, msgs, chainId);
    expect(shown).toBe(tagged("IBC transfer USDC.n"));
    await signAndBroadcastTx(signRequest(request, preview, shown));
    expect(calls.sign).toEqual([shown]);
    expect(directTxHex(0)).toContain(hexOf(shown));
    // Without a preview memo, the same chain-aware default.
    expect(transferMemo(null, msgs, chainId)).toBe(shown);
  });
});

/* -------------------------------------------------------------------------- *
 * The amino path: same-chain Send, Earn and Governance
 * -------------------------------------------------------------------------- */

const FEE: StdFee = { amount: [{ denom: "uusdc", amount: "5000" }], gas: "200000" };

async function signAmino(chainId: string, msgs: AminoMsg[], memo?: string) {
  return signAndBroadcast({
    chainId,
    signerAddress: addressOn(chainId),
    msgs,
    ...(memo === undefined ? {} : { memo }),
    fee: FEE,
    gasLimit: 200_000,
  });
}

function reviewed(chainId: string, denom: string): ReviewedSend {
  return { chainId, denom, identity: identityOf(chainId, denom), units: 1_500_000n };
}

describe("wallet-tx: the memo a screen shows is the one signed", () => {
  it.each([
    ["noble-1", "uusdc", tagged("Send USDC.n")],
    ["osmosis-1", USDC_N_ON_OSMOSIS, tagged("Send USDC.n")],
    ["osmosis-1", "uosmo", tagged("Send OSMO")],
    ["osmosis-1", UNLISTED, tagged("Send")],
  ])("same-chain Send of %s %s: `%s`", async (chainId, denom, memo) => {
    const review = reviewed(chainId, denom);
    const from = addressOn(chainId);
    const to = otherOn(chainId);
    // The confirm screen's Memo row; the sign button passes it as it is.
    const shown = sameChainMemo("", from, to, review);
    expect(shown).toBe(memo);
    const result = await signAmino(chainId, sameChainMsgs(from, to, review), shown);
    expect(result.signDoc.memo).toBe(shown);
    expect(aminoMemo(0)).toBe(shown);
    expect(aminoTxHex(0)).toContain(hexOf(shown));
  });

  it("same-chain Send keeps the user's memo, trimmed, and signs it", async () => {
    const review = reviewed("noble-1", "uusdc");
    const from = addressOn("noble-1");
    const to = otherOn("noble-1");
    const shown = sameChainMemo("  rent  ", from, to, review);
    expect(shown).toBe("rent");
    const result = await signAmino("noble-1", sameChainMsgs(from, to, review), shown);
    expect(result.signDoc.memo).toBe("rent");
    expect(aminoMemo(0)).toBe("rent");
  });

  it("a blank memo gets the default that names the coin as the signing chain holds it", async () => {
    const review = reviewed("noble-1", "uusdc");
    const msgs = sameChainMsgs(addressOn("noble-1"), otherOn("noble-1"), review);
    const result = await signAmino("noble-1", msgs, "");
    expect(result.signDoc.memo).toBe(tagged("Send USDC.n"));
    // What the screen would have shown for the same send.
    expect(result.signDoc.memo).toBe(sameChainMemo("", addressOn("noble-1"), otherOn("noble-1"), review));
  });

  it("a retry after a sequence mismatch signs the same memo", async () => {
    net.aminoFailures.push(new Error("account sequence mismatch, expected 4, got 3: incorrect account sequence"));
    const review = reviewed("osmosis-1", USDC_N_ON_OSMOSIS);
    const msgs = sameChainMsgs(addressOn("osmosis-1"), otherOn("osmosis-1"), review);
    const result = await signAmino("osmosis-1", msgs);
    expect(result.signDoc.sequence).toBe("4");
    expect(calls.amino).toHaveLength(2);
    expect([aminoMemo(0), aminoMemo(1)]).toEqual([tagged("Send USDC.n"), tagged("Send USDC.n")]);
  });

  it.each([
    ["noble-1", tagged("Stake USDC.n")],
    ["phoenix-1", tagged("Stake LUNA")],
    ["columbus-5", tagged("Stake LUNC")],
    ["cosmoshub-4", tagged("Stake ATOM")],
  ])("Earn on %s: the sheet shows and signs `%s`", async (chainId, memo) => {
    const denom = CHAIN_CATALOG.find((entry) => entry.chainId === chainId)?.coinMinimalDenom ?? "";
    // The delegate sheet's Memo row, as EarnScreen builds it.
    const shown = resolveTxMemo("", [{ type: "cosmos-sdk/MsgDelegate", value: { amount: { denom } } }], chainId);
    expect(shown).toBe(memo);
    // runBroadcast's payload for the same stake.
    const msgs = [
      msgDelegate({
        delegatorAddress: addressOn(chainId),
        validatorAddress: otherOn(chainId),
        amount: { denom, amount: "1000000" },
      }),
    ];
    const result = await signAmino(chainId, msgs, resolveTxMemo("", msgs, chainId));
    expect(result.signDoc.memo).toBe(shown);
    expect(aminoTxHex(0)).toContain(hexOf(shown));
  });

  it("Governance: the vote line shows and signs the same memo, which names no token", async () => {
    const vote = (voter: string) => [msgVote({ proposalId: "42", voter, option: "yes" })];
    // The footer line is built before the address is known ("").
    const shown = resolveTxMemo("", vote(""), "cosmoshub-4");
    expect(shown).toBe(tagged("Vote Yes on #42"));
    expect(resolveTxMemo("", vote(""))).toBe(shown);
    const msgs = vote(addressOn("cosmoshub-4"));
    const result = await signAmino("cosmoshub-4", msgs, resolveTxMemo("", msgs, "cosmoshub-4"));
    expect(result.signDoc.memo).toBe(shown);
  });
});

/* -------------------------------------------------------------------------- *
 * Earn and Governance on every bundled chain
 * -------------------------------------------------------------------------- */

describe("Earn and Governance memos on every bundled chain", () => {
  const ME = "addr";
  const VALIDATOR = "valoper";

  /** What a sheet shows: the message type and the chain's staking coin, nothing else. */
  const sheet = (type: string, denom: string): MemoSourceMsg[] => [{ type, value: { amount: { denom } } }];

  it("the memo a staking sheet shows is the memo its message signs", () => {
    for (const entry of CHAIN_CATALOG) {
      const denom = entry.coinMinimalDenom;
      const coin = { denom, amount: "123456789" };
      const pairs: [MemoSourceMsg[], MemoSourceMsg[]][] = [
        [
          sheet("cosmos-sdk/MsgDelegate", denom),
          [msgDelegate({ delegatorAddress: ME, validatorAddress: VALIDATOR, amount: coin })],
        ],
        [
          sheet("cosmos-sdk/MsgUndelegate", denom),
          [msgUndelegate({ delegatorAddress: ME, validatorAddress: VALIDATOR, amount: coin })],
        ],
        [
          [{ type: "cosmos-sdk/MsgWithdrawDelegationReward", value: {} }],
          [1, 2, 3].map((n) => msgWithdrawReward({ delegatorAddress: ME, validatorAddress: `${VALIDATOR}${n}` })),
        ],
      ];
      for (const [shown, signed] of pairs) {
        expect(resolveTxMemo("", shown, entry.chainId), entry.chainId).toBe(
          resolveTxMemo("", signed, entry.chainId),
        );
      }
    }
  });

  it("naming by chain changes a staking memo only where the old one named the wrong token", () => {
    const changed: Record<string, [string, string]> = {};
    for (const entry of CHAIN_CATALOG) {
      const msgs = sheet("cosmos-sdk/MsgDelegate", entry.coinMinimalDenom);
      const before = resolveTxMemo("", msgs);
      const after = resolveTxMemo("", msgs, entry.chainId);
      if (before !== after) changed[entry.chainId] = [before, after];
    }
    expect(changed).toEqual({
      // Terra 2.0 stakes LUNA; LUNC is Terra Classic's. Without the chain the
      // two (and Classic's testnet) cannot be told apart, so none was named.
      "phoenix-1": [tagged("Stake"), tagged("Stake LUNA")],
      "columbus-5": [tagged("Stake"), tagged("Stake LUNC")],
      "rebel-2": [tagged("Stake"), tagged("Stake LUNC")],
      // Testnets were named by their mainnet's listing; each now by its own.
      "athens_7001-1": [tagged("Stake ZETA"), tagged("Stake tZETA")],
      "bbn-test-6": [tagged("Stake BABY"), tagged("Stake tBABY")],
      "bzetestnet-3": [tagged("Stake BZE"), tagged("Stake TBZE")],
      "grand-1": [tagged("Stake USDC.n"), tagged("Stake USDC")],
      "injective-888": [tagged("Stake INJ"), tagged("Stake INJ (Testnet)")],
      "ShareRing-KUD": [tagged("Stake shr"), tagged("Stake SHR")],
      "xion-testnet-2": [tagged("Stake VERONA"), tagged("Stake XION")],
    });
    // On every other mainnet the staking memo reads exactly as before.
    const mainnets = Object.keys(changed).filter(
      (chainId) => CHAIN_CATALOG.find((entry) => entry.chainId === chainId)?.network === "mainnet",
    );
    expect(mainnets.sort()).toEqual(["columbus-5", "phoenix-1"]);
  });

  it("claim and vote memos name no token, so the chain changes nothing", () => {
    for (const entry of CHAIN_CATALOG) {
      const claim: MemoSourceMsg[] = [{ type: "cosmos-sdk/MsgWithdrawDelegationReward", value: {} }];
      expect(resolveTxMemo("", claim, entry.chainId)).toBe(tagged("Claim rewards"));
      const vote = [msgVote({ proposalId: "7", voter: ME, option: "veto" })];
      expect(resolveTxMemo("", vote, entry.chainId)).toBe(resolveTxMemo("", vote));
    }
  });
});

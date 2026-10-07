#!/usr/bin/env node
/**
 * Writes lib/__tests__/fixtures/amino-summaries.json: one message per entry, in both encodings a
 * dApp can ask Zunia to sign, both made by the reference libraries and never by hand.
 *
 * - The protobuf comes from the cosmjs-types and osmojs encoders, wrapped into a direct
 *   `SignDoc` by CosmJS (`makeSignBytes`). The kernel decodes it in direct mode.
 * - The Amino `{type, value}` comes from the converter a CosmJS client registers for the type
 *   URL: `@cosmjs/stargate` 0.32.3's defaults for the Cosmos SDK and IBC messages (cross-checked
 *   against osmojs's own converters), osmojs 16.15's for the poolmanager swaps and for
 *   `MsgExecuteContract`.
 *
 * gov v1 has no converter in either library. Its Amino value is the v1beta1 converter's value
 * for the same fields under `cosmos-sdk/v1/MsgVote`, with `metadata` when it is not empty: what
 * x/gov v1 registers, and what interchainjs's telescope converter writes (checked when
 * INTERCHAINJS points at an install of it).
 *
 * lib/__tests__/amino-summary.test.ts reads each entry and requires the amino prompt to say
 * what the real kernel says for the direct bytes.
 *
 * The libraries are the ones zunia-core's vector generator pins. Install them once, then run
 * this from the extension root:
 *
 *   pnpm -C ../zunia-core/tests/vectors/generate install
 *   node scripts/generate-amino-summaries.mjs
 */

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REFERENCE = resolve(process.env.REFERENCE_DIR ?? join(ROOT, "../zunia-core/tests/vectors/generate"));
const ref = createRequire(join(REFERENCE, "package.json"));
const versionOf = (name) => ref(`${name}/package.json`).version;

const EXPECTED = { "@cosmjs/stargate": "0.32.3", osmojs: "16.15.0" };
for (const [name, version] of Object.entries(EXPECTED)) {
  if (versionOf(name) !== version) {
    throw new Error(`${name} is ${versionOf(name)} in ${REFERENCE}; this fixture is made with ${version}`);
  }
}

const { DirectSecp256k1HdWallet, makeSignDoc, makeSignBytes } = ref("@cosmjs/proto-signing");
const { sha256 } = ref("@cosmjs/crypto");
const { fromBech32, toBech32, toBase64, toHex, toUtf8 } = ref("@cosmjs/encoding");
const { AminoTypes, createDefaultAminoConverters } = ref("@cosmjs/stargate");
const { TxBody, AuthInfo, SignerInfo, Fee } = ref("cosmjs-types/cosmos/tx/v1beta1/tx.js");
const { PubKey } = ref("cosmjs-types/cosmos/crypto/secp256k1/keys.js");
const { Any } = ref("cosmjs-types/google/protobuf/any.js");
const { MsgSend } = ref("cosmjs-types/cosmos/bank/v1beta1/tx.js");
const { MsgDelegate, MsgUndelegate, MsgBeginRedelegate } = ref("cosmjs-types/cosmos/staking/v1beta1/tx.js");
const { MsgWithdrawDelegatorReward } = ref("cosmjs-types/cosmos/distribution/v1beta1/tx.js");
const { MsgVote } = ref("cosmjs-types/cosmos/gov/v1beta1/tx.js");
const { MsgVote: GovV1Vote } = ref("cosmjs-types/cosmos/gov/v1/tx.js");
const { MsgTransfer } = ref("cosmjs-types/ibc/applications/transfer/v1/tx.js");
const osmojs = (path) => ref(`osmojs/${path}`);
const poolmanager = osmojs("osmosis/poolmanager/v1beta1/tx.js");
const { AminoConverter: PoolmanagerAmino } = osmojs("osmosis/poolmanager/v1beta1/tx.amino.js");
const { MsgExecuteContract } = osmojs("cosmwasm/wasm/v1/tx.js");
const { AminoConverter: WasmAmino } = osmojs("cosmwasm/wasm/v1/tx.amino.js");
/** osmojs's own encoders for the CosmJS-converted types, to cross-check the Amino value. */
const OSMOJS_TWINS = {
  [MsgSend.typeUrl]: osmojs("cosmos/bank/v1beta1/tx.js").MsgSend,
  [MsgDelegate.typeUrl]: osmojs("cosmos/staking/v1beta1/tx.js").MsgDelegate,
  [MsgUndelegate.typeUrl]: osmojs("cosmos/staking/v1beta1/tx.js").MsgUndelegate,
  [MsgBeginRedelegate.typeUrl]: osmojs("cosmos/staking/v1beta1/tx.js").MsgBeginRedelegate,
  [MsgWithdrawDelegatorReward.typeUrl]: osmojs("cosmos/distribution/v1beta1/tx.js").MsgWithdrawDelegatorReward,
  [MsgVote.typeUrl]: osmojs("cosmos/gov/v1beta1/tx.js").MsgVote,
  [MsgTransfer.typeUrl]: osmojs("ibc/applications/transfer/v1/tx.js").MsgTransfer,
};

// The public all-abandon test key, for the signer's own addresses and public key.
const MNEMONIC = `${"abandon ".repeat(11)}about`;
const wallet = await DirectSecp256k1HdWallet.fromMnemonic(MNEMONIC, { prefix: "cosmos" });
const [account] = await wallet.getAccounts();
const KEY = fromBech32(account.address).data;
const HUB = account.address;
const OSMO = toBech32("osmo", KEY);
const VALOPER = toBech32("cosmosvaloper", KEY);
const VALOPER_2 = toBech32("cosmosvaloper", sha256(toUtf8("validator 2")).slice(0, 20));
const STRIDE = toBech32("stride", KEY);
const TO = "cosmos1jrkmdcwgq94uaamx6zax2luewlhf7u4kucx3kz";
// Osmosis crosschain-swaps: a real contract, 32 bytes like every contract wasmd instantiates.
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const TO_32_BYTE = toBech32("cosmos", fromBech32(XCS).data);
const CW721 = toBech32("osmo", sha256(toUtf8("cw721 test collection")));
const NFT_RECIPIENT = toBech32("osmo", fromBech32(TO).data);
// Pools and denoms of Osmosis mainnet, as zunia-core's vectors use them: pool 1 is OSMO/ATOM,
// 3498 and 3586 hold OSMO and the second token, and 3586 holds ATOM too.
const ATOM = "ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2";
const OUT = "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138";
const TIMEOUT = 1_791_400_000_000_000_000n;

const hub = { chainId: "cosmoshub-4", feeDenom: "uatom" };
const osmosis = { chainId: "osmosis-1", feeDenom: "uosmo" };
const aminoTypes = new AminoTypes(createDefaultAminoConverters());

/** A Cosmos SDK or IBC message: cosmjs-types bytes, the stargate converter's Amino value. */
function cosmos(name, chain, Msg, partial) {
  const message = Msg.fromPartial(partial);
  const amino = aminoTypes.toAmino({ typeUrl: Msg.typeUrl, value: message });
  const twin = OSMOJS_TWINS[Msg.typeUrl];
  const theirs = { type: twin.aminoType, value: twin.toAmino(twin.fromPartial(partial)) };
  if (JSON.stringify(sorted(theirs)) !== JSON.stringify(sorted(amino))) {
    throw new Error(`${name}: @cosmjs/stargate and osmojs disagree on the Amino form`);
  }
  return { name, ...chain, typeUrl: Msg.typeUrl, proto: Msg.encode(message).finish(), amino, aminoFrom: "@cosmjs/stargate" };
}

/** An osmojs message with the Amino converter osmojs registers for it. */
function osmojsCase(name, chain, Msg, converters, partial) {
  const message = Msg.fromPartial(partial);
  const converter = converters[Msg.typeUrl];
  return {
    name,
    ...chain,
    typeUrl: Msg.typeUrl,
    proto: Msg.encode(message).finish(),
    amino: { type: converter.aminoType, value: converter.toAmino(message) },
    aminoFrom: "osmojs",
  };
}

/** A gov v1 vote: see the header. */
function govV1Vote(name, partial) {
  const message = GovV1Vote.fromPartial(partial);
  const { value } = aminoTypes.toAmino({ typeUrl: MsgVote.typeUrl, value: MsgVote.fromPartial(partial) });
  const amino = { type: "cosmos-sdk/v1/MsgVote", value: { ...value, ...(partial.metadata ? { metadata: partial.metadata } : {}) } };
  if (process.env.INTERCHAINJS) {
    const { MsgVote: Telescope } = createRequire(join(resolve(process.env.INTERCHAINJS), "package.json"))("interchainjs/cosmos/gov/v1/tx");
    const theirs = { type: Telescope.aminoType, value: Telescope.toAmino(Telescope.fromPartial(partial)) };
    if (JSON.stringify(sorted(theirs)) !== JSON.stringify(sorted(amino))) {
      throw new Error(`${name}: interchainjs writes a different gov v1 Amino form`);
    }
  }
  return { name, ...hub, typeUrl: GovV1Vote.typeUrl, proto: GovV1Vote.encode(message).finish(), amino, aminoFrom: "gov v1 (see about)" };
}

function contractCall(name, contract, msg, funds = []) {
  return osmojsCase(name, osmosis, MsgExecuteContract, WasmAmino, { sender: OSMO, contract, msg: toUtf8(JSON.stringify(msg)), funds });
}

const swap = (name, Msg, partial) => osmojsCase(name, osmosis, Msg, PoolmanagerAmino, { sender: OSMO, ...partial });

const transfer = (partial) => ({
  sourcePort: "transfer",
  sourceChannel: "channel-141",
  token: { denom: "uatom", amount: "1000000" },
  sender: HUB,
  receiver: OSMO,
  timeoutTimestamp: TIMEOUT,
  ...partial,
});

const cases = [
  cosmos("delegate", hub, MsgDelegate, { delegatorAddress: HUB, validatorAddress: VALOPER, amount: { denom: "uatom", amount: "5000000" } }),
  cosmos("undelegate", hub, MsgUndelegate, { delegatorAddress: HUB, validatorAddress: VALOPER, amount: { denom: "uatom", amount: "1000000" } }),
  cosmos("redelegate", hub, MsgBeginRedelegate, {
    delegatorAddress: HUB,
    validatorSrcAddress: VALOPER,
    validatorDstAddress: VALOPER_2,
    amount: { denom: "uatom", amount: "1000000" },
  }),
  cosmos("claim_rewards", hub, MsgWithdrawDelegatorReward, { delegatorAddress: HUB, validatorAddress: VALOPER }),
  cosmos("vote_yes", hub, MsgVote, { proposalId: 848n, voter: HUB, option: 1 }),
  cosmos("vote_abstain", hub, MsgVote, { proposalId: 848n, voter: HUB, option: 2 }),
  cosmos("vote_no", hub, MsgVote, { proposalId: 848n, voter: HUB, option: 3 }),
  cosmos("vote_no_with_veto", hub, MsgVote, { proposalId: 848n, voter: HUB, option: 4 }),
  govV1Vote("vote_v1_yes", { proposalId: 1000n, voter: HUB, option: 1 }),
  govV1Vote("vote_v1_no_with_metadata", { proposalId: 1000n, voter: HUB, option: 3, metadata: "ipfs://bafy-rationale" }),
  cosmos("transfer_timestamp_only", hub, MsgTransfer, transfer({})),
  cosmos("transfer_with_height", hub, MsgTransfer, transfer({ timeoutHeight: { revisionNumber: 1n, revisionHeight: 20_000_000n } })),
  cosmos(
    "transfer_packet_forward_memo",
    hub,
    MsgTransfer,
    transfer({ memo: JSON.stringify({ forward: { receiver: STRIDE, port: "transfer", channel: "channel-5" } }) }),
  ),
  cosmos(
    "transfer_ibc_hooks_memo",
    hub,
    MsgTransfer,
    transfer({
      receiver: XCS,
      memo: JSON.stringify({
        wasm: {
          contract: XCS,
          msg: { osmosis_swap: { output_denom: "uosmo", slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } }, receiver: OSMO, on_failed_delivery: "do_nothing" } },
        },
      }),
    }),
  ),
  swap("swap_exact_in", poolmanager.MsgSwapExactAmountIn, {
    routes: [{ poolId: 3586n, tokenOutDenom: OUT }],
    tokenIn: { denom: "uosmo", amount: "9950000" },
    tokenOutMinAmount: "350000",
  }),
  swap("swap_exact_in_two_hops", poolmanager.MsgSwapExactAmountIn, {
    routes: [
      { poolId: 1n, tokenOutDenom: ATOM },
      { poolId: 3586n, tokenOutDenom: OUT },
    ],
    tokenIn: { denom: "uosmo", amount: "10000000" },
    tokenOutMinAmount: "340000",
  }),
  swap("split_in", poolmanager.MsgSplitRouteSwapExactAmountIn, {
    routes: [
      { pools: [{ poolId: 3498n, tokenOutDenom: OUT }], tokenInAmount: "6000000" },
      { pools: [{ poolId: 3586n, tokenOutDenom: OUT }], tokenInAmount: "4000000" },
    ],
    tokenInDenom: "uosmo",
    tokenOutMinAmount: "350000",
  }),
  swap("split_in_two_hop_leg", poolmanager.MsgSplitRouteSwapExactAmountIn, {
    routes: [
      { pools: [{ poolId: 1n, tokenOutDenom: ATOM }, { poolId: 3586n, tokenOutDenom: OUT }], tokenInAmount: "7000000" },
      { pools: [{ poolId: 3498n, tokenOutDenom: OUT }], tokenInAmount: "3000000" },
    ],
    tokenInDenom: "uosmo",
    tokenOutMinAmount: "340000",
  }),
  swap("swap_exact_out", poolmanager.MsgSwapExactAmountOut, {
    routes: [{ poolId: 3586n, tokenInDenom: "uosmo" }],
    tokenInMaxAmount: "10000000",
    tokenOut: { denom: OUT, amount: "340000" },
  }),
  swap("swap_exact_out_two_hops", poolmanager.MsgSwapExactAmountOut, {
    routes: [
      { poolId: 1n, tokenInDenom: "uosmo" },
      { poolId: 3586n, tokenInDenom: ATOM },
    ],
    tokenInMaxAmount: "10000000",
    tokenOut: { denom: OUT, amount: "340000" },
  }),
  swap("split_out", poolmanager.MsgSplitRouteSwapExactAmountOut, {
    routes: [
      { pools: [{ poolId: 3498n, tokenInDenom: "uosmo" }], tokenOutAmount: "200000" },
      { pools: [{ poolId: 3586n, tokenInDenom: "uosmo" }], tokenOutAmount: "140000" },
    ],
    tokenOutDenom: OUT,
    tokenInMaxAmount: "10000000",
  }),
  // The messages the extension already read in Amino before 0.1.5, for the both-modes check.
  cosmos("send", hub, MsgSend, { fromAddress: HUB, toAddress: TO, amount: [{ denom: "uatom", amount: "1000000" }] }),
  cosmos("send_two_coins", hub, MsgSend, {
    fromAddress: HUB,
    toAddress: TO,
    amount: [
      { denom: "uatom", amount: "1" },
      { denom: "uosmo", amount: "2" },
    ],
  }),
  cosmos("send_to_32_byte", hub, MsgSend, { fromAddress: HUB, toAddress: TO_32_BYTE, amount: [{ denom: "uatom", amount: "1000000" }] }),
  contractCall(
    "execute_xcs_swap",
    XCS,
    { osmosis_swap: { output_denom: ATOM, slippage: { twap: { window_seconds: 10, slippage_percentage: "5" } }, receiver: HUB, on_failed_delivery: { local_recovery_addr: OSMO } } },
    [{ denom: "uosmo", amount: "1000000" }],
  ),
  contractCall("execute_recover", XCS, { recover: {} }),
  contractCall("execute_nft_transfer", CW721, { transfer_nft: { recipient: NFT_RECIPIENT, token_id: "rock & roll" } }),
  contractCall("execute_nft_send", CW721, { send_nft: { contract: XCS, token_id: "7", msg: toBase64(toUtf8("{}")) } }),
];

const pubKey = Any.fromPartial({
  typeUrl: "/cosmos.crypto.secp256k1.PubKey",
  value: PubKey.encode(PubKey.fromPartial({ key: account.pubkey })).finish(),
});

function signDocHex({ chainId, feeDenom, typeUrl, proto }) {
  const bodyBytes = TxBody.encode(TxBody.fromPartial({ messages: [Any.fromPartial({ typeUrl, value: proto })], memo: "" })).finish();
  const authInfoBytes = AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [SignerInfo.fromPartial({ publicKey: pubKey, modeInfo: { single: { mode: 1 } }, sequence: 7n })],
      fee: Fee.fromPartial({ amount: [{ denom: feeDenom, amount: "5000" }], gasLimit: 200_000n }),
    }),
  ).finish();
  return toHex(makeSignBytes(makeSignDoc(bodyBytes, authInfoBytes, chainId, 12345)));
}

function sorted(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sorted);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, sorted(value[key])]),
  );
}

const fixture = {
  about:
    "One message per entry, in both encodings, made by scripts/generate-amino-summaries.mjs and never edited by hand. signDocHex is the direct SignDoc CosmJS makes around the cosmjs-types or osmojs protobuf (fee 5000 of the chain's fee denom, gas 200000, account 12345, sequence 7, the public abandon…about key). amino is the Amino {type, value} of the same message from the converter a CosmJS client registers: @cosmjs/stargate's defaults for Cosmos SDK and IBC messages (osmojs's agree), osmojs's for poolmanager swaps and MsgExecuteContract. gov v1 has no converter in either: its value is the v1beta1 converter's under cosmos-sdk/v1/MsgVote, plus metadata when set, as interchainjs 1.21's converter writes it.",
  generatedWith: {
    "@cosmjs/stargate": versionOf("@cosmjs/stargate"),
    "@cosmjs/proto-signing": versionOf("@cosmjs/proto-signing"),
    "cosmjs-types": versionOf("cosmjs-types"),
    osmojs: versionOf("osmojs"),
  },
  cases: cases.map((entry) => ({
    name: entry.name,
    chainId: entry.chainId,
    typeUrl: entry.typeUrl,
    aminoFrom: entry.aminoFrom,
    amino: sorted(entry.amino),
    signDocHex: signDocHex(entry),
  })),
};

const target = join(ROOT, "lib/__tests__/fixtures/amino-summaries.json");
writeFileSync(target, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${fixture.cases.length} cases to ${target}`);

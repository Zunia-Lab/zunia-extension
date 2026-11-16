/**
 * The dApp messages the kernel reads since 0.1.2 (zunia-core dapp.rs), in Amino.
 *
 * A dApp picks the sign mode, so what the user reads must not depend on it. Each of the 55 real
 * mainnet transactions in zunia-core's tests/vectors/chain-verified-dapp-messages.json is decoded
 * by the real kernel (the wasm the build ships), and the LCD's JSON of its message is turned
 * into the Amino JSON a client signs with, by the rules of the Amino encoding and not by this
 * module's code. describeAminoMsg must then give the kernel's summary, recipient and detail, and
 * every address the kernel names must be one the Amino message holds. The types with no real
 * transaction, the edge cases and the messages that must stay unread are pinned below.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { bech32 } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";

import { DAPP_DESCRIBERS, describeAminoMsg } from "../amino-summary";

type Fields = Record<string, unknown>;

interface KernelMessage {
  typeUrl: string;
  summary: string;
  unknown: boolean;
  recipient?: string;
  detail?: unknown;
}

let decode: (signDocHex: string) => { messages: KernelMessage[]; addresses: string[] };

beforeAll(async () => {
  const dir = process.env.ZUNIA_CORE_DIR ?? dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href)) as typeof import("@zunialab/core");
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  decode = (signDocHex) => core.decodeDirectTx(signDocHex) as never;
});

/* -------------------------------------------------------------------------- *
 * Protobuf, just enough to cut a TxRaw into a SignDoc
 * -------------------------------------------------------------------------- */

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function lengthDelimited(tag: number, bytes: Uint8Array): number[] {
  return [(tag << 3) | 2, ...varint(bytes.length), ...bytes];
}

/** `body_bytes` (1) and `auth_info_bytes` (2) of a TxRaw. */
function rawFields(tx: Uint8Array): Map<number, Uint8Array> {
  const found = new Map<number, Uint8Array>();
  let at = 0;
  const read = (): number => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = tx[at++]!;
      value += (byte & 0x7f) * shift;
      if ((byte & 0x80) === 0) return value;
      shift *= 128;
    }
  };
  while (at < tx.length) {
    const key = read();
    if ((key & 7) !== 2) throw new Error("TxRaw holds only byte strings");
    const length = read();
    if (!found.has(key >> 3)) found.set(key >> 3, tx.subarray(at, at + length));
    at += length;
  }
  return found;
}

/** The direct SignDoc a wallet would be asked to sign for a transaction already on chain. */
function signDocHex(txBase64: string, chainId: string): string {
  const fields = rawFields(Buffer.from(txBase64, "base64"));
  const doc = [
    ...lengthDelimited(1, fields.get(1)!),
    ...lengthDelimited(2, fields.get(2)!),
    ...lengthDelimited(3, new TextEncoder().encode(chainId)),
    ...[0x20, 0x01],
  ];
  return Buffer.from(doc).toString("hex");
}

/* -------------------------------------------------------------------------- *
 * The LCD's JSON to Amino JSON
 * -------------------------------------------------------------------------- */

/** The Amino name of each type (the kernel's table, written out by hand). */
const AMINO_NAMES: Record<string, string> = {
  "/osmosis.concentratedliquidity.v1beta1.MsgCreatePosition": "osmosis/cl-create-position",
  "/osmosis.concentratedliquidity.v1beta1.MsgAddToPosition": "osmosis/cl-add-to-position",
  "/osmosis.concentratedliquidity.v1beta1.MsgWithdrawPosition": "osmosis/cl-withdraw-position",
  "/osmosis.concentratedliquidity.v1beta1.MsgCollectSpreadRewards": "osmosis/cl-col-sp-rewards",
  "/osmosis.concentratedliquidity.v1beta1.MsgCollectIncentives": "osmosis/cl-collect-incentives",
  "/osmosis.concentratedliquidity.v1beta1.MsgTransferPositions": "osmosis/cl-transfer-positions",
  "/osmosis.gamm.v1beta1.MsgJoinPool": "osmosis/gamm/join-pool",
  "/osmosis.gamm.v1beta1.MsgExitPool": "osmosis/gamm/exit-pool",
  "/osmosis.gamm.v1beta1.MsgJoinSwapExternAmountIn": "osmosis/gamm/join-swap-extern-amount-in",
  "/osmosis.gamm.v1beta1.MsgExitSwapShareAmountIn": "osmosis/gamm/exit-swap-share-amount-in",
  "/osmosis.gamm.v1beta1.MsgJoinSwapShareAmountOut": "osmosis/gamm/join-swap-share-amount-out",
  "/osmosis.gamm.v1beta1.MsgExitSwapExternAmountOut": "osmosis/gamm/exit-swap-extern-amount-out",
  "/osmosis.gamm.v1beta1.MsgSwapExactAmountIn": "osmosis/gamm/swap-exact-amount-in",
  "/osmosis.gamm.v1beta1.MsgSwapExactAmountOut": "osmosis/gamm/swap-exact-amount-out",
  "/osmosis.lockup.MsgLockTokens": "osmosis/lockup/lock-tokens",
  "/osmosis.lockup.MsgBeginUnlocking": "osmosis/lockup/begin-unlock-period-lock",
  "/osmosis.lockup.MsgBeginUnlockingAll": "osmosis/lockup/begin-unlock-tokens",
  "/osmosis.superfluid.MsgSuperfluidDelegate": "osmosis/superfluid-delegate",
  "/osmosis.superfluid.MsgSuperfluidUndelegate": "osmosis/superfluid-undelegate",
  "/osmosis.superfluid.MsgLockAndSuperfluidDelegate": "osmosis/lock-and-superfluid-delegate",
  "/osmosis.superfluid.MsgSuperfluidUnbondLock": "osmosis/superfluid-unbond-lock",
  "/osmosis.superfluid.MsgSuperfluidUndelegateAndUnbondLock": "osmosis/superfluid-undelegate-unbond-lock",
  "/osmosis.superfluid.MsgCreateFullRangePositionAndSuperfluidDelegate": "osmosis/full-range-and-sf-delegate",
  "/osmosis.superfluid.MsgAddToConcentratedLiquiditySuperfluidPosition": "osmosis/add-to-cl-superfluid-position",
  "/cosmos.bank.v1beta1.MsgMultiSend": "cosmos-sdk/MsgMultiSend",
  "/cosmos.staking.v1beta1.MsgCancelUnbondingDelegation": "cosmos-sdk/MsgCancelUnbondingDelegation",
  "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress": "cosmos-sdk/MsgModifyWithdrawAddress",
  "/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission": "cosmos-sdk/MsgWithdrawValCommission",
  "/cosmos.distribution.v1beta1.MsgFundCommunityPool": "cosmos-sdk/MsgFundCommunityPool",
  "/cosmos.gov.v1beta1.MsgDeposit": "cosmos-sdk/MsgDeposit",
  "/cosmos.gov.v1.MsgDeposit": "cosmos-sdk/v1/MsgDeposit",
  "/cosmos.gov.v1beta1.MsgVoteWeighted": "cosmos-sdk/MsgVoteWeighted",
  "/cosmos.gov.v1.MsgVoteWeighted": "cosmos-sdk/v1/MsgVoteWeighted",
  "/cosmos.authz.v1beta1.MsgRevoke": "cosmos-sdk/MsgRevoke",
  "/cosmos.feegrant.v1beta1.MsgRevokeAllowance": "cosmos-sdk/MsgRevokeAllowance",
  "/cosmwasm.wasm.v1.MsgInstantiateContract": "wasm/MsgInstantiateContract",
  "/cosmwasm.wasm.v1.MsgInstantiateContract2": "wasm/MsgInstantiateContract2",
  "/cosmwasm.wasm.v1.MsgMigrateContract": "wasm/MsgMigrateContract",
  "/cosmwasm.wasm.v1.MsgUpdateAdmin": "wasm/MsgUpdateAdmin",
  "/cosmwasm.wasm.v1.MsgClearAdmin": "wasm/MsgClearAdmin",
};

/**
 * Amino JSON of an LCD message: no `@type`; an empty string or list is left out (Amino's
 * `omitempty`); a lock's `google.protobuf.Duration` ("1209600s") is nanoseconds in a string; and
 * a contract message is the JSON itself, kept as it is.
 */
function aminoOf(lcd: Fields): Fields {
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (typeof value !== "object" || value === null) return value;
    const out: Fields = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "@type") continue;
      if (item === "" || (Array.isArray(item) && item.length === 0)) continue;
      if (item === false && key === "fix_msg") continue;
      out[key] = key === "msg" ? item : clean(item);
    }
    return out;
  };
  const out = clean(lcd) as Fields;
  if (typeof out.duration === "string") {
    out.duration = (BigInt(out.duration.replace(/s$/, "")) * 1_000_000_000n).toString();
  }
  return out;
}

const vectors = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../../zunia-core/tests/vectors/chain-verified-dapp-messages.json"), "utf8"),
) as {
  cases: Array<{ chain: string; chainId: string; typeUrl: string; hash: string; msgIndex: number; tx: string; lcd: Fields }>;
};

describe("real mainnet transactions", () => {
  it("cover every type the kernel table lists that has a real transaction", () => {
    expect(vectors.cases).toHaveLength(55);
    expect(new Set(vectors.cases.map((entry) => entry.typeUrl)).size).toBe(30);
  });

  it.each(vectors.cases.map((entry) => [`${entry.typeUrl.split(".").pop()} ${entry.hash.slice(0, 8)}`, entry] as const))(
    "%s: the Amino form reads as the kernel reads the direct form",
    (_name, entry) => {
      const decoded = decode(signDocHex(entry.tx, entry.chainId));
      const kernel = decoded.messages[entry.msgIndex]!;
      expect(kernel.unknown, "kernel 0.1.2 or later").toBe(false);
      expect(kernel.typeUrl).toBe(entry.typeUrl);

      const type = AMINO_NAMES[entry.typeUrl]!;
      const value = aminoOf(entry.lcd);
      expect(describeAminoMsg(type, value)).toEqual({
        typeUrl: type,
        summary: kernel.summary,
        ...(kernel.recipient === undefined ? {} : { recipient: kernel.recipient }),
        ...(kernel.detail === undefined ? {} : { detail: kernel.detail }),
      });

      // Every address of the message, which the kernel names, is in the document the user signs.
      if (decoded.messages.length === 1) {
        const text = JSON.stringify(value);
        for (const address of decoded.addresses) expect(text).toContain(address);
      }
    },
  );
});

/* -------------------------------------------------------------------------- *
 * Types with no real transaction, and the edges
 * -------------------------------------------------------------------------- */

const address = (prefix: string, bytes: number, seed = 1): string =>
  bech32.encode(prefix, bech32.toWords(Uint8Array.from({ length: bytes }, (_, i) => (i * 7 + seed) & 0xff)));
const SENDER = address("osmo", 20);
const OTHER = address("osmo", 20, 2);
const CONTRACT = address("osmo", 32, 3);
const VALOPER = address("osmovaloper", 20, 4);
const USDC = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";

const sentence = (type: string, value: unknown) => describeAminoMsg(type, value)?.summary;

describe("types with no mainnet sample", () => {
  it("reads gamm JoinSwapShareAmountOut and ExitSwapExternAmountOut", () => {
    expect(
      sentence("osmosis/gamm/join-swap-share-amount-out", {
        sender: SENDER, pool_id: "3600", token_in_denom: "uosmo", share_out_amount: "5000000", token_in_max_amount: "100000",
      }),
    ).toBe("Join pool 3600 with uosmo alone, paying at most 100000 uosmo for exactly 5000000 gamm/pool/3600 shares");
    expect(
      sentence("osmosis/gamm/exit-swap-extern-amount-out", {
        sender: SENDER, pool_id: "1", token_out: { denom: "uosmo", amount: "1000" }, share_in_max_amount: "77",
      }),
    ).toBe("Exit pool 1 receiving exactly 1000 uosmo alone, burning at most 77 gamm/pool/1 shares");
  });

  it("reads lockup BeginUnlockingAll", () => {
    expect(sentence("osmosis/lockup/begin-unlock-tokens", { owner: SENDER })).toBe(
      `Begin unlocking every lock owned by ${SENDER}`,
    );
  });

  it("reads the superfluid messages", () => {
    expect(sentence("osmosis/superfluid-delegate", { sender: SENDER, lock_id: "42", val_addr: VALOPER })).toBe(
      `Superfluid-delegate lock 42 to validator ${VALOPER}`,
    );
    expect(
      sentence("osmosis/lock-and-superfluid-delegate", {
        sender: SENDER, coins: [{ denom: "gamm/pool/1", amount: "5" }], val_addr: VALOPER,
      }),
    ).toBe(`Lock 5 gamm/pool/1 and superfluid-delegate it to validator ${VALOPER}`);
    expect(
      sentence("osmosis/full-range-and-sf-delegate", {
        sender: SENDER, coins: [{ denom: "uosmo", amount: "10" }], val_addr: VALOPER, pool_id: "1",
      }),
    ).toBe(
      `Create a full-range concentrated liquidity position in pool 1 with 10 uosmo and superfluid-delegate it to validator ${VALOPER}`,
    );
    expect(
      sentence("osmosis/add-to-cl-superfluid-position", {
        position_id: "9", sender: SENDER, token_desired0: { denom: "uosmo", amount: "10" }, token_desired1: { denom: "uatom", amount: "0" },
      }),
    ).toBe("Add 10 uosmo and 0 uatom to superfluid concentrated liquidity position 9");
  });

  it("reads SuperfluidUndelegateAndUnbondLock under both Amino names", () => {
    const value = { sender: SENDER, lock_id: "7", coin: { denom: "gamm/pool/678", amount: "12" } };
    const expected = "Superfluid-undelegate lock 7 and unbond 12 gamm/pool/678 from it";
    expect(sentence("osmosis/superfluid-undelegate-unbond-lock", value)).toBe(expected);
    expect(sentence("osmosis/sf-undelegate-and-unbond-lock", value)).toBe(expected);
  });

  it("reads gov weighted votes, v1beta1 and v1, with 18-place weights", () => {
    const expected = "Vote Yes 0.700000000000000000, No 0.300000000000000000 on proposal 7";
    const options = (first: string, second: string) => [
      { option: 1, weight: first },
      { option: "VOTE_OPTION_NO", weight: second },
    ];
    expect(
      sentence("cosmos-sdk/MsgVoteWeighted", { proposal_id: "7", voter: SENDER, options: options("0.700000000000000000", "0.300000000000000000") }),
    ).toBe(expected);
    // gov v1 passes the string through, so a short decimal is read and shown in full.
    expect(
      sentence("cosmos-sdk/v1/MsgVoteWeighted", { proposal_id: "7", voter: SENDER, options: options("0.7", "0.300000000000000000"), metadata: "" }),
    ).toBe(expected);
    // v1beta1 is always written with 18 places; a short weight is not the chain's own document.
    expect(sentence("cosmos-sdk/MsgVoteWeighted", { proposal_id: "7", voter: SENDER, options: options("0.7", "0.3") })).toBeUndefined();
    expect(sentence("cosmos-sdk/v1/MsgVoteWeighted", { proposal_id: "7", voter: SENDER, options: [{ option: 2, weight: "1" }] })).toBe(
      "Vote Abstain 1.000000000000000000 on proposal 7",
    );
  });

  it("reads wasm ClearAdmin, with no recipient", () => {
    const described = describeAminoMsg("wasm/MsgClearAdmin", { sender: SENDER, contract: CONTRACT });
    expect(described?.summary).toBe(`Clear the admin of contract ${CONTRACT}, so nobody can migrate it again`);
    expect(described?.recipient).toBeUndefined();
  });
});

describe("edges the kernel demotes to unknown", () => {
  const position = { pool_id: "3600", sender: SENDER, lower_tick: "-100", upper_tick: "200", tokens_provided: [{ denom: "uosmo", amount: "5" }], token_min_amount0: "0", token_min_amount1: "0" };

  it("reads a position with negative ticks, and a tick of 0 Amino omits", () => {
    expect(sentence("osmosis/cl-create-position", position)).toContain("between ticks -100 and 200 with 5 uosmo");
    const { lower_tick: _omitted, ...zeroLower } = position;
    expect(sentence("osmosis/cl-create-position", zeroLower)).toContain("between ticks 0 and 200");
  });

  it.each([
    ["pool 0", { ...position, pool_id: "0" }],
    ["ticks not ascending", { ...position, lower_tick: "5", upper_tick: "5" }],
    ["a tick that is not canonical", { ...position, lower_tick: "-0" }],
    ["no coins", { ...position, tokens_provided: undefined }],
    ["three coins", { ...position, tokens_provided: [1, 2, 3].map((n) => ({ denom: `den${n}`, amount: "1" })) }],
    ["a zero coin", { ...position, tokens_provided: [{ denom: "uosmo", amount: "0" }] }],
    ["an invalid denom", { ...position, tokens_provided: [{ denom: "9", amount: "1" }] }],
    ["a missing minimum", { ...position, token_min_amount1: undefined }],
    ["an address with no bech32 shape", { ...position, sender: "osmo1abc" }],
  ])("refuses a position with %s", (_name, value) => {
    expect(describeAminoMsg("osmosis/cl-create-position", value)).toBeNull();
  });

  it("refuses an add that adds nothing, and a withdraw of no liquidity", () => {
    const add = { position_id: "5", sender: SENDER, amount0: "0", amount1: "0", token_min_amount0: "0", token_min_amount1: "0" };
    expect(describeAminoMsg("osmosis/cl-add-to-position", add)).toBeNull();
    expect(describeAminoMsg("osmosis/cl-add-to-position", { ...add, amount1: "3" })).not.toBeNull();
    expect(describeAminoMsg("osmosis/cl-add-to-position", { ...add, position_id: "0", amount1: "3" })).toBeNull();
    const withdraw = { position_id: "5", sender: SENDER, liquidity_amount: "0.000000000000000000" };
    expect(describeAminoMsg("osmosis/cl-withdraw-position", withdraw)).toBeNull();
    // Not an 18-place decimal: not what the chain writes.
    expect(describeAminoMsg("osmosis/cl-withdraw-position", { ...withdraw, liquidity_amount: "5" })).toBeNull();
    expect(sentence("osmosis/cl-withdraw-position", { ...withdraw, liquidity_amount: "5.000000000000000000" })).toBe(
      "Withdraw 5.000000000000000000 liquidity units (the message names no denom) from concentrated liquidity position 5",
    );
  });

  it("refuses empty and duplicate position ids, and words one and several", () => {
    const collect = (position_ids: unknown) => describeAminoMsg("osmosis/cl-collect-incentives", { sender: SENDER, position_ids });
    expect(collect(undefined)).toBeNull();
    expect(collect([])).toBeNull();
    expect(collect(["1", "1"])).toBeNull();
    expect(collect(["0"])).toBeNull();
    expect(collect(["5"])?.summary).toBe("Collect the incentives of concentrated liquidity position 5");
    expect(collect(["5", "6", "7"])?.summary).toBe("Collect the incentives of concentrated liquidity positions 5, 6, 7");
  });

  it("makes a position's new owner its recipient, on the signer's prefix", () => {
    const transfer = (new_owner: string) => describeAminoMsg("osmosis/cl-transfer-positions", { sender: SENDER, position_ids: ["1"], new_owner });
    expect(transfer(OTHER)?.recipient).toBe(OTHER);
    expect(transfer(CONTRACT)?.recipient).toBe(CONTRACT);
    expect(transfer(address("cosmos", 20))).toBeNull();
    expect(transfer(address("osmo", 24))).toBeNull();
  });

  it("words an exit with no minimum, and refuses an empty share amount", () => {
    const exit = { sender: SENDER, pool_id: "3", share_in_amount: "10" };
    expect(sentence("osmosis/gamm/exit-pool", exit)).toBe("Exit pool 3 by burning 10 gamm/pool/3 shares, with no minimum amount out");
    expect(sentence("osmosis/gamm/exit-pool", { ...exit, token_out_mins: [{ denom: "uosmo", amount: "4" }, { denom: "uatom", amount: "5" }] })).toBe(
      "Exit pool 3 by burning 10 gamm/pool/3 shares, receiving at least 4 uosmo, 5 uatom",
    );
    expect(describeAminoMsg("osmosis/gamm/exit-pool", { ...exit, share_in_amount: "0" })).toBeNull();
    expect(describeAminoMsg("osmosis/gamm/join-pool", { sender: SENDER, pool_id: "3", share_out_amount: "1", token_in_maxs: [{ denom: "uosmo", amount: "4" }, { denom: "uosmo", amount: "5" }] })).toBeNull();
  });

  it("reads a gamm swap as the poolmanager's sentence", () => {
    expect(
      sentence("osmosis/gamm/swap-exact-amount-in", {
        sender: SENDER, routes: [{ pool_id: "1", token_out_denom: "uatom" }, { pool_id: "2", token_out_denom: USDC }], token_in: { denom: "uosmo", amount: "50" }, token_out_min_amount: "7",
      }),
    ).toBe(`Swap 50 uosmo for at least 7 ${USDC} through pools 1 → 2`);
  });

  it("converts a lock's nanoseconds to whole seconds, and refuses anything else", () => {
    const lock = (duration: unknown) => describeAminoMsg("osmosis/lockup/lock-tokens", { owner: SENDER, duration, coins: [{ denom: "uosmo", amount: "1" }] });
    expect(lock("86400000000000")?.summary).toBe("Lock 1 uosmo for 86400 seconds");
    expect(lock("86400000000001")).toBeNull();
    expect(lock("0")).toBeNull();
    expect(lock(undefined)).toBeNull();
    expect(lock("-1000000000")).toBeNull();
    expect(lock("1209600s")).toBeNull();
  });

  it("words unlocking all of a lock when the coins Amino omits are empty", () => {
    expect(sentence("osmosis/lockup/begin-unlock-period-lock", { owner: SENDER, ID: "9" })).toBe("Begin unlocking all the tokens of lock 9");
    expect(sentence("osmosis/lockup/begin-unlock-period-lock", { owner: SENDER, ID: "9", coins: [{ denom: "uosmo", amount: "2" }] })).toBe(
      "Begin unlocking 2 uosmo from lock 9",
    );
    expect(describeAminoMsg("osmosis/lockup/begin-unlock-period-lock", { owner: SENDER, ID: "0" })).toBeNull();
  });

  it("refuses a validator that is not 20 bytes", () => {
    expect(describeAminoMsg("osmosis/superfluid-delegate", { sender: SENDER, lock_id: "1", val_addr: address("osmovaloper", 32) })).toBeNull();
    expect(describeAminoMsg("osmosis/superfluid-unbond-lock", { sender: SENDER, lock_id: "0" })).toBeNull();
    expect(describeAminoMsg("osmosis/add-to-cl-superfluid-position", { position_id: "9", sender: SENDER, token_desired0: { denom: "uosmo", amount: "0" }, token_desired1: { denom: "uatom", amount: "0" } })).toBeNull();
  });

  describe("a multi-send", () => {
    const send = (inputs: unknown, outputs: unknown) => describeAminoMsg("cosmos-sdk/MsgMultiSend", { inputs, outputs });
    const coins = (amount: string, name = "uosmo") => [{ denom: name, amount }];

    it("names the one outside output as its recipient", () => {
      const described = send([{ address: SENDER, coins: coins("30") }], [{ address: OTHER, coins: coins("10") }, { address: SENDER, coins: coins("20") }]);
      expect(described?.recipient).toBe(OTHER);
      expect(described?.summary).toBe(`Send 10 uosmo to ${OTHER}; 20 uosmo to ${SENDER} in one multi-send paid by ${SENDER} (30 uosmo)`);
    });

    it("names no recipient for several outside outputs, and every output in the detail", () => {
      const described = send([{ address: SENDER, coins: coins("30") }], [{ address: OTHER, coins: coins("10") }, { address: CONTRACT, coins: coins("20") }]);
      expect(described?.recipient).toBeUndefined();
      expect(described?.detail).toEqual({
        kind: "multi-send",
        inputs: [{ address: SENDER, coins: coins("30") }],
        outputs: [{ address: OTHER, coins: coins("10") }, { address: CONTRACT, coins: coins("20") }],
      });
    });

    it("refuses what does not balance per denom, or has no input or output", () => {
      expect(send([{ address: SENDER, coins: coins("30") }], [{ address: OTHER, coins: coins("29") }])).toBeNull();
      expect(send([{ address: SENDER, coins: coins("30") }], [{ address: OTHER, coins: coins("30", "uatom") }])).toBeNull();
      expect(send([], [{ address: OTHER, coins: coins("30") }])).toBeNull();
      expect(send([{ address: SENDER, coins: coins("30") }], [])).toBeNull();
      expect(send([{ address: SENDER, coins: coins("30") }], undefined)).toBeNull();
      expect(send([{ address: SENDER, coins: [] }], [{ address: OTHER, coins: coins("30") }])).toBeNull();
      // An input is an account of the chain; an output may be module-derived but not foreign.
      expect(send([{ address: SENDER, coins: coins("30") }], [{ address: address("cosmos", 20), coins: coins("30") }])).toBeNull();
    });
  });

  it("refuses an unbonding cancelled at height 0, and a withdraw address of another chain", () => {
    const cancel = { delegator_address: address("cosmos", 20), validator_address: address("cosmosvaloper", 20), amount: { denom: "uatom", amount: "5" }, creation_height: "12" };
    expect(sentence("cosmos-sdk/MsgCancelUnbondingDelegation", cancel)).toBe(
      `Cancel the unbonding of 5 uatom from ${cancel.validator_address}, created at height 12`,
    );
    expect(describeAminoMsg("cosmos-sdk/MsgCancelUnbondingDelegation", { ...cancel, creation_height: undefined })).toBeNull();
    expect(describeAminoMsg("cosmos-sdk/MsgModifyWithdrawAddress", { delegator_address: SENDER, withdraw_address: address("cosmos", 20) })).toBeNull();
    expect(describeAminoMsg("cosmos-sdk/MsgModifyWithdrawAddress", { delegator_address: SENDER, withdraw_address: OTHER })?.recipient).toBe(OTHER);
  });

  it("accepts a deposit on proposal 0 as the kernel does, and refuses a vote on it", () => {
    expect(sentence("cosmos-sdk/MsgDeposit", { depositor: SENDER, amount: [{ denom: "uosmo", amount: "1" }] })).toBe("Deposit 1 uosmo on proposal 0");
    expect(describeAminoMsg("cosmos-sdk/MsgDeposit", { depositor: SENDER, proposal_id: "3" })).toBeNull();
    const vote = { voter: SENDER, options: [{ option: 1, weight: "1.000000000000000000" }] };
    expect(describeAminoMsg("cosmos-sdk/MsgVoteWeighted", { ...vote, proposal_id: "0" })).toBeNull();
  });

  it("refuses weights that do not sum to 1, repeat an option, or are zero", () => {
    const vote = (options: unknown) => describeAminoMsg("cosmos-sdk/MsgVoteWeighted", { proposal_id: "7", voter: SENDER, options });
    expect(vote([{ option: 1, weight: "0.500000000000000000" }])).toBeNull();
    expect(vote([{ option: 1, weight: "0.500000000000000000" }, { option: 1, weight: "0.500000000000000000" }])).toBeNull();
    expect(vote([{ option: 1, weight: "1.000000000000000000" }, { option: 3, weight: "0.000000000000000000" }])).toBeNull();
    expect(vote([{ option: 0, weight: "1.000000000000000000" }])).toBeNull();
    expect(vote([])).toBeNull();
    expect(vote([{ option: 4, weight: "1.000000000000000000" }])?.summary).toBe("Vote No with veto 1.000000000000000000 on proposal 7");
  });

  it("quotes only a plain type URL when revoking", () => {
    const revoke = (msg_type_url: string) => describeAminoMsg("cosmos-sdk/MsgRevoke", { granter: SENDER, grantee: OTHER, msg_type_url });
    expect(revoke("/cosmos.staking.v1beta1.MsgDelegate")?.summary).toBe(
      `Revoke the authorization given to ${OTHER} for /cosmos.staking.v1beta1.MsgDelegate`,
    );
    for (const url of ["cosmos.bank.MsgSend", "/", "/a b", "/a‮b", "/a/b", ""]) expect(revoke(url)).toBeNull();
  });

  describe("an instantiate", () => {
    const base = { sender: SENDER, code_id: "5", label: "my contract", msg: { hello: "world" } };

    it("shows the label, the message, the funds and the admin in its detail, and the admin as recipient", () => {
      const described = describeAminoMsg("wasm/MsgInstantiateContract", { ...base, admin: OTHER, funds: [{ denom: "uosmo", amount: "9" }] });
      expect(described?.summary).toBe(`Instantiate code 5 as a new contract with admin ${OTHER}, sending 9 uosmo`);
      expect(described?.recipient).toBe(OTHER);
      expect(described?.detail).toEqual({
        kind: "instantiate-contract", codeId: "5", label: "my contract", admin: OTHER, msg: { hello: "world" }, funds: [{ denom: "uosmo", amount: "9" }],
      });
    });

    it("reads a missing admin and missing funds as none", () => {
      const described = describeAminoMsg("wasm/MsgInstantiateContract", base);
      expect(described?.summary).toBe("Instantiate code 5 as a new contract with no admin");
      expect(described?.recipient).toBeUndefined();
      expect(described?.detail).toMatchObject({ admin: null, funds: [] });
    });

    it("refuses code 0, an empty label, a missing message and a foreign admin", () => {
      expect(describeAminoMsg("wasm/MsgInstantiateContract", { ...base, code_id: "0" })).toBeNull();
      expect(describeAminoMsg("wasm/MsgInstantiateContract", { ...base, label: "" })).toBeNull();
      expect(describeAminoMsg("wasm/MsgInstantiateContract", { ...base, msg: undefined })).toBeNull();
      expect(describeAminoMsg("wasm/MsgInstantiateContract", { ...base, admin: address("cosmos", 20) })).toBeNull();
      expect(describeAminoMsg("wasm/MsgInstantiateContract", { ...base, funds: [{ denom: "uosmo", amount: "0" }] })).toBeNull();
    });

    it("carries the salt as hex and fix_msg for instantiate2, and refuses an empty or oversized salt", () => {
      const two = (value: Fields) => describeAminoMsg("wasm/MsgInstantiateContract2", { ...base, ...value });
      const described = two({ salt: "AQID", fix_msg: true });
      expect(described?.summary).toBe("Instantiate code 5 as a new contract at a salt-derived address with no admin");
      expect(described?.detail).toMatchObject({ salt: "010203", fixMsg: true });
      expect(two({ salt: "AQID" })?.detail).toMatchObject({ salt: "010203", fixMsg: false });
      expect(two({})).toBeNull();
      expect(two({ salt: "" })).toBeNull();
      expect(two({ salt: Buffer.alloc(65, 1).toString("base64") })).toBeNull();
      expect(two({ salt: Buffer.alloc(64, 1).toString("base64") })).not.toBeNull();
      expect(two({ salt: "not base64!" })).toBeNull();
    });
  });

  it("reads a migration with its message, and an admin change with its new admin as recipient", () => {
    const migrate = describeAminoMsg("wasm/MsgMigrateContract", { sender: SENDER, contract: CONTRACT, code_id: "8", msg: {} });
    expect(migrate).toEqual({
      typeUrl: "wasm/MsgMigrateContract",
      summary: `Migrate contract ${CONTRACT} to code 8`,
      detail: { kind: "migrate-contract", contract: CONTRACT, codeId: "8", msg: {} },
    });
    expect(describeAminoMsg("wasm/MsgMigrateContract", { sender: SENDER, contract: CONTRACT, code_id: "8" })).toBeNull();
    expect(describeAminoMsg("wasm/MsgMigrateContract", { sender: SENDER, contract: CONTRACT, code_id: "0", msg: {} })).toBeNull();
    const update = describeAminoMsg("wasm/MsgUpdateAdmin", { sender: SENDER, new_admin: OTHER, contract: CONTRACT });
    expect(update?.summary).toBe(`Make ${OTHER} the admin of contract ${CONTRACT}`);
    expect(update?.recipient).toBe(OTHER);
    expect(describeAminoMsg("wasm/MsgUpdateAdmin", { sender: SENDER, new_admin: "", contract: CONTRACT })).toBeNull();
  });
});

describe("messages that stay unread, in Amino as in direct mode", () => {
  it.each([
    "cosmos-sdk/MsgGrant",
    "cosmos-sdk/MsgExec",
    "cosmos-sdk/MsgGrantAllowance",
    "wasm/MsgStoreCode",
    "cosmos-sdk/MsgSubmitProposal",
    "cosmos-sdk/v1/MsgSubmitProposal",
    "osmosis/smartaccount/add-authenticator",
    "osmosis/smartaccount/remove-authenticator",
    "osmosis/smartaccount/set-active-state",
    "osmosis/smartaccount/tx-extension",
  ])("%s", (type) => {
    expect(describeAminoMsg(type, { granter: SENDER, grantee: OTHER, sender: SENDER })).toBeNull();
    expect(DAPP_DESCRIBERS.has(type)).toBe(false);
  });
});

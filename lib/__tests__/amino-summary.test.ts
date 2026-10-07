/**
 * An Amino prompt says what the kernel says.
 *
 * fixtures/amino-summaries.json holds each message twice, both made by the reference libraries
 * and not by this code (scripts/generate-amino-summaries.mjs): its Amino {type, value} from the
 * converter a CosmJS client signs with (@cosmjs/stargate 0.32.3, osmojs 16.15), and a direct
 * SignDoc around its protobuf. The real kernel, the wasm the build ships, decodes the direct
 * bytes; describeAminoMsg must write the same sentence for the Amino form, so the sign mode a
 * dApp picks does not change what the user reads.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { bech32 } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";

import { DESCRIBED_AMINO_TYPES, describeAminoMsg } from "../amino-summary";
import fixture from "./fixtures/amino-summaries.json";

type Fields = Record<string, unknown>;
type Case = (typeof fixture.cases)[number];

/** The parts of kernel payload v2 (zunia-core 0.1.1) read here, typed locally like lib/kernel.ts does. */
interface KernelMessage {
  typeUrl: string;
  summary: string;
  unknown: boolean;
  recipient?: string;
}

let decode: (signDocHex: string) => { summaries: string[]; messages?: KernelMessage[] };

beforeAll(async () => {
  // ZUNIA_CORE_DIR: a freshly built zunia-core packages/npm, before it is linked in.
  const dir = process.env.ZUNIA_CORE_DIR ?? dirname(createRequire(import.meta.url).resolve("@zunialab/core/package.json"));
  const core = (await import(/* @vite-ignore */ pathToFileURL(join(dir, "index.js")).href)) as typeof import("@zunialab/core");
  core.initZuniaCoreSync({ module: readFileSync(join(dir, "zunia_core_bg.wasm")) });
  decode = (signDocHex) => core.decodeDirectTx(signDocHex);
});

const byName = (name: string): Case => {
  const found = fixture.cases.find((entry) => entry.name === name);
  if (!found) throw new Error(`fixture ${name} missing`);
  return found;
};

/** A deep copy of a fixture entry's Amino value, for a test to break. */
const valueOf = (name: string): Fields => structuredClone(byName(name).amino.value) as Fields;
const at = (value: Fields, key: string): Fields => value[key] as Fields;
const routesOf = (value: Fields): Fields[] => value.routes as Fields[];

const described = fixture.cases.filter((entry) => DESCRIBED_AMINO_TYPES.includes(entry.amino.type));
const notDescribed = fixture.cases.filter((entry) => !DESCRIBED_AMINO_TYPES.includes(entry.amino.type));

describe("the types it reads", () => {
  it("are exactly the staking, vote, transfer and poolmanager messages", () => {
    expect([...DESCRIBED_AMINO_TYPES].sort()).toEqual(
      [
        "cosmos-sdk/MsgDelegate",
        "cosmos-sdk/MsgUndelegate",
        "cosmos-sdk/MsgBeginRedelegate",
        "cosmos-sdk/MsgWithdrawDelegationReward",
        "cosmos-sdk/MsgVote",
        "cosmos-sdk/v1/MsgVote",
        "cosmos-sdk/MsgTransfer",
        "osmosis/poolmanager/swap-exact-amount-in",
        "osmosis/poolmanager/split-amount-in",
        "osmosis/poolmanager/swap-exact-amount-out",
        "osmosis/poolmanager/split-amount-out",
      ].sort(),
    );
    // Every one of them has reference documents.
    expect(new Set(described.map((entry) => entry.amino.type))).toEqual(new Set(DESCRIBED_AMINO_TYPES));
  });

  // A send and a contract call are read by lib/signing.ts, as before 0.1.5.
  it.each(notDescribed.map((entry) => [entry.name, entry] as const))("%s is left to the caller", (_name, entry) => {
    expect(describeAminoMsg(entry.amino.type, entry.amino.value)).toBeNull();
  });

  it("reads nothing for a type it does not know, or a value that is not an object", () => {
    const vote = valueOf("vote_yes");
    for (const type of ["cosmos-sdk/MsgGrant", "cosmos-sdk/MsgVoteWeighted", "constructor", "__proto__", "", "cosmos-sdk/msgvote"]) {
      expect(describeAminoMsg(type, vote)).toBeNull();
    }
    for (const value of [null, undefined, "{}", 7, [vote]]) {
      expect(describeAminoMsg("cosmos-sdk/MsgVote", value)).toBeNull();
    }
  });
});

describe("in the kernel's words", () => {
  it.each(described.map((entry) => [entry.name, entry] as const))("%s: the Amino form reads as the kernel reads the direct form", (_name, entry) => {
    const decoded = decode(entry.signDocHex);
    const kernel = decoded.messages?.[0];
    expect(kernel, "kernel payload v2 (zunia-core 0.1.1 or later)").toBeDefined();
    expect(kernel!.unknown).toBe(false);
    expect(kernel!.summary).toBe(decoded.summaries[0]);
    expect(describeAminoMsg(entry.amino.type, entry.amino.value)).toEqual({
      typeUrl: entry.amino.type,
      summary: kernel!.summary,
      ...(kernel!.recipient === undefined ? {} : { recipient: kernel!.recipient }),
    });
  });

  it("names a transfer's receiver as its recipient, bech32 or not", () => {
    expect(describeAminoMsg("cosmos-sdk/MsgTransfer", valueOf("transfer_packet_forward_memo"))?.recipient).toBe(
      "osmo19rl4cm2hmr8afy4kldpxz3fka4jguq0a5m7df8",
    );
    // Packet-forward and EVM receivers live on another chain and need not be bech32.
    const hex = "0x6a1c6Fd1D9B2Eb5B6a2D9c3b0eF2a8A0A5d1C3e4";
    const value = { ...valueOf("transfer_timestamp_only"), receiver: hex };
    expect(describeAminoMsg("cosmos-sdk/MsgTransfer", value)).toEqual({
      typeUrl: "cosmos-sdk/MsgTransfer",
      summary: `IBC transfer 1000000 uatom to ${hex} over channel-141`,
      recipient: hex,
    });
  });

  it("keeps every digit of an amount, and adds a split swap's legs exactly", () => {
    const delegate = valueOf("delegate");
    at(delegate, "amount").amount = "123456789012345678901234567890";
    expect(describeAminoMsg("cosmos-sdk/MsgDelegate", delegate)?.summary).toBe(
      "Delegate 123456789012345678901234567890 uatom to cosmosvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0ae5egnx",
    );
    const swap = valueOf("split_in");
    routesOf(swap)[0]!.token_in_amount = "99999999999999999999";
    routesOf(swap)[1]!.token_in_amount = "1";
    expect(describeAminoMsg("osmosis/poolmanager/split-amount-in", swap)?.summary).toMatch(/^Swap 100000000000000000000 uosmo for at least /);
  });
});

describe("votes", () => {
  it.each([
    ["VOTE_OPTION_YES", "Yes"],
    ["VOTE_OPTION_ABSTAIN", "Abstain"],
    ["VOTE_OPTION_NO", "No"],
    ["VOTE_OPTION_NO_WITH_VETO", "No with veto"],
  ])("reads the enum name %s as the number's label", (option, label) => {
    expect(describeAminoMsg("cosmos-sdk/MsgVote", { ...valueOf("vote_yes"), option })?.summary).toBe(`Vote ${label} on proposal 848`);
  });

  it.each([0, 5, -1, 1.5, "1", "yes", "VOTE_OPTION_UNSPECIFIED", null, undefined])(
    "marks option %s unknown rather than guessing it",
    (option) => {
      for (const [type, name] of [
        ["cosmos-sdk/MsgVote", "vote_yes"],
        ["cosmos-sdk/v1/MsgVote", "vote_v1_yes"],
      ] as const) {
        const value: Fields = { ...valueOf(name), option };
        expect(describeAminoMsg(type, value)).toEqual({
          typeUrl: type,
          summary: `Vote on proposal ${String(value.proposal_id)} with an unrecognised option`,
          unknown: true,
        });
      }
    },
  );

  it("reads gov v1's metadata as text, and only on gov v1", () => {
    expect(describeAminoMsg("cosmos-sdk/v1/MsgVote", { ...valueOf("vote_v1_yes"), metadata: "" })?.summary).toBe("Vote Yes on proposal 1000");
    expect(describeAminoMsg("cosmos-sdk/v1/MsgVote", { ...valueOf("vote_v1_yes"), metadata: 7 })).toBeNull();
    expect(describeAminoMsg("cosmos-sdk/MsgVote", { ...valueOf("vote_yes"), metadata: "ipfs://x" })).toBeNull();
  });
});

/** A 20-byte bech32 address the decoder accepts, and a 32-byte one where only 20 belong. */
const twenty = bech32.encode("cosmos", bech32.toWords(new Uint8Array(20).fill(7)));
const thirtyTwo = bech32.encode("cosmos", bech32.toWords(new Uint8Array(32).fill(7)));

const MALFORMED: ReadonlyArray<readonly [string, string, (value: Fields) => void]> = [
  ["delegate", "a decimal amount", (v) => {
    at(v, "amount").amount = "1.5";
  }],
  ["delegate", "a padded amount", (v) => {
    at(v, "amount").amount = "007";
  }],
  ["delegate", "an empty amount", (v) => {
    at(v, "amount").amount = "";
  }],
  ["delegate", "a numeric amount", (v) => {
    at(v, "amount").amount = 5000000;
  }],
  ["delegate", "an amount past 256 bits", (v) => {
    at(v, "amount").amount = "1".repeat(79);
  }],
  ["delegate", "a two-letter denom", (v) => {
    at(v, "amount").denom = "ua";
  }],
  ["delegate", "a denom starting with a digit", (v) => {
    at(v, "amount").denom = "1uatom";
  }],
  ["delegate", "a denom with a space", (v) => {
    at(v, "amount").denom = "u atom";
  }],
  ["delegate", "a list of coins", (v) => {
    v.amount = [at(v, "amount")];
  }],
  ["delegate", "no validator", (v) => {
    delete v.validator_address;
  }],
  ["delegate", "a validator with a NUL inside", (v) => {
    v.validator_address = "cosmosvaloper19rl4cm2hmr8afy4k\u0000ldpxz3fka4jguq0ae5egnx";
  }],
  ["delegate", "a validator with a bidi override", (v) => {
    v.validator_address = `\u202e${String(v.validator_address)}`;
  }],
  ["delegate", "a delegator that is not bech32", (v) => {
    v.delegator_address = "cosmos1notanaddress";
  }],
  ["delegate", "a delegator with a broken checksum", (v) => {
    v.delegator_address = String(v.delegator_address).replace(/l4$/, "l5");
  }],
  ["delegate", "a 32-byte delegator", (v) => {
    v.delegator_address = thirtyTwo;
  }],
  ["undelegate", "no amount", (v) => {
    delete v.amount;
  }],
  ["redelegate", "an empty destination", (v) => {
    v.validator_dst_address = "";
  }],
  ["redelegate", "no source", (v) => {
    delete v.validator_src_address;
  }],
  ["claim_rewards", "no validator", (v) => {
    delete v.validator_address;
  }],
  ["claim_rewards", "a numeric delegator", (v) => {
    v.delegator_address = 7;
  }],
  ["vote_yes", "proposal 0", (v) => {
    v.proposal_id = "0";
  }],
  ["vote_yes", "a proposal id that is not a number", (v) => {
    v.proposal_id = "848a";
  }],
  ["vote_yes", "a numeric proposal id", (v) => {
    v.proposal_id = 848;
  }],
  ["vote_yes", "a proposal id past u64", (v) => {
    v.proposal_id = "18446744073709551616";
  }],
  ["vote_v1_yes", "a voter that is not bech32", (v) => {
    v.voter = "cosmos1voter";
  }],
  ["transfer_timestamp_only", "a token in scientific notation", (v) => {
    at(v, "token").amount = "1e6";
  }],
  ["transfer_timestamp_only", "no token", (v) => {
    delete v.token;
  }],
  ["transfer_timestamp_only", "an empty channel", (v) => {
    v.source_channel = "";
  }],
  ["transfer_timestamp_only", "a channel with a space", (v) => {
    v.source_channel = "channel 141";
  }],
  ["transfer_timestamp_only", "no port", (v) => {
    delete v.source_port;
  }],
  ["transfer_timestamp_only", "an empty receiver", (v) => {
    v.receiver = "";
  }],
  ["transfer_timestamp_only", "a receiver with a line break", (v) => {
    v.receiver = "osmo1abc\nosmo1def";
  }],
  ["transfer_timestamp_only", "a sender that is not bech32", (v) => {
    v.sender = "cosmos1sender";
  }],
  ["transfer_timestamp_only", "a numeric timestamp", (v) => {
    v.timeout_timestamp = 1791400000000000000;
  }],
  ["transfer_timestamp_only", "a negative timestamp", (v) => {
    v.timeout_timestamp = "-1";
  }],
  ["transfer_with_height", "a height that is text", (v) => {
    v.timeout_height = "1-20000000";
  }],
  ["transfer_with_height", "a height past u64", (v) => {
    at(v, "timeout_height").revision_height = "18446744073709551616";
  }],
  ["transfer_packet_forward_memo", "a memo that is an object", (v) => {
    v.memo = { forward: {} };
  }],
  ["swap_exact_in", "no routes", (v) => {
    v.routes = [];
  }],
  ["swap_exact_in", "routes that are not a list", (v) => {
    v.routes = routesOf(v)[0];
  }],
  ["swap_exact_in", "pool 0", (v) => {
    routesOf(v)[0]!.pool_id = "0";
  }],
  ["swap_exact_in", "a decimal pool id", (v) => {
    routesOf(v)[0]!.pool_id = "3586.0";
  }],
  ["swap_exact_in", "a numeric pool id", (v) => {
    routesOf(v)[0]!.pool_id = 3586;
  }],
  ["swap_exact_in", "an invalid output denom", (v) => {
    routesOf(v)[0]!.token_out_denom = "x";
  }],
  ["swap_exact_in", "nothing in", (v) => {
    at(v, "token_in").amount = "0";
  }],
  ["swap_exact_in", "a minimum of 0", (v) => {
    v.token_out_min_amount = "0";
  }],
  ["swap_exact_in", "no minimum", (v) => {
    delete v.token_out_min_amount;
  }],
  ["swap_exact_in", "nine pools", (v) => {
    v.routes = Array.from({ length: 9 }, () => routesOf(v)[0]);
  }],
  ["swap_exact_in", "a sender that is not bech32", (v) => {
    v.sender = "osmo1sender";
  }],
  ["split_in", "no legs", (v) => {
    v.routes = [];
  }],
  ["split_in", "a leg without pools", (v) => {
    routesOf(v)[0]!.pools = [];
  }],
  ["split_in", "a leg spending nothing", (v) => {
    routesOf(v)[1]!.token_in_amount = "0";
  }],
  ["split_in", "legs ending in different denoms", (v) => {
    (routesOf(v)[1]!.pools as Fields[])[0]!.token_out_denom = "uion";
  }],
  ["split_in", "the same pools twice", (v) => {
    routesOf(v)[1]!.pools = routesOf(v)[0]!.pools;
  }],
  ["split_in", "seventeen legs", (v) => {
    v.routes = Array.from({ length: 17 }, (_, i) => ({ pools: [{ pool_id: String(i + 1), token_out_denom: "uion" }], token_in_amount: "1" }));
  }],
  ["split_in", "an invalid input denom", (v) => {
    v.token_in_denom = "";
  }],
  ["split_in", "a minimum of 0", (v) => {
    v.token_out_min_amount = "0";
  }],
  ["swap_exact_out", "a ceiling of 0", (v) => {
    v.token_in_max_amount = "0";
  }],
  ["swap_exact_out", "nothing out", (v) => {
    at(v, "token_out").amount = "0";
  }],
  ["swap_exact_out", "no routes", (v) => {
    delete v.routes;
  }],
  ["swap_exact_out", "an exact-in hop", (v) => {
    v.routes = [{ pool_id: "3586", token_out_denom: "uosmo" }];
  }],
  ["split_out", "legs spending different denoms", (v) => {
    (routesOf(v)[1]!.pools as Fields[])[0]!.token_in_denom = "uion";
  }],
  ["split_out", "a leg delivering nothing", (v) => {
    routesOf(v)[0]!.token_out_amount = "0";
  }],
  ["split_out", "the same pools twice", (v) => {
    routesOf(v)[1]!.pools = routesOf(v)[0]!.pools;
  }],
  ["split_out", "an invalid output denom", (v) => {
    v.token_out_denom = "ibc/27394FB0 92D2";
  }],
  ["split_out", "no ceiling", (v) => {
    delete v.token_in_max_amount;
  }],
];

describe("a document that is not in the chain's Amino shape", () => {
  it.each(MALFORMED.map(([name, what, breakIt]) => [name, what, breakIt] as const))("%s with %s is left to the generic summary", (name, _what, breakIt) => {
    const entry = byName(name);
    const value = valueOf(name);
    // The unbroken document is described, so the null below is the break's doing.
    expect(describeAminoMsg(entry.amino.type, value)).not.toBeNull();
    breakIt(value);
    expect(describeAminoMsg(entry.amino.type, value)).toBeNull();
  });

  it("reads any 20-byte account, not only the test key's", () => {
    const value = { ...valueOf("claim_rewards"), delegator_address: twenty };
    expect(describeAminoMsg("cosmos-sdk/MsgWithdrawDelegationReward", value)?.summary).toBe(
      "Claim staking rewards from cosmosvaloper19rl4cm2hmr8afy4kldpxz3fka4jguq0ae5egnx",
    );
  });
});

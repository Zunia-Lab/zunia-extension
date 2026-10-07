import { describe, expect, it } from "vitest";

import { cosmWasmActionName, hasUnreadableContractAction, isPlainContractAction } from "../nft";
import { summarizeAminoMsgs } from "../signing";

/**
 * A contract message's top-level key is quoted in the signing prompt
 * (`Execute "{action}" on …`). zunia-core 0.1.1 names it only when it is a
 * plain name and otherwise reads the call as unknown, so the blind-signing gate
 * refuses it in direct mode. The Amino path must do the same: a key carrying a
 * right-to-left override or a line separator could otherwise reorder or split
 * the sentence the user approves.
 */
const CONTRACT = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";
const RLO = String.fromCharCode(0x202e);
const LINE_SEPARATOR = String.fromCharCode(0x2028);

function amino(msg: unknown) {
  return summarizeAminoMsgs([
    {
      type: "wasm/MsgExecuteContract",
      value: { sender: "osmo1qx8te2rzsdyj47q2hswzclqc52gp9nju5wq0qe", contract: CONTRACT, msg, funds: [] },
    },
  ])[0];
}

describe("contract action names", () => {
  it("accepts the names contracts use", () => {
    for (const key of ["swap", "osmosis_swap", "send_nft", "increase-allowance", "Recover2", "a".repeat(128)]) {
      expect(isPlainContractAction(key)).toBe(true);
    }
  });

  it("refuses keys that could rewrite the prompt", () => {
    for (const key of ["", "a".repeat(129), `swap${RLO}lla`, `swap${LINE_SEPARATOR}send`, 'swap" on osmo1evil', "swap now", "swäp"]) {
      expect(isPlainContractAction(key)).toBe(false);
    }
  });

  it("names a plain action and never quotes another", () => {
    expect(cosmWasmActionName({ swap: {} })).toBe("swap");
    expect(cosmWasmActionName({ [`swap${RLO}`]: {} })).toBeNull();
    expect(cosmWasmActionName({ a: {}, b: {} })).toBeNull();
    expect(hasUnreadableContractAction({ [`swap${RLO}`]: {} })).toBe(true);
    expect(hasUnreadableContractAction({ swap: {} })).toBe(false);
    expect(hasUnreadableContractAction({ a: {}, b: {} })).toBe(false);
  });

  it("an Amino call with a plain action reads like the kernel and stays approvable", () => {
    const message = amino({ recover: {} });
    expect(message?.summary).toBe(`Execute "recover" on ${CONTRACT}`);
    expect(message?.unknown).toBeFalsy();
  });

  it("an Amino call whose action carries a bidi override or a line separator is unknown and never quoted", () => {
    for (const key of [`swap${RLO}tnuocca_ruoy`, `swap${LINE_SEPARATOR}to osmo1evil`]) {
      const message = amino({ [key]: {} });
      expect(message?.unknown).toBe(true);
      expect(message?.summary).not.toContain(RLO);
      expect(message?.summary).not.toContain(LINE_SEPARATOR);
      expect(message?.summary).toBe(`Execute a contract call on ${CONTRACT} that Zunia could not read`);
    }
  });
});

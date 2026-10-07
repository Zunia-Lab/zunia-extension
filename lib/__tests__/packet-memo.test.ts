/**
 * lib/packet-memo.ts: where a transfer's packet memo sends the tokens, read the way
 * packet-forward-middleware and ibc-hooks read it (Go's encoding/json), or not named at all.
 */
import { describe, expect, it } from "vitest";

import { PACKET_MEMO_UNREADABLE, packetMemoNote, readPacketMemo } from "../packet-memo";

const STRIDE = "stride19rl4cm2hmr8afy4kldpxz3fka4jguq0altdpte";
const JUNO = "juno1qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qurswpc8qursaq28r5";
const XCS = "osmo1uwk8xc6q0s6t5qcpr6rht3sczu6du83xq8pwxjua0hfj5hzcnh3sqxwvxs";

const forward = (receiver: string, channel: string, extra: Record<string, unknown> = {}) => ({
  forward: { receiver, port: "transfer", channel, ...extra },
});

describe("packetMemoNote names where the memo sends the tokens", () => {
  it("one packet-forward hop", () => {
    expect(packetMemoNote(JSON.stringify(forward(STRIDE, "channel-5")))).toBe(
      `The packet memo forwards the tokens from the receiving chain over channel-5 to ${STRIDE}.`,
    );
  });

  it("every hop of a multi-hop route, with next as an object or as a JSON string", () => {
    const route = forward("pfm", "channel-5", { next: forward(JUNO, "channel-42") });
    const sentence = `The packet memo forwards the tokens from the receiving chain over channel-5 to pfm, then over channel-42 to ${JUNO}.`;
    expect(packetMemoNote(JSON.stringify(route))).toBe(sentence);
    const asString = forward("pfm", "channel-5", { next: JSON.stringify(forward(JUNO, "channel-42")) });
    expect(packetMemoNote(JSON.stringify(asString))).toBe(sentence);
  });

  it("the contract an ibc-hooks memo calls, on the receiving chain or after a hop", () => {
    const hook = { wasm: { contract: XCS, msg: { osmosis_swap: { output_denom: "uatom" } } } };
    expect(packetMemoNote(JSON.stringify(hook))).toBe(
      `The packet memo hands the tokens to contract ${XCS} on the receiving chain.`,
    );
    expect(packetMemoNote(JSON.stringify(forward(XCS, "channel-141", { next: hook })))).toBe(
      `The packet memo forwards the tokens from the receiving chain over channel-141 to ${XCS}, then hands them to contract ${XCS} there.`,
    );
  });

  it("a whitespace-padded memo as encoding/json reads it", () => {
    const padded = `{"forward":{${" ".repeat(12_500)}"receiver":"${STRIDE}","port":"transfer","channel":"channel-5"}}`;
    expect(packetMemoNote(padded)).toBe(
      `The packet memo forwards the tokens from the receiving chain over channel-5 to ${STRIDE}.`,
    );
  });

  it("names four steps of a longer route, then says it goes on", () => {
    let route: Record<string, unknown> = forward(JUNO, "channel-9");
    for (const channel of ["channel-4", "channel-3", "channel-2", "channel-1"]) route = forward("pfm", channel, { next: route });
    expect(readPacketMemo(JSON.stringify(route))).toMatchObject({ readable: true, more: true });
    expect(packetMemoNote(JSON.stringify(route))).toBe(
      "The packet memo forwards the tokens from the receiving chain over channel-1 to pfm, then over channel-2 to pfm, then over channel-3 to pfm, then over channel-4 to pfm, and on from there.",
    );
  });

  it("says nothing more for a memo no middleware acts on", () => {
    for (const memo of ["thanks for lunch", "42", '"forward"', "[]", "{}", '{"note":"hi"}', '{"forward":null}', '{"ibc_callback":"osmo1x"}']) {
      expect(packetMemoNote(memo)).toBeNull();
      expect(readPacketMemo(memo)).toEqual({ steps: [], readable: true, more: false });
    }
  });
});

describe("packetMemoNote names nothing it could misread", () => {
  it.each([
    ["a receiver spelled twice, the chain reading the last", `{"forward":{"receiver":"cosmos1me","port":"transfer","channel":"channel-5","Receiver":"${STRIDE}"}}`],
    ["a forward spelled in capitals", `{"FORWARD":{"receiver":"${STRIDE}","port":"transfer","channel":"channel-5"}}`],
    ["a second hook spelled with a long s", `{"forward":{"receiver":"${XCS}","port":"transfer","channel":"channel-5","next":{"wasm":{"contract":"${XCS}","msg":{},"m\u017fg":{}}}}}`],
    ["a dotless i in receiver", `{"forward":{"receiver":"cosmos1me","port":"transfer","channel":"channel-5","rece\u0131ver":"${STRIDE}"}}`],
    ["a dotted capital I in receiver", `{"forward":{"receiver":"cosmos1me","port":"transfer","channel":"channel-5","RECE\u0130VER":"${STRIDE}"}}`],
    ["a long s in wasm", `{"wa\u017fm":{"contract":"${XCS}","msg":{}}}`],
    ["a channel that is not one", `{"forward":{"receiver":"${STRIDE}","port":"transfer","channel":"channel-5 to cosmos1me"}}`],
    ["a receiver with a bidi override", `{"forward":{"receiver":"${STRIDE}\u202e","port":"transfer","channel":"channel-5"}}`],
    ["a receiver with a space", `{"forward":{"receiver":"cosmos1me or ${STRIDE}","port":"transfer","channel":"channel-5"}}`],
    ["a forward that is not an object", `{"forward":"${STRIDE}"}`],
    ["a forward missing its receiver", `{"forward":{"port":"transfer","channel":"channel-5"}}`],
    ["a wasm hook that is not an object", `{"wasm":null}`],
    ["a wasm hook without a contract", `{"wasm":{"msg":{}}}`],
    ["a forward and a hook at one level", `{"forward":{"receiver":"${STRIDE}","port":"transfer","channel":"channel-5"},"wasm":{"contract":"${XCS}","msg":{}}}`],
    ["a next that is not JSON", `{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-5","next":"{nope"}}`],
    ["an unreadable second hop", `{"forward":{"receiver":"pfm","port":"transfer","channel":"channel-5","next":{"forward":{"receiver":"${JUNO}","channel":"7"}}}}`],
  ])("%s", (_name, memo) => {
    expect(packetMemoNote(memo)).toBe(PACKET_MEMO_UNREADABLE);
    expect(readPacketMemo(memo).steps).toEqual([]);
  });

  it("reads a duplicate key as encoding/json does: the last one", () => {
    const memo = `{"forward":{"receiver":"cosmos1me","port":"transfer","channel":"channel-5","receiver":"${STRIDE}"}}`;
    expect(readPacketMemo(memo).steps).toEqual([{ kind: "forward", channel: "channel-5", receiver: STRIDE }]);
  });

  it("reads only the memo's own fields, never inherited ones", () => {
    const memo = `{"__proto__":{"forward":{"receiver":"${STRIDE}","port":"transfer","channel":"channel-5"}}}`;
    expect(readPacketMemo(memo)).toEqual({ steps: [], readable: true, more: false });
  });
});

/**
 * Where a transfer's packet memo sends the tokens, read the way the receiving chain reads it.
 *
 * An ICS20 memo is not for the receiver: middleware on the receiving chain acts on the tokens
 * before the receiver holds them.
 * - packet-forward-middleware's `{"forward":{"receiver","port","channel","next"}}` sends them on
 *   over `channel` to `receiver`, and from there wherever `next` says;
 * - ibc-hooks' `{"wasm":{"contract","msg"}}` hands them to `contract` along with `msg`.
 * So the receiver a transfer's sentence names may never hold them. {@link packetMemoNote} says
 * where the memo sends them, for the signing prompt, which also shows the memo whole.
 *
 * Both middlewares read the memo with Go's encoding/json, which matches a struct field's name
 * case-insensitively and reads U+017F (long s), U+212A (Kelvin sign), U+0131 (dotless i) and
 * U+0130 (capital I with a dot) as `s`, `k`, `i` and `i`, where JSON.parse matches exactly:
 * `{"forward":{"receiver":"a","Receiver":"b"}}` forwards to `b`. So a memo that spells a field it
 * acts on two ways, or names a channel, receiver or contract the prompt cannot show as it is, is
 * not named: the user is told to read it instead.
 */

/** A step the memo has the tokens take on the receiving chain, or on a chain it forwards them to. */
export type PacketMemoStep =
  | { readonly kind: "forward"; readonly channel: string; readonly receiver: string }
  | { readonly kind: "wasm"; readonly contract: string };

export interface PacketMemoReading {
  /** The steps in the order they happen. Empty for a memo no middleware acts on. */
  readonly steps: readonly PacketMemoStep[];
  /** False when the memo holds instructions that could not be read the way the chain reads them. */
  readonly readable: boolean;
  /** True when the route goes on past the last step named ({@link MAX_STEPS}). */
  readonly more: boolean;
}

/** The most steps named in one sentence; a longer route ends in "and on from there". */
const MAX_STEPS = 4;

/** The fields each level of a memo is read for. A spelling of one of them that Go would match too is ambiguous. */
const LEVEL_FIELDS: readonly string[] = ["forward", "wasm"];
const FORWARD_FIELDS: readonly string[] = ["receiver", "port", "channel", "timeout", "retries", "next"];
const WASM_FIELDS: readonly string[] = ["contract", "msg"];

/** An IBC channel identifier as packet-forward-middleware takes one. */
const CHANNEL = /^channel-\d{1,20}$/;

/** An address on another chain the prompt can show as it is: printable ASCII, no space (zunia-core `is_renderable_address`). */
const SHOWN_ADDRESS = /^[\x21-\x7e]{1,128}$/;

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Fields) : null;
}

/** A field the memo itself holds, never one an object inherits. */
function own(object: Fields, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** A JSON key as Go's encoding/json compares it with a field name (fold.go, `foldName`). */
function goFold(key: string): string {
  return key
    .replace(/[\u0130\u0131]/g, "i")
    .replace(/\u017f/g, "s")
    .replace(/\u212a/g, "k")
    .replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Whether every key Go would read as one of `names` is spelled exactly as that name. */
function spelledOnce(object: Fields, names: readonly string[]): boolean {
  return Object.keys(object).every((key) => {
    const folded = goFold(key);
    return folded === key || !names.includes(folded);
  });
}

/**
 * Read one level of instructions into `steps`: the memo itself, or a forward's `next`, which
 * packet-forward-middleware also takes as a JSON string. False when the level cannot be read
 * the way the chain reads it.
 */
function readLevel(value: unknown, steps: PacketMemoStep[]): { readable: boolean; more: boolean } {
  const unreadable = { readable: false, more: false };
  let level = value;
  if (typeof level === "string") {
    try {
      level = JSON.parse(level) as unknown;
    } catch {
      return unreadable;
    }
  }
  const object = fields(level);
  if (!object || !spelledOnce(object, LEVEL_FIELDS)) return unreadable;
  const forward = own(object, "forward");
  // ibc-hooks acts on a memo that has the key at all; packet-forward-middleware on one whose
  // value is not null.
  const hooked = Object.hasOwn(object, "wasm");
  const forwarded = forward !== undefined && forward !== null;
  // Both at one level: what happens depends on the order of the chain's middleware.
  if (forwarded && hooked) return unreadable;

  if (hooked) {
    const hook = fields(own(object, "wasm"));
    const contract = hook ? own(hook, "contract") : undefined;
    if (!hook || !spelledOnce(hook, WASM_FIELDS) || typeof contract !== "string" || !SHOWN_ADDRESS.test(contract)) {
      return unreadable;
    }
    steps.push({ kind: "wasm", contract });
    return { readable: true, more: false };
  }
  if (!forwarded) return { readable: true, more: false };

  const hop = fields(forward);
  if (!hop || !spelledOnce(hop, FORWARD_FIELDS)) return unreadable;
  const channel = own(hop, "channel");
  const receiver = own(hop, "receiver");
  if (typeof channel !== "string" || !CHANNEL.test(channel) || typeof receiver !== "string" || !SHOWN_ADDRESS.test(receiver)) {
    return unreadable;
  }
  steps.push({ kind: "forward", channel, receiver });
  const next = own(hop, "next");
  if (next === undefined || next === null) return { readable: true, more: false };
  if (steps.length === MAX_STEPS) return { readable: true, more: true };
  return readLevel(next, steps);
}

/**
 * What a packet memo has the receiving chain do with the tokens. A memo that is not a JSON
 * object is one no middleware acts on: no steps, and nothing unreadable about it.
 */
export function readPacketMemo(memo: string): PacketMemoReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(memo) as unknown;
  } catch {
    return { steps: [], readable: true, more: false };
  }
  if (!fields(parsed)) return { steps: [], readable: true, more: false };
  const steps: PacketMemoStep[] = [];
  const { readable, more } = readLevel(parsed, steps);
  return readable ? { steps, readable, more } : { steps: [], readable, more: false };
}

/** Told when a memo holds instructions {@link readPacketMemo} could not read the way the chain does. */
export const PACKET_MEMO_UNREADABLE =
  "Zunia cannot tell where this packet memo sends the tokens. Read it under Raw transaction before you approve.";

/**
 * Where a packet memo sends the tokens, in one sentence for the signing prompt:
 * `The packet memo forwards the tokens from the receiving chain over channel-5 to stride1…`.
 * {@link PACKET_MEMO_UNREADABLE} for a memo that cannot be read the way the chain reads it, and
 * null for one that sends them nowhere.
 */
export function packetMemoNote(memo: string): string | null {
  const { steps, readable, more } = readPacketMemo(memo);
  if (!readable) return PACKET_MEMO_UNREADABLE;
  if (steps.length === 0) return null;
  const said = steps.map((step, index) => {
    const first = index === 0;
    if (step.kind === "forward") {
      return `${first ? "forwards the tokens from the receiving chain " : ""}over ${step.channel} to ${step.receiver}`;
    }
    return first
      ? `hands the tokens to contract ${step.contract} on the receiving chain`
      : `hands them to contract ${step.contract} there`;
  });
  return `The packet memo ${said.join(", then ")}${more ? ", and on from there" : ""}.`;
}

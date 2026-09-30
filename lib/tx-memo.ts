/**
 * Transaction-body memos Zunia writes when the user leaves the field empty.
 *
 * This is the Cosmos `tx.body.memo`, visible on explorers. It is never written
 * onto an ICS20 / PFM / ibc-hooks packet memo: those are protocol JSON and
 * live on the message.
 */

import { displayCoinSymbol, findCurrency } from "./chain-catalog";
import { baseDenomOf } from "./coin-display";
import { shortDenom } from "./format";

export const ZUNIA_WALLET_TAG = "by Zunia-wallet";

/** Amino `type` or proto `typeUrl`, plus the message value. */
export interface MemoSourceMsg {
  readonly type?: string;
  readonly typeUrl?: string;
  readonly value?: Record<string, unknown>;
}

const MAX_MEMO_CHARS = 256;

/**
 * Keep a user-written memo. When they left it blank, write a type-specific
 * Zunia default that always ends with {@link ZUNIA_WALLET_TAG}.
 */
export function resolveTxMemo(
  userMemo: string | null | undefined,
  msgs: readonly MemoSourceMsg[],
): string {
  const custom = (userMemo ?? "").trim();
  if (custom) return custom;
  return defaultTxMemo(msgs);
}

/** Default memo for a wallet-originated transaction, from its messages. */
export function defaultTxMemo(msgs: readonly MemoSourceMsg[]): string {
  return withTag(phraseFor(msgs));
}

function withTag(phrase: string): string {
  const tag = ` · ${ZUNIA_WALLET_TAG}`;
  if (phrase.length + tag.length <= MAX_MEMO_CHARS) return `${phrase}${tag}`;
  const keep = MAX_MEMO_CHARS - tag.length - 1;
  return `${phrase.slice(0, Math.max(keep, 1))}…${tag}`;
}

function phraseFor(msgs: readonly MemoSourceMsg[]): string {
  if (msgs.length === 0) return "Signed";
  const phrases = msgs.map(phraseForOne);
  if (phrases.length > 1 && phrases.every((line) => line.startsWith("Claim rewards"))) {
    return "Claim rewards";
  }
  return phrases[0] ?? "Signed";
}

function phraseForOne(msg: MemoSourceMsg): string {
  const kind = messageKind(msg);
  const value = msg.value ?? {};
  const symbol = tokenSymbol(firstCoinDenom(value));

  switch (kind) {
    case "send":
      return labeled("Send", symbol);
    case "ibc":
      return labeled("IBC transfer", symbol);
    case "ibc-forward":
      return labeled("IBC forward", symbol);
    case "swap":
      return labeled("Swap", symbol);
    case "stake":
      return labeled("Stake", symbol);
    case "unstake":
      return labeled("Unstake", symbol);
    case "redelegate":
      return labeled("Redelegate", symbol);
    case "claim":
      return "Claim rewards";
    case "vote":
      return votePhrase(value);
    case "nft":
      return "NFT transfer";
    case "nft-ibc":
      return "NFT IBC send";
    case "recover":
      return "Recover funds";
    case "contract":
      return "Contract call";
    default:
      return "Signed";
  }
}

function labeled(action: string, symbol: string | null): string {
  return symbol ? `${action} ${symbol}` : action;
}

type MemoKind =
  | "send"
  | "ibc"
  | "ibc-forward"
  | "swap"
  | "stake"
  | "unstake"
  | "redelegate"
  | "claim"
  | "vote"
  | "nft"
  | "nft-ibc"
  | "recover"
  | "contract"
  | "other";

function messageKind(msg: MemoSourceMsg): MemoKind {
  const type = `${msg.typeUrl ?? ""} ${msg.type ?? ""}`.toLowerCase();
  if (type.includes("beginredelegate")) return "redelegate";
  if (type.includes("undelegate")) return "unstake";
  if (type.includes("delegate") && !type.includes("withdraw")) return "stake";
  if (type.includes("withdrawdelegat") || type.includes("withdrawdelegationreward")) {
    return "claim";
  }
  if (type.includes("msgvote") || type.endsWith("/vote")) return "vote";
  if (type.includes("msgsend") || type.includes("multisend")) return "send";
  if (type.includes("msgtransfer") || type.includes("ibc.applications.transfer")) {
    const packet = packetMemoKind(msg.value ?? {});
    if (packet === "swap") return "swap";
    if (packet === "forward") return "ibc-forward";
    return "ibc";
  }
  if (type.includes("executecontract") || type.includes("wasm/msgexecute")) {
    const action = wasmAction(msg.value ?? {});
    if (action === "transfer_nft") return "nft";
    if (action === "send_nft") return "nft-ibc";
    if (action === "recover" || action === "recover_failed" || action === "retrieve") {
      return "recover";
    }
    return "contract";
  }
  return "other";
}

function packetMemoKind(value: Record<string, unknown>): "swap" | "forward" | null {
  const memo = value.memo;
  if (typeof memo !== "string" || !memo.trim()) return null;
  try {
    const parsed = JSON.parse(memo) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.wasm) return "swap";
    if (parsed.forward) return "forward";
  } catch {
    /* Plain text on the packet is not a Zunia default. Leave it alone. */
  }
  return null;
}

function wasmAction(value: Record<string, unknown>): string | null {
  const parsed = decodeWasmMsg(value.msg);
  if (!parsed) return null;
  const keys = Object.keys(parsed);
  return keys[0] ?? null;
}

function decodeWasmMsg(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string" || !raw) return null;
  const asJson = tryJson(raw);
  if (asJson) return asJson;
  try {
    return tryJson(atob(raw));
  } catch {
    return null;
  }
}

function tryJson(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function votePhrase(value: Record<string, unknown>): string {
  const id = text(value.proposal_id) || text(value.proposalId);
  const option = voteLabel(value.option);
  if (id && option) return `Vote ${option} on #${id}`;
  if (option) return `Vote ${option}`;
  if (id) return `Vote on #${id}`;
  return "Vote";
}

function voteLabel(option: unknown): string | null {
  if (typeof option === "number") {
    return { 1: "Yes", 2: "Abstain", 3: "No", 4: "Veto" }[option] ?? null;
  }
  const raw = String(option ?? "")
    .trim()
    .toUpperCase()
    .replace(/^VOTE_OPTION_/, "")
    .replace(/_WITH_VETO$/, "");
  if (raw === "YES") return "Yes";
  if (raw === "NO") return "No";
  if (raw === "ABSTAIN") return "Abstain";
  if (raw === "VETO" || raw === "NO_WITH_VETO") return "Veto";
  return null;
}

function firstCoinDenom(value: Record<string, unknown>): string | undefined {
  if (isCoin(value.token)) return value.token.denom;
  if (isCoin(value.amount)) return value.amount.denom;
  if (Array.isArray(value.amount) && isCoin(value.amount[0])) return value.amount[0].denom;
  return undefined;
}

function isCoin(value: unknown): value is { denom: string; amount?: string } {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as { denom?: unknown }).denom === "string" &&
    Boolean((value as { denom: string }).denom)
  );
}

function tokenSymbol(denom: string | undefined): string | null {
  if (!denom) return null;
  const base = baseDenomOf(denom);
  const known = findCurrency(base);
  if (known) return displayCoinSymbol(known.currency.coinDenom, known.entry.bech32Prefix);
  if (base.startsWith("factory/")) {
    const name = base.split("/").pop();
    return name && name.length <= 20 ? name : "factory token";
  }
  if (base.startsWith("ibc/")) return shortDenom(base);
  return base.length <= 16 ? base : shortDenom(base);
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

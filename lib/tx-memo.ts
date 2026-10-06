/**
 * Transaction-body memos Zunia writes when the user leaves the field empty.
 *
 * This is the Cosmos `tx.body.memo`, visible on explorers and permanent, so a
 * token is named in it only when its identity is proven on the chain that
 * signs (`Send USDC.n` for Noble's own USDC, never the `USDC.axl` a base-denom
 * lookup used to pick). A token nothing proves gets the generic phrase
 * (`IBC transfer`). It is never written onto an ICS20 / PFM / ibc-hooks packet
 * memo: those are protocol JSON and live on the message, and nothing here
 * writes to a message.
 */

import { CHAIN_CATALOG, currenciesOf, denomsMatch } from "./chain-catalog";
import { baseDenomOf } from "./coin-display";
import { identityOf, type TokenIdentity } from "./token-identity";

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
 *
 * `chainId` is the chain that signs `msgs`: their coin denoms are its bank
 * denoms, so it is what names them (`ibc/498A…` on Osmosis is `USDC.n`,
 * `uusdc` on Noble is `USDC.n`). Without it, a plain denom is named only when
 * every bundled chain that could be signing it agrees on its ticker: for a
 * stake, the chains whose staking coin it is (Earn and Governance pass no
 * chain, and staking `uusdc` is Noble's); otherwise every chain that lists
 * it. A voucher, or a denom two issuers name differently (`uusdc` in a send,
 * `uluna`), gets the generic phrase. Pass the same `chainId` wherever the same
 * memo is previewed and signed, so the two cannot differ.
 */
export function resolveTxMemo(
  userMemo: string | null | undefined,
  msgs: readonly MemoSourceMsg[],
  chainId?: string,
): string {
  const custom = (userMemo ?? "").trim();
  if (custom) return custom;
  return defaultTxMemo(msgs, chainId);
}

/** Default memo for a wallet-originated transaction, from its messages; see {@link resolveTxMemo}. */
export function defaultTxMemo(msgs: readonly MemoSourceMsg[], chainId?: string): string {
  return withTag(phraseFor(msgs, chainId));
}

function withTag(phrase: string): string {
  const tag = ` · ${ZUNIA_WALLET_TAG}`;
  if (phrase.length + tag.length <= MAX_MEMO_CHARS) return `${phrase}${tag}`;
  const keep = MAX_MEMO_CHARS - tag.length - 1;
  return `${phrase.slice(0, Math.max(keep, 1))}…${tag}`;
}

/**
 * A transaction is named by its first message. Several reward claims read as
 * one claim. A swap is signed first, with Zunia's fee (a bank send of the
 * token sold, lib/swap-fee.ts) after it, so its memo names the swap (`Swap
 * OSMO to ATOM`) and never the fee beside it: the fee is not what the user
 * set out to do, and the confirm screen shows it on its own row.
 */
function phraseFor(msgs: readonly MemoSourceMsg[], chainId: string | undefined): string {
  if (msgs.length === 0) return "Signed";
  const phrases = msgs.map((msg) => phraseForOne(msg, chainId));
  if (phrases.length > 1 && phrases.every((line) => line.startsWith("Claim rewards"))) {
    return "Claim rewards";
  }
  return phrases[0] ?? "Signed";
}

function phraseForOne(msg: MemoSourceMsg, chainId: string | undefined): string {
  const kind = messageKind(msg);
  const value = msg.value ?? {};
  const symbol = tokenSymbol(firstCoinDenom(value), chainId, kind);

  switch (kind) {
    case "send":
      return labeled("Send", symbol);
    case "ibc":
      return labeled("IBC transfer", symbol);
    case "ibc-forward":
      return labeled("IBC forward", symbol);
    case "swap":
      return labeled("Swap", symbol);
    case "swap-call":
      return swapCallPhrase(value, chainId);
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

/**
 * A swap signed as one `MsgExecuteContract` on the chain holding the funds
 * (Swap's venue-origin path, `{"osmosis_swap":{…}}` on Osmosis): `Swap OSMO
 * to ATOM`. Both tokens are named as the signing chain names them, the coin
 * in `funds` and the contract's `output_denom` alike, and only when both are
 * proven: one the memo cannot name leaves the generic `Contract call`, never
 * half a pair or a ticker someone chose.
 */
function swapCallPhrase(value: Record<string, unknown>, chainId: string | undefined): string {
  const swap = swapCallOf(value);
  if (!swap) return "Contract call";
  const sold = tokenSymbol(swap.soldDenom, chainId, "swap-call");
  const bought = tokenSymbol(swap.outputDenom, chainId, "swap-call");
  return sold && bought ? `Swap ${sold} to ${bought}` : "Contract call";
}

/**
 * The two denoms of a crosschain-swaps call: the one coin it pays with and
 * the `output_denom` it asks for. `null` for any other shape, which the
 * contract would refuse anyway (it takes exactly one coin).
 */
function swapCallOf(value: Record<string, unknown>): { soldDenom: string; outputDenom: string } | null {
  const msg = decodeWasmMsg(value.msg);
  if (!msg || Object.keys(msg).length !== 1) return null;
  const swap = msg.osmosis_swap;
  if (!swap || typeof swap !== "object" || Array.isArray(swap)) return null;
  const outputDenom = (swap as { output_denom?: unknown }).output_denom;
  const funds = value.funds;
  if (typeof outputDenom !== "string" || !outputDenom) return null;
  if (!Array.isArray(funds) || funds.length !== 1 || !isCoin(funds[0])) return null;
  return { soldDenom: funds[0].denom, outputDenom };
}

type MemoKind =
  | "send"
  | "ibc"
  | "ibc-forward"
  | "swap"
  | "swap-call"
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
    if (action === "osmosis_swap") return "swap-call";
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

/** Messages that bond, unbond or move a stake: their coin is the signing chain's staking coin. */
const STAKING_KINDS: ReadonlySet<MemoKind> = new Set(["stake", "unstake", "redelegate"]);

/**
 * The identity a message's coin has for the memo.
 *
 * With the signing chain, the denom is that chain's bank denom and
 * {@link identityOf} answers. Without it (Earn and Governance pass none), a
 * voucher or a packet path names nothing: `ibc/…` is a path, and only the
 * chain holding it knows which. A plain denom is named when every bundled
 * chain that could be signing it, mainnets before testnets, gives it the same
 * proven ticker: `uatom` is ATOM, a testnet's own staking coin keeps its
 * symbol, and `uluna` (LUNA on Terra, LUNC on Terra Classic) or `uusdc`
 * (Noble's and Axelar's) stays unnamed instead of taking whichever issuer
 * comes first.
 *
 * A staking message can only bond the signing chain's own staking coin, so
 * for one the candidates are the chains whose staking coin the denom is:
 * staking `uusdc` is Noble's (`USDC.n`, never Axelar's), staking `xfi` is
 * CrossFi's. Chains that share a staking denom (`uluna`) still disagree and
 * get the generic phrase.
 */
function memoIdentity(denom: string, chainId: string | undefined, kind: MemoKind): TokenIdentity | undefined {
  if (chainId) return identityOf(chainId, denom);
  if (denom.startsWith("ibc/") || baseDenomOf(denom) !== denom) return undefined;
  const listing = CHAIN_CATALOG.filter(
    (entry) =>
      entry.coinMinimalDenom === denom ||
      entry.feeMinimalDenom === denom ||
      currenciesOf(entry).some((row) => denomsMatch(row.coinMinimalDenom, denom)),
  );
  const staking = STAKING_KINDS.has(kind) ? listing.filter((entry) => entry.coinMinimalDenom === denom) : [];
  const candidates = staking.length > 0 ? staking : listing;
  const mainnets = candidates.filter((entry) => entry.network === "mainnet");
  const named = (mainnets.length > 0 ? mainnets : candidates).map((entry) => identityOf(entry.chainId, denom));
  const first = named[0];
  return first && named.every((identity) => identity.proven && identity.ticker === first.ticker)
    ? first
    : undefined;
}

/**
 * The ticker the memo names a coin by, or `null` for the generic phrase. Only
 * a proven identity names it: the memo is written on chain for good, so an
 * unknown voucher, an unlisted token's free-text subdenom, a token on a chain
 * the user added, and an impostor all read `Send` rather than a name someone
 * could have chosen.
 */
function tokenSymbol(denom: string | undefined, chainId: string | undefined, kind: MemoKind): string | null {
  if (!denom) return null;
  const identity = memoIdentity(denom, chainId, kind);
  return identity?.proven ? identity.ticker : null;
}

function text(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

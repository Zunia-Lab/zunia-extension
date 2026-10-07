/**
 * The signing prompt's facts about a transaction a site asked Zunia to sign, in either mode.
 *
 * Direct bytes are decoded by the kernel, whose sentences the prompt shows as written, with each
 * message's type URL, recipient and {@link DecodedMessageDetail} (zunia-core 0.1.1). Amino
 * documents are described here in the same words: lib/amino-summary.ts writes the kernel's
 * sentence for staking, votes, IBC transfers and Osmosis swaps, and this module the send and the
 * contract call. One sentence is not the kernel's in either mode: a CW721 transfer reads as
 * lib/nft.ts describes it (which token, which collection, to whom), where the kernel names the
 * action alone. So the sign mode a dApp picks does not change what the user reads.
 */
import { STORAGE_KEYS } from "./storage-keys";
import type { DecodedDirectTx, DecodedMessageDetail, DecodedTxMessage, KernelCoin } from "./kernel";
import { loadKernel, bytesToHex, hexToBytes } from "./kernel";
import { SECURITY_CONFIG } from "../config/security";
import { aminoCoin, aminoUint64, describeAminoMsg } from "./amino-summary";
import { exactCoinText, isBankSpelling } from "./chain-queries";
import { cosmWasmActionName, describeCw721Action } from "./nft";
import { packetMemoNote } from "./packet-memo";
import { assertSameChain } from "./provider-guards";
import { getSettings } from "./settings";
import { amountFieldText } from "./token-amount";
import { hydrateTokenIdentities, identityOf, type TokenIdentity } from "./token-identity";

export interface SignSafetySummary {
  chainId: string;
  /**
   * The exact words of what is signed: the kernel's, or for Amino the same words written here
   * (see the module documentation), and never reworded after. With each message, what the
   * signing prompt's "Raw transaction" shows of it: the address it pays and the contract message
   * or packet memo it carries.
   */
  messages: Array<{
    type: string;
    summary: string;
    unknown?: boolean;
    recipient?: string;
    detail?: DecodedMessageDetail;
  }>;
  /** The fee in words: one "Fee" row naming every coin it pays, and the gas limit. */
  fees: Array<{ label: string; value: string }>;
  /** The fee as signed, for the "Raw transaction". Absent when the document's could not be read. */
  fee?: { amount: SignedCoin[]; gas: string };
  warnings: string[];
  /** True when approval requires blind-signing opt-in. */
  requiresBlindSigning: boolean;
  memo?: string;
  /**
   * Per message, same order as `messages`: each coin it moves, named by its
   * proven identity (`= 12.34 USDC.n · Noble → on Osmosis · verified by
   * channel`). An addition under the raw summary, never in place of it, and
   * empty for a coin whose identity is not proven. Kept apart from `messages`
   * so the transaction JSON a prompt shows stays the decoded transaction.
   */
  resolved?: string[][];
}

/** A coin a signed message moves, exactly as the document spells it. */
export interface SignedCoin {
  readonly amount: string;
  readonly denom: string;
}

async function loadKnownRecipients(): Promise<Set<string>> {
  const result = await browser.storage.local.get(STORAGE_KEYS.knownRecipients);
  const list =
    (result[STORAGE_KEYS.knownRecipients] as string[] | undefined) ?? [];
  return new Set(list);
}

export async function rememberRecipient(address: string): Promise<void> {
  const known = await loadKnownRecipients();
  known.add(address);
  await browser.storage.local.set({
    [STORAGE_KEYS.knownRecipients]: [...known],
  });
}

/**
 * Coins as the kernel writes them in a summary, `1000000 uosmo, 5 uatom`; null
 * when there are none.
 */
function coinsText(coins: unknown): string | null {
  if (!Array.isArray(coins) || coins.length === 0) return null;
  return coins
    .map((coin: { amount?: unknown; denom?: unknown } | null) =>
      `${String(coin?.amount ?? "?")} ${String(coin?.denom ?? "")}`.trim(),
    )
    .join(", ");
}

/**
 * A CW721 transfer in words: which token, from which collection, to whom.
 *
 * The case that matters is a dApp's request: an opaque contract call, where the
 * kernel's `Execute "transfer_nft" on stars1…` tells the user nothing about the
 * one-of-a-kind asset they are about to sign away. lib/nft.ts reads the
 * ExecuteMsg, as Amino's plain object or the kernel's parse of the direct
 * bytes, so both sign modes show the same sentence. `recipient` is set only for
 * a transfer whose new owner is really known, so the first-time-recipient
 * warning cannot fire on a guess. Coins attached, which a CW721 transfer never
 * takes, are named the way the kernel names them; lib/nft.ts also warns.
 */
function describeNftCall(
  contract: string,
  body: unknown,
  funds: unknown,
): { summary: string; recipient?: string } | null {
  const described = describeCw721Action(contract, body, funds);
  if (!described) return null;
  const sending = coinsText(funds);
  const coins = sending ? ` sending ${sending}` : "";
  const { action } = described;
  if (action.kind === "transfer_nft") {
    const { tokenId, collectionAddress, recipient } = action;
    return { summary: `Give away NFT ${tokenId} from collection ${collectionAddress} to ${recipient}${coins}`, recipient };
  }
  return {
    summary: action.ics721
      ? `Send NFT ${action.tokenId} from collection ${action.collectionAddress} across ${action.ics721.channelId} to ${action.ics721.receiver}${coins}, which mints a voucher rather than moving the original`
      : `Hand NFT ${action.tokenId} from collection ${action.collectionAddress} to contract ${action.receivingContract}${coins}`,
  };
}

/** Coins with string amounts and denoms, or null for anything else. */
function wellFormedCoins(value: unknown): KernelCoin[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const coins: KernelCoin[] = [];
  for (const item of value) {
    const { denom, amount } = (item ?? {}) as { denom?: unknown; amount?: unknown };
    if (typeof denom !== "string" || typeof amount !== "string") return null;
    coins.push({ denom, amount });
  }
  return coins;
}

/**
 * Describe an Amino `MsgExecuteContract`: a CW721 transfer as
 * {@link describeNftCall} reads it, anything else as the kernel writes a
 * contract call, `Execute "{action}" on {contract}[ sending {coins}]`. The
 * top-level key of an ExecuteMsg is the action by convention, and
 * `Execute "increase_allowance" on juno1...` is strictly more than `Message
 * wasm/MsgExecuteContract`. The detail is the kernel's for the direct form:
 * the contract, its message and the coins attached.
 */
function summarizeExecuteContract(
  type: string,
  value: Record<string, unknown>,
): DecodedTxMessage {
  const contract = typeof value.contract === "string" ? value.contract : "";
  // wasmd renamed this field from `sent_funds` to `funds`; both appear in the
  // wild depending on the chain's SDK version.
  const funds = value.funds ?? value.sent_funds;
  const coins = wellFormedCoins(funds);
  const detail: DecodedMessageDetail | null =
    contract && value.msg !== undefined && coins
      ? { kind: "execute-contract", contract, msg: value.msg, funds: coins }
      : null;
  const withDetail = detail ? { detail } : {};

  const nft = describeNftCall(contract, value.msg, funds);
  if (nft) return { typeUrl: type, ...nft, ...withDetail };

  const action = cosmWasmActionName(value.msg);
  const sending = coinsText(funds);
  return {
    typeUrl: type,
    summary: action
      ? `Execute "${action}" on ${contract || "an unnamed contract"}${sending ? ` sending ${sending}` : ""}`
      : `Execute a contract call on ${contract || "an unnamed contract"} that Zunia could not read`,
    ...withDetail,
  };
}

/**
 * The kernel's messages with a CW721 transfer reworded as the Amino path words
 * it ({@link describeNftCall}); every other summary exactly as the kernel wrote
 * it.
 */
function withNftSentences(messages: readonly DecodedTxMessage[]): DecodedTxMessage[] {
  return messages.map((message) => {
    const { detail } = message;
    if (message.unknown || detail?.kind !== "execute-contract") return message;
    const nft = describeNftCall(detail.contract, detail.msg, detail.funds);
    if (!nft) return message;
    const { recipient: _kernelRecipient, ...rest } = message;
    return { ...rest, ...nft };
  });
}

/**
 * Told whenever a transfer carries a packet memo. The memo is not in the
 * summary, and packet-forward or ibc-hooks instructions in it can send the
 * tokens on from the receiving chain to another chain and another receiver;
 * lib/packet-memo.ts names where, in a note of its own beside this one.
 */
const PACKET_MEMO_NOTICE =
  "This transfer carries instructions for the receiving chain (packet memo). Check them under Raw transaction.";

/** A fee in words: every coin it pays, each as exactly as {@link exactCoinText} names one. */
function feeText(chainId: string, coins: readonly SignedCoin[]): string {
  if (coins.length === 0) return "None";
  return coins.map((coin) => exactCoinText(chainId, coin.amount, coin.denom)).join(" + ");
}

/**
 * An Amino fee in which every coin and the gas limit are spelled as the chain writes them,
 * whole: a fee in several coins is deducted in all of them. Undefined for any other.
 */
function aminoFee(value: unknown): DecodedDirectTx["fee"] {
  const { amount, gas } = (typeof value === "object" && value !== null ? value : {}) as {
    amount?: unknown;
    gas?: unknown;
  };
  const limit = aminoUint64(gas);
  if (!Array.isArray(amount) || limit === null) return undefined;
  const coins: KernelCoin[] = [];
  for (const item of amount) {
    const coin = aminoCoin(item);
    if (!coin) return undefined;
    coins.push({ denom: coin.denom, amount: coin.amount });
  }
  return { amount: coins, gas: limit };
}

/* -------------------------------------------------------------------------- *
 * The resolved line under a raw summary
 * -------------------------------------------------------------------------- */

/** How a proven identity was proven, in the prompt's words. */
function provenBy(identity: TokenIdentity): string {
  return identity.provenance === "table" || identity.provenance === "channel-walk"
    ? "verified by channel"
    : "verified by registry";
}

/**
 * One coin of a signed message in words, under the raw summary:
 * `= 12.34 USDC.n · Noble → on Osmosis · verified by channel`, or
 * `= 1.5 OSMO · native on Osmosis · verified by registry`. The amount is the
 * raw amount scaled exactly, every digit kept (`= 1.234567890123456789 INJ`):
 * the line says `=`, so it is never cut to six decimals or rounded.
 *
 * `null` unless the denom's identity on `chainId` is proven: the raw summary
 * alone is shown for anything else, so a token someone named after a real one
 * (an unlisted `factory/…/USDC`) never gets a reassuring line, and neither
 * does a voucher hash in a spelling no bank holds (`ibc/498a…`, lowercase).
 * Display only: nothing here is signed, and the raw amount and denom stay on
 * screen.
 */
export function resolvedCoinLine(chainId: string, coin: SignedCoin): string | null {
  if (!chainId || !/^\d+$/.test(coin.amount) || !coin.denom || !isBankSpelling(coin.denom)) return null;
  const identity = identityOf(chainId, coin.denom);
  if (!identity.proven) return null;
  const amount = `${amountFieldText(coin.amount, identity)} ${identity.ticker}`;
  const where =
    identity.originChainId === identity.heldOnChainId
      ? `native on ${identity.heldOnChainName}`
      : `${identity.originChainName ?? "Unknown chain"} → on ${identity.heldOnChainName}`;
  return `= ${amount} · ${where} · ${provenBy(identity)}`;
}

/** A coin as the kernel writes it: base units, a space, the denom (no spaces, no commas). */
const COIN_TEXT = /^(\d+) ([A-Za-z][A-Za-z0-9/:._-]*)$/;

/**
 * The kernel's direct-sign summary formats that carry one coin
 * (zunia-core crates/cosmos/src/msg.rs `summary`):
 * - `Send {amount} {denom} to {address}`
 * - `IBC transfer {amount} {denom} to {receiver} over {channel}`
 * - `Delegate {amount} {denom} to {validator}`, `Undelegate … from …`,
 *   `Redelegate {amount} {denom} from {validator} to {validator}`
 * - `Execute "{action}" on {contract} sending {amount} {denom}`
 */
const SUMMARY_FORMATS: readonly RegExp[] = [
  /^Send (.+) to [a-z0-9]+$/,
  /^IBC transfer (\S+ \S+) to \S+ over \S+$/,
  /^(?:Delegate|Undelegate) (\S+ \S+) (?:to|from) \S+$/,
  /^Redelegate (\S+ \S+) from \S+ to \S+$/,
  /^Execute ".*" on \S+ sending (.+)$/,
];

/**
 * The coin a kernel summary names, read back from its text; `[]` when the
 * text is not one of the formats above or does not hold exactly one coin.
 * The kernel joins several coins with `, ` and a forged document can put a
 * comma inside a denom, so a list of coins is never split and guessed at:
 * those messages keep their raw summary alone.
 */
export function summaryCoins(summary: string): SignedCoin[] {
  for (const format of SUMMARY_FORMATS) {
    const coins = format.exec(summary)?.[1];
    if (coins === undefined) continue;
    const coin = COIN_TEXT.exec(coins);
    return coin ? [{ amount: coin[1] ?? "", denom: coin[2] ?? "" }] : [];
  }
  return [];
}

/** A `{denom, amount}` object with a base-unit amount, or null. */
function signedCoin(value: unknown): SignedCoin | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { denom, amount } = value as { denom?: unknown; amount?: unknown };
  return typeof denom === "string" && denom && typeof amount === "string" && /^\d+$/.test(amount)
    ? { denom, amount }
    : null;
}

/**
 * The coins an Amino message moves, read from its value rather than from a
 * summary: `amount` (MsgSend's list, a staking message's coin), `token`
 * (MsgTransfer), `funds` or `sent_funds` (a contract call).
 */
export function aminoCoins(value: Record<string, unknown>): SignedCoin[] {
  const out: SignedCoin[] = [];
  for (const field of [value.amount, value.token, value.funds, value.sent_funds]) {
    for (const item of Array.isArray(field) ? field : [field]) {
      const coin = signedCoin(item);
      if (coin) out.push(coin);
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- *
 * Summaries
 * -------------------------------------------------------------------------- */

export function summarizeAminoMsgs(
  msgs: Array<{ type: string; value: Record<string, unknown> }>,
): DecodedTxMessage[] {
  return msgs.map((msg) => {
    const type = msg.type || "unknown";
    if (type === "wasm/MsgExecuteContract" || type.endsWith("MsgExecuteContract")) {
      return summarizeExecuteContract(type, msg.value);
    }
    if (type === "cosmos-sdk/MsgSend" || type.endsWith("MsgSend")) {
      const toAddress = String(msg.value.to_address ?? msg.value.toAddress ?? "");
      const amount = Array.isArray(msg.value.amount)
        ? msg.value.amount
            .map((a: { amount?: string; denom?: string }) =>
              `${a.amount ?? "?"} ${a.denom ?? ""}`.trim(),
            )
            .join(", ")
        : "?";
      return {
        typeUrl: type,
        summary: `Send ${amount} to ${toAddress || "unknown"}`,
        recipient: toAddress || undefined,
      };
    }
    const described = describeAminoMsg(type, msg.value);
    if (described) return described;
    // Anything else, including one of those types in a shape the chain would
    // not rebuild, keeps the generic line; a type without "Msg" in it is gated.
    return {
      typeUrl: type,
      summary: `Message ${type}`,
      unknown: !type.includes("Msg"),
    };
  });
}

/** How long a prompt waits for the stored token facts before naming coins without them. */
const FACTS_WAIT_MS = 1_500;

/**
 * Load the proven traces other contexts stored, so a voucher the balance
 * reader walked is named here too. Never throws; a storage read that does not
 * answer costs at most {@link FACTS_WAIT_MS}, and the coins it would have
 * named are left with their raw summary alone.
 */
async function tokenFactsLoaded(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FACTS_WAIT_MS);
  });
  await Promise.race([hydrateTokenIdentities().catch(() => undefined), late]);
  clearTimeout(timer);
}

export async function buildSignSafety(input: {
  expectedChainId: string;
  decoded: DecodedDirectTx | { chainId: string; messages: DecodedTxMessage[]; memo?: string; fee?: DecodedDirectTx["fee"] };
  /**
   * The coins each message moves, read from the document itself (Amino).
   * Without it they are read back from the kernel's summaries.
   */
  coins?: ReadonlyArray<readonly SignedCoin[]>;
}): Promise<SignSafetySummary> {
  const [settings, known] = await Promise.all([getSettings(), loadKnownRecipients(), tokenFactsLoaded()]);
  const warnings: string[] = [];
  let requiresBlindSigning = false;

  // "unknown" is what a kernel that cannot read the document reports; the raw
  // document's own chain id has already been checked by the caller.
  if (input.decoded.chainId && input.decoded.chainId !== "unknown") {
    assertSameChain(input.expectedChainId, input.decoded.chainId);
  }

  const notes = new Set<string>();
  const messages = input.decoded.messages.map((m) => {
    if (m.unknown && SECURITY_CONFIG.signing.warnUnknownMsgs) {
      warnings.push(`Unknown or undecoded message: ${m.typeUrl}`);
      requiresBlindSigning = true;
    }
    if (
      m.recipient &&
      SECURITY_CONFIG.signing.warnFirstTimeRecipient &&
      !known.has(m.recipient)
    ) {
      warnings.push(`First-time recipient: ${m.recipient}`);
    }
    if (m.detail?.kind === "execute-contract") {
      // What lib/nft.ts notes about a CW721 transfer: coins attached to one, which takes none.
      for (const note of describeCw721Action(m.detail.contract, m.detail.msg, m.detail.funds)?.warnings ?? []) {
        notes.add(note);
      }
    }
    if (m.detail?.kind === "ibc-transfer" && m.detail.memo.trim() !== "") {
      notes.add(PACKET_MEMO_NOTICE);
      const where = packetMemoNote(m.detail.memo);
      if (where) notes.add(where);
    }
    return {
      type: m.typeUrl,
      summary: m.summary,
      unknown: m.unknown,
      ...(m.recipient ? { recipient: m.recipient } : {}),
      ...(m.detail ? { detail: m.detail } : {}),
    };
  });
  warnings.push(...notes);

  if (requiresBlindSigning && !settings.blindSigning) {
    warnings.push(
      "Blind signing is off. Enable it in settings to approve undecoded messages.",
    );
  }

  const fees: Array<{ label: string; value: string }> = [];
  const fee = input.decoded.fee;
  if (fee) {
    fees.push({ label: "Fee", value: feeText(input.expectedChainId, fee.amount) });
    fees.push({ label: "Gas", value: /^\d+$/.test(fee.gas) ? Number(fee.gas).toLocaleString("en-US") : fee.gas });
  } else {
    fees.push({ label: "Fee", value: "Not specified" });
  }

  // An undecoded message is shown as the kernel reported it and nothing more.
  const resolved = input.decoded.messages.map((m, index) =>
    m.unknown
      ? []
      : (input.coins?.[index] ?? summaryCoins(m.summary))
          .map((coin) => resolvedCoinLine(input.expectedChainId, coin))
          .filter((line): line is string => line !== null),
  );

  return {
    chainId: input.decoded.chainId || input.expectedChainId,
    messages,
    fees,
    ...(fee ? { fee: { amount: fee.amount.map(({ denom, amount }) => ({ denom, amount })), gas: fee.gas } } : {}),
    warnings,
    requiresBlindSigning: requiresBlindSigning && !settings.blindSigning,
    memo: "memo" in input.decoded ? input.decoded.memo : undefined,
    ...(resolved.some((lines) => lines.length > 0) ? { resolved } : {}),
  };
}

/**
 * Summarize the exact `SignDoc` bytes that will be signed. The kernel decodes
 * the same bytes the signature covers, so the prompt cannot describe one
 * transaction while the key signs another.
 */
export async function decodeDirectSignBytes(
  expectedChainId: string,
  signBytes: Uint8Array,
): Promise<SignSafetySummary> {
  const kernel = await loadKernel();
  const decoded = kernel.decodeDirectTx(bytesToHex(signBytes));
  return buildSignSafety({
    expectedChainId,
    decoded: { ...decoded, messages: withNftSentences(decoded.messages) },
  });
}

export async function decodeAminoSignDoc(
  expectedChainId: string,
  signDoc: unknown,
): Promise<SignSafetySummary> {
  const amino = signDoc as {
    chain_id?: string;
    memo?: string;
    fee?: unknown;
    msgs?: Array<{ type: string; value: Record<string, unknown> }>;
  };
  const messages = summarizeAminoMsgs(amino.msgs ?? []);
  return buildSignSafety({
    expectedChainId,
    coins: (amino.msgs ?? []).map((msg) =>
      msg?.value && typeof msg.value === "object" ? aminoCoins(msg.value) : [],
    ),
    decoded: {
      chainId: amino.chain_id ?? expectedChainId,
      messages,
      memo: amino.memo,
      fee: aminoFee(amino.fee),
    },
  });
}

export { hexToBytes };

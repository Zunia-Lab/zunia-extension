import { STORAGE_KEYS } from "./storage-keys";
import type { DecodedDirectTx, DecodedTxMessage } from "./kernel";
import { loadKernel, bytesToHex, hexToBytes } from "./kernel";
import { SECURITY_CONFIG } from "../config/security";
import { exactCoinText, isBankSpelling } from "./chain-queries";
import { cosmWasmActionName, describeCw721Action } from "./nft";
import { assertSameChain } from "./provider-guards";
import { getSettings } from "./settings";
import { amountFieldText } from "./token-amount";
import { hydrateTokenIdentities, identityOf, type TokenIdentity } from "./token-identity";

export interface SignSafetySummary {
  chainId: string;
  /** The exact words of what is signed: the kernel's, or for Amino this module's. Never rewritten. */
  messages: Array<{ type: string; summary: string; unknown?: boolean }>;
  fees: Array<{ label: string; value: string }>;
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
 * Describe an Amino `MsgExecuteContract`.
 *
 * A CW721 transfer arriving from a dApp is the case that matters: it is an
 * opaque contract call, and "Message wasm/MsgExecuteContract" tells the user
 * nothing about the one-of-a-kind asset they are about to sign away. The Amino
 * encoding puts the ExecuteMsg in as a plain object rather than base64, so the
 * shared CW721 decoder in `lib/nft.ts` is handed the object directly and both
 * encodings produce the same sentence.
 *
 * When the payload is not a CW721 transfer the summary still names the action -
 * the top-level key of an ExecuteMsg is the action by convention, and
 * "Execute increase_allowance on juno1..." is strictly more than "Message
 * wasm/MsgExecuteContract". `recipient` is set only for a transfer whose new
 * owner is really known, so the first-time-recipient warning cannot fire on a
 * guess.
 */
function summarizeExecuteContract(
  type: string,
  value: Record<string, unknown>,
): DecodedTxMessage {
  const contract = typeof value.contract === "string" ? value.contract : "";
  // wasmd renamed this field from `sent_funds` to `funds`; both appear in the
  // wild depending on the chain's SDK version, and the only thing read from it
  // is whether coins are attached at all.
  const funds = value.funds ?? value.sent_funds;
  const described = describeCw721Action(contract, value.msg, funds);

  if (described?.action.kind === "transfer_nft") {
    const { tokenId, recipient, collectionAddress } = described.action;
    return {
      typeUrl: type,
      summary: `Give away NFT ${tokenId} from collection ${collectionAddress} to ${recipient}`,
      recipient,
    };
  }
  if (described?.action.kind === "send_nft") {
    const action = described.action;
    return {
      typeUrl: type,
      summary: action.ics721
        ? `Send NFT ${action.tokenId} from collection ${action.collectionAddress} across ${action.ics721.channelId} to ${action.ics721.receiver}, which mints a voucher rather than moving the original`
        : `Hand NFT ${action.tokenId} from collection ${action.collectionAddress} to contract ${action.receivingContract}`,
    };
  }

  const action = cosmWasmActionName(value.msg);
  return {
    typeUrl: type,
    summary: action
      ? `Execute "${action}" on ${contract || "an unnamed contract"}`
      : `Execute a contract call on ${contract || "an unnamed contract"} that Zunia could not read`,
  };
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
    return {
      type: m.typeUrl,
      summary: m.summary,
      unknown: m.unknown,
    };
  });

  if (requiresBlindSigning && !settings.blindSigning) {
    warnings.push(
      "Blind signing is off. Enable it in settings to approve undecoded messages.",
    );
  }

  const fees: Array<{ label: string; value: string }> = [];
  if (input.decoded.fee) {
    const { amount, denom, gas } = input.decoded.fee;
    fees.push({ label: "Fee", value: exactCoinText(input.expectedChainId, amount, denom) });
    fees.push({ label: "Gas", value: /^\d+$/.test(gas) ? Number(gas).toLocaleString("en-US") : gas });
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
  return buildSignSafety({ expectedChainId, decoded });
}

export async function decodeAminoSignDoc(
  expectedChainId: string,
  signDoc: unknown,
): Promise<SignSafetySummary> {
  const amino = signDoc as {
    chain_id?: string;
    memo?: string;
    fee?: { amount: Array<{ amount: string; denom: string }>; gas: string };
    msgs?: Array<{ type: string; value: Record<string, unknown> }>;
  };
  const messages = summarizeAminoMsgs(amino.msgs ?? []);
  const feeAmount = amino.fee?.amount?.[0];
  return buildSignSafety({
    expectedChainId,
    coins: (amino.msgs ?? []).map((msg) =>
      msg?.value && typeof msg.value === "object" ? aminoCoins(msg.value) : [],
    ),
    decoded: {
      chainId: amino.chain_id ?? expectedChainId,
      messages,
      memo: amino.memo,
      fee: feeAmount
        ? {
            amount: feeAmount.amount,
            denom: feeAmount.denom,
            gas: amino.fee?.gas ?? "0",
          }
        : undefined,
    },
  });
}

export { hexToBytes };

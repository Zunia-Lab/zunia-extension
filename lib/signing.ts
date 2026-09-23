import { STORAGE_KEYS } from "./storage-keys";
import type { DecodedDirectTx, DecodedTxMessage } from "./kernel";
import { loadKernel, bytesToHex, hexToBytes } from "./kernel";
import { SECURITY_CONFIG } from "../config/security";
import { cosmWasmActionName, describeCw721Action } from "./nft";
import { assertSameChain } from "./provider-guards";
import { getSettings } from "./settings";

export interface SignSafetySummary {
  chainId: string;
  messages: Array<{ type: string; summary: string; unknown?: boolean }>;
  fees: Array<{ label: string; value: string }>;
  warnings: string[];
  /** True when approval requires blind-signing opt-in. */
  requiresBlindSigning: boolean;
  memo?: string;
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

export async function buildSignSafety(input: {
  expectedChainId: string;
  decoded: DecodedDirectTx | { chainId: string; messages: DecodedTxMessage[]; memo?: string; fee?: DecodedDirectTx["fee"] };
}): Promise<SignSafetySummary> {
  const settings = await getSettings();
  const known = await loadKnownRecipients();
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
    fees.push({
      label: "Fee",
      value: `${input.decoded.fee.amount} ${input.decoded.fee.denom}`,
    });
    fees.push({ label: "Gas", value: input.decoded.fee.gas });
  } else {
    fees.push({ label: "Fee", value: "Not specified" });
  }

  return {
    chainId: input.decoded.chainId || input.expectedChainId,
    messages,
    fees,
    warnings,
    requiresBlindSigning: requiresBlindSigning && !settings.blindSigning,
    memo: "memo" in input.decoded ? input.decoded.memo : undefined,
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

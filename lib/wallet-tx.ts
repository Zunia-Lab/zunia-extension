/**
 * End-to-end wallet write path: build amino doc → sign with kernel → broadcast.
 */

import {
  assembleAminoTxRaw,
  estimateFee,
  makeStdSignDoc,
  parseSignatureBase64,
  signDocBytes,
  type AminoMsg,
  type StdFee,
  type StdSignDoc,
} from "./amino-tx";
import {
  broadcastTx,
  expectedSequenceOf,
  fetchAccountNumberSequence,
  isSequenceMismatch,
  waitForInclusion,
  type BroadcastResult,
} from "./broadcast";
import {
  chainUsesEthKeySign,
  ethPubKeyTypeUrlFor,
  findCatalogEntry,
} from "./chain-catalog";
import { chainJsonFor } from "./chains";
import {
  bytesToHex,
  fromBase64,
  hexToBytes,
  loadKernel,
  toBase64,
} from "./kernel";
import {
  getActiveDerivationIndex,
  getSessionMnemonic,
  touchSession,
} from "./session";
import { getSettings } from "./settings";
import { rememberRecipient } from "./signing";
import { resolveTxMemo } from "./tx-memo";

export interface SignAndBroadcastInput {
  chainId: string;
  signerAddress: string;
  msgs: AminoMsg[];
  memo?: string;
  /** Override gas; defaults by message kind. */
  gasLimit?: number;
  fee?: StdFee;
}

export interface SignAndBroadcastResult extends BroadcastResult {
  signDoc: StdSignDoc;
}

function defaultGas(msgs: AminoMsg[]): number {
  if (msgs.some((m) => m.type === "cosmos-sdk/MsgTransfer")) return 250_000;
  if (msgs.length > 1) return 200_000 + msgs.length * 80_000;
  if (
    msgs.some(
      (m) =>
        m.type.includes("Delegate") ||
        m.type.includes("Undelegate") ||
        m.type.includes("Withdraw"),
    )
  ) {
    return 250_000;
  }
  return 200_000;
}

async function feeForChain(chainId: string, gasLimit: number): Promise<StdFee> {
  const entry = findCatalogEntry(chainId);
  const prefs = await getSettings();
  const denom = entry?.feeMinimalDenom ?? entry?.coinMinimalDenom ?? "uatom";
  const gasPrice = entry?.gasPriceStep?.[prefs.feeSpeed] ?? 0.025;
  const adjusted = Math.max(1, Math.ceil(gasLimit * prefs.gasAdjustment));
  return estimateFee({ gasLimit: adjusted, gasPrice, denom });
}

/**
 * Sign amino msgs with the unlocked kernel and broadcast via chain REST.
 * Wallet-originated only; never used for dApp `sendTx`.
 */
export async function signAndBroadcast(
  input: SignAndBroadcastInput,
): Promise<SignAndBroadcastResult> {
  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");

  const gasLimit = input.gasLimit ?? defaultGas(input.msgs);
  const fee = input.fee ?? (await feeForChain(input.chainId, gasLimit));
  const kernel = await loadKernel();
  const accountIndex = await getActiveDerivationIndex();
  const chainJson = chainJsonFor(input.chainId);
  const derived = kernel.deriveAddress(mnemonic, "", chainJson, accountIndex);
  if (derived.bech32Address !== input.signerAddress) {
    throw new Error(
      `Signer mismatch: expected ${input.signerAddress}, derived ${derived.bech32Address}`,
    );
  }

  const ethKeyType = chainUsesEthKeySign(input.chainId);
  const ethPubKeyTypeUrl = ethPubKeyTypeUrlFor(input.chainId);

  let lastError: unknown;
  let forcedSequence: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const live = await fetchAccountNumberSequence(
      input.chainId,
      input.signerAddress,
    );
    const accountNumber = live.accountNumber;
    const sequence = forcedSequence ?? live.sequence;
    const signDoc = makeStdSignDoc({
      chainId: input.chainId,
      accountNumber,
      sequence,
      fee,
      msgs: input.msgs,
      memo: resolveTxMemo(input.memo, input.msgs),
    });
    const signatureHex = kernel.signCosmos(
      mnemonic,
      "",
      chainJson,
      accountIndex,
      bytesToHex(signDocBytes(signDoc)),
    );
    const txRaw = assembleAminoTxRaw({
      signDoc,
      pubKey: derived.pubKey,
      signature: hexToBytes(signatureHex),
      ethKeyType,
      ethPubKeyTypeUrl,
    });

    for (const msg of input.msgs) {
      const to = msg.value?.to_address;
      if (typeof to === "string" && to) await rememberRecipient(to);
    }

    await touchSession();
    try {
      const result = await broadcastTx({
        chainId: input.chainId,
        txBytes: txRaw,
      });
      const included = await waitForInclusion(input.chainId, result.txhash);
      return { ...included, signDoc };
    } catch (error) {
      lastError = error;
      if (!isSequenceMismatch(error) || attempt === 1) throw error;
      forcedSequence = expectedSequenceOf(error);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Encode already-signed amino result (e.g. from provider) into tx_bytes. */
export function encodeSignedAmino(params: {
  signed: StdSignDoc;
  signature: { pub_key: { value: string }; signature: string };
  ethKeyType?: boolean;
  ethPubKeyTypeUrl?: string;
}): string {
  const keyBytes = fromBase64(params.signature.pub_key.value);
  if (keyBytes.length !== 33) {
    throw new Error("Expected compressed secp256k1 public key (33 bytes)");
  }
  const sig = parseSignatureBase64(params.signature.signature);
  const txRaw = assembleAminoTxRaw({
    signDoc: params.signed,
    pubKey: keyBytes,
    signature: sig,
    ethKeyType: params.ethKeyType,
    ethPubKeyTypeUrl: params.ethPubKeyTypeUrl,
  });
  return toBase64(txRaw);
}

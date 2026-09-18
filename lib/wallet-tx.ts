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
  fetchAccountNumberSequence,
  type BroadcastResult,
} from "./broadcast";
import { findCatalogEntry } from "./chain-catalog";
import { chainJsonFor } from "./chains";
import {
  bytesToHex,
  fromBase64,
  hexToBytes,
  loadKernel,
  toBase64,
} from "./kernel";
import {
  getActiveAccountIndex,
  getSessionMnemonic,
  touchSession,
} from "./session";
import { rememberRecipient } from "./signing";

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
  if (msgs.some((m) => m.type.includes("Delegate") || m.type.includes("Withdraw"))) {
    return 250_000;
  }
  return 200_000;
}

function feeForChain(chainId: string, gasLimit: number): StdFee {
  const entry = findCatalogEntry(chainId);
  const denom = entry?.feeMinimalDenom ?? entry?.coinMinimalDenom ?? "uatom";
  const gasPrice = entry?.gasPriceStep?.average ?? 0.025;
  return estimateFee({ gasLimit, gasPrice, denom });
}

/**
 * Sign amino msgs with the unlocked kernel and broadcast via chain REST.
 * Wallet-originated only — never used for dApp `sendTx`.
 */
export async function signAndBroadcast(
  input: SignAndBroadcastInput,
): Promise<SignAndBroadcastResult> {
  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");

  const gasLimit = input.gasLimit ?? defaultGas(input.msgs);
  const fee = input.fee ?? feeForChain(input.chainId, gasLimit);
  const { accountNumber, sequence } = await fetchAccountNumberSequence(
    input.chainId,
    input.signerAddress,
  );

  const signDoc = makeStdSignDoc({
    chainId: input.chainId,
    accountNumber,
    sequence,
    fee,
    msgs: input.msgs,
    memo: input.memo,
  });

  const kernel = await loadKernel();
  const accountIndex = await getActiveAccountIndex();
  const chainJson = chainJsonFor(input.chainId);
  const derived = kernel.deriveAddress(mnemonic, "", chainJson, accountIndex);
  if (derived.bech32Address !== input.signerAddress) {
    throw new Error(
      `Signer mismatch: expected ${input.signerAddress}, derived ${derived.bech32Address}`,
    );
  }

  const ethKeyType =
    derived.algo === "eth_secp256k1" ||
    findCatalogEntry(input.chainId)?.coinType === 60;

  const signatureHex = kernel.signCosmos(
    mnemonic,
    "",
    chainJson,
    accountIndex,
    bytesToHex(signDocBytes(signDoc)),
  );
  const signature = hexToBytes(signatureHex);
  const txRaw = assembleAminoTxRaw({
    signDoc,
    pubKey: derived.pubKey,
    signature,
    ethKeyType,
  });

  for (const msg of input.msgs) {
    const to = msg.value?.to_address;
    if (typeof to === "string" && to) await rememberRecipient(to);
  }

  await touchSession();
  const result = await broadcastTx({
    chainId: input.chainId,
    txBytes: txRaw,
  });

  return { ...result, signDoc };
}

/** Encode already-signed amino result (e.g. from provider) into tx_bytes. */
export function encodeSignedAmino(params: {
  signed: StdSignDoc;
  signature: { pub_key: { value: string }; signature: string };
  ethKeyType?: boolean;
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
  });
  return toBase64(txRaw);
}

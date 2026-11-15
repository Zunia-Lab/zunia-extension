/**
 * End-to-end wallet write path: build amino doc → sign with kernel → broadcast.
 */

import {
  assembleAminoTxRaw,
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
  restOf,
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
import {
  buildSimulateBytes,
  fetchMinGasPrice,
  isInsufficientFee,
  planFee,
  requiredFeeOf,
  simulateGas,
  toRatio,
  type Ratio,
} from "./tx-fee";

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

async function walletPriceFor(chainId: string): Promise<{ denom: string; price: Ratio | null }> {
  const entry = findCatalogEntry(chainId);
  const prefs = await getSettings();
  const denom = entry?.feeMinimalDenom ?? entry?.coinMinimalDenom ?? "uatom";
  const step = entry?.gasPriceStep?.[prefs.feeSpeed];
  return { denom, price: toRatio(step ?? 0.025) };
}

async function getJson(rest: string, path: string): Promise<unknown> {
  const res = await fetch(`${rest}${path}`, {
    credentials: "omit",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson(rest: string, path: string, body: unknown) {
  const res = await fetch(`${rest}${path}`, {
    method: "POST",
    credentials: "omit",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/**
 * Sign amino msgs with the unlocked kernel and broadcast via chain REST.
 * Wallet-originated only; never used for dApp `sendTx`.
 *
 * Before signing, the exact message list is simulated (zero signature, real
 * sequence) so the gas limit covers the work (a claim from many validators
 * needs far more than one), and the fee is raised to the node's own minimum
 * gas price. A refusal for a stale sequence is retried with the sequence the
 * node names; a refusal for too small a fee is retried once with the fee it
 * names.
 */
export async function signAndBroadcast(
  input: SignAndBroadcastInput,
): Promise<SignAndBroadcastResult> {
  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");
  if (input.msgs.length === 0) throw new Error("Nothing to send: the message list is empty");

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
  // The screens pass the memo they showed, which is kept as it is. A blank
  // one gets the default that names the token as this chain holds it, worked
  // out once, so a retry after a sequence mismatch signs the same text.
  const memo = resolveTxMemo(input.memo, input.msgs, input.chainId);

  const callerGas = BigInt(input.fee?.gas ?? input.gasLimit ?? defaultGas(input.msgs));
  const wallet = await walletPriceFor(input.chainId);
  const prefs = await getSettings();
  const rest = restOf(input.chainId);
  const feeDenom = input.fee?.amount[0]?.denom ?? wallet.denom;

  const first = await fetchAccountNumberSequence(input.chainId, input.signerAddress);
  const nodeMin = await fetchMinGasPrice((path) => getJson(rest, path), feeDenom);
  const simBytes = buildSimulateBytes({
    chainId: input.chainId,
    accountNumber: first.accountNumber,
    sequence: first.sequence,
    msgs: input.msgs,
    memo,
    gasLimit: callerGas,
    pubKey: derived.pubKey,
    ethKeyType,
    ethPubKeyTypeUrl,
  });
  const simulated = await simulateGas((path, body) => postJson(rest, path, body), simBytes);
  let plan = planFee({
    callerGas,
    callerFee: input.fee?.amount ?? [],
    feeDenom,
    walletPrice: wallet.price,
    nodeMinPrice: nodeMin,
    gasAdjustment: prefs.gasAdjustment,
    simulatedGas: simulated,
  });

  let lastError: unknown;
  let forcedSequence: string | null = null;
  let feeBumped = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    const live =
      attempt === 0
        ? first
        : await fetchAccountNumberSequence(input.chainId, input.signerAddress);
    const sequence = forcedSequence ?? live.sequence;
    const signDoc = makeStdSignDoc({
      chainId: input.chainId,
      accountNumber: live.accountNumber,
      sequence,
      fee: plan.fee,
      msgs: input.msgs,
      memo,
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
      if (isSequenceMismatch(error) && attempt < 3) {
        forcedSequence = expectedSequenceOf(error);
        continue;
      }
      if (isInsufficientFee(error) && !feeBumped) {
        feeBumped = true;
        const need = requiredFeeOf(error);
        const denom = plan.fee.amount[0]?.denom ?? feeDenom;
        const approved = BigInt(plan.fee.amount[0]?.amount ?? "0");
        const amount = need && need.denom === denom ? raisedFee(need.amount, approved) : null;
        if (amount !== null) {
          plan = { ...plan, fee: { ...plan.fee, amount: [{ denom, amount: amount.toString() }] } };
          continue;
        }
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * How far an "insufficient fee" refusal may raise the fee without asking: at
 * most this many times the fee the user approved. Past it the refusal is
 * shown, and the user picks a higher speed.
 */
export const MAX_FEE_RAISE = 3n;

/**
 * The fee to retry with after a node said it requires [need]: 10% over its
 * floor, which absorbs a base fee that moved meanwhile. Null when that is more
 * than [MAX_FEE_RAISE] times the [approved] fee: the "required" figure comes
 * from whatever node answered, and a wallet that pays any figure a node names
 * can be made to pay anything.
 */
export function raisedFee(need: bigint, approved: bigint): bigint | null {
  const amount = (need * 11n + 9n) / 10n;
  return amount <= approved * MAX_FEE_RAISE ? amount : null;
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

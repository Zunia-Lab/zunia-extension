/**
 * The wallet's transaction path for engine-built messages.
 *
 * `lib/wallet-tx.ts` signs the five amino message types this extension has
 * always sent, using its own hand-written proto encoder. That encoder cannot
 * express what the interchain engine produces — an ICS20 transfer carrying a
 * multi-kilobyte ibc-hooks memo, a `MsgExecuteContract` recovery call — so this
 * module takes the other road: it hands the engine's `BuiltMsg` list straight to
 * `@zunialab/core`, which owns the encoding, and keeps zero message knowledge
 * of its own.
 *
 * Runs in the background worker only: `sign()` reads the session mnemonic.
 * `preview()` does not sign, but it does derive the account's own public key,
 * which needs the same unlocked keyring, so both live here.
 *
 * The JS fallback kernel refuses every transaction method rather than returning
 * bytes that would fail on chain. That refusal is surfaced as
 * {@link TxKernelUnavailable} and the screens disable their confirm control
 * with its reason, which is the honest outcome: a wallet that cannot build a
 * transaction should say so, not produce one nobody can broadcast.
 */

import {
  broadcast as engineBroadcast,
  createLcdPostClient,
  estimateFee,
  getAccount,
  isEthSecp256k1PubKey,
  lcdEndpointsFromChain,
  simulate,
  validateMemo,
  type BuiltMsg,
  type Coin,
  type FeeSpeed,
  type MemoInspection,
} from "@zunialab/interchain";

import { findCatalogEntry } from "./chain-catalog";
import { chainJsonFor } from "./chains";
import { chainRegistry, lcdFor } from "./interchain";
import {
  bytesToHex,
  loadKernel,
  type KernelStatus,
  type SigningPreview,
} from "./kernel";
import { getActiveAccountIndex, getSessionMnemonic, touchSession } from "./session";

/** Fee as the kernel wants it. `gas_limit` is a string: a u64 outruns a JSON number. */
export interface KernelFeeJson {
  readonly amount: readonly Coin[];
  readonly gas_limit: string;
}

/** What the wallet needs to know before it can ask a user to approve anything. */
export type TxKernelStatus = KernelStatus;

/** Raised when the active kernel cannot build transactions at all. */
export class TxKernelUnavailable extends Error {
  readonly code = "KERNEL_TRANSACTION_UNSUPPORTED" as const;
  constructor(reason: string | undefined) {
    super(
      reason
        ? `Signing is unavailable: ${reason}`
        : "Signing is unavailable: the @zunialab/core kernel is not loaded.",
    );
    this.name = "TxKernelUnavailable";
  }
}

async function requireSigningKernel() {
  const kernel = await loadKernel();
  if (!kernel.status.canSignTransactions) {
    throw new TxKernelUnavailable(kernel.status.degradedReason);
  }
  return kernel;
}

/** Whether this build can sign, and why not when it cannot. */
export async function txKernelStatus(): Promise<TxKernelStatus> {
  return (await loadKernel()).status;
}

/* -------------------------------------------------------------------------- *
 * Preview
 * -------------------------------------------------------------------------- */

/** What the caller wants signed. Identical for preview and for signing. */
export interface TxRequest {
  readonly chainId: string;
  readonly signerAddress: string;
  readonly msgs: readonly BuiltMsg[];
  /** Transaction memo. ICS20 and PFM memos live on the message, not here. */
  readonly memo?: string;
  readonly feeSpeed?: FeeSpeed;
}

/**
 * Everything the approval screen shows, plus the numbers the signature is
 * pinned to.
 *
 * `accountNumber` and `sequence` are returned so the signing call can reuse the
 * exact values the preview was computed over. Re-reading them would let the
 * signed bytes drift from the bytes the user approved, which is the whole
 * reason `signBytesHash` exists.
 */
export interface TxPreview {
  readonly preview: SigningPreview;
  readonly accountNumber: string;
  readonly sequence: string;
  readonly fee: KernelFeeJson;
  /** Set when simulation failed and a fallback gas limit was used. Shown, never hidden. */
  readonly feeNote: string | null;
  /** The engine's reading of the ICS20 memo on the first message, when there is one. */
  readonly packetMemo: MemoInspection | null;
  readonly kernel: TxKernelStatus;
}

/**
 * Gas limit used when the chain will not simulate.
 *
 * A cross-chain transfer with an ibc-hooks memo is the largest thing this
 * wallet sends and 400k covers it on every chain we have measured; the fallback
 * exists because several public LCDs disable the simulate route entirely. It is
 * always accompanied by a visible note — an invisible guess is how a wallet
 * ships transactions that fail for reasons the user cannot see.
 */
const FALLBACK_GAS_LIMIT = "400000";

function packetMemoOf(msgs: readonly BuiltMsg[]): MemoInspection | null {
  const first = msgs[0];
  if (!first || first.typeUrl !== "/ibc.applications.transfer.v1.MsgTransfer") {
    return null;
  }
  const memo = first.value["memo"];
  const receiver = first.value["receiver"];
  if (typeof memo !== "string" || memo.length === 0) return null;
  return validateMemo(memo, {
    ...(typeof receiver === "string" ? { receiver } : {}),
  });
}

/**
 * Build the preview the user approves, and the fee it is priced at.
 *
 * Order matters: read the account, simulate with a zero-signature transaction,
 * turn simulated gas into a fee, and only then render the preview — so the
 * gas and fee shown are the ones inside the signed bytes rather than a number
 * computed afterwards.
 */
export async function previewTx(request: TxRequest): Promise<TxPreview> {
  const kernel = await requireSigningKernel();
  const chain = chainRegistry().get(request.chainId);
  if (!chain) throw new Error(`${request.chainId} is not in this wallet's chain list`);
  if (request.msgs.length === 0) throw new Error("A transaction needs at least one message");

  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");
  const accountIndex = await getActiveAccountIndex();
  const derived = kernel.deriveAddress(mnemonic, "", chainJsonFor(request.chainId), accountIndex);
  if (derived.bech32Address !== request.signerAddress) {
    throw new Error(
      `Signer mismatch: expected ${request.signerAddress}, derived ${derived.bech32Address}`,
    );
  }
  const publicKeyHex = bytesToHex(derived.pubKey);

  const lcd = lcdFor(chain);
  const account = await getAccount(lcd, request.chainId, request.signerAddress);
  const ethKeyType =
    derived.algo === "eth_secp256k1" ||
    isEthSecp256k1PubKey(account.pubKey) ||
    findCatalogEntry(request.chainId)?.coinType === 60;

  const msgsJson = JSON.stringify(request.msgs);
  const memo = request.memo ?? "";

  let fee: KernelFeeJson;
  let feeNote: string | null = null;
  try {
    const simulateTx = kernel.buildSimulateTx(
      request.chainId,
      msgsJson,
      JSON.stringify({ amount: [], gas_limit: FALLBACK_GAS_LIMIT }),
      memo,
      account.accountNumber,
      account.sequence,
      publicKeyHex,
      ethKeyType,
    );
    const post = createLcdPostClient({ client: lcd, endpoints: lcdEndpointsFromChain(chain) });
    const gasUsed = await simulate(post, request.chainId, hexToBase64(simulateTx));
    const estimate = estimateFee(gasUsed, chain, request.feeSpeed ?? "average");
    fee = { amount: estimate.amount, gas_limit: estimate.gasLimit };
  } catch (error) {
    const gasPrice = chain.gasPriceStep?.[request.feeSpeed ?? "average"];
    if (gasPrice === undefined) {
      // No simulation and no published gas price means any fee we put in is
      // invented. Refuse rather than sign something the chain will reject.
      throw new Error(
        `${chain.chainName} would not simulate this transaction and publishes no gas price, so Zunia cannot work out a fee.`,
      );
    }
    const estimate = estimateFee(FALLBACK_GAS_LIMIT, chain, request.feeSpeed ?? "average", {
      gasAdjustment: 1,
    });
    fee = { amount: estimate.amount, gas_limit: estimate.gasLimit };
    feeNote = `${chain.chainName} would not simulate this transaction (${
      error instanceof Error ? error.message : String(error)
    }). The fee below uses a fixed ${FALLBACK_GAS_LIMIT} gas limit and may be wrong.`;
  }

  const preview = kernel.previewTx(
    request.chainId,
    msgsJson,
    JSON.stringify(fee),
    memo,
    account.accountNumber,
    account.sequence,
    publicKeyHex,
    ethKeyType,
    "direct",
  );

  return {
    preview,
    accountNumber: account.accountNumber,
    sequence: account.sequence,
    fee,
    feeNote,
    packetMemo: packetMemoOf(request.msgs),
    kernel: kernel.status,
  };
}

/* -------------------------------------------------------------------------- *
 * Sign and broadcast
 * -------------------------------------------------------------------------- */

/** The preview's numbers, handed back so the signature covers what was shown. */
export interface TxSignRequest extends TxRequest {
  readonly fee: KernelFeeJson;
  readonly accountNumber: string;
  readonly sequence: string;
  /**
   * `SigningPreview.signBytesHash` from the preview the user approved.
   *
   * Checked against a freshly built preview before anything is signed. It is
   * the only link between the screen the user read and the bytes that go to the
   * chain: without it, a bug or a race between preview and signing would be
   * invisible to everyone including the user.
   */
  readonly expectSignBytesHash: string;
}

/** A broadcast result, in the shape the popup's send flow already renders. */
export interface TxBroadcastResult {
  readonly txhash: string;
  readonly code: number;
  readonly rawLog: string;
  readonly success: boolean;
}

/**
 * Sign the previewed transaction and submit it.
 *
 * @throws when the recomputed sign-bytes hash differs from the one the user
 *   approved, when the kernel cannot sign, or when the node rejects the
 *   transaction. A rejection still carries its hash, because a rejected
 *   transaction has one and it is what a support conversation needs.
 */
export async function signAndBroadcastTx(
  request: TxSignRequest,
): Promise<TxBroadcastResult> {
  const kernel = await requireSigningKernel();
  const chain = chainRegistry().get(request.chainId);
  if (!chain) throw new Error(`${request.chainId} is not in this wallet's chain list`);

  const mnemonic = await getSessionMnemonic();
  if (!mnemonic) throw new Error("Wallet is locked");
  const accountIndex = await getActiveAccountIndex();
  const chainJson = chainJsonFor(request.chainId);
  const derived = kernel.deriveAddress(mnemonic, "", chainJson, accountIndex);
  if (derived.bech32Address !== request.signerAddress) {
    throw new Error(
      `Signer mismatch: expected ${request.signerAddress}, derived ${derived.bech32Address}`,
    );
  }

  const msgsJson = JSON.stringify(request.msgs);
  const feeJson = JSON.stringify(request.fee);
  const memo = request.memo ?? "";
  const ethKeyType =
    derived.algo === "eth_secp256k1" || findCatalogEntry(request.chainId)?.coinType === 60;

  const recomputed = kernel.previewTx(
    request.chainId,
    msgsJson,
    feeJson,
    memo,
    request.accountNumber,
    request.sequence,
    bytesToHex(derived.pubKey),
    ethKeyType,
    "direct",
  );
  if (recomputed.signBytesHash !== request.expectSignBytesHash) {
    throw new Error(
      "The transaction changed between the approval screen and signing. Nothing was signed; start again.",
    );
  }

  const txRawHex = kernel.signTx(
    mnemonic,
    "",
    chainJson,
    accountIndex,
    request.chainId,
    msgsJson,
    feeJson,
    memo,
    request.accountNumber,
    request.sequence,
    "direct",
  );

  await touchSession();
  const lcd = lcdFor(chain);
  const post = createLcdPostClient({ client: lcd, endpoints: lcdEndpointsFromChain(chain) });
  const result = await engineBroadcast(post, request.chainId, hexToBase64(txRawHex), "sync");
  return {
    txhash: result.txHash,
    code: result.code,
    rawLog: result.rawLog,
    success: result.success,
  };
}

/** Hex from the kernel to base64 for the wire, without a Buffer. */
function hexToBase64(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  let binary = "";
  for (let i = 0; i < clean.length; i += 2) {
    binary += String.fromCharCode(Number.parseInt(clean.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

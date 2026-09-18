/**
 * Wallet-originated broadcast via chain registry REST (LCD).
 *
 * Accepts amino or direct signed payloads already encoded as TxRaw base64,
 * or a raw TxRaw Uint8Array. dApp `sendTx` remains unsupported on the provider.
 */

import { findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission } from "./balances";
import { getSettings } from "./settings";
import { toBase64 } from "./kernel";

const REQUEST_TIMEOUT_MS = 20_000;

export type BroadcastMode =
  | "BROADCAST_MODE_SYNC"
  | "BROADCAST_MODE_ASYNC"
  | "BROADCAST_MODE_BLOCK";

export interface BroadcastResult {
  txhash: string;
  code: number;
  rawLog: string;
  success: boolean;
}

export class BroadcastError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly rawLog?: string,
    readonly txhash?: string,
  ) {
    super(message);
    this.name = "BroadcastError";
  }
}

function restOf(chainId: string): string {
  const rest = findCatalogEntry(chainId)?.rest?.replace(/\/$/, "");
  if (!rest) {
    throw new BroadcastError(`No REST endpoint configured for ${chainId}`);
  }
  return rest;
}

async function assertCanReachLcd(): Promise<void> {
  const settings = await getSettings();
  if (!settings.liveBalances) {
    throw new BroadcastError(
      "Turn on live balances in Preferences so the wallet can reach chain REST endpoints.",
    );
  }
  if (!(await hasLiveBalancePermission())) {
    throw new BroadcastError(
      "Grant the optional host permission (Preferences → Live balances) to broadcast.",
    );
  }
}

/**
 * POST signed tx bytes to `{rest}/cosmos/tx/v1beta1/txs`.
 *
 * @param txBytes - TxRaw as Uint8Array, or base64 string
 */
export async function broadcastTx(params: {
  chainId: string;
  txBytes: Uint8Array | string;
  mode?: BroadcastMode;
}): Promise<BroadcastResult> {
  await assertCanReachLcd();
  const rest = restOf(params.chainId);
  const tx_bytes =
    typeof params.txBytes === "string"
      ? params.txBytes
      : toBase64(params.txBytes);
  const mode = params.mode ?? "BROADCAST_MODE_SYNC";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${rest}/cosmos/tx/v1beta1/txs`, {
      method: "POST",
      signal: controller.signal,
      credentials: "omit",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tx_bytes, mode }),
    });
    const body = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!res.ok) {
      const message =
        (body && typeof body.message === "string" && body.message) ||
        `Broadcast HTTP ${res.status}`;
      throw new BroadcastError(message);
    }
    return parseBroadcastBody(body);
  } finally {
    clearTimeout(timer);
  }
}

export function parseBroadcastBody(
  body: Record<string, unknown> | null,
): BroadcastResult {
  if (!body || typeof body !== "object") {
    throw new BroadcastError("Broadcast response is empty");
  }
  const response =
    (body.tx_response as Record<string, unknown> | undefined) ?? body;
  const txhash = String(response.txhash ?? response.hash ?? "");
  if (!txhash) {
    throw new BroadcastError("Broadcast response has no txhash");
  }
  const code = typeof response.code === "number" ? response.code : 0;
  const rawLog = String(response.raw_log ?? response.rawLog ?? "");
  const result: BroadcastResult = {
    txhash: txhash.toUpperCase(),
    code,
    rawLog,
    success: code === 0,
  };
  if (!result.success) {
    throw new BroadcastError(
      rawLog || `Transaction rejected (code ${code})`,
      code,
      rawLog,
      result.txhash,
    );
  }
  return result;
}

/** Fetch account_number + sequence from LCD auth. */
export async function fetchAccountNumberSequence(
  chainId: string,
  address: string,
): Promise<{ accountNumber: string; sequence: string }> {
  await assertCanReachLcd();
  const rest = restOf(chainId);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${rest}/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`,
      {
        signal: controller.signal,
        credentials: "omit",
        headers: { accept: "application/json" },
      },
    );
    if (res.status === 404) {
      return { accountNumber: "0", sequence: "0" };
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      // Some LCDs return 200-shaped NotFound via gRPC code 5.
      const code = body.code;
      if (code === 5) return { accountNumber: "0", sequence: "0" };
      throw new BroadcastError(
        `Account query failed (HTTP ${res.status})`,
      );
    }
    return parseAccountBody(body, address);
  } finally {
    clearTimeout(timer);
  }
}

function parseAccountBody(
  body: Record<string, unknown>,
  fallbackAddress: string,
): { accountNumber: string; sequence: string } {
  if (body.account === null) {
    return { accountNumber: "0", sequence: "0" };
  }
  const envelope =
    asRecord(body.account) ??
    asRecord(body.info) ??
    asRecord(asRecord(body.result)?.value) ??
    asRecord(body.result) ??
    body;

  const base =
    unwrapBaseAccount(envelope) ??
    (envelope.address || envelope.account_number !== undefined
      ? envelope
      : null);
  if (!base) {
    // Treat missing as fresh account when LCD returned an odd empty shape.
    void fallbackAddress;
    return { accountNumber: "0", sequence: "0" };
  }
  return {
    accountNumber: String(base.account_number ?? "0"),
    sequence: String(base.sequence ?? "0"),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapBaseAccount(
  envelope: Record<string, unknown>,
): Record<string, unknown> | null {
  // Proto Any: { "@type": "...BaseAccount", ...fields }
  // Nested: { base_account: { ... } } (vesting, ethermint, …)
  const nested =
    asRecord(envelope.base_account) ??
    asRecord(envelope.baseAccount) ??
    asRecord(asRecord(envelope.value)?.base_account);
  if (nested) return nested;
  if (
    envelope.account_number !== undefined ||
    envelope.sequence !== undefined ||
    typeof envelope.address === "string"
  ) {
    return envelope;
  }
  return null;
}

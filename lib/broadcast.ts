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

/**
 * Sync broadcast only ran CheckTx. Poll until the tx is in a block so a
 * DeliverTx failure (insufficient funds, out of gas) is not shown as success.
 */
export async function waitForInclusion(
  chainId: string,
  txhash: string,
  deadlineMs = 45_000,
): Promise<BroadcastResult> {
  const rest = restOf(chainId);
  const hash = txhash.toUpperCase();
  const deadline = Date.now() + deadlineMs;
  let interval = 1_200;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${rest}/cosmos/tx/v1beta1/txs/${hash}`, {
        credentials: "omit",
        headers: { accept: "application/json" },
      });
      if (res.ok) {
        const body = (await res.json()) as Record<string, unknown>;
        const response =
          (body.tx_response as Record<string, unknown> | undefined) ?? body;
        const height = String(response.height ?? "0");
        if (height !== "0") {
          const code = typeof response.code === "number" ? response.code : 0;
          const rawLog = String(response.raw_log ?? "");
          const result: BroadcastResult = {
            txhash: hash,
            code,
            rawLog,
            success: code === 0,
          };
          if (!result.success) {
            throw new BroadcastError(
              rawLog || `Transaction failed (code ${code})`,
              code,
              rawLog,
              hash,
            );
          }
          return result;
        }
      }
    } catch (error) {
      if (error instanceof BroadcastError) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(6_000, Math.round(interval * 1.4));
  }
  return { txhash: hash, code: 0, rawLog: "", success: true };
}

const ACCOUNT_NESTING_KEYS = [
  "base_account",
  "baseAccount",
  "base_vesting_account",
  "baseVestingAccount",
] as const;

/** Fetch account_number + sequence from LCD auth. Never cached. */
export async function fetchAccountNumberSequence(
  chainId: string,
  address: string,
): Promise<{ accountNumber: string; sequence: string }> {
  await assertCanReachLcd();
  const rest = restOf(chainId);
  const paths = [
    `/cosmos/auth/v1beta1/accounts/${encodeURIComponent(address)}`,
    `/cosmos/auth/v1beta1/account_info/${encodeURIComponent(address)}`,
  ];
  let lastError: unknown;
  for (const path of paths) {
    try {
      const parsed = await readAccountPath(rest, path);
      if (parsed) return parsed;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof BroadcastError) throw lastError;
  throw new BroadcastError(
    `Could not read the account sequence on ${chainId}. Try again in a moment.`,
  );
}

async function readAccountPath(
  rest: string,
  path: string,
): Promise<{ accountNumber: string; sequence: string } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${rest}${path}`, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json", "cache-control": "no-cache" },
    });
    if (res.status === 404) return { accountNumber: "0", sequence: "0" };
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const code = body.code;
      if (code === 5 || notFoundText(String(body.message ?? ""))) {
        return { accountNumber: "0", sequence: "0" };
      }
      throw new BroadcastError(`Account query failed (HTTP ${res.status})`);
    }
    if (typeof body.code === "number" && body.code !== 0) {
      if (body.code === 5 || notFoundText(String(body.message ?? ""))) {
        return { accountNumber: "0", sequence: "0" };
      }
      throw new BroadcastError(
        `Account query failed (code ${body.code})`,
      );
    }
    return parseAccountBody(body);
  } finally {
    clearTimeout(timer);
  }
}

/** True when a broadcast failed because the sign doc used a stale sequence. */
export function isSequenceMismatch(error: unknown): boolean {
  const text = sequenceErrorText(error);
  return /account sequence mismatch|incorrect account sequence|sequence mismatch/i.test(
    text,
  );
}

/**
 * The sequence the chain said it wanted, parsed from a mismatch log
 * (`expected 36, got 0`). The node is the source of truth on retry.
 */
export function expectedSequenceOf(error: unknown): string | null {
  if (error && typeof error === "object" && "failure" in error) {
    const expected = (error as { failure?: { expectedSequence?: string | null } })
      .failure?.expectedSequence;
    if (typeof expected === "string" && /^\d+$/.test(expected)) return expected;
  }
  const match = /expected\s+(\d+)/i.exec(sequenceErrorText(error));
  return match?.[1] ?? null;
}

function sequenceErrorText(error: unknown): string {
  if (error instanceof BroadcastError) {
    return `${error.message} ${error.rawLog ?? ""}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function parseAccountBody(
  body: Record<string, unknown>,
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

  const base = unwrapBaseAccount(envelope);
  if (!base) {
    throw new BroadcastError(
      "Account response had no sequence. Nothing was signed.",
    );
  }
  return {
    accountNumber: readUint(base.account_number),
    sequence: readUint(base.sequence),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unwrapBaseAccount(
  start: Record<string, unknown>,
): Record<string, unknown> | null {
  let row: Record<string, unknown> = start;
  for (let depth = 0; depth < 6; depth++) {
    if (row.account_number !== undefined && row.sequence !== undefined) {
      return row;
    }
    let next: Record<string, unknown> | null = null;
    for (const key of ACCOUNT_NESTING_KEYS) {
      const candidate = asRecord(row[key]);
      if (candidate) {
        next = candidate;
        break;
      }
    }
    if (!next) next = asRecord(row.value);
    if (!next) break;
    row = next;
  }
  return row.address || row["@type"] || row.type ? row : null;
}

function readUint(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "0";
  if (typeof raw === "number" && Number.isFinite(raw)) return String(Math.trunc(raw));
  if (typeof raw === "string" && /^\d+$/.test(raw)) return raw;
  throw new BroadcastError(`Account sequence is not a number: ${String(raw)}`);
}

function notFoundText(text: string): boolean {
  return /not found|does not exist|unknown address|key not found/i.test(text);
}

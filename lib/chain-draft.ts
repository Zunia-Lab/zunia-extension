/**
 * Validation for chains that do not come from the bundled registry: the ones a
 * user types into Networks and the ones a dApp proposes through
 * `experimentalSuggestChain`. Both end up deriving addresses and receiving
 * balance queries, so both go through the same checks before anything is saved.
 *
 * Pure on purpose: no `browser` global, so the rules can be tested directly.
 */

import { CHAIN_CATALOG } from "./chain-catalog.generated";

export interface CustomChainDraft {
  chainName: string;
  chainId: string;
  rpc: string;
  rest: string;
  bech32Prefix: string;
  coinType: number;
  coinDenom: string;
  coinMinimalDenom: string;
  coinDecimals: number;
  gasPrice: number;
}

export class ChainDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainDraftError";
  }
}

const CHAIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PREFIX_RE = /^[a-z][a-z0-9]{1,19}$/;
/** The Cosmos SDK base-denom rule, which also admits IBC and factory paths. */
const DENOM_RE = /^[a-zA-Z][a-zA-Z0-9/:._-]{1,127}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;
const MAX_COIN_TYPE = 0x7fffffff;
const DEFAULT_GAS_PRICE = 0.025;

function cleanLabel(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new ChainDraftError(`${field} is required`);
  const trimmed = value.trim();
  if (!trimmed) throw new ChainDraftError(`${field} is required`);
  if (trimmed.length > max) {
    throw new ChainDraftError(`${field} must be ${max} characters or fewer`);
  }
  if (CONTROL_RE.test(trimmed)) {
    throw new ChainDraftError(`${field} contains hidden or control characters`);
  }
  return trimmed;
}

/** An endpoint the wallet will send the user's addresses to. HTTPS only, no credentials. */
export function cleanEndpoint(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ChainDraftError(`${field} is required`);
  }
  const raw = value.trim();
  if (raw.length > 2048) throw new ChainDraftError(`${field} is too long`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChainDraftError(`${field} is not a valid URL`);
  }
  if (url.protocol !== "https:") {
    throw new ChainDraftError(`${field} must be an https:// URL`);
  }
  if (url.username || url.password) {
    throw new ChainDraftError(`${field} must not contain a username or password`);
  }
  return raw.replace(/\/+$/, "");
}

function wholeNumber(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new ChainDraftError(`${field} must be a whole number from ${min} to ${max}`);
  }
  return n;
}

export function isRegistryChainId(chainId: string): boolean {
  return CHAIN_CATALOG.some((c) => c.chainId === chainId);
}

/** Normalize a draft or throw a {@link ChainDraftError} naming the first bad field. */
export function validateCustomChainDraft(draft: CustomChainDraft): CustomChainDraft {
  const chainId = typeof draft.chainId === "string" ? draft.chainId.trim() : "";
  if (!chainId) throw new ChainDraftError("Chain ID is required");
  if (!CHAIN_ID_RE.test(chainId)) {
    throw new ChainDraftError(
      "Chain ID may use letters, digits, dot, dash and underscore (64 characters max)",
    );
  }
  if (isRegistryChainId(chainId)) {
    throw new ChainDraftError("That chain ID is already in the registry");
  }

  const bech32Prefix =
    typeof draft.bech32Prefix === "string" ? draft.bech32Prefix.trim() : "";
  if (!PREFIX_RE.test(bech32Prefix)) {
    throw new ChainDraftError("Prefix must be lowercase letters, optionally followed by digits");
  }

  const coinMinimalDenom =
    typeof draft.coinMinimalDenom === "string" ? draft.coinMinimalDenom.trim() : "";
  if (!DENOM_RE.test(coinMinimalDenom)) {
    throw new ChainDraftError("Base denom is not a valid Cosmos denom");
  }

  const gasPrice =
    draft.gasPrice === undefined || draft.gasPrice === null
      ? DEFAULT_GAS_PRICE
      : Number(draft.gasPrice);
  if (!Number.isFinite(gasPrice) || gasPrice < 0 || gasPrice > 1_000_000) {
    throw new ChainDraftError("Gas price must be a positive number");
  }

  return {
    chainId,
    chainName: cleanLabel(draft.chainName, "Name", 48),
    rpc: cleanEndpoint(draft.rpc, "RPC"),
    rest: cleanEndpoint(draft.rest, "REST"),
    bech32Prefix,
    coinType: wholeNumber(draft.coinType, "Coin type", 0, MAX_COIN_TYPE),
    coinDenom: cleanLabel(draft.coinDenom, "Symbol", 16),
    coinMinimalDenom,
    coinDecimals: wholeNumber(draft.coinDecimals, "Decimals", 0, 18),
    gasPrice,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstRecord(value: unknown): Record<string, unknown> {
  return Array.isArray(value) ? record(value[0]) : {};
}

/**
 * Read a Keplr-style `ChainInfo` (the shape dApps pass to `experimentalSuggestChain`)
 * into a draft and validate it. Unknown fields are ignored; nothing the dApp sends
 * is stored unless it survives {@link validateCustomChainDraft}.
 */
export function draftFromSuggestedChain(raw: unknown): CustomChainDraft {
  const info = record(raw);
  const bech32 = record(info.bech32Config);
  const bip44 = record(info.bip44);
  const currency = firstRecord(info.currencies);
  const stake = record(info.stakeCurrency);
  const fee = firstRecord(info.feeCurrencies);
  const primary = Object.keys(currency).length ? currency : stake;
  const step = record(fee.gasPriceStep);

  return validateCustomChainDraft({
    chainId: String(info.chainId ?? ""),
    chainName: String(info.chainName ?? info.chainId ?? ""),
    rpc: String(info.rpc ?? ""),
    rest: String(info.rest ?? ""),
    bech32Prefix: String(bech32.bech32PrefixAccAddr ?? info.bech32Prefix ?? ""),
    coinType: Number(bip44.coinType ?? info.coinType ?? Number.NaN),
    coinDenom: String(primary.coinDenom ?? ""),
    coinMinimalDenom: String(primary.coinMinimalDenom ?? ""),
    coinDecimals: Number(primary.coinDecimals ?? Number.NaN),
    gasPrice: Number(step.average ?? step.low ?? DEFAULT_GAS_PRICE),
  });
}

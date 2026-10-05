/**
 * Read-only chain queries behind the same opt-in host permission as balances.
 *
 * Everything here hits the public REST (LCD) endpoint the registry lists for a
 * chain. Nothing is signed and nothing is broadcast. When the permission is
 * missing the calls short-circuit so the UI can render its "reads are off"
 * state instead of failing.
 */

import {
  decodeBase64Utf8,
  extractPacketsFromTx,
  parseIcs20PacketData,
  type ExtractedPacket,
  type Ics20PacketData,
} from "@zunialab/interchain";

import { chainTicker, findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission, heldTokenIdentity, type TokenBalance } from "./balances";
import { coinDisplay, type CoinDisplay } from "./coin-display";
import { shortAddress, shortDenom } from "./format";
import { IBC_CHANNEL_ROWS } from "./ibc-channels.generated";
import { getSettings } from "./settings";
import {
  amountFieldText,
  amountUnit,
  formatTokenAmount,
  type AmountIdentity,
  type TokenAmountVariant,
} from "./token-amount";
import {
  hydrateTokenIdentities,
  ibcDenomFor,
  identityOf,
  type TokenIdentity,
  type TokenProvenance,
} from "./token-identity";

export { baseDenomOf, coinDisplay, formatCoin, type CoinDisplay } from "./coin-display";

const REQUEST_TIMEOUT_MS = 9_000;

export interface ValidatorInfo {
  chainId: string;
  operatorAddress: string;
  moniker: string;
  /** Keybase hex from `description.identity`, empty when the validator set none. */
  identity: string;
  /** Keybase picture URL, set after the identity lookup. */
  logoUrl?: string;
  /** Commission rate as a 0-1 fraction. */
  commission: number;
  /** Max commission the validator can raise to, 0-1. */
  maxCommission: number;
  /** Share of total bonded stake, 0-1. */
  votingPower: number;
  tokens: string;
  minSelfDelegation: string;
  website: string;
  details: string;
  jailed: boolean;
  status: string;
}

/** http(s) website from `description.website`, or null when the field is empty or unsafe. */
export function validatorWebsite(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export type ValidatorBondState = "active" | "inactive" | "jailed";

/** Bonded and not jailed is active. Unbonded / unbonding is inactive. */
export function validatorBondState(input: {
  jailed?: boolean;
  status?: string;
}): ValidatorBondState {
  if (input.jailed) return "jailed";
  const status = (input.status ?? "")
    .trim()
    .toUpperCase()
    .replace(/^BOND_STATUS_/, "");
  if (
    status === "UNBONDED" ||
    status === "UNBONDING" ||
    status === "1" ||
    status === "3"
  ) {
    return "inactive";
  }
  return "active";
}

export interface DelegationInfo {
  chainId: string;
  validatorAddress: string;
  moniker: string;
  identity: string;
  logoUrl?: string;
  amount: string;
  rewards: string;
  denom: string;
  decimals: number;
  symbol: string;
  jailed: boolean;
  status: string;
}

export interface UnbondingInfo {
  chainId: string;
  validatorAddress: string;
  moniker: string;
  identity: string;
  logoUrl?: string;
  amount: string;
  completionTime: string;
  denom: string;
  decimals: number;
  symbol: string;
}

export type ProposalStatus =
  | "voting"
  | "deposit"
  | "passed"
  | "rejected"
  | "failed"
  | "unknown";

export interface ProposalInfo {
  chainId: string;
  id: string;
  title: string;
  summary: string;
  status: ProposalStatus;
  votingEndTime?: string;
  /** Normalised 0-1 tallies. Absent when the chain returns nothing. */
  tally?: { yes: number; no: number; veto: number; abstain: number };
}

export type ActivityKind =
  | "sent"
  | "received"
  | "ibc"
  | "swap"
  | "staking"
  | "claim"
  | "governance"
  | "other";

export interface ActivityItem {
  chainId: string;
  hash: string;
  kind: ActivityKind;
  /** `Send USDC.n`, `Receive USDC.n over IBC`: named by the coin's identity. */
  title: string;
  subtitle: string;
  /** Signed base-unit delta for the account, when we can work it out. */
  amount?: string;
  /**
   * The exact bank denom on `chainId` that moved. For an IBC receipt it is the
   * denom the receiving chain credited (`ibc/498A…` for Noble USDC arriving on
   * Osmosis, `uusdc` for it coming home to Noble), never the packet's
   * sender-side denom.
   */
  denom?: string;
  /** For `denom`: 0 when `decimalsKnown` is false, and `amount` is then base units. */
  decimals: number;
  /** The identity's ticker (`USDC.n`, `IBC·498A`), the same word the title uses. */
  symbol: string;
  /**
   * False when nothing proves `decimals`: show `amount` in base units, never
   * scaled. Set with `denom`; see {@link activityAmountIdentity}.
   */
  decimalsKnown?: boolean;
  /** How the coin's identity was established; `unknown` when nothing names it. */
  provenance?: TokenProvenance;
  /** The coin's identity is proven: the only reason to show a seal. */
  proven?: boolean;
  timestamp: number;
  success: boolean;
  from?: string;
  to?: string;
  /** Short protobuf name, e.g. `MsgUpdateClient`. Drives the row icon. */
  messageType?: string;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      credentials: "omit",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function readsAllowed(): Promise<boolean> {
  const settings = await getSettings();
  return settings.liveBalances && (await hasLiveBalancePermission());
}

function restOf(chainId: string): string | null {
  const rest = findCatalogEntry(chainId)?.rest?.replace(/\/$/, "");
  return rest || null;
}

function denomMeta(chainId: string) {
  const entry = findCatalogEntry(chainId);
  return {
    denom: entry?.coinMinimalDenom ?? "",
    decimals: entry?.coinDecimals ?? 6,
    symbol: entry ? chainTicker(entry) : chainId,
  };
}

function pickAmount(
  rows: Array<{ denom?: string; amount?: string }> | undefined,
  denom: string,
): string {
  if (!rows) return "0";
  let total = 0n;
  for (const row of rows) {
    if (row.denom !== denom || !row.amount) continue;
    total += BigInt(row.amount.split(".")[0] || "0");
  }
  return total.toString();
}

/** Bonded validators, strongest first. */
export async function fetchValidators(
  chainId: string,
): Promise<ValidatorInfo[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];

  const body = (await getJson(
    `${rest}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=150`,
  )) as {
    validators?: Array<{
      operator_address?: string;
      jailed?: boolean;
      status?: string;
      tokens?: string;
      min_self_delegation?: string;
      description?: {
        moniker?: string;
        identity?: string;
        website?: string;
        details?: string;
      };
      commission?: {
        commission_rates?: { rate?: string; max_rate?: string };
      };
    }>;
  };

  const rows = body.validators ?? [];
  const total = rows.reduce((sum, v) => sum + BigInt(v.tokens || "0"), 0n);
  const mapped = rows
    .map((v) => ({
      chainId,
      operatorAddress: v.operator_address ?? "",
      moniker: v.description?.moniker ?? v.operator_address ?? "Validator",
      identity: v.description?.identity ?? "",
      commission: Number(v.commission?.commission_rates?.rate ?? "0"),
      maxCommission: Number(v.commission?.commission_rates?.max_rate ?? "0"),
      votingPower:
        total > 0n ? Number((BigInt(v.tokens || "0") * 10000n) / total) / 10000 : 0,
      tokens: v.tokens ?? "0",
      minSelfDelegation: v.min_self_delegation ?? "0",
      website: v.description?.website ?? "",
      details: (v.description?.details ?? "").trim(),
      jailed: Boolean(v.jailed),
      status: v.status ?? "",
    }))
    .sort((a, b) => Number(b.tokens) - Number(a.tokens));
  // Do not wait on Keybase here. A bonded set is 100+ rows; looking each
  // identity up before returning left Earn blank and often timed the
  // background message out. The popup resolves pictures per row.
  return mapped;
}

/** Active delegations for one address, with their pending rewards. */
export async function fetchDelegations(
  chainId: string,
  address: string,
): Promise<DelegationInfo[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];
  const meta = denomMeta(chainId);

  const [delegations, rewards] = await Promise.allSettled([
    getJson(`${rest}/cosmos/staking/v1beta1/delegations/${address}`),
    getJson(`${rest}/cosmos/distribution/v1beta1/delegators/${address}/rewards`),
  ]);
  if (delegations.status === "rejected") return [];

  const rewardByValidator = new Map<string, string>();
  if (rewards.status === "fulfilled") {
    const body = rewards.value as {
      rewards?: Array<{
        validator_address?: string;
        reward?: Array<{ denom?: string; amount?: string }>;
      }>;
    };
    for (const row of body.rewards ?? []) {
      if (!row.validator_address) continue;
      rewardByValidator.set(
        row.validator_address,
        pickAmount(row.reward, meta.denom),
      );
    }
  }

  const body = delegations.value as {
    delegation_responses?: Array<{
      delegation?: { validator_address?: string };
      balance?: { denom?: string; amount?: string };
    }>;
  };
  const rows = body.delegation_responses ?? [];

  const monikers = await resolveValidatorMeta(
    rest,
    rows.map((r) => r.delegation?.validator_address ?? ""),
  );

  return rows.map((row) => {
    const validator = row.delegation?.validator_address ?? "";
    const metaRow = monikers.get(validator);
    return {
      chainId,
      validatorAddress: validator,
      moniker: metaRow?.moniker ?? validator,
      identity: metaRow?.identity ?? "",
      amount: row.balance?.amount ?? "0",
      rewards: rewardByValidator.get(validator) ?? "0",
      jailed: metaRow?.jailed ?? false,
      status: metaRow?.status ?? "",
      ...meta,
    };
  });
}

/** In-flight unbonding entries, soonest completion first. */
export async function fetchUnbonding(
  chainId: string,
  address: string,
): Promise<UnbondingInfo[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];
  const meta = denomMeta(chainId);

  const body = (await getJson(
    `${rest}/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`,
  ).catch(() => ({}))) as {
    unbonding_responses?: Array<{
      validator_address?: string;
      entries?: Array<{ balance?: string; completion_time?: string }>;
    }>;
  };

  const rows = body.unbonding_responses ?? [];
  const monikers = await resolveValidatorMeta(
    rest,
    rows.map((r) => r.validator_address ?? ""),
  );

  return rows
    .flatMap((row) =>
      (row.entries ?? []).map((entry) => {
        const metaRow = monikers.get(row.validator_address ?? "");
        return {
          chainId,
          validatorAddress: row.validator_address ?? "",
          moniker: metaRow?.moniker ?? row.validator_address ?? "",
          identity: metaRow?.identity ?? "",
          amount: entry.balance ?? "0",
          completionTime: entry.completion_time ?? "",
          ...meta,
        };
      }),
    )
    .sort((a, b) => a.completionTime.localeCompare(b.completionTime));
}

async function resolveValidatorMeta(
  rest: string,
  operators: string[],
): Promise<
  Map<
    string,
    { moniker: string; identity: string; jailed: boolean; status: string }
  >
> {
  const unique = Array.from(new Set(operators.filter(Boolean)));
  const pairs = await Promise.all(
    unique.map(async (operator) => {
      try {
        const body = (await getJson(
          `${rest}/cosmos/staking/v1beta1/validators/${operator}`,
        )) as {
          validator?: {
            jailed?: boolean;
            status?: string;
            description?: { moniker?: string; identity?: string };
          };
        };
        return [
          operator,
          {
            moniker: body.validator?.description?.moniker ?? operator,
            identity: body.validator?.description?.identity ?? "",
            jailed: Boolean(body.validator?.jailed),
            status: body.validator?.status ?? "",
          },
        ] as const;
      } catch {
        return [
          operator,
          { moniker: operator, identity: "", jailed: false, status: "" },
        ] as const;
      }
    }),
  );
  return new Map(pairs);
}

function normaliseStatus(raw: string): ProposalStatus {
  switch (raw) {
    case "PROPOSAL_STATUS_VOTING_PERIOD":
      return "voting";
    case "PROPOSAL_STATUS_DEPOSIT_PERIOD":
      return "deposit";
    case "PROPOSAL_STATUS_PASSED":
      return "passed";
    case "PROPOSAL_STATUS_REJECTED":
      return "rejected";
    case "PROPOSAL_STATUS_FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

function normaliseTally(
  tally:
    | {
        yes_count?: string;
        no_count?: string;
        no_with_veto_count?: string;
        abstain_count?: string;
        yes?: string;
        no?: string;
        no_with_veto?: string;
        abstain?: string;
      }
    | undefined,
): ProposalInfo["tally"] {
  if (!tally) return undefined;
  const yes = Number(tally.yes_count ?? tally.yes ?? "0");
  const no = Number(tally.no_count ?? tally.no ?? "0");
  const veto = Number(tally.no_with_veto_count ?? tally.no_with_veto ?? "0");
  const abstain = Number(tally.abstain_count ?? tally.abstain ?? "0");
  const total = yes + no + veto + abstain;
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return {
    yes: yes / total,
    no: no / total,
    veto: veto / total,
    abstain: abstain / total,
  };
}

/**
 * Governance proposals for a chain. Tries gov v1 first and falls back to
 * v1beta1, since older chains never migrated.
 */
export async function fetchProposals(
  chainId: string,
): Promise<ProposalInfo[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];

  const v1 = await getJson(
    `${rest}/cosmos/gov/v1/proposals?pagination.limit=20&pagination.reverse=true`,
  ).catch(() => null);

  if (v1) {
    const body = v1 as {
      proposals?: Array<{
        id?: string;
        title?: string;
        summary?: string;
        status?: string;
        voting_end_time?: string;
        final_tally_result?: Record<string, string>;
        messages?: Array<{ content?: { title?: string; description?: string } }>;
      }>;
    };
    return (body.proposals ?? []).map((p) => ({
      chainId,
      id: p.id ?? "",
      title:
        p.title ||
        p.messages?.[0]?.content?.title ||
        `Proposal ${p.id ?? ""}`.trim(),
      summary: p.summary || p.messages?.[0]?.content?.description || "",
      status: normaliseStatus(p.status ?? ""),
      votingEndTime: p.voting_end_time,
      tally: normaliseTally(p.final_tally_result),
    }));
  }

  const legacy = (await getJson(
    `${rest}/cosmos/gov/v1beta1/proposals?pagination.limit=20&pagination.reverse=true`,
  ).catch(() => null)) as {
    proposals?: Array<{
      proposal_id?: string;
      status?: string;
      voting_end_time?: string;
      content?: { title?: string; description?: string };
      final_tally_result?: Record<string, string>;
    }>;
  } | null;
  if (!legacy) return [];

  return (legacy.proposals ?? []).map((p) => ({
    chainId,
    id: p.proposal_id ?? "",
    title: p.content?.title || `Proposal ${p.proposal_id ?? ""}`.trim(),
    summary: p.content?.description ?? "",
    status: normaliseStatus(p.status ?? ""),
    votingEndTime: p.voting_end_time,
    tally: normaliseTally(p.final_tally_result),
  }));
}

/* -------------------------------------------------------------------------- *
 * Activity
 * -------------------------------------------------------------------------- */

/** Rows asked for per chain on the first page, and added by each "Load more". */
export const ACTIVITY_PAGE_SIZE = 15;
/** The most rows a public node returns for one tx search. */
export const MAX_ACTIVITY_LIMIT = 100;

interface Coin {
  denom: string;
  amount: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** The first well-formed coin in a coin or a list of coins. */
function firstCoin(value: unknown): Coin | null {
  const rows = Array.isArray(value) ? value : [value];
  for (const row of rows) {
    const coin = asRecord(row);
    const denom = text(coin?.denom);
    const amount = text(coin?.amount).split(".")[0] ?? "";
    if (denom && /^\d+$/.test(amount)) return { denom, amount };
  }
  return null;
}

function typeUrlOf(message: Record<string, unknown>): string {
  return text(message["@type"]);
}

/** `MsgSend` from `/cosmos.bank.v1beta1.MsgSend`. */
function shortTypeName(typeUrl: string): string {
  return typeUrl.split(".").pop() || typeUrl || "Unknown message";
}

/** `Swap Exact Amount In` from `MsgSwapExactAmountIn`. */
function humanType(typeUrl: string): string {
  return shortTypeName(typeUrl)
    .replace(/^Msg/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

/** The ICS20 payload a `MsgRecvPacket` delivers, or `null` for anything else. */
function receivedPacket(message: Record<string, unknown>) {
  const packet = asRecord(message.packet);
  const raw = text(packet?.data);
  if (!packet || !raw) return null;
  let data: Ics20PacketData | null = null;
  let tracedDenom = false;
  try {
    const json = decodeBase64Utf8(raw);
    data = parseIcs20PacketData(json);
    // ICS20 v1 writes the whole trace into `denom`. A v2 packet nests the
    // token and its trace, and the engine keeps only the base from it, which
    // is not enough to say what the receiver was credited.
    tracedDenom = typeof asRecord(JSON.parse(json) as unknown)?.denom === "string";
  } catch {
    return null;
  }
  if (!data) return null;
  return {
    data,
    tracedDenom,
    channel: text(packet.destination_channel),
    ends: {
      sourcePort: text(packet.source_port),
      sourceChannel: text(packet.source_channel),
      destinationPort: text(packet.destination_port),
      destinationChannel: text(packet.destination_channel),
    },
  };
}

/** The two ends of a received ICS20 packet, as the chain's JSON spells them. */
export interface PacketEnds {
  readonly sourcePort?: string;
  readonly sourceChannel?: string;
  readonly destinationPort?: string;
  readonly destinationChannel?: string;
}

let canonicalEnds: Map<string, string> | null = null;

/**
 * The channel id at the other end of `channelId` on `chainId`, from the
 * registry's canonical channel table. A channel's counterparty is fixed when
 * the channel opens, so this is a fact about the channel, not a guess about
 * the packet.
 */
function canonicalCounterpartyChannel(chainId: string, channelId: string): string | null {
  if (!canonicalEnds) {
    canonicalEnds = new Map();
    for (const [source, channel, , counterparty] of IBC_CHANNEL_ROWS) {
      canonicalEnds.set(`${source}|${channel}`, counterparty);
    }
  }
  return canonicalEnds.get(`${chainId}|${channelId}`) ?? null;
}

/**
 * A hop's identifier, by ibc-go's rule: a channel id (`channel-750`), or since
 * ibc-go v10 an IBC v2 client id (`08-wasm-1369`, `07-tendermint-0`;
 * clienttypes.IsClientIDFormat). The Hub's Eureka tokens carry the second
 * kind: `transfer/08-wasm-1369/0xc02a…` is ETH.eureka's trace.
 */
const HOP_ID = /^(?:channel-\d+|\w+(?:[\w-]+\w)?-\d{1,20})$/;

/**
 * `transfer/channel-0/uatom` and `transfer/08-wasm-1369/0xc02a…` are traces;
 * `uatom` and `factory/osmo1…/x` are bank denoms (ibc-go's rule).
 */
function isTracedDenom(denom: string): boolean {
  const parts = denom.split("/");
  return parts.length > 2 && HOP_ID.test(parts[1] ?? "");
}

/**
 * The bank denom a received ICS20 packet credits on `chainId`, by ibc-go's
 * receive rule. The packet's `denom` is the sender's trace, so it is never the
 * denom the receiver holds:
 * - when it starts with the packet's own source `port/channel/`, the token is
 *   going home: that prefix comes off, leaving the native denom (`uusdc` for
 *   Noble USDC returning to Noble) or the voucher of the remaining trace;
 * - otherwise the receiving chain mints the voucher of
 *   `destPort/destChannel/denom` (`ibc/498A…` for `uusdc` arriving on Osmosis
 *   over channel-750).
 *
 * A packet the chain's JSON lists without its source end is read through the
 * registry's canonical table for its destination channel; `null` when that
 * still leaves the source unknown, rather than a guess.
 */
export function receivedDenomOf(chainId: string, packetDenom: string, ends: PacketEnds): string | null {
  const destinationChannel = ends.destinationChannel ?? "";
  if (!packetDenom || !/^channel-\d+$/.test(destinationChannel)) return null;
  const destinationPort = ends.destinationPort || "transfer";
  const sourcePort = ends.sourcePort || "transfer";
  const sourceChannel =
    ends.sourceChannel ||
    (destinationPort === "transfer" ? canonicalCounterpartyChannel(chainId, destinationChannel) : null);
  if (!sourceChannel) return null;
  const prefix = `${sourcePort}/${sourceChannel}/`;
  if (packetDenom.startsWith(prefix)) {
    const home = packetDenom.slice(prefix.length);
    if (!home) return null;
    return isTracedDenom(home) ? ibcDenomFor("", home) : home;
  }
  return ibcDenomFor(`${destinationPort}/${destinationChannel}`, packetDenom);
}

/** A relayer delivers a packet with client updates around it. */
const RELAYER_UPKEEP = /\.(MsgUpdateClient|MsgAcknowledgement|MsgTimeout|MsgTimeoutOnClose)$/;

/**
 * The message a transaction is about, for this account.
 *
 * A relayer's transaction usually opens with a client update and may deliver
 * packets for many people, so the one delivering to this account wins, then
 * the first message that is not relayer upkeep.
 */
export function pickMessage(
  messages: readonly Record<string, unknown>[],
  address: string,
): Record<string, unknown> | undefined {
  const delivery = messages.find(
    (message) =>
      typeUrlOf(message).endsWith(".MsgRecvPacket") &&
      receivedPacket(message)?.data.receiver === address,
  );
  if (delivery) return delivery;
  return (
    messages.find((message) => {
      const type = typeUrlOf(message);
      return !RELAYER_UPKEEP.test(type) && !type.endsWith(".MsgRecvPacket");
    }) ?? messages[0]
  );
}

/** What a history row needs from a coin's identity. */
type CoinFacts = Pick<TokenIdentity, "decimals" | "decimalsKnown" | "ticker" | "provenance" | "proven">;

/**
 * A coin nothing names: base units, and its own spelling as the only word for
 * it. Used for a receipt whose credited denom is unknown, so the packet's
 * sender-side `uusdc` is never read as this chain's denom (it would name an
 * unlisted local token) or as any issuer's.
 */
function unknownCoin(spelling: string): CoinFacts {
  return { decimals: 0, decimalsKnown: false, ticker: shortDenom(spelling), provenance: "unknown", proven: false };
}

/**
 * The unit after an amount: the ticker, or the short denom for a coin nothing
 * names (`ibc/498A…6BA6E4` says which voucher; `IBC·498A` is the ticker the
 * title uses for it). Without a denom, the ticker is all there is.
 */
function unitOf(facts: Pick<TokenIdentity, "ticker" | "provenance">, denom: string | undefined): string {
  return facts.provenance === "unknown" && denom ? amountUnit({ ...facts, denom }) : facts.ticker;
}

/** `2.5 OSMO`, `12340000 base units ibc/498A…6BA6E4`: exact, for a sentence about one message. */
function coinWords(amount: string, facts: CoinFacts & { denom: string }): string {
  return `${formatTokenAmount(amount, facts, "confirm")} ${unitOf(facts, facts.denom || undefined)}`;
}

/** One message as the history row and the detail list describe it. */
export interface DescribedMessage {
  kind: ActivityKind;
  title: string;
  subtitle: string;
  /** Signed base units for this account; negative when value left it. */
  amount?: string;
  /** The exact bank denom on this chain, see {@link ActivityItem.denom}. */
  denom?: string;
  decimals: number;
  /** The coin's ticker, or the chain's own when the message moves no coin. */
  symbol: string;
  decimalsKnown?: boolean;
  provenance?: TokenProvenance;
  proven?: boolean;
  /** One sentence for the transaction detail. */
  summary: string;
  from?: string;
  to?: string;
  channel?: string;
  contract?: string;
  proposalId?: string;
  vote?: string;
}

/**
 * Read one message into words. Unknown messages keep their type name.
 *
 * Every coin is named by its {@link TokenIdentity} on `chainId`, so the title
 * (`Send USDC.n`), the summary and the amount fields come from one identity
 * and always agree. A coin nothing names keeps its short denom in prose and
 * its amount in base units, never a guessed issuer or exponent.
 */
export function describeMessage(
  message: Record<string, unknown>,
  address: string,
  chainId: string,
): DescribedMessage {
  const type = typeUrlOf(message);
  const nativeDenom = findCatalogEntry(chainId)?.coinMinimalDenom ?? "";
  const native = identityOf(chainId, nativeDenom);
  const plain = { decimals: native.decimals, symbol: nativeDenom ? native.ticker : "" };
  /** `denom` absent: the coin's denom on this chain is not known (see MsgRecvPacket). */
  const coinOf = (amount: string, denom: string | undefined, facts: CoinFacts, sign: "" | "-") => ({
    amount: `${sign}${amount}`,
    ...(denom ? { denom } : {}),
    decimals: facts.decimals,
    symbol: facts.ticker,
    decimalsKnown: facts.decimalsKnown,
    provenance: facts.provenance,
    proven: facts.proven,
    words: coinWords(amount, { ...facts, denom: denom ?? "" }),
  });
  const withCoin = (coin: Coin | null, sign: "" | "-" = "") =>
    coin ? coinOf(coin.amount, coin.denom, identityOf(chainId, coin.denom), sign) : { ...plain, words: "" };

  if (type.endsWith(".MsgSend")) {
    const from = text(message.from_address);
    const to = text(message.to_address);
    const outgoing = from === address;
    const { words, ...coin } = withCoin(firstCoin(message.amount), outgoing ? "-" : "");
    return {
      kind: outgoing ? "sent" : "received",
      title: `${outgoing ? "Send" : "Receive"} ${coin.symbol}`,
      subtitle: outgoing ? `to ${to}` : `from ${from}`,
      ...coin,
      from,
      to,
      summary: outgoing
        ? `Send ${words} to ${shortAddress(to)}`
        : `Receive ${words} from ${shortAddress(from)}`,
    };
  }

  if (type.endsWith(".MsgMultiSend")) {
    const inputs = Array.isArray(message.inputs) ? message.inputs : [];
    const outgoing = inputs.some((input) => text(asRecord(input)?.address) === address);
    return {
      kind: outgoing ? "sent" : "received",
      title: outgoing ? "Send to several" : "Receive",
      subtitle: "multi-send",
      ...plain,
      summary: outgoing ? "Send to several addresses at once" : "Receive in a multi-send",
    };
  }

  if (type.endsWith(".MsgTransfer")) {
    const receiver = text(message.receiver);
    const channel = text(message.source_channel);
    const { words, ...coin } = withCoin(firstCoin(message.token), "-");
    return {
      kind: "ibc",
      title: `Send ${coin.symbol} over IBC`,
      subtitle: `to ${receiver}`,
      ...coin,
      from: text(message.sender) || address,
      to: receiver,
      channel,
      summary: `Send ${words} over IBC to ${shortAddress(receiver)} on ${channel}`,
    };
  }

  if (type.endsWith(".MsgRecvPacket")) {
    const packet = receivedPacket(message);
    const data = packet?.data;
    const amount = data?.amount ?? "";
    if (packet && data?.receiver === address && data.denom && /^\d+$/.test(amount)) {
      // Named by what this chain credited, not by the sender's trace: the
      // packet's `uusdc` is Noble USDC only once the channel says so. When the
      // credited denom cannot be worked out, nothing is named after the
      // packet's own spelling: the amount stays in base units.
      const local = packet.tracedDenom ? receivedDenomOf(chainId, data.denom, packet.ends) : null;
      const { words, ...coin } = local
        ? coinOf(amount, local, identityOf(chainId, local), "")
        : coinOf(amount, undefined, unknownCoin(data.denom), "");
      const sender = data.sender ?? "";
      return {
        kind: "ibc",
        title: `Receive ${coin.symbol} over IBC`,
        subtitle: `from ${sender}`,
        ...coin,
        from: sender,
        to: data.receiver,
        channel: packet?.channel,
        summary: `Receive ${words} over IBC from ${shortAddress(sender)} on ${packet?.channel}`,
      };
    }
    return {
      kind: "other",
      title: "Deliver IBC packet",
      subtitle: packet?.channel ?? "",
      ...plain,
      summary: `Deliver an IBC packet${packet?.channel ? ` on ${packet.channel}` : ""}`,
    };
  }

  if (RELAYER_UPKEEP.test(type)) {
    return {
      kind: "other",
      title: humanType(type),
      subtitle: type,
      ...plain,
      summary: type.endsWith(".MsgUpdateClient")
        ? `Update the IBC client ${text(message.client_id)}`.trim()
        : `IBC relayer step: ${humanType(type).toLowerCase()}`,
    };
  }

  if (type.includes("MsgSwap") || type.endsWith(".MsgJoinPool") || type.endsWith(".MsgExitPool")) {
    const { words, ...coin } = withCoin(firstCoin(message.token_in ?? message.token_in_maxs), "-");
    const routes = Array.isArray(message.routes) ? message.routes : [];
    const outDenom = text(asRecord(routes[routes.length - 1])?.token_out_denom);
    const outSymbol = outDenom ? identityOf(chainId, outDenom).ticker : "";
    return {
      kind: "swap",
      title: humanType(type),
      subtitle: outSymbol ? `${coin.symbol} for ${outSymbol}` : type,
      ...coin,
      summary: words
        ? `${humanType(type)}: ${words}${outSymbol ? ` for ${outSymbol}` : ""}`
        : humanType(type),
    };
  }

  if (type.endsWith(".MsgExecuteContract")) {
    const contract = text(message.contract);
    const action = Object.keys(asRecord(message.msg) ?? {})[0] ?? "";
    const { words, ...coin } = withCoin(firstCoin(message.funds), "-");
    return {
      kind: action.includes("swap") ? "swap" : "other",
      title: action ? `Call ${action}` : "Contract call",
      subtitle: `on ${contract}`,
      ...coin,
      to: contract,
      contract,
      summary: `Call ${action || "a contract"} on ${shortAddress(contract)}${words ? ` with ${words}` : ""}`,
    };
  }

  if (type.endsWith(".MsgDelegate") || type.endsWith(".MsgUndelegate")) {
    const delegate = type.endsWith(".MsgDelegate");
    const validator = text(message.validator_address);
    const { words, ...coin } = withCoin(firstCoin(message.amount));
    return {
      kind: "staking",
      title: delegate ? "Delegate" : "Undelegate",
      subtitle: validator,
      ...coin,
      ...(delegate ? { to: validator } : { from: validator }),
      summary: delegate
        ? `Delegate ${words} to ${shortAddress(validator)}`
        : `Undelegate ${words} from ${shortAddress(validator)}`,
    };
  }

  if (type.endsWith(".MsgBeginRedelegate")) {
    const from = text(message.validator_src_address);
    const to = text(message.validator_dst_address);
    const { words, ...coin } = withCoin(firstCoin(message.amount));
    return {
      kind: "staking",
      title: "Redelegate",
      subtitle: to,
      ...coin,
      from,
      to,
      summary: `Move ${words} from ${shortAddress(from)} to ${shortAddress(to)}`,
    };
  }

  if (type.endsWith(".MsgWithdrawDelegatorReward")) {
    const validator = text(message.validator_address);
    return {
      kind: "claim",
      title: "Claim rewards",
      subtitle: validator,
      ...plain,
      from: validator,
      summary: `Claim staking rewards from ${shortAddress(validator)}`,
    };
  }

  if (type.endsWith(".MsgVote") || type.endsWith(".MsgVoteWeighted")) {
    const proposal = text(message.proposal_id);
    const option = text(message.option).replace("VOTE_OPTION_", "").replace(/_/g, " ").toLowerCase();
    return {
      kind: "governance",
      title: `Vote on #${proposal}`,
      subtitle: option,
      ...plain,
      proposalId: proposal,
      vote: option,
      summary: option ? `Vote ${option} on proposal #${proposal}` : `Vote on proposal #${proposal}`,
    };
  }

  return { kind: "other", title: humanType(type), subtitle: type, ...plain, summary: humanType(type) };
}

/** How long a history read waits for the stored token facts before naming coins without them. */
const FACTS_WAIT_MS = 2_000;
let factsLoading: Promise<void> | null = null;

/**
 * The proven traces other contexts stored (lib/token-identity.ts), loaded once
 * per context, so a voucher the balance reader walked is named the same in the
 * history. A storage read that never answers costs at most {@link FACTS_WAIT_MS}.
 */
function tokenFactsLoaded(): Promise<void> {
  factsLoading ??= hydrateTokenIdentities().catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, FACTS_WAIT_MS);
  });
  return Promise.race([factsLoading, late]).finally(() => clearTimeout(timer));
}

/** Which spelling of the tx search each chain answered: SDK 0.50 `query`, older `events`. */
const searchStyles = new Map<string, "query" | "events">();

interface TxSearchResponse {
  tx_responses?: Array<{
    txhash?: string;
    code?: number;
    timestamp?: string;
    tx?: { body?: { messages?: Array<Record<string, unknown>> } };
  }>;
}

async function searchTxs(
  rest: string,
  chainId: string,
  condition: string,
  limit: number,
): Promise<TxSearchResponse> {
  const known = searchStyles.get(chainId);
  const styles = known === "events" ? (["events", "query"] as const) : (["query", "events"] as const);
  let lastError: unknown = null;
  for (const style of styles) {
    try {
      const body = (await getJson(
        `${rest}/cosmos/tx/v1beta1/txs?${style}=${encodeURIComponent(condition)}&order_by=ORDER_BY_DESC&limit=${limit}`,
      )) as TxSearchResponse;
      searchStyles.set(chainId, style);
      return body;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Recent transactions touching an address, newest first. Uses the LCD tx
 * search, so it only covers what the node still has indexed.
 *
 * @throws when neither search could be read, so a caller can tell a chain it
 *   could not reach from a chain with no history.
 */
export async function fetchActivity(
  chainId: string,
  address: string,
  limit = ACTIVITY_PAGE_SIZE,
): Promise<ActivityItem[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];
  const size = Math.min(Math.max(Math.floor(limit), 1), MAX_ACTIVITY_LIMIT);

  const [responses] = await Promise.all([
    Promise.allSettled(
      [`message.sender='${address}'`, `transfer.recipient='${address}'`].map((condition) =>
        searchTxs(rest, chainId, condition, size),
      ),
    ),
    tokenFactsLoaded(),
  ]);
  if (responses.every((response) => response.status === "rejected")) {
    throw new Error(`${chainId}: transaction history unavailable`);
  }

  const seen = new Set<string>();
  const items: ActivityItem[] = [];
  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    for (const tx of response.value.tx_responses ?? []) {
      const hash = tx.txhash ?? "";
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      const messages = (tx.tx?.body?.messages ?? []).filter(
        (message): message is Record<string, unknown> => asRecord(message) !== null,
      );
      const message = pickMessage(messages, address);
      if (!message) continue;
      const {
        summary: _summary,
        channel: _channel,
        contract: _contract,
        proposalId: _proposalId,
        vote: _vote,
        ...described
      } = describeMessage(message, address, chainId);
      items.push({
        chainId,
        hash,
        timestamp: tx.timestamp ? Date.parse(tx.timestamp) : 0,
        success: (tx.code ?? 0) === 0,
        messageType: shortTypeName(typeUrlOf(message)),
        ...described,
      });
    }
  }

  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, size);
}

/* -------------------------------------------------------------------------- *
 * Showing a history row's coin
 * -------------------------------------------------------------------------- */

/** A balance row, as far as showing an amount of its denom needs it. */
type HeldRow = Pick<TokenBalance, "denom" | "decimals" | "decimalsKnown">;

/** The balances a screen holds, by chain (`ChainBalance` fits). */
export type HeldBalances = Readonly<Record<string, { readonly tokens: readonly HeldRow[] } | undefined>>;

function heldRow(item: Pick<ActivityItem, "chainId" | "denom">, balances: HeldBalances | undefined): HeldRow | undefined {
  return item.denom ? balances?.[item.chainId]?.tokens.find((row) => row.denom === item.denom) : undefined;
}

/**
 * `-` when value left the account, `+` when it arrived (a receipt, an IBC
 * delivery, claimed rewards), nothing for staking, which moves value between
 * the account's own balances.
 */
export function activitySign(item: Pick<ActivityItem, "amount" | "kind">): "-" | "+" | "" {
  if (item.amount?.startsWith("-")) return "-";
  return item.kind === "received" || item.kind === "ibc" || item.kind === "claim" ? "+" : "";
}

/**
 * The identity a history row's amount is written with. It is the identity the
 * row's title was named with, carried on the row, so `Send USDC.n` and
 * `-12.34 USDC.n` always agree. For a coin nothing names, the balance row's
 * decimals count when the chain's metadata gave them (the rule of
 * `heldTokenIdentity`), so a held coin reads on the same scale here as on Home;
 * otherwise the amount is base units.
 */
export function activityAmountIdentity(
  item: Pick<ActivityItem, "chainId" | "denom" | "symbol" | "decimals" | "decimalsKnown" | "provenance">,
  balances?: HeldBalances,
): AmountIdentity {
  // Rows from before identities carried decimals 0 for "unknown".
  const decimalsKnown = item.decimalsKnown ?? item.decimals > 0;
  const own: AmountIdentity = {
    ticker: item.symbol,
    denom: item.denom ?? "",
    decimals: decimalsKnown ? item.decimals : 0,
    decimalsKnown,
    provenance: item.provenance ?? (decimalsKnown ? "catalog" : "unknown"),
  };
  if (own.decimalsKnown || own.provenance !== "unknown") return own;
  const held = heldRow(item, balances);
  if (!held) return own;
  const scaled = heldTokenIdentity(item.chainId, held);
  return scaled.decimalsKnown ? { ...own, decimals: scaled.decimals, decimalsKnown: true } : own;
}

/** A history row's amount, in parts so a screen can keep the unit whole. */
export interface ActivityAmount {
  readonly sign: "-" | "+" | "";
  /** `12.34`, `12340000 base units`, or `••••` when balances are hidden. */
  readonly value: string;
  /** `USDC.n`; the short denom for a coin nothing names; empty when hidden. */
  readonly unit: string;
  /** All of it on one line: `-12.34 USDC.n`. */
  readonly text: string;
}

/**
 * The amount a history row shows, by the shared policy (lib/token-amount.ts):
 * `history` for lists and notices, `confirm` for a transaction's detail. A
 * coin whose decimals are unknown reads `12340000 base units ibc/498A…6BA6E4`,
 * never `12.34M`. `null` when the row moved nothing.
 */
export function activityAmount(
  item: Pick<
    ActivityItem,
    "chainId" | "kind" | "amount" | "denom" | "symbol" | "decimals" | "decimalsKnown" | "provenance"
  >,
  variant: TokenAmountVariant,
  options: { readonly balances?: HeldBalances; readonly hidden?: boolean } = {},
): ActivityAmount | null {
  const unsigned = item.amount?.replace(/^-/, "") ?? "";
  if (!/^\d+$/.test(unsigned)) return null;
  if (options.hidden) {
    const masked = formatTokenAmount(unsigned, activityAmountIdentity(item), variant, { hidden: true });
    return { sign: "", value: masked, unit: "", text: masked };
  }
  const identity = activityAmountIdentity(item, options.balances);
  const sign = activitySign(item);
  const value = formatTokenAmount(unsigned, identity, variant);
  const unit = unitOf(identity, item.denom);
  return { sign, value, unit, text: `${sign}${value}${unit ? ` ${unit}` : ""}` };
}

/** A history amount cut where a narrow column may wrap it. */
export interface ActivityAmountPieces {
  /** The signed figure: `-12.34`, `+12340000`, `••••`. */
  readonly figure: string;
  /** `base units` (or `base unit`) after a figure whose decimals are unknown; null otherwise. */
  readonly words: string | null;
  /** The unit, as {@link ActivityAmount.unit}. */
  readonly unit: string;
}

const BASE_UNITS_WORDS = / (base units?)$/;

/**
 * The pieces a screen wraps a history amount at, each as a whole: the figure,
 * the `base units` words, the unit. A coin nothing names reads in base units,
 * and one token of an 18-decimal coin is already a 19-digit figure, so a
 * screen must let these wrap (and the figure break inside its digits when it
 * alone is wider than the column) instead of keeping them on one line that
 * runs over the text beside it.
 */
export function activityAmountPieces(amount: ActivityAmount): ActivityAmountPieces {
  const words = BASE_UNITS_WORDS.exec(amount.value);
  return {
    figure: `${amount.sign}${words ? amount.value.slice(0, words.index) : amount.value}`,
    words: words?.[1] ?? null,
    unit: amount.unit,
  };
}

/**
 * The exact words for a coin someone is about to pay or sign, such as a fee on
 * an approval prompt: `0.005 OSMO`, every digit the coin has
 * (`0.000123456789 INJ`, never cut to six decimals or rounded) when the
 * denom's identity and decimals are known on `chainId`; otherwise the raw
 * amount and the full denom, because the prompt is where the user checks
 * exactly what leaves the account.
 */
export function exactCoinText(chainId: string, amount: string, denom: string): string {
  const identity = identityOf(chainId, denom);
  return identity.provenance !== "unknown" && identity.decimalsKnown && isBankSpelling(denom) && /^\d+$/.test(amount)
    ? `${amountFieldText(amount, identity)} ${identity.ticker}`
    : `${amount} ${denom}`;
}

/**
 * Whether `denom` is spelled the way a bank holds it. IBC mints every voucher
 * as `ibc/` + uppercase hex, while the identity lookup reads the hash in
 * either case; a document a site wrote can carry `ibc/498a…`, which is not the
 * voucher it names, so it is shown raw rather than named after one.
 */
export function isBankSpelling(denom: string): boolean {
  return !denom.startsWith("ibc/") || denom === `ibc/${denom.slice(4).toUpperCase()}`;
}

/**
 * The full identity of a history row's coin, for its logo, seal, words and
 * details; a held coin through `heldTokenIdentity`. `null` when the row moved
 * no coin, or its denom on this chain could not be worked out.
 */
export function activityTokenIdentity(
  item: Pick<ActivityItem, "chainId" | "denom">,
  balances?: HeldBalances,
): TokenIdentity | null {
  if (!item.denom) return null;
  const held = heldRow(item, balances);
  return held ? heldTokenIdentity(item.chainId, held) : identityOf(item.chainId, item.denom);
}

/* -------------------------------------------------------------------------- *
 * One transaction
 * -------------------------------------------------------------------------- */

export interface TxFeeCoin extends CoinDisplay {
  amount: string;
  denom: string;
}

/** Everything the transaction detail shows, read from the chain. */
export interface TxDetailInfo {
  chainId: string;
  hash: string;
  height: string | null;
  timestamp: number;
  success: boolean;
  /** The chain's own words when it rejected the transaction. */
  error: string | null;
  memo: string;
  fee: TxFeeCoin[];
  gasWanted: string | null;
  gasUsed: string | null;
  messages: Array<{
    type: string;
    summary: string;
    kind: ActivityKind;
    title: string;
    from?: string;
    to?: string;
    channel?: string;
    contract?: string;
    proposalId?: string;
    vote?: string;
  }>;
  /** IBC packets the transaction sent, to follow them across chains. */
  packets: ExtractedPacket[];
}

/** Long enough for any chain error worth reading; the raw log can run to pages. */
const MAX_ERROR_CHARS = 400;

/**
 * Read `/cosmos/tx/v1beta1/txs/{hash}` into what the detail screen shows.
 * `null` when the body is not a transaction.
 */
export function parseTxDetail(
  body: unknown,
  chainId: string,
  address: string,
): TxDetailInfo | null {
  const root = asRecord(body);
  const response = asRecord(root?.tx_response) ?? root;
  const hash = text(response?.txhash);
  if (!response || !hash) return null;
  const tx = asRecord(root?.tx) ?? asRecord(response.tx);
  const txBody = asRecord(tx?.body);
  const fee = asRecord(asRecord(tx?.auth_info)?.fee);
  const code = typeof response.code === "number" ? response.code : 0;
  const rawLog = text(response.raw_log);
  const messages = (Array.isArray(txBody?.messages) ? txBody.messages : [])
    .map(asRecord)
    .filter((message): message is Record<string, unknown> => message !== null);

  return {
    chainId,
    hash,
    height: text(response.height) || null,
    timestamp: response.timestamp ? Date.parse(text(response.timestamp)) || 0 : 0,
    success: code === 0,
    error:
      code === 0
        ? null
        : (rawLog || `The chain rejected it with code ${code}.`).slice(0, MAX_ERROR_CHARS),
    memo: text(txBody?.memo),
    fee: (Array.isArray(fee?.amount) ? fee.amount : [])
      .map(firstCoin)
      .filter((coin): coin is Coin => coin !== null)
      .map((coin) => ({ ...coin, ...coinDisplay(chainId, coin.denom) })),
    gasWanted: text(response.gas_wanted) || null,
    gasUsed: text(response.gas_used) || null,
    messages: messages.map((message) => {
      const described = describeMessage(message, address, chainId);
      return {
        type: shortTypeName(typeUrlOf(message)),
        summary: described.summary,
        kind: described.kind,
        title: described.title,
        ...(described.from ? { from: described.from } : {}),
        ...(described.to ? { to: described.to } : {}),
        ...(described.channel ? { channel: described.channel } : {}),
        ...(described.contract ? { contract: described.contract } : {}),
        ...(described.proposalId ? { proposalId: described.proposalId } : {}),
        ...(described.vote ? { vote: described.vote } : {}),
      };
    }),
    // A failed transaction sends nothing, whatever its messages asked for.
    packets: code === 0 ? [...extractPacketsFromTx(body)] : [],
  };
}

/**
 * One transaction from the chain's REST endpoint. `null` when the node does
 * not have it: not indexed yet, or pruned.
 */
export async function fetchTxDetail(
  chainId: string,
  hash: string,
  address: string,
): Promise<TxDetailInfo | null> {
  if (!(await readsAllowed())) return null;
  const rest = restOf(chainId);
  if (!rest) return null;
  try {
    const [body] = await Promise.all([
      getJson(`${rest}/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`),
      tokenFactsLoaded(),
    ]);
    return parseTxDetail(body, chainId, address);
  } catch (error) {
    if (error instanceof Error && error.message === "HTTP 404") return null;
    throw error;
  }
}

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

import { findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission } from "./balances";
import { coinDisplay, formatCoin, type CoinDisplay } from "./coin-display";
import { shortAddress } from "./format";
import { getSettings } from "./settings";

export { baseDenomOf, coinDisplay, formatCoin, type CoinDisplay } from "./coin-display";

const REQUEST_TIMEOUT_MS = 9_000;

export interface ValidatorInfo {
  chainId: string;
  operatorAddress: string;
  moniker: string;
  /** Commission rate as a 0-1 fraction. */
  commission: number;
  /** Share of total bonded stake, 0-1. */
  votingPower: number;
  tokens: string;
  jailed: boolean;
  status: string;
}

export interface DelegationInfo {
  chainId: string;
  validatorAddress: string;
  moniker: string;
  amount: string;
  rewards: string;
  denom: string;
  decimals: number;
  symbol: string;
}

export interface UnbondingInfo {
  chainId: string;
  validatorAddress: string;
  moniker: string;
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
  title: string;
  subtitle: string;
  /** Signed base-unit delta for the account, when we can work it out. */
  amount?: string;
  denom?: string;
  /** For `denom`: 0 and the raw denom when nothing names it. */
  decimals: number;
  symbol: string;
  timestamp: number;
  success: boolean;
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
    symbol: entry?.coinDenom ?? chainId,
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
      description?: { moniker?: string };
      commission?: { commission_rates?: { rate?: string } };
    }>;
  };

  const rows = body.validators ?? [];
  const total = rows.reduce((sum, v) => sum + BigInt(v.tokens || "0"), 0n);
  return rows
    .map((v) => ({
      chainId,
      operatorAddress: v.operator_address ?? "",
      moniker: v.description?.moniker ?? v.operator_address ?? "Validator",
      commission: Number(v.commission?.commission_rates?.rate ?? "0"),
      votingPower:
        total > 0n ? Number((BigInt(v.tokens || "0") * 10000n) / total) / 10000 : 0,
      tokens: v.tokens ?? "0",
      jailed: Boolean(v.jailed),
      status: v.status ?? "",
    }))
    .sort((a, b) => Number(b.tokens) - Number(a.tokens));
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

  const monikers = await resolveMonikers(
    rest,
    rows.map((r) => r.delegation?.validator_address ?? ""),
  );

  return rows.map((row) => {
    const validator = row.delegation?.validator_address ?? "";
    return {
      chainId,
      validatorAddress: validator,
      moniker: monikers.get(validator) ?? validator,
      amount: row.balance?.amount ?? "0",
      rewards: rewardByValidator.get(validator) ?? "0",
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
  const monikers = await resolveMonikers(
    rest,
    rows.map((r) => r.validator_address ?? ""),
  );

  return rows
    .flatMap((row) =>
      (row.entries ?? []).map((entry) => ({
        chainId,
        validatorAddress: row.validator_address ?? "",
        moniker:
          monikers.get(row.validator_address ?? "") ??
          row.validator_address ??
          "",
        amount: entry.balance ?? "0",
        completionTime: entry.completion_time ?? "",
        ...meta,
      })),
    )
    .sort((a, b) => a.completionTime.localeCompare(b.completionTime));
}

async function resolveMonikers(
  rest: string,
  operators: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(operators.filter(Boolean)));
  const pairs = await Promise.all(
    unique.map(async (operator) => {
      try {
        const body = (await getJson(
          `${rest}/cosmos/staking/v1beta1/validators/${operator}`,
        )) as { validator?: { description?: { moniker?: string } } };
        return [operator, body.validator?.description?.moniker ?? operator] as const;
      } catch {
        return [operator, operator] as const;
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
  try {
    data = parseIcs20PacketData(decodeBase64Utf8(raw));
  } catch {
    return null;
  }
  if (!data) return null;
  return { data, channel: text(packet.destination_channel) };
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

/** One message as the history row and the detail list describe it. */
export interface DescribedMessage {
  kind: ActivityKind;
  title: string;
  subtitle: string;
  /** Signed base units for this account; negative when value left it. */
  amount?: string;
  denom?: string;
  decimals: number;
  symbol: string;
  /** One sentence for the transaction detail. */
  summary: string;
}

/** Read one message into words. Unknown messages keep their type name. */
export function describeMessage(
  message: Record<string, unknown>,
  address: string,
  chainId: string,
): DescribedMessage {
  const type = typeUrlOf(message);
  const native = coinDisplay(chainId, findCatalogEntry(chainId)?.coinMinimalDenom ?? "");
  const plain = { decimals: native.decimals, symbol: native.symbol };
  const withCoin = (coin: Coin | null, sign: "" | "-" = "") => {
    if (!coin) return { ...plain, words: "" };
    const display = coinDisplay(chainId, coin.denom);
    return {
      amount: `${sign}${coin.amount}`,
      denom: coin.denom,
      decimals: display.decimals,
      symbol: display.symbol,
      words: formatCoin(coin.amount, display),
    };
  };

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
      summary: `Send ${words} over IBC to ${shortAddress(receiver)} on ${channel}`,
    };
  }

  if (type.endsWith(".MsgRecvPacket")) {
    const packet = receivedPacket(message);
    const data = packet?.data;
    if (data?.receiver === address && data.denom && data.amount) {
      const { words, ...coin } = withCoin({ denom: data.denom, amount: data.amount });
      const sender = data.sender ?? "";
      return {
        kind: "ibc",
        title: `Receive ${coin.symbol} over IBC`,
        subtitle: `from ${sender}`,
        ...coin,
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
    const outSymbol = outDenom ? coinDisplay(chainId, outDenom).symbol : "";
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
      summary: option ? `Vote ${option} on proposal #${proposal}` : `Vote on proposal #${proposal}`,
    };
  }

  return { kind: "other", title: humanType(type), subtitle: type, ...plain, summary: humanType(type) };
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

  const responses = await Promise.allSettled(
    [`message.sender='${address}'`, `transfer.recipient='${address}'`].map((condition) =>
      searchTxs(rest, chainId, condition, size),
    ),
  );
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
      const { summary: _summary, ...described } = describeMessage(message, address, chainId);
      items.push({
        chainId,
        hash,
        timestamp: tx.timestamp ? Date.parse(tx.timestamp) : 0,
        success: (tx.code ?? 0) === 0,
        ...described,
      });
    }
  }

  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, size);
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
  messages: Array<{ type: string; summary: string }>;
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
    messages: messages.map((message) => ({
      type: shortTypeName(typeUrlOf(message)),
      summary: describeMessage(message, address, chainId).summary,
    })),
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
    const body = await getJson(`${rest}/cosmos/tx/v1beta1/txs/${encodeURIComponent(hash)}`);
    return parseTxDetail(body, chainId, address);
  } catch (error) {
    if (error instanceof Error && error.message === "HTTP 404") return null;
    throw error;
  }
}

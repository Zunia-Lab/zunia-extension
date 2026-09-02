/**
 * Read-only chain queries behind the same opt-in host permission as balances.
 *
 * Everything here hits the public REST (LCD) endpoint the registry lists for a
 * chain. Nothing is signed and nothing is broadcast. When the permission is
 * missing the calls short-circuit so the UI can render its "reads are off"
 * state instead of failing.
 */

import { findCatalogEntry } from "./chain-catalog";
import { hasLiveBalancePermission } from "./balances";
import { getSettings } from "./settings";

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

interface TxSearchResponse {
  tx_responses?: Array<{
    txhash?: string;
    code?: number;
    timestamp?: string;
    tx?: { body?: { messages?: Array<Record<string, unknown>> } };
  }>;
}

function describeMessage(
  message: Record<string, unknown>,
  address: string,
  meta: { denom: string; decimals: number; symbol: string },
): Pick<ActivityItem, "kind" | "title" | "subtitle" | "amount" | "denom"> {
  const type = String(message["@type"] ?? "");
  const short = type.split(".").pop() ?? type;

  if (type.endsWith("MsgSend")) {
    const from = String(message.from_address ?? "");
    const to = String(message.to_address ?? "");
    const amount = pickAmount(
      message.amount as Array<{ denom?: string; amount?: string }>,
      meta.denom,
    );
    const outgoing = from === address;
    return {
      kind: outgoing ? "sent" : "received",
      title: outgoing ? `Send ${meta.symbol}` : `Receive ${meta.symbol}`,
      subtitle: outgoing ? `to ${to}` : `from ${from}`,
      amount: outgoing ? `-${amount}` : amount,
      denom: meta.denom,
    };
  }

  if (type.endsWith("MsgTransfer")) {
    const token = message.token as { denom?: string; amount?: string } | undefined;
    return {
      kind: "ibc",
      title: "IBC transfer",
      subtitle: String(message.source_channel ?? "ibc"),
      amount:
        token?.denom === meta.denom && token.amount ? `-${token.amount}` : undefined,
      denom: token?.denom,
    };
  }

  if (
    type.includes("MsgSwap") ||
    type.endsWith("MsgSwapExactAmountIn") ||
    type.endsWith("MsgSwapExactAmountOut") ||
    type.endsWith("MsgJoinPool") ||
    type.endsWith("MsgExitPool")
  ) {
    return {
      kind: "swap",
      title: short.replace(/^Msg/, "").replace(/([A-Z])/g, " $1").trim(),
      subtitle: type,
    };
  }

  if (type.endsWith("MsgDelegate") || type.endsWith("MsgBeginRedelegate")) {
    const amount = message.amount as { denom?: string; amount?: string } | undefined;
    return {
      kind: "staking",
      title: type.endsWith("MsgDelegate") ? "Delegate" : "Redelegate",
      subtitle: String(
        message.validator_address ?? message.validator_dst_address ?? "",
      ),
      amount: amount?.amount,
      denom: amount?.denom,
    };
  }

  if (type.endsWith("MsgUndelegate")) {
    const amount = message.amount as { denom?: string; amount?: string } | undefined;
    return {
      kind: "staking",
      title: "Undelegate",
      subtitle: String(message.validator_address ?? ""),
      amount: amount?.amount,
      denom: amount?.denom,
    };
  }

  if (type.endsWith("MsgWithdrawDelegatorReward")) {
    return {
      kind: "claim",
      title: "Claim rewards",
      subtitle: String(message.validator_address ?? ""),
    };
  }

  if (type.endsWith("MsgVote")) {
    return {
      kind: "governance",
      title: `Vote on #${String(message.proposal_id ?? "")}`,
      subtitle: String(message.option ?? "").replace("VOTE_OPTION_", "").toLowerCase(),
    };
  }

  return { kind: "other", title: short, subtitle: type };
}

/**
 * Recent transactions touching an address, newest first. Uses the LCD tx
 * search, so it only covers what the node still has indexed.
 */
export async function fetchActivity(
  chainId: string,
  address: string,
  limit = 15,
): Promise<ActivityItem[]> {
  if (!(await readsAllowed())) return [];
  const rest = restOf(chainId);
  if (!rest) return [];
  const meta = denomMeta(chainId);

  // Newer SDKs use `query`, older ones `events`. Ask for both directions.
  const queries = [
    `message.sender='${address}'`,
    `transfer.recipient='${address}'`,
  ];
  const responses = await Promise.allSettled(
    queries.flatMap((q) => [
      getJson(
        `${rest}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(q)}&order_by=ORDER_BY_DESC&limit=${limit}`,
      ),
      getJson(
        `${rest}/cosmos/tx/v1beta1/txs?events=${encodeURIComponent(q)}&order_by=ORDER_BY_DESC&limit=${limit}`,
      ),
    ]),
  );

  const seen = new Set<string>();
  const items: ActivityItem[] = [];
  for (const response of responses) {
    if (response.status !== "fulfilled") continue;
    const body = response.value as TxSearchResponse;
    for (const tx of body.tx_responses ?? []) {
      const hash = tx.txhash ?? "";
      if (!hash || seen.has(hash)) continue;
      seen.add(hash);
      const message = tx.tx?.body?.messages?.[0];
      if (!message) continue;
      const described = describeMessage(message, address, meta);
      items.push({
        chainId,
        hash,
        decimals: meta.decimals,
        symbol: meta.symbol,
        timestamp: tx.timestamp ? Date.parse(tx.timestamp) : 0,
        success: (tx.code ?? 0) === 0,
        ...described,
      });
    }
  }

  return items.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

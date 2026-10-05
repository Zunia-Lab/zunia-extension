/**
 * The notification feed, and the browser alerts it fires.
 *
 * This used to live inside a popup hook, which meant the wallet only ever
 * noticed anything while the user was already looking at it: nothing was
 * derived with the popup closed, so the one case a notification exists for -
 * telling you about something you were not watching - was the one case that
 * could not happen. Everything except the React state now lives here, so the
 * worker derives the same feed on a chain event and the popup renders it.
 *
 * `deriveNotices` is pure and takes its clock as an argument. That is not
 * ceremony: the row ids are what "already announced" and "already read" are
 * keyed on, so a derivation that is not reproducible for the same inputs
 * silently re-alerts the user for things they have already dismissed.
 */

import type { ApprovalRequest } from "./approvals";
import type { ChainBalance } from "./balances";
import { showBrowserAlert } from "./browser-alerts";
import { chainTicker, findCatalogEntry } from "./chain-catalog";
import type { ActivityItem, ProposalInfo, UnbondingInfo } from "./chain-queries";
import { formatUnits } from "./format";
import type { MovedCoin, TxNotice } from "./realtime-protocol";
import type { NotifyPrefs, RewardReminder } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";

export type NoticeKind =
  | "approval"
  | "transfer"
  | "rewards"
  | "unbonding"
  | "governance";

export interface Notice {
  readonly id: string;
  readonly kind: NoticeKind;
  readonly title: string;
  readonly meta: string;
  /** Route the row opens, when there is somewhere useful to go. */
  readonly target?: {
    readonly route: "approve" | "earn" | "governance" | "chain";
    readonly chainId?: string;
  };
  readonly timestamp: number;
  readonly read: boolean;
}

/** Everything the feed is derived from. */
export interface NoticeInput {
  readonly approvals: readonly ApprovalRequest[];
  readonly balances: Readonly<Record<string, ChainBalance>>;
  readonly chainNames: ReadonlyMap<string, string>;
  readonly activity: readonly ActivityItem[];
  readonly proposals: readonly ProposalInfo[];
  readonly unbonding: readonly UnbondingInfo[];
  /** Arrivals seen on a live socket, ahead of any history read. */
  readonly arrivals: readonly ArrivalNotice[];
  readonly read: readonly string[];
  readonly now: number;
  /**
   * The claimable-rewards cycle ({@link nextRewardsNotice}). Only the worker
   * advances it; every surface renders the row it describes. Absent means no
   * rewards row.
   */
  readonly rewards?: RewardsNoticeState;
  /**
   * Which kinds the user wants. Rows of other kinds are not derived at all, so
   * they reach neither the feed, nor a badge, nor a browser alert. Approvals
   * always show. Absent means everything.
   */
  readonly prefs?: NotifyPrefs;
}

/**
 * A transfer the realtime engine saw land, before it is in the history feed.
 *
 * Kept as its own input rather than merged into `activity` because it is a
 * different kind of claim: activity is what the chain's history endpoint has
 * indexed, this is what a socket said a moment ago. They converge - the same
 * transfer shows up in both within a block or two - and the shared
 * `transfer:<hash>` id is what makes the duplicate collapse.
 */
export interface ArrivalNotice {
  readonly chainId: string;
  readonly hash: string;
  readonly coins: readonly MovedCoin[];
  readonly at: number;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function daysLeft(iso: string | undefined, now: number): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.ceil(ms / 86_400_000);
}

/**
 * Name a coin well enough for one line of notification text.
 *
 * The balance rows are the only asset registry the worker has, so a denom this
 * wallet already holds gets its real ticker and decimals. Anything else is
 * shown as its raw denom with no decimal scaling, which is honest: inventing
 * six decimals for an unknown IBC denom would put a wrong number in a
 * notification, and a wrong number is worse than a raw one.
 */
export function describeCoin(
  coin: MovedCoin,
  chainBalance: ChainBalance | undefined,
): string {
  const token = chainBalance?.tokens.find((row) => row.denom === coin.denom);
  if (token) return `${formatUnits(coin.amount, token.decimals, 3)} ${token.symbol}`;
  if (chainBalance && coin.denom === chainBalance.denom) {
    return `${formatUnits(coin.amount, chainBalance.decimals, 3)} ${chainBalance.symbol}`;
  }
  const entry = findCatalogEntry(chainBalance?.chainId ?? "");
  if (entry && coin.denom === entry.coinMinimalDenom) {
    return `${formatUnits(coin.amount, entry.coinDecimals, 3)} ${chainTicker(entry)}`;
  }
  const short = coin.denom.startsWith("ibc/")
    ? `IBC ${coin.denom.slice(4, 10).toUpperCase()}`
    : coin.denom;
  return `${coin.amount} ${short}`;
}

/**
 * The feed, newest first with unread above read.
 *
 * Pure: the same inputs and the same `now` always produce the same rows in the
 * same order, ids included.
 */
export function deriveNotices(input: NoticeInput): Notice[] {
  const { now } = input;
  const prefs = input.prefs;
  const rows: Array<Omit<Notice, "read">> = [];
  const chainName = (chainId: string): string =>
    input.chainNames.get(chainId) ?? findCatalogEntry(chainId)?.chainName ?? chainId;

  for (const approval of input.approvals) {
    rows.push({
      id: `approval:${approval.id}`,
      kind: "approval",
      title: approval.title,
      meta: `${hostOf(approval.origin)} · waiting for you`,
      target: { route: "approve" },
      timestamp: approval.createdAt,
    });
  }

  // One generic row per rewards cycle, with no amount in it: the amount grows
  // every block, and a row keyed or worded on it was a new alert every block.
  // Nothing balance-derived shows while the wallet is locked (no balances).
  const rewards = input.rewards;
  if (
    rewards?.phase === "raised" &&
    prefs?.rewards !== "off" &&
    Object.keys(input.balances).length > 0
  ) {
    rows.push({
      id: `rewards:${rewards.cycle}`,
      kind: "rewards",
      title: "Staking rewards ready to claim",
      meta: "Open Earn to claim them.",
      target: { route: "earn" },
      timestamp: rewards.raisedAt || now,
    });
  }

  for (const row of input.unbonding) {
    const remaining = daysLeft(row.completionTime, now);
    rows.push({
      id: `unbonding:${row.chainId}:${row.validatorAddress}:${row.completionTime}`,
      kind: "unbonding",
      title: remaining === null ? "Unbonding complete" : "Unbonding in progress",
      meta:
        remaining === null
          ? `${formatUnits(row.amount, row.decimals, 3)} ${row.symbol} is liquid again`
          : `${formatUnits(row.amount, row.decimals, 3)} ${row.symbol} · ${remaining}d left`,
      target: { route: "earn" },
      timestamp: Date.parse(row.completionTime) || now,
    });
  }

  // Arrivals first, so the socket's version of a transfer wins over the
  // history endpoint's: it is the one with a live timestamp, and both carry
  // the same id, so the later `Map` pass keeps whichever was pushed first.
  for (const arrival of input.arrivals) {
    const balance = input.balances[arrival.chainId];
    const described = arrival.coins.map((coin) => describeCoin(coin, balance));
    rows.push({
      id: `transfer:${arrival.hash}`,
      kind: "transfer",
      title: `Received on ${chainName(arrival.chainId)}`,
      meta: described.length > 0 ? described.join(" · ") : "A transfer arrived",
      target: { route: "chain", chainId: arrival.chainId },
      timestamp: arrival.at,
    });
  }

  for (const item of input.activity.slice(0, 8)) {
    if (item.kind !== "received") continue;
    rows.push({
      id: `transfer:${item.hash}`,
      kind: "transfer",
      title: `Received on ${chainName(item.chainId)}`,
      meta: item.amount
        ? `${formatUnits(item.amount.replace("-", ""), item.decimals, 3)} ${item.symbol}`
        : item.subtitle,
      target: { route: "chain", chainId: item.chainId },
      timestamp: item.timestamp,
    });
  }

  for (const proposal of input.proposals) {
    const remaining = daysLeft(proposal.votingEndTime, now);
    if (proposal.status !== "voting" || remaining === null) continue;
    rows.push({
      id: `gov:${proposal.chainId}:${proposal.id}`,
      kind: "governance",
      title: `Proposal ${proposal.id} ends in ${remaining}d`,
      meta: `${chainName(proposal.chainId)} · ${proposal.title}`,
      target: { route: "governance" },
      timestamp: Date.parse(proposal.votingEndTime ?? "") || now,
    });
  }

  const wanted = (kind: NoticeKind): boolean => {
    if (!prefs) return true;
    if (kind === "transfer") return prefs.transfers;
    if (kind === "unbonding") return prefs.unbonding;
    if (kind === "governance") return prefs.governance;
    if (kind === "rewards") return prefs.rewards !== "off";
    return true;
  };
  const unique = new Map<string, Omit<Notice, "read">>();
  for (const row of rows) if (wanted(row.kind) && !unique.has(row.id)) unique.set(row.id, row);

  const readIds = new Set(input.read);
  return [...unique.values()]
    .map((row) => ({ ...row, read: readIds.has(row.id) }))
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.timestamp - a.timestamp;
    });
}

/* -------------------------------------------------------------------------- *
 * Claimable rewards
 * -------------------------------------------------------------------------- */

/**
 * The "rewards ready" notice is a cycle, not a reading of the amount.
 *
 * Staking rewards grow every block a validator pays out, every few seconds on
 * some chains. A notice keyed on the amount was therefore a new alert every
 * block. Now:
 *
 * - `waiting` (a fresh install or account): the notice is raised as soon as
 *   anything at all is claimable, on any chain;
 * - `raised`: one generic notice ("Staking rewards ready to claim", no token
 *   and no amount) stays in the feed for as long as the rewards wait. Reading
 *   it is final for this cycle: the id does not change, so it never re-alerts;
 * - once the rewards are claimed (nothing claimable, or a claim seen as a drop
 *   with every chain back under one whole token), the cycle is `rearmed`, and
 *   the next notice waits until some chain has at least one whole token to
 *   claim. A claim is not followed, a block later, by an alert for a few
 *   micro-units that started accruing again.
 *
 * With a daily or weekly reminder ({@link RewardReminder}), rewards still
 * waiting a day or a week after the notice raise it again, as a new cycle:
 * one more alert, then quiet until the next reminder or the claim.
 */
export type RewardsPhase = "waiting" | "raised" | "rearmed";

export interface RewardsNoticeState {
  readonly phase: RewardsPhase;
  /** Raised notices so far; the notice id, so each cycle is read on its own. */
  readonly cycle: number;
  /** When the current notice was raised: its place in the feed. */
  readonly raisedAt: number;
  /** Claimable per chain at the last look, in base units, to see a claim. */
  readonly last: Readonly<Record<string, string>>;
}

export const INITIAL_REWARDS_NOTICE: RewardsNoticeState = {
  phase: "waiting",
  cycle: 0,
  raisedAt: 0,
  last: {},
};

function baseUnits(value: string | undefined): bigint {
  return value && /^\d{1,80}$/.test(value) ? BigInt(value) : 0n;
}

/** How long a waiting reward notice stays quiet before it is raised again. */
export function reminderInterval(reminder: RewardReminder): number | null {
  if (reminder === "daily") return 86_400_000;
  if (reminder === "weekly") return 7 * 86_400_000;
  return null;
}

/**
 * The next state of the rewards cycle, from the balances just seen.
 *
 * Pure. Chains whose read failed teach nothing (a failed read reports zero,
 * which must not pass for a claim), and an empty list (locked, or nothing
 * loaded yet) leaves the state as it was. `repeatMs` re-raises a notice whose
 * rewards are still waiting that long after it was raised (daily or weekly
 * reminders); null raises once per cycle.
 */
export function nextRewardsNotice(
  prev: RewardsNoticeState,
  balances: readonly ChainBalance[],
  now: number,
  repeatMs: number | null = null,
): RewardsNoticeState {
  const seen = balances.filter((row) => !row.error);
  if (seen.length === 0) return prev;

  const last: Record<string, string> = { ...prev.last };
  let anyClaimable = false;
  let anyWhole = false;
  let claimed = false;
  for (const row of seen) {
    const amount = baseUnits(row.rewards);
    const decimals = Number.isInteger(row.decimals) ? Math.min(Math.max(row.decimals, 0), 30) : 6;
    if (amount > 0n) anyClaimable = true;
    if (amount >= 10n ** BigInt(decimals)) anyWhole = true;
    const before = prev.last[row.chainId];
    if (before !== undefined && amount < baseUnits(before)) claimed = true;
    last[row.chainId] = amount.toString();
  }

  const raise = (): RewardsNoticeState => ({ phase: "raised", cycle: prev.cycle + 1, raisedAt: now, last });
  switch (prev.phase) {
    case "waiting":
      return anyClaimable ? raise() : { ...prev, last };
    case "raised":
      if (!anyClaimable || (claimed && !anyWhole)) return { ...prev, phase: "rearmed", last };
      if (repeatMs !== null && now - prev.raisedAt >= repeatMs) return raise();
      return { ...prev, last };
    case "rearmed":
      return anyWhole ? raise() : { ...prev, last };
  }
}

/** A stored rewards state, validated; anything unreadable starts a fresh cycle. */
export function parseRewardsNotice(value: unknown): RewardsNoticeState {
  if (!value || typeof value !== "object") return INITIAL_REWARDS_NOTICE;
  const row = value as Partial<Record<keyof RewardsNoticeState, unknown>>;
  const phase = row.phase === "raised" || row.phase === "rearmed" || row.phase === "waiting" ? row.phase : null;
  if (!phase || typeof row.cycle !== "number" || !Number.isSafeInteger(row.cycle) || row.cycle < 0) {
    return INITIAL_REWARDS_NOTICE;
  }
  const last: Record<string, string> = {};
  if (row.last && typeof row.last === "object") {
    for (const [chainId, amount] of Object.entries(row.last as Record<string, unknown>)) {
      if (typeof amount === "string" && /^\d{1,80}$/.test(amount)) last[chainId] = amount;
    }
  }
  return {
    phase,
    cycle: row.cycle,
    raisedAt: typeof row.raisedAt === "number" && Number.isFinite(row.raisedAt) ? row.raisedAt : 0,
    last,
  };
}

export async function readRewardsNotice(): Promise<RewardsNoticeState> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.rewardsNotice))[STORAGE_KEYS.rewardsNotice];
  return parseRewardsNotice(stored);
}

/** Advance the stored cycle with these balances; written only when it changed. */
export async function advanceRewardsNotice(
  balances: readonly ChainBalance[],
  now: number,
  reminder: RewardReminder = "once",
): Promise<RewardsNoticeState> {
  const prev = await readRewardsNotice();
  const next = nextRewardsNotice(prev, balances, now, reminderInterval(reminder));
  if (JSON.stringify(next) !== JSON.stringify(prev)) {
    await browser.storage.local.set({ [STORAGE_KEYS.rewardsNotice]: next });
  }
  return next;
}

/* -------------------------------------------------------------------------- *
 * Announcing
 * -------------------------------------------------------------------------- */

/**
 * Ids already turned into a browser notification.
 *
 * `seeded` is the fix for a real bug in the version of this that lived in the
 * popup: it inferred "this is a first run, do not alert" from the id list being
 * empty, which is also true after the list is trimmed or the profile's storage
 * is cleared. The first genuinely new notice after either of those was then
 * swallowed. Seeding is now recorded explicitly, once.
 */
interface AnnounceState {
  seeded: boolean;
  ids: string[];
}

/**
 * How many announced ids are remembered.
 *
 * Bounded so the list cannot grow without limit over months of transfers and
 * proposals. 200 covers far more than a single session's feed, which is all
 * this has to do. (Reward notices are one id per cycle, `rewards:<n>`.)
 */
const MAX_ANNOUNCED = 200;

async function readAnnounceState(): Promise<AnnounceState> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.announcedNotices))[
    STORAGE_KEYS.announcedNotices
  ] as Partial<AnnounceState> | undefined;
  return {
    seeded: stored?.seeded === true,
    ids: Array.isArray(stored?.ids)
      ? stored.ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

async function writeAnnounceState(state: AnnounceState): Promise<void> {
  await browser.storage.local.set({
    [STORAGE_KEYS.announcedNotices]: {
      seeded: state.seeded,
      ids: state.ids.slice(0, MAX_ANNOUNCED),
    } satisfies AnnounceState,
  });
}

/**
 * Which of these notices have not been announced yet.
 *
 * Split out from the effect so the ordering rule is testable: the first run
 * records the feed and announces nothing (opening a wallet that has had
 * claimable rewards for a month should not fire thirty notifications), and
 * every run after that announces what is new.
 */
export function pendingAnnouncements(
  notices: readonly Notice[],
  state: AnnounceState,
): { announce: Notice[]; next: AnnounceState } {
  const seen = new Set(state.ids);
  const fresh = notices.filter((notice) => !notice.read && !seen.has(notice.id));
  const ids = [...fresh.map((n) => n.id), ...state.ids].slice(0, MAX_ANNOUNCED);
  return {
    announce: state.seeded ? fresh : [],
    next: { seeded: true, ids },
  };
}

/**
 * Fire a browser notification for everything new, and update the toolbar badge.
 *
 * Never throws: it runs on a chain event, and an alert that cannot be shown
 * must not take the realtime loop down with it.
 */
export async function announceNotices(notices: readonly Notice[]): Promise<void> {
  try {
    const state = await readAnnounceState();
    const { announce, next } = pendingAnnouncements(notices, state);
    await writeAnnounceState(next);
    for (const notice of announce) {
      await showBrowserAlert(notice.id, notice.title, notice.meta);
    }
  } catch {
    // Storage or the notifications API refused; the badge below still runs.
  }
  await setUnreadBadge(notices.filter((notice) => !notice.read).length);
}

/**
 * The count on the toolbar icon.
 *
 * This is the part of "notify me" that works with no permission at all: the
 * `notifications` permission is optional and off until the user grants it,
 * whereas the badge is always available, so a wallet that has seen something
 * new can always say so even when it may not raise an alert.
 */
export async function setUnreadBadge(count: number): Promise<void> {
  const action = browser.action ?? browser.browserAction;
  if (!action?.setBadgeText) return;
  try {
    await action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : "" });
    await action.setBadgeBackgroundColor?.({ color: "#f0463c" });
  } catch {
    // Safari exposes no badge; nothing to fall back to.
  }
}

/** Ids the user has marked read. Shared by the worker and the popup. */
export async function readNoticeIds(): Promise<string[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.readNotifications))[
    STORAGE_KEYS.readNotifications
  ];
  return Array.isArray(stored)
    ? stored.filter((id): id is string => typeof id === "string")
    : [];
}

export async function markNoticesRead(ids: readonly string[]): Promise<string[]> {
  const next = [...new Set([...(await readNoticeIds()), ...ids])].slice(-MAX_ANNOUNCED);
  await browser.storage.local.set({ [STORAGE_KEYS.readNotifications]: next });
  return next;
}

/** A realtime arrival, in the shape the feed takes. Outgoing txs are dropped. */
export function arrivalFrom(notice: TxNotice, at: number): ArrivalNotice | null {
  if (notice.direction !== "received" || !notice.succeeded) return null;
  if (notice.coins.length === 0) return null;
  return {
    chainId: notice.chainId,
    hash: notice.hash,
    coins: notice.coins,
    at,
  };
}

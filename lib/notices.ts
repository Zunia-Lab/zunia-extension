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

  for (const [chainId, balance] of Object.entries(input.balances)) {
    if (!balance.rewards || balance.rewards === "0") continue;
    rows.push({
      id: `rewards:${chainId}:${balance.rewards}`,
      kind: "rewards",
      title: "Rewards ready to claim",
      meta: `${formatUnits(balance.rewards, balance.decimals, 3)} ${balance.symbol} on ${chainName(chainId)}`,
      target: { route: "earn" },
      timestamp: now,
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

  const unique = new Map<string, Omit<Notice, "read">>();
  for (const row of rows) if (!unique.has(row.id)) unique.set(row.id, row);

  const readIds = new Set(input.read);
  return [...unique.values()]
    .map((row) => ({ ...row, read: readIds.has(row.id) }))
    .sort((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return b.timestamp - a.timestamp;
    });
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
 * Bounded because `rewards:` ids embed the reward amount, which changes every
 * block a validator pays out: an unbounded list grows without limit for as
 * long as the wallet is staking anything. 200 covers far more than a single
 * session's feed, which is all this has to do.
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

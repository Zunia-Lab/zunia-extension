/**
 * The wallet's realtime engine. Runs in the background worker, nowhere else.
 *
 * Before this existed the wallet only learned anything by being asked: the
 * popup fetched balances once on mount, the 60-second cache answered every
 * read after that, and with the popup closed nothing looked at a chain at all.
 * A transfer that arrived was invisible until the user reopened the wallet and
 * pulled to refresh. Outgoing routes the wallet had signed were the single
 * exception (`lib/transfer-watch.ts`), which is why swaps appeared to work in
 * realtime and receiving did not.
 *
 * What runs here:
 *
 * - One CometBFT subscription per enabled chain, for the active account's
 *   address on it, covering both directions (`lib/realtime-protocol.ts`).
 * - On an event: refresh that one chain's balance, push it to every open
 *   surface, re-derive the notification feed and raise a browser alert.
 * - A one-minute alarm that both polls the chains with no live socket and
 *   restarts everything after MV3 has torn the worker down.
 *
 * Three constraints shape all of it:
 *
 * 1. **The privacy gate is absolute.** A socket to a chain's RPC tells that
 *    host this user's IP and the address being watched, which is exactly the
 *    disclosure `liveBalances` plus the optional host permission governs. No
 *    socket is opened unless both hold, and every one is closed the moment
 *    either stops holding.
 * 2. **It only runs unlocked.** Addresses are derived from the session phrase,
 *    so there is nothing to watch while locked, and nothing is kept behind to
 *    watch with.
 * 3. **The worker is disposable.** MV3 stops it whenever it decides the worker
 *    is idle, so no state here is load-bearing: everything needed to rebuild
 *    the streams is read back from storage on the next alarm.
 */

import {
  getChainBalances,
  hasRealtimePermission,
  refreshChainBalance,
  type ChainBalance,
} from "./balances";
import { findCatalogEntry } from "./chain-catalog";
import { openChainStream, type ChainStream, type StreamState } from "./chain-stream";
import { getEnabledChainIds } from "./enabled-chains";
import {
  fetchProposals,
  fetchUnbonding,
  type ProposalInfo,
  type UnbondingInfo,
} from "./chain-queries";
import { getPendingApprovals } from "./approvals";
import { interchainReadsAllowed } from "./interchain";
import {
  advanceRewardsNotice,
  announceNotices,
  arrivalFrom,
  deriveNotices,
  readNoticeIds,
  type ArrivalNotice,
} from "./notices";
import { subscriptionsFor, type TxNotice } from "./realtime-protocol";
import { getChainAccounts, getSessionMnemonic } from "./session";
import { getSettings } from "./settings";
import { STORAGE_KEYS } from "./storage-keys";
import {
  broadcastWalletEvent,
  walletEventSnapshot,
  type RealtimeHealth,
} from "./wallet-events";

export const REALTIME_ALARM = "zunia.realtime";

/**
 * Chains given a live socket, most important first.
 *
 * A socket per chain is cheap but not free, and a user who enables forty
 * networks would otherwise open eighty subscriptions against forty public
 * nodes from one browser. The rest are covered by the same alarm poll that
 * covers a chain whose node refuses WebSocket upgrades, so nothing is dropped -
 * it is the latency that degrades, from instant to within a minute.
 */
const MAX_LIVE_CHAINS = 8;

/** The alarm period. Also the poll interval for chains with no live socket. */
const ALARM_MINUTES = 1;

/** Arrivals older than this are dropped: history has long since caught up. */
const ARRIVAL_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_ARRIVALS = 30;

/**
 * How often unbonding and governance rows are re-read.
 *
 * These used to be fetched by a hidden component the popup mounted on every
 * screen, purely so the feed could be derived and alerts fired - three LCD
 * fan-outs across every enabled chain, repeated on each navigation, and only
 * ever while the wallet happened to be open. They belong here instead, and they
 * belong on a slow clock: an unbonding period is three weeks and a voting
 * period is a fortnight, so ten minutes is already far finer than the events
 * being watched.
 */
const SLOW_PASS_MS = 10 * 60 * 1000;

interface NoticeContext {
  at: number;
  unbonding: UnbondingInfo[];
  proposals: ProposalInfo[];
}

/* -------------------------------------------------------------------------- *
 * Worker-local state
 * -------------------------------------------------------------------------- */

const streams = new Map<string, ChainStream>();
const health: RealtimeHealth = {};
/** The address each stream is watching, so a re-sync can spot an account switch. */
const watching = new Map<string, string>();

function publishHealth(): void {
  broadcastWalletEvent({ type: "realtime", health: { ...health } });
}

/* -------------------------------------------------------------------------- *
 * Arrivals
 * -------------------------------------------------------------------------- */

async function readArrivals(): Promise<ArrivalNotice[]> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.recentArrivals))[
    STORAGE_KEYS.recentArrivals
  ];
  if (!Array.isArray(stored)) return [];
  const cutoff = Date.now() - ARRIVAL_TTL_MS;
  return stored.filter(
    (row): row is ArrivalNotice =>
      typeof row === "object" &&
      row !== null &&
      typeof (row as ArrivalNotice).hash === "string" &&
      typeof (row as ArrivalNotice).chainId === "string" &&
      Array.isArray((row as ArrivalNotice).coins) &&
      typeof (row as ArrivalNotice).at === "number" &&
      (row as ArrivalNotice).at > cutoff,
  );
}

async function rememberArrival(arrival: ArrivalNotice): Promise<ArrivalNotice[]> {
  const existing = await readArrivals();
  if (existing.some((row) => row.hash === arrival.hash)) return existing;
  const next = [arrival, ...existing].slice(0, MAX_ARRIVALS);
  await browser.storage.local.set({ [STORAGE_KEYS.recentArrivals]: next });
  return next;
}

/** Called on lock, reset and account switch: the feed belongs to one account. */
export async function clearArrivals(): Promise<void> {
  await browser.storage.local.remove([
    STORAGE_KEYS.recentArrivals,
    STORAGE_KEYS.noticeContext,
    // Another account's rewards start their own cycle.
    STORAGE_KEYS.rewardsNotice,
  ]);
}

/* -------------------------------------------------------------------------- *
 * The slow pass
 * -------------------------------------------------------------------------- */

async function readNoticeContext(): Promise<NoticeContext> {
  const stored = (await browser.storage.local.get(STORAGE_KEYS.noticeContext))[
    STORAGE_KEYS.noticeContext
  ] as Partial<NoticeContext> | undefined;
  return {
    at: typeof stored?.at === "number" ? stored.at : 0,
    unbonding: Array.isArray(stored?.unbonding) ? stored.unbonding : [],
    proposals: Array.isArray(stored?.proposals) ? stored.proposals : [],
  };
}

/**
 * Re-read unbonding and governance, at most once per {@link SLOW_PASS_MS}.
 *
 * Capped to the same chains that get a socket. A user with forty networks
 * enabled would otherwise have the worker make eighty LCD calls every ten
 * minutes in the background, which is not a trade any of them asked for; the
 * rows still appear on the Earn and Governance screens, which read every
 * enabled chain because the user is looking at them.
 */
async function runSlowPass(force = false): Promise<NoticeContext> {
  const existing = await readNoticeContext();
  if (!force && Date.now() - existing.at < SLOW_PASS_MS) return existing;

  const enabled = (await getEnabledChainIds()).slice(0, MAX_LIVE_CHAINS);
  const accounts = await getChainAccounts(enabled).catch(() => []);
  if (accounts.length === 0) return existing;

  const [unbonding, proposals] = await Promise.all([
    Promise.all(
      accounts.map((a) => fetchUnbonding(a.chainId, a.address).catch(() => [])),
    ),
    Promise.all(accounts.map((a) => fetchProposals(a.chainId).catch(() => []))),
  ]);
  const next: NoticeContext = {
    at: Date.now(),
    unbonding: unbonding.flat(),
    proposals: proposals.flat(),
  };
  await browser.storage.local.set({ [STORAGE_KEYS.noticeContext]: next });
  return next;
}

/* -------------------------------------------------------------------------- *
 * The notification feed
 * -------------------------------------------------------------------------- */

/**
 * Re-derive the feed and announce whatever is new.
 *
 * Deliberately built from the cheap inputs only: pending approvals, the
 * balances already in hand, and the arrivals this engine recorded. Unbonding,
 * governance and history are not re-read here because none of them can have
 * changed as a result of the event that triggered this, and reading them would
 * turn every incoming transfer into a fan-out of LCD calls across every
 * enabled chain. The popup fills those three in from its own screens.
 *
 * Safe to call while locked: with no balances and no arrivals it derives the
 * approvals alone, which is exactly what the toolbar badge should show then.
 */
export async function refreshNotices(
  updated: readonly ChainBalance[] = [],
): Promise<void> {
  // The snapshot is the running picture; `updated` is whatever this call just
  // learned. Merging here is what lets a feed rebuilt for an approval keep its
  // reward rows, and a feed rebuilt for one chain's arrival keep the others'.
  const byChain = new Map(
    walletEventSnapshot().balances.map((row) => [row.chainId, row]),
  );
  for (const row of updated) byChain.set(row.chainId, row);
  const balances = [...byChain.values()];

  // `getPendingApprovals` reads the worker's own in-memory queue and is
  // synchronous; only the two storage reads are awaited.
  const approvals = getPendingApprovals();
  const { notify } = await getSettings();
  const [arrivals, read, context, rewards] = await Promise.all([
    readArrivals(),
    readNoticeIds(),
    readNoticeContext(),
    // The worker alone advances the rewards cycle; the popup only reads it.
    advanceRewardsNotice(balances, Date.now(), notify.rewards),
  ]);
  const chainNames = new Map<string, string>();
  const name = (chainId: string): string =>
    findCatalogEntry(chainId)?.chainName ?? chainId;
  for (const row of balances) chainNames.set(row.chainId, name(row.chainId));
  for (const arrival of arrivals) {
    if (!chainNames.has(arrival.chainId)) {
      chainNames.set(arrival.chainId, name(arrival.chainId));
    }
  }
  for (const row of [...context.unbonding, ...context.proposals]) {
    if (!chainNames.has(row.chainId)) chainNames.set(row.chainId, name(row.chainId));
  }

  const notices = deriveNotices({
    approvals,
    balances: Object.fromEntries(balances.map((row) => [row.chainId, row])),
    chainNames,
    // History is not read here: an incoming transfer reaches the feed through
    // `arrivals` the moment the socket reports it, which is both sooner and
    // cheaper than asking the history endpoint whether it has indexed it yet.
    activity: [],
    proposals: context.proposals,
    unbonding: context.unbonding,
    arrivals,
    read,
    now: Date.now(),
    rewards,
    prefs: notify,
  });
  broadcastWalletEvent({
    type: "notices",
    notices,
    unread: notices.filter((notice) => !notice.read).length,
  });
  await announceNotices(notices);
}

/* -------------------------------------------------------------------------- *
 * Reacting to a chain event
 * -------------------------------------------------------------------------- */

/**
 * Coalesce bursts per chain.
 *
 * A single swap produces several matching events on one chain within a block
 * (the transfer in, the fee out, the contract's own payout), and a relayer
 * delivering a batch produces more. Refreshing the balance once per event would
 * be several identical LCD reads for one state change, so the first event in a
 * burst schedules the refresh and the rest fold into it.
 */
const BURST_MS = 600;
const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();

async function onChainEvent(notice: TxNotice): Promise<void> {
  broadcastWalletEvent({ type: "tx", notice });

  const arrival = arrivalFrom(notice, Date.now());
  if (arrival) await rememberArrival(arrival);

  const existing = pendingRefresh.get(notice.chainId);
  if (existing) clearTimeout(existing);
  pendingRefresh.set(
    notice.chainId,
    setTimeout(() => {
      pendingRefresh.delete(notice.chainId);
      void refreshChain(notice.chainId, notice.address);
    }, BURST_MS),
  );
}

/** Read one chain's balance now and push it everywhere, feed included. */
async function refreshChain(chainId: string, address: string): Promise<void> {
  try {
    const balance = await refreshChainBalance({ chainId, address });
    if (!balance) return;
    broadcastWalletEvent({ type: "balances", balances: [balance] });
    await refreshNotices([balance]);
  } catch {
    // The endpoint was down. The alarm poll retries within the minute.
  }
}

/* -------------------------------------------------------------------------- *
 * Starting, stopping, reconciling
 * -------------------------------------------------------------------------- */

function closeStream(chainId: string): void {
  streams.get(chainId)?.close();
  streams.delete(chainId);
  watching.delete(chainId);
  delete health[chainId];
}

/** Close every socket. Called on lock, on reset, and when reads are turned off. */
export function stopRealtime(): void {
  for (const chainId of [...streams.keys()]) closeStream(chainId);
  for (const timer of pendingRefresh.values()) clearTimeout(timer);
  pendingRefresh.clear();
  publishHealth();
}

/**
 * Bring the open sockets in line with what should be open right now.
 *
 * Idempotent and safe to call as often as anything likes - it is called on the
 * alarm, on unlock, on an account switch, on a network list change and when a
 * surface connects. A chain already watching the right address is left alone,
 * so a re-sync does not churn live sockets.
 */
export async function syncRealtime(): Promise<void> {
  const unlocked = Boolean(await getSessionMnemonic());
  if (!unlocked || !(await interchainReadsAllowed())) {
    stopRealtime();
    await browser.alarms.clear(REALTIME_ALARM);
    return;
  }

  // `https://*` does not cover `wss://` - see config/hosts.ts. Without the
  // websocket origins every socket would fail at the handshake, so this runs
  // poll-only instead, which is a real degradation rather than a broken
  // feature, and the UI can offer the upgrade.
  const canSocket = await hasRealtimePermission();

  const enabled = await getEnabledChainIds();
  const accounts = await getChainAccounts(enabled).catch(() => []);
  // Only chains the registry gives an RPC host for can be watched live; the
  // rest fall through to the poll below with no socket and no error.
  const watchable = canSocket
    ? accounts
        .filter((account) => Boolean(findCatalogEntry(account.chainId)?.rpc))
        .slice(0, MAX_LIVE_CHAINS)
    : [];
  const wanted = new Map(watchable.map((account) => [account.chainId, account.address]));

  for (const chainId of [...streams.keys()]) {
    if (wanted.get(chainId) !== watching.get(chainId)) closeStream(chainId);
  }

  for (const [chainId, address] of wanted) {
    if (streams.has(chainId)) continue;
    const entry = findCatalogEntry(chainId);
    if (!entry?.rpc) continue;
    watching.set(chainId, address);
    health[chainId] = "connecting";
    streams.set(
      chainId,
      openChainStream({
        chainId,
        endpoints: [entry.rpc],
        subscriptions: subscriptionsFor(chainId, address),
        onTx: (notice) => void onChainEvent(notice),
        onState: (state: StreamState) => {
          health[chainId] = state;
          publishHealth();
        },
      }),
    );
  }

  publishHealth();
  await ensureAlarm();
}

/**
 * Whether realtime is running on sockets, and why not when it is not.
 *
 * `reason` is what the UI offers to fix, so it names the one actionable case -
 * the missing websocket origins - and stays null for the states the user
 * cannot do anything about.
 */
export async function realtimeStatus(): Promise<{
  sockets: boolean;
  reason: "permission" | null;
}> {
  if (!(await hasRealtimePermission())) return { sockets: false, reason: "permission" };
  return { sockets: Object.values(health).some((s) => s === "live"), reason: null };
}

/**
 * The heartbeat.
 *
 * It does three jobs that all need the same timer. It polls the chains with no
 * live socket, so those still update within a minute. It re-runs `syncRealtime`,
 * which is what reopens every socket after MV3 has stopped and restarted the
 * worker - without it, realtime would last exactly as long as the worker did.
 * And, in Chromium, waking the worker on a schedule is itself what keeps the
 * sockets from being collected during a quiet period.
 */
async function ensureAlarm(): Promise<void> {
  const existing = await browser.alarms.get(REALTIME_ALARM);
  if (existing) return;
  await browser.alarms.create(REALTIME_ALARM, {
    delayInMinutes: ALARM_MINUTES,
    periodInMinutes: ALARM_MINUTES,
  });
}

/**
 * One alarm tick: reconcile the sockets, then refresh whatever they do not
 * cover.
 *
 * The poll is not a duplicate of the socket path. It is the only path for a
 * chain past `MAX_LIVE_CHAINS`, for a chain whose registry row has no RPC, and
 * for a chain whose node refuses subscriptions - all of which are common enough
 * across a 300-chain registry that treating the socket as the only path would
 * leave a visible fraction of the wallet as stale as it was before.
 */
export async function runRealtimeTick(): Promise<void> {
  await syncRealtime();
  const unlocked = Boolean(await getSessionMnemonic());
  if (!unlocked || !(await interchainReadsAllowed())) return;

  // Self-throttling: this returns the cached rows untouched until the slow
  // interval is up, so calling it on every tick costs one storage read.
  await runSlowPass().catch(() => undefined);

  const enabled = await getEnabledChainIds();
  const accounts = await getChainAccounts(enabled).catch(() => []);
  const polled = accounts.filter((account) => health[account.chainId] !== "live");
  const rows: ChainBalance[] = [];
  for (const account of polled) {
    const balance = await refreshChainBalance(account).catch(() => null);
    if (balance) rows.push(balance);
  }
  if (rows.length > 0) broadcastWalletEvent({ type: "balances", balances: rows });
  // Always re-derived, even with every chain live and nothing polled: an
  // unbonding that finished or a vote that is about to close changes the feed
  // with no chain event of its own to notice it.
  await refreshNotices(rows);
}

/**
 * Push the current balances to a surface that just opened, and re-derive the
 * feed for it.
 *
 * Called on port connect. It reads through the cache, so an arrival that
 * happened thirty seconds ago costs nothing to serve, and a cold popup renders
 * with numbers instead of em dashes.
 */
export async function primeSurface(): Promise<void> {
  if (!(await getSessionMnemonic())) return;
  if (!(await interchainReadsAllowed())) return;
  const enabled = await getEnabledChainIds();
  const accounts = await getChainAccounts(enabled).catch(() => []);
  if (accounts.length === 0) return;
  const balances = await getChainBalances(accounts).catch(() => []);
  await runSlowPass().catch(() => undefined);
  if (balances.length > 0) broadcastWalletEvent({ type: "balances", balances });
  await refreshNotices(balances);
}

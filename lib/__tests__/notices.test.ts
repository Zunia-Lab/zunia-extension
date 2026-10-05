import { describe, expect, it } from "vitest";
import type { ChainBalance } from "../balances";
import { describeMessage } from "../chain-queries";
import {
  INITIAL_REWARDS_NOTICE,
  deriveNotices,
  describeCoin,
  nextRewardsNotice,
  parseRewardsNotice,
  reminderInterval,
  type NoticeInput,
  type RewardsNoticeState,
} from "../notices";
import { DEFAULT_NOTIFY_PREFS, parseNotifyPrefs } from "../settings";

const T0 = Date.UTC(2026, 9, 5, 9, 0, 0);
const DAY = 86_400_000;

function chain(chainId: string, rewards: string, extra: Partial<ChainBalance> = {}): ChainBalance {
  return {
    chainId,
    available: "0",
    staked: "1000000000",
    rewards,
    denom: chainId === "injective-1" ? "inj" : "uatom",
    decimals: chainId === "injective-1" ? 18 : 6,
    symbol: chainId === "injective-1" ? "INJ" : "ATOM",
    tokens: [],
    ...extra,
  };
}

/** Feed the cycle a sequence of looks, one per block. */
function run(looks: ChainBalance[][], start = INITIAL_REWARDS_NOTICE, repeatMs: number | null = null) {
  let state = start;
  const states: RewardsNoticeState[] = [];
  looks.forEach((balances, i) => {
    state = nextRewardsNotice(state, balances, T0 + i * 6_000, repeatMs);
    states.push(state);
  });
  return states;
}

function feed(balances: ChainBalance[], rewards: RewardsNoticeState, extra: Partial<NoticeInput> = {}) {
  return deriveNotices({
    approvals: [],
    balances: Object.fromEntries(balances.map((row) => [row.chainId, row])),
    chainNames: new Map([["cosmoshub-4", "Cosmos Hub"]]),
    activity: [],
    proposals: [],
    unbonding: [],
    arrivals: [],
    read: [],
    now: T0,
    rewards,
    ...extra,
  });
}

describe("the claimable-rewards notice", () => {
  it("is raised once, and stays the same notice while rewards grow every block", () => {
    const states = run([
      [chain("cosmoshub-4", "0")],
      [chain("cosmoshub-4", "1200")],
      [chain("cosmoshub-4", "1350")],
      [chain("cosmoshub-4", "1500")],
      [chain("cosmoshub-4", "2500000")],
    ]);
    expect(states.map((s) => s.phase)).toEqual(["waiting", "raised", "raised", "raised", "raised"]);
    expect(new Set(states.slice(1).map((s) => s.cycle))).toEqual(new Set([1]));
    const ids = states.slice(1).map((s) => feed([chain("cosmoshub-4", "1")], s).map((n) => n.id));
    expect(new Set(ids.flat())).toEqual(new Set(["rewards:1"]));
  });

  it("names no token and no amount", () => {
    const [state] = run([[chain("cosmoshub-4", "4210000")]]);
    const [row] = feed([chain("cosmoshub-4", "4210000")], state);
    expect(row.title).toBe("Staking rewards ready to claim");
    expect(`${row.title} ${row.meta}`).not.toMatch(/ATOM|4\.21|Cosmos Hub/);
    expect(row.target).toEqual({ route: "earn" });
  });

  it("re-arms after a claim and waits for a whole token before the next notice", () => {
    const states = run([
      [chain("cosmoshub-4", "3000000")], // raised
      [chain("cosmoshub-4", "40")], // claimed: dropped, under one ATOM
      [chain("cosmoshub-4", "900000")], // 0.9 ATOM: still quiet
      [chain("cosmoshub-4", "999999")],
      [chain("cosmoshub-4", "1000000")], // one whole ATOM: notice 2
    ]);
    expect(states.map((s) => s.phase)).toEqual(["raised", "rearmed", "rearmed", "rearmed", "raised"]);
    expect(states[4].cycle).toBe(2);
    expect(feed([chain("cosmoshub-4", "40")], states[1])).toEqual([]);
  });

  it("re-arms when nothing is claimable any more", () => {
    const states = run([[chain("cosmoshub-4", "500")], [chain("cosmoshub-4", "0")]]);
    expect(states.map((s) => s.phase)).toEqual(["raised", "rearmed"]);
  });

  it("keeps the notice when only part of the rewards was claimed", () => {
    const states = run([
      [chain("cosmoshub-4", "3000000"), chain("injective-1", "2000000000000000000")],
      [chain("cosmoshub-4", "10"), chain("injective-1", "2000000000000000500")],
    ]);
    // INJ still has two whole tokens waiting: same notice, no new alert.
    expect(states.map((s) => s.phase)).toEqual(["raised", "raised"]);
    expect(states[1].cycle).toBe(1);
  });

  it("does not take a failed read or a locked wallet for a claim", () => {
    const states = run([
      [chain("cosmoshub-4", "3000000")],
      [chain("cosmoshub-4", "0", { error: "timeout" })],
      [],
      [chain("cosmoshub-4", "3000100")],
    ]);
    expect(states.map((s) => s.phase)).toEqual(["raised", "raised", "raised", "raised"]);
    expect(states[3].cycle).toBe(1);
  });

  it("is not shown while the wallet is locked", () => {
    const [state] = run([[chain("cosmoshub-4", "3000000")]]);
    expect(feed([], state)).toEqual([]);
  });

  it("comes back daily or weekly when the user asked for reminders", () => {
    expect(reminderInterval("once")).toBeNull();
    expect(reminderInterval("off")).toBeNull();
    expect(reminderInterval("daily")).toBe(DAY);
    expect(reminderInterval("weekly")).toBe(7 * DAY);
    let state = nextRewardsNotice(INITIAL_REWARDS_NOTICE, [chain("cosmoshub-4", "5")], T0, DAY);
    state = nextRewardsNotice(state, [chain("cosmoshub-4", "9")], T0 + DAY - 1, DAY);
    expect(state.cycle).toBe(1);
    state = nextRewardsNotice(state, [chain("cosmoshub-4", "12")], T0 + DAY, DAY);
    expect(state).toMatchObject({ phase: "raised", cycle: 2, raisedAt: T0 + DAY });
  });

  it("reads back what it stored, and starts over on anything else", () => {
    const stored = { phase: "rearmed", cycle: 3, raisedAt: T0, last: { "cosmoshub-4": "12", bad: "1.5" } };
    expect(parseRewardsNotice(stored)).toEqual({ phase: "rearmed", cycle: 3, raisedAt: T0, last: { "cosmoshub-4": "12" } });
    for (const junk of [null, "raised", { phase: "loud", cycle: 1 }, { phase: "raised", cycle: -1 }]) {
      expect(parseRewardsNotice(junk)).toEqual(INITIAL_REWARDS_NOTICE);
    }
  });
});

describe("notification preferences", () => {
  const raised: RewardsNoticeState = { phase: "raised", cycle: 4, raisedAt: T0, last: {} };
  const approval = {
    id: "a1",
    origin: "https://app.osmosis.zone",
    title: "Sign a swap",
    createdAt: T0,
  } as unknown as NoticeInput["approvals"][number];
  const proposal = {
    chainId: "cosmoshub-4",
    id: "981",
    title: "Upgrade",
    status: "voting",
    votingEndTime: new Date(T0 + 3 * DAY).toISOString(),
  } as unknown as NoticeInput["proposals"][number];

  it("drops the kinds the user turned off, and always keeps approvals", () => {
    const prefs = { transfers: false, unbonding: false, governance: false, rewards: "off" as const };
    const rows = feed([chain("cosmoshub-4", "9")], raised, { approvals: [approval], proposals: [proposal], prefs });
    expect(rows.map((row) => row.kind)).toEqual(["approval"]);
    const all = feed([chain("cosmoshub-4", "9")], raised, { approvals: [approval], proposals: [proposal], prefs: DEFAULT_NOTIFY_PREFS });
    expect(all.map((row) => row.kind).sort()).toEqual(["approval", "governance", "rewards"]);
  });

  it("parses stored preferences field by field", () => {
    expect(parseNotifyPrefs(undefined)).toEqual(DEFAULT_NOTIFY_PREFS);
    expect(parseNotifyPrefs({ transfers: false, rewards: "weekly", governance: "yes" })).toEqual({
      ...DEFAULT_NOTIFY_PREFS,
      transfers: false,
      rewards: "weekly",
    });
    expect(parseNotifyPrefs({ rewards: "hourly" }).rewards).toBe("once");
  });
});

describe("transfer notices named by identity", () => {
  /** Noble USDC on Osmosis (`transfer/channel-750/uusdc`). */
  const USDC_N = "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4";
  const UNLISTED = "ibc/0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";
  const ME = "osmo1qyqszqgpqyqszqgpqyqszqgpqyqszqgpjnp7du";
  const quiet: RewardsNoticeState = INITIAL_REWARDS_NOTICE;
  const arrival = (hash: string, denom: string, amount: string): NoticeInput["arrivals"][number] => ({
    chainId: "osmosis-1",
    hash,
    coins: [{ denom, amount }],
    at: T0,
  });
  const osmosisRow = (tokens: ChainBalance["tokens"]): ChainBalance => ({
    ...chain("osmosis-1", "0"),
    denom: "uosmo",
    symbol: "OSMO",
    tokens,
  });

  it("names a voucher arrival by the chain it landed on, held or not", () => {
    // Noble USDC used to read as Axelar's USDC.axl here.
    const [held] = feed([osmosisRow([])], quiet, { arrivals: [arrival("H1", USDC_N, "12340000")] });
    expect(held).toMatchObject({ id: "transfer:H1", kind: "transfer", title: "Received on Osmosis", meta: "12.34 USDC.n" });
    // No balance row for the chain at all: still named by the arrival's chain.
    const [bare] = feed([], quiet, { arrivals: [arrival("H2", USDC_N, "5000000")] });
    expect(bare?.meta).toBe("5 USDC.n");
    expect(describeCoin({ denom: "uosmo", amount: "1500000" }, undefined, "osmosis-1")).toBe("1.5 OSMO");
  });

  it("keeps a coin nothing names in base units, never as millions", () => {
    const [row] = feed([osmosisRow([])], quiet, { arrivals: [arrival("H3", UNLISTED, "12340000")] });
    expect(row?.meta).toBe("12340000 base units ibc/0123…ABCDEF");
    expect(row?.meta).not.toMatch(/\d(k|M|Bn)\b/);
    // The chain's own metadata may scale a held one, as on Home.
    const scaled = osmosisRow([
      { denom: UNLISTED, amount: "12340000", kind: "ibc", symbol: "IBC·0123", displayName: "IBC·0123", decimals: 6, decimalsKnown: true },
    ]);
    expect(feed([scaled], quiet, { arrivals: [arrival("H4", UNLISTED, "12340000")] })[0]?.meta).toBe(
      "12.34 ibc/0123…ABCDEF",
    );
  });

  it("names a history receipt with the same ticker and amount as its Activity row, under the same id", () => {
    const received = (hash: string, denom: string): NoticeInput["activity"][number] => ({
      ...describeMessage(
        {
          "@type": "/cosmos.bank.v1beta1.MsgSend",
          from_address: "osmo1zgq2rswzqupqyqs3dqsdgq2rswzqupqyqs5c7ms0",
          to_address: ME,
          amount: [{ denom, amount: "12340000" }],
        },
        ME,
        "osmosis-1",
      ),
      chainId: "osmosis-1",
      hash,
      timestamp: T0,
      success: true,
    });
    const rows = feed([osmosisRow([])], quiet, { activity: [received("R1", USDC_N), received("R2", UNLISTED)] });
    expect(rows.map((row) => [row.id, row.meta])).toEqual([
      ["transfer:R1", "12.34 USDC.n"],
      ["transfer:R2", "12340000 base units ibc/0123…ABCDEF"],
    ]);
    // The socket's arrival and the history row are one notice.
    const both = feed([osmosisRow([])], quiet, {
      activity: [received("R1", USDC_N)],
      arrivals: [arrival("R1", USDC_N, "12340000")],
    });
    expect(both.map((row) => row.id)).toEqual(["transfer:R1"]);
  });
});

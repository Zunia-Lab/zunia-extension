import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendToLog,
  missedEvents,
  publishEvents,
  registerEventPort,
  resetEventPortForTests,
  type EventLog,
  type EventPortMessage,
} from "../event-port";
import type { OriginEvent } from "../provider-events";

const A = "https://a.example";
const B = "https://b.example";
const EMPTY: EventLog = { seq: 0, events: [] };

function event(origin: string, name: OriginEvent["event"] = "accountsChanged"): OriginEvent {
  return { origin, event: name, data: null };
}

describe("event log", () => {
  it("numbers events from the clock, one apart within a batch", () => {
    const { log, added } = appendToLog(EMPTY, [event(A), event(B)], 1_000);
    expect(added.map((e) => e.seq)).toEqual([1_000, 1_001]);
    expect(log.seq).toBe(1_001);
  });

  it("never goes back when the clock does", () => {
    const first = appendToLog(EMPTY, [event(A)], 5_000).log;
    const { added } = appendToLog(first, [event(A)], 4_000);
    expect(added[0].seq).toBe(5_001);
  });

  it("keeps growing after the log was cleared, so pages do not skip new events", () => {
    const before = appendToLog(EMPTY, [event(A)], 1_000).log;
    const afterClear = appendToLog(EMPTY, [event(A)], 2_000).log;
    expect(missedEvents(afterClear, A, before.seq)).toHaveLength(1);
  });

  it("keeps only the most recent hundred events", () => {
    let log = EMPTY;
    for (let i = 0; i < 120; i++) log = appendToLog(log, [event(A)], i + 1).log;
    expect(log.events).toHaveLength(100);
    expect(log.events[0].seq).toBe(21);
  });

  it("replays only the origin's own events, and only newer ones", () => {
    const { log } = appendToLog(EMPTY, [event(A), event(B), event(A, "locked")], 1_000);
    expect(missedEvents(log, A, 0).map((e) => [e.event, e.seq])).toEqual([
      ["accountsChanged", 1_000],
      ["locked", 1_002],
    ]);
    expect(missedEvents(log, A, 1_000).map((e) => e.seq)).toEqual([1_002]);
    expect(missedEvents(log, "https://c.example", 0)).toEqual([]);
  });
});

function fakePort() {
  const sent: EventPortMessage[] = [];
  const onMessage: Array<(message: unknown) => void> = [];
  const onDisconnect: Array<() => void> = [];
  const port = {
    postMessage: (message: EventPortMessage) => sent.push(message),
    onMessage: { addListener: (listener: (message: unknown) => void) => onMessage.push(listener) },
    onDisconnect: { addListener: (listener: () => void) => onDisconnect.push(listener) },
  } as unknown as Parameters<typeof registerEventPort>[0];
  return {
    port,
    sent,
    receive: (message: unknown) => onMessage.forEach((listener) => listener(message)),
    disconnect: () => onDisconnect.forEach((listener) => listener()),
  };
}

function eventsIn(message: EventPortMessage | undefined) {
  return message?.type === "events" ? message.events.map((e) => [e.origin, e.event]) : [];
}

/** Log reads and writes run in order, so publishing nothing waits for the ones queued before. */
const settled = () => publishEvents([]);

describe("event ports", () => {
  afterEach(() => {
    resetEventPortForTests();
    vi.unstubAllGlobals();
  });

  function installSessionStorage(): void {
    const session = new Map<string, unknown>();
    vi.stubGlobal("browser", {
      storage: {
        session: {
          get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
          set: async (patch: Record<string, unknown>) => {
            for (const [key, value] of Object.entries(patch)) session.set(key, value);
          },
        },
      },
    });
  }

  it("replays what a page missed before it sends the page anything live", async () => {
    installSessionStorage();
    await publishEvents([event(A, "locked")]);
    const page = fakePort();
    registerEventPort(page.port, A);
    // An event lands between the port opening and its resume request.
    const live = publishEvents([event(A)]);
    page.receive({ type: "resume", after: 0 });
    await live;
    await settled();

    expect(page.sent).toHaveLength(1);
    expect(eventsIn(page.sent[0])).toEqual([
      [A, "locked"],
      [A, "accountsChanged"],
    ]);
  });

  it("then sends each port the new events for its own origin", async () => {
    installSessionStorage();
    const a = fakePort();
    const b = fakePort();
    registerEventPort(a.port, A);
    registerEventPort(b.port, B);
    a.receive({ type: "resume", after: 0 });
    b.receive({ type: "resume", after: 0 });
    await settled();

    await publishEvents([event(A), event(B, "locked")]);
    expect(eventsIn(a.sent.at(-1))).toEqual([[A, "accountsChanged"]]);
    expect(eventsIn(b.sent.at(-1))).toEqual([[B, "locked"]]);
  });

  it("sends nothing live to a port that closed before its replay", async () => {
    installSessionStorage();
    const page = fakePort();
    registerEventPort(page.port, A);
    page.receive({ type: "resume", after: 0 });
    page.disconnect();
    await settled();
    const replayed = page.sent.length;

    await publishEvents([event(A)]);
    expect(page.sent).toHaveLength(replayed);
  });
});

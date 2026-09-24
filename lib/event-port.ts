import type { OriginEvent } from "./provider-events";
import { STORAGE_KEYS } from "./storage-keys";

/**
 * Wallet events over a port the content script opens. Safari only.
 *
 * Safari accepts tabs.sendMessage from the worker and never hands the message
 * to the content script, and storage.onChanged reaches content scripts only
 * now and then. A port the content script opens does carry messages, for as
 * long as the worker lives, and Safari stops an idle worker within seconds.
 * So there:
 *
 * - A page that has used the provider opens {@link EVENT_PORT}, and while it
 *   is on screen it pings the worker so the worker and the port stay up
 *   (entrypoints/content.ts).
 * - The worker numbers every event and keeps the recent ones in
 *   storage.session. A page that opens the port says the last number it saw,
 *   gets what it missed for its own origin, nothing else, and then the new
 *   events as they happen.
 *
 * Numbers come from the clock (never below the previous one plus one), so they
 * keep growing even after the browser clears storage.session, and a page can
 * start from the time it opened its port.
 */

export const EVENT_PORT = "zunia:provider-events";

export interface SequencedEvent extends OriginEvent {
  seq: number;
}

export interface EventLog {
  seq: number;
  events: SequencedEvent[];
}

/** What crosses the port, in both directions. */
export type EventPortMessage =
  | { type: "resume"; after: number }
  | { type: "events"; seq: number; events: SequencedEvent[] };

/** Enough for a page hidden through a burst of changes; older ones are dropped. */
const MAX_LOGGED_EVENTS = 100;

export function appendToLog(
  log: EventLog,
  events: OriginEvent[],
  now: number,
): { log: EventLog; added: SequencedEvent[] } {
  let seq = log.seq;
  const added = events.map((event) => {
    seq = Math.max(now, seq + 1);
    return { ...event, seq };
  });
  return { log: { seq, events: [...log.events, ...added].slice(-MAX_LOGGED_EVENTS) }, added };
}

/** The events for `origin` numbered after `after`, oldest first. */
export function missedEvents(log: EventLog, origin: string, after: number): SequencedEvent[] {
  return log.events.filter((event) => event.origin === origin && event.seq > after);
}

function logFrom(raw: unknown): EventLog {
  const stored = (raw ?? {}) as Partial<EventLog>;
  return {
    seq: typeof stored.seq === "number" ? stored.seq : 0,
    events: Array.isArray(stored.events) ? stored.events : [],
  };
}

type Port = ReturnType<typeof browser.runtime.connect>;

const ports = new Map<Port, string>();
let cache: EventLog | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Reads and writes of the log run one at a time, so no append is lost. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

async function loadLog(): Promise<EventLog> {
  if (cache) return cache;
  const stored = await browser.storage.session.get(STORAGE_KEYS.providerEventLog);
  cache = logFrom(stored[STORAGE_KEYS.providerEventLog]);
  return cache;
}

function post(port: Port, message: EventPortMessage): void {
  try {
    port.postMessage(message);
  } catch {
    ports.delete(port);
  }
}

/** Log the events, then send each open port the ones for its origin. */
export function publishEvents(events: OriginEvent[]): Promise<void> {
  return serialized(async () => {
    const { log, added } = appendToLog(await loadLog(), events, Date.now());
    cache = log;
    await browser.storage.session.set({ [STORAGE_KEYS.providerEventLog]: log });
    for (const [port, origin] of ports) {
      const mine = added.filter((event) => event.origin === origin);
      if (mine.length > 0) post(port, { type: "events", seq: log.seq, events: mine });
    }
  });
}

/**
 * A content script's port. `origin` is what the browser says about the sender,
 * never what the page claims. The port receives live events only after its
 * replay: the page moves its last seen number to the newest batch it gets, so
 * a live event that came first would make it skip the replayed ones.
 */
export function registerEventPort(port: Port, origin: string): void {
  let open = true;
  port.onDisconnect.addListener(() => {
    open = false;
    ports.delete(port);
  });
  port.onMessage.addListener((message: unknown) => {
    const { type, after } = (message ?? {}) as { type?: unknown; after?: unknown };
    if (type !== "resume" || typeof after !== "number") return;
    void serialized(async () => {
      const log = await loadLog();
      post(port, { type: "events", seq: log.seq, events: missedEvents(log, origin, after) });
      if (open) ports.set(port, origin);
    });
  });
}

/** Test-only reset. */
export function resetEventPortForTests(): void {
  ports.clear();
  cache = null;
  queue = Promise.resolve();
}

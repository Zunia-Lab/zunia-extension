/**
 * One live CometBFT subscription per chain.
 *
 * This is the socket half of realtime; the framing and parsing live in
 * `lib/realtime-protocol.ts` and are tested without a network. A stream owns:
 *
 * - the socket, and reopening it with jittered backoff when it drops;
 * - rotation across the RPC hosts the caller supplies, because a public node
 *   that refuses WebSocket upgrades (several do) must not take realtime down
 *   for that chain - after a few failures the next host is tried;
 * - a liveness check, because a Cosmos node behind a proxy will often leave a
 *   dead socket "open" indefinitely rather than closing it, which looks exactly
 *   like a quiet chain.
 *
 * It does not decide *what* to subscribe to and never touches wallet state.
 * That is `lib/realtime.ts`.
 */

import {
  backoffDelay,
  parseFrame,
  subscribeFrame,
  websocketUrl,
  type Subscription,
  type TxNotice,
} from "./realtime-protocol";

/**
 * Consecutive failures on one host before moving to the next.
 *
 * Two, not one: a single failure is usually the node restarting, and rotating
 * away on it would walk the whole endpoint list during a routine redeploy.
 */
const FAILURES_BEFORE_ROTATE = 2;

/**
 * How long a silent socket is given before it is treated as dead.
 *
 * A chain with no traffic for this address is silent by design, so silence
 * alone proves nothing - which is why the stream sends its own health probe
 * and measures the reply, rather than timing out on subscription events.
 */
const HEALTH_INTERVAL_MS = 45_000;
const HEALTH_TIMEOUT_MS = 15_000;

export type StreamState = "connecting" | "live" | "retrying" | "closed";

export interface ChainStreamOptions {
  readonly chainId: string;
  /** RPC hosts to try, best first. Rotation wraps around. */
  readonly endpoints: readonly string[];
  readonly subscriptions: readonly Subscription[];
  readonly onTx: (notice: TxNotice) => void;
  /** Called on every state change, for the health line the UI shows. */
  readonly onState?: (state: StreamState, detail: string | null) => void;
}

export interface ChainStream {
  readonly chainId: string;
  readonly state: () => StreamState;
  close: () => void;
}

/**
 * Open a stream. It starts connecting immediately and keeps itself open until
 * `close()`; every failure path retries rather than surfacing an error, because
 * there is no caller in a position to do anything else with one.
 */
export function openChainStream(options: ChainStreamOptions): ChainStream {
  const urls = options.endpoints
    .map(websocketUrl)
    .filter((url): url is string => url !== null);

  let socket: WebSocket | null = null;
  let state: StreamState = "connecting";
  let closed = false;
  let attempt = 0;
  let hostIndex = 0;
  let failuresOnHost = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let healthDeadline: ReturnType<typeof setTimeout> | null = null;

  function setState(next: StreamState, detail: string | null = null): void {
    if (state === next) return;
    state = next;
    options.onState?.(next, detail);
  }

  function clearTimers(): void {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (healthTimer !== null) clearInterval(healthTimer);
    if (healthDeadline !== null) clearTimeout(healthDeadline);
    retryTimer = null;
    healthTimer = null;
    healthDeadline = null;
  }

  /**
   * Tear down the current socket without triggering the reconnect path.
   *
   * The handlers are detached first: a `close()` call fires `onclose`
   * asynchronously, and letting that run would schedule a reconnect for a
   * socket we are deliberately replacing, producing two live sockets per chain.
   */
  function dropSocket(): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closing; nothing to do.
    }
    socket = null;
  }

  function scheduleRetry(reason: string): void {
    if (closed) return;
    dropSocket();
    clearTimers();
    failuresOnHost += 1;
    if (failuresOnHost >= FAILURES_BEFORE_ROTATE && urls.length > 1) {
      hostIndex = (hostIndex + 1) % urls.length;
      failuresOnHost = 0;
    }
    const delay = backoffDelay(attempt);
    attempt += 1;
    setState("retrying", reason);
    retryTimer = setTimeout(connect, delay);
  }

  /**
   * Ask the node something cheap and require an answer.
   *
   * `unsubscribe` for a query that was never subscribed is the probe: it is a
   * single small frame, every CometBFT version answers it (with an error, which
   * is a perfectly good sign of life), and unlike a real `subscribe` it cannot
   * change what this socket is receiving if the reply is late.
   */
  function startHealthChecks(): void {
    healthTimer = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "health",
            method: "unsubscribe",
            params: { query: "tm.event='__zunia_health__'" },
          }),
        );
      } catch {
        scheduleRetry("health probe could not be sent");
        return;
      }
      if (healthDeadline !== null) clearTimeout(healthDeadline);
      healthDeadline = setTimeout(
        () => scheduleRetry("the node stopped answering"),
        HEALTH_TIMEOUT_MS,
      );
    }, HEALTH_INTERVAL_MS);
  }

  function connect(): void {
    if (closed) return;
    const url = urls[hostIndex];
    if (!url) {
      setState("closed", "no usable RPC endpoint for this chain");
      closed = true;
      return;
    }
    setState("connecting");
    let next: WebSocket;
    try {
      next = new WebSocket(url);
    } catch {
      scheduleRetry("the RPC URL was refused by the browser");
      return;
    }
    socket = next;

    next.onopen = () => {
      if (closed || socket !== next) return;
      attempt = 0;
      failuresOnHost = 0;
      for (const subscription of options.subscriptions) {
        try {
          next.send(JSON.stringify(subscribeFrame(subscription)));
        } catch {
          scheduleRetry("the subscription could not be sent");
          return;
        }
      }
      setState("live");
      startHealthChecks();
    };

    next.onmessage = (event: MessageEvent) => {
      if (closed || socket !== next) return;
      // Any frame at all proves the socket is alive, so the outstanding health
      // deadline is satisfied by ordinary traffic too.
      if (healthDeadline !== null) {
        clearTimeout(healthDeadline);
        healthDeadline = null;
      }
      if (typeof event.data !== "string") return;
      const frame = parseFrame(event.data, options.chainId);
      if (frame.kind === "tx") {
        options.onTx(frame);
        return;
      }
      if (frame.kind === "error" && frame.subscriptionId !== "health") {
        // A node that refuses the subscription itself will never send events,
        // so this socket is useless: rotate rather than sit on it looking live.
        const known = options.subscriptions.some((s) => s.id === frame.subscriptionId);
        if (known || frame.subscriptionId === null) {
          scheduleRetry(frame.message);
        }
      }
    };

    next.onerror = () => {
      if (closed || socket !== next) return;
      scheduleRetry("the connection failed");
    };

    next.onclose = () => {
      if (closed || socket !== next) return;
      scheduleRetry("the node closed the connection");
    };
  }

  connect();

  return {
    chainId: options.chainId,
    state: () => state,
    close: () => {
      closed = true;
      clearTimers();
      dropSocket();
      setState("closed");
    },
  };
}

/**
 * Backoff for wrong passwords. scrypt already makes each guess cost about a
 * second of CPU; this makes a scripted guesser wait on top of that, and it
 * survives the service worker restarting because the state is persisted.
 */

export interface ThrottleState {
  failures: number;
  /** Epoch ms before which another attempt is refused. 0 when not throttled. */
  retryAt: number;
}

export const EMPTY_THROTTLE: ThrottleState = { failures: 0, retryAt: 0 };

const FREE_ATTEMPTS = 3;
const BASE_DELAY_MS = 2_000;
const MAX_DELAY_MS = 5 * 60_000;

/** The wait imposed after the given number of consecutive failures. */
export function throttleDelayMs(failures: number): number {
  if (failures < FREE_ATTEMPTS) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_ATTEMPTS), MAX_DELAY_MS);
}

export function recordFailure(state: ThrottleState, now: number): ThrottleState {
  const failures = state.failures + 1;
  const delay = throttleDelayMs(failures);
  return { failures, retryAt: delay ? now + delay : 0 };
}

/**
 * The stored state as of `now`. A wait that already ended reads as 0, and one
 * longer than the maximum (the clock was set back after it was recorded) is
 * cut to the maximum instead of locking the user out for the difference.
 */
export function readThrottleState(value: unknown, now: number): ThrottleState {
  if (!value || typeof value !== "object") return EMPTY_THROTTLE;
  const { failures, retryAt } = value as Partial<ThrottleState>;
  return {
    failures: typeof failures === "number" && failures > 0 ? Math.floor(failures) : 0,
    retryAt:
      typeof retryAt === "number" && retryAt > now
        ? Math.min(retryAt, now + MAX_DELAY_MS)
        : 0,
  };
}

export class PasswordThrottledError extends Error {
  readonly retryAt: number;
  constructor(retryAt: number, now: number) {
    const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
    super(`Too many wrong passwords. Try again in ${seconds} s.`);
    this.name = "PasswordThrottledError";
    this.retryAt = retryAt;
  }
}

/** Throws while a wait is in force. */
export function assertNotThrottled(state: ThrottleState, now: number): void {
  if (state.retryAt > now) throw new PasswordThrottledError(state.retryAt, now);
}

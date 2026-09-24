/**
 * User input on wallet pages, reported to the worker so auto-lock counts time
 * without input instead of time since the last signature.
 */

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/**
 * Calls `report` at once, then on user input at most once per `intervalMs`.
 * Returns the function that stops watching.
 */
export function watchUserActivity(
  target: EventTarget,
  report: () => void,
  intervalMs: number,
): () => void {
  let reportedAt = Number.NEGATIVE_INFINITY;
  const onInput = () => {
    const now = Date.now();
    if (now - reportedAt < intervalMs) return;
    reportedAt = now;
    report();
  };
  for (const type of INPUT_EVENTS) {
    target.addEventListener(type, onInput, { capture: true, passive: true });
  }
  onInput();
  return () => {
    for (const type of INPUT_EVENTS) {
      target.removeEventListener(type, onInput, { capture: true });
    }
  };
}

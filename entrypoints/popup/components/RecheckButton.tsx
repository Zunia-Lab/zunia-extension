/**
 * The control behind every "check again" on the popup: a real button that
 * shows the check running, refuses a second press while it does, and says what
 * came of it.
 *
 * A check that fails again usually fails fast, and a button that only
 * re-renders the same sentence reads as a click that did nothing. So the
 * running state is held for a moment even when the answer is immediate
 * ({@link MIN_CHECK_MS}), and once the answer is in, a line under the button
 * says the problem is still there and when it was last looked at. When the
 * problem is gone the screen drops the callout the button sits in, so nothing
 * here says "fixed".
 */

import { useCallback, useEffect, useState } from "react";
import { Button, cn } from "@zunialab/ui";

import { useClock } from "../screens/interchain-ui";

/** The least time the running state stays on screen, so a fast answer is still seen. */
export const MIN_CHECK_MS = 700;

/**
 * When the last check ended, in the words a note uses: `just now` under ten
 * seconds, then seconds, then minutes.
 */
export function checkedAgo(finishedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - finishedAt) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds} s ago`;
  return `${Math.floor(seconds / 60)} min ago`;
}

/**
 * The line a finished check leaves: what is still true and when it was
 * looked at, `Still unavailable — checked just now`.
 */
export function recheckNote(still: string, finishedAt: number, now: number): string {
  return `${still} — checked ${checkedAgo(finishedAt, now)}`;
}

/**
 * The life of one press. `busy` is whatever the screen already knows about
 * the check it started (a loading flag derived from its own request key);
 * `onRecheck` starts it.
 *
 * `checking` is true from the press until the check is no longer busy and
 * {@link MIN_CHECK_MS} has passed, or while `busy` on its own. `finishedAt`
 * is when the last pressed check ended, `null` before the first.
 */
export function useRecheck(busy: boolean, onRecheck: () => void, minMs = MIN_CHECK_MS) {
  const [pressed, setPressed] = useState<{ startedAt: number; finishedAt: number | null } | null>(
    null,
  );

  // The end is set from a timer, never from the effect body, so it is a
  // callback's write and not a render's. A busy check cancels the timer and
  // the next quiet render sets it again for the time still owed.
  useEffect(() => {
    if (!pressed || pressed.finishedAt !== null || busy) return;
    const owed = Math.max(0, pressed.startedAt + minMs - Date.now());
    const timer = window.setTimeout(() => {
      setPressed((current) =>
        current && current.finishedAt === null ? { ...current, finishedAt: Date.now() } : current,
      );
    }, owed);
    return () => window.clearTimeout(timer);
  }, [pressed, busy, minMs]);

  const checking = busy || (pressed !== null && pressed.finishedAt === null);
  const press = useCallback(() => {
    // A second press while the first is running would start a second check
    // and reset the first one's clock.
    if (checking) return;
    setPressed({ startedAt: Date.now(), finishedAt: null });
    onRecheck();
  }, [checking, onRecheck]);

  return { checking, finishedAt: pressed?.finishedAt ?? null, press };
}

/** The button alone: its label, its running state, and nothing it has to remember. */
export function RecheckButton({
  checking,
  onClick,
  label = "Check again",
  checkingLabel = "Checking…",
  className,
}: {
  checking: boolean;
  onClick: () => void;
  label?: string;
  checkingLabel?: string;
  className?: string;
}) {
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={checking}
      onClick={onClick}
      className={cn("shrink-0", className)}
    >
      {checking ? checkingLabel : label}
    </Button>
  );
}

/**
 * A "check again" with its outcome, for a check run by {@link useRecheck}. The
 * hook lives in the screen, above the thing that comes and goes while the
 * check runs (a callout that shows only once an error is known), so pressing
 * the button does not reset what it remembers. `still` is what remains true
 * when the check fails again, `Still unavailable`.
 */
export function RecheckControl({
  recheck,
  still,
  label,
  checkingLabel,
  className,
}: {
  recheck: ReturnType<typeof useRecheck>;
  still: string;
  label?: string;
  checkingLabel?: string;
  className?: string;
}) {
  const { checking, finishedAt, press } = recheck;
  const showNote = !checking && finishedAt !== null;
  const now = useClock(showNote);
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <RecheckButton
        checking={checking}
        onClick={press}
        {...(label ? { label } : {})}
        {...(checkingLabel ? { checkingLabel } : {})}
      />
      {/* Always mounted, so a screen reader hears the text arrive. */}
      <span role="status" className="min-w-0 text-[10.5px] leading-snug text-fg-muted">
        {showNote ? recheckNote(still, finishedAt, now) : null}
      </span>
    </div>
  );
}

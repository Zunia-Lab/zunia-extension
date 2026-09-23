import { useCallback, useEffect, useRef, useState } from "react";
import { Button, PasswordInput, ScreenScaffold, cn, focusRing } from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import type { ThrottleState } from "../../../lib/password-throttle";
import { IconLock } from "./icons";

/** Seconds until another attempt is allowed, ticking down while the screen is open. */
function useRetryCountdown(): [number, () => void] {
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  const reload = useCallback(() => {
    void sendToBackground<ThrottleState>("GET_PASSWORD_THROTTLE")
      .then((state) => {
        setRetryAt(state.retryAt);
        setNow(Date.now());
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= retryAt) window.clearInterval(timer);
    }, 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  return [Math.max(0, Math.ceil((retryAt - now) / 1000)), reload];
}

export function UnlockScreen({
  autoLockMs,
  onUnlocked,
  onForgot,
}: {
  autoLockMs: number;
  onUnlocked: () => void;
  onForgot: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waitSeconds, reloadThrottle] = useRetryCountdown();
  const passwordRef = useRef<HTMLInputElement>(null);

  // Focus is moved deliberately, not with autoFocus. This is the one surface
  // where the jump is what the user asked for: the popup was opened to unlock
  // the wallet and the password box is the only thing on it. The field carries
  // aria-label="Password" and the heading above it is read as the focus lands,
  // so a screen reader is told where it has been put; the "Locks after N min"
  // note and the forgot-password link stay one Tab away.
  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  const throttled = waitSeconds > 0;

  async function handleUnlock() {
    if (throttled) return;
    setError(null);
    setBusy(true);
    try {
      await sendToBackground("UNLOCK", { password });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      reloadThrottle();
    } finally {
      setBusy(false);
    }
  }

  const lockMinutes = Math.round(autoLockMs / 60_000);

  return (
    <ScreenScaffold
      footer={
        <div className="flex flex-col items-center gap-3">
          <Button
            className="w-full"
            size="lg"
            loading={busy}
            disabled={!password || throttled}
            onClick={() => void handleUnlock()}
          >
            {throttled ? `Try again in ${waitSeconds} s` : "Unlock"}
          </Button>
          <p className="flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
            <IconLock width={16} height={16} />
            Locks after {lockMinutes} min idle
          </p>
        </div>
      }
    >
      <div className="flex flex-col items-center gap-6 pt-12">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/brand/mark.svg" alt="" width={30} height={28} />
          <div>
            <h1 className="text-[21px] font-medium tracking-[-0.035em] text-fg">
              Welcome back
            </h1>
            <p className="mt-1.5 text-[12.5px] text-fg-muted">
              Enter your password to unlock this session.
            </p>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2">
          <PasswordInput
            ref={passwordRef}
            aria-label="Password"
            placeholder="Password"
            value={password}
            aria-invalid={Boolean(error) || undefined}
            state={error ? "error" : "default"}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password && !throttled) void handleUnlock();
            }}
          />
          {error ? (
            <p role="alert" className="text-[11.5px] text-[var(--z-danger-fg)]">
              {error}
            </p>
          ) : null}
        </div>

        <button
          type="button"
          onClick={onForgot}
          className={cn(
            "text-[11.5px] text-fg-dim transition-colors duration-[var(--z-duration-base)] hover:text-fg",
            focusRing,
          )}
        >
          Forgot password? Restore with your phrase
        </button>
      </div>
    </ScreenScaffold>
  );
}

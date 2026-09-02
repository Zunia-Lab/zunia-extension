import { useState } from "react";
import { Button, PasswordInput, ScreenScaffold, cn, focusRing } from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import { IconLock } from "./icons";

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

  async function handleUnlock() {
    setError(null);
    setBusy(true);
    try {
      await sendToBackground("UNLOCK", { password });
      onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
            disabled={!password}
            onClick={() => void handleUnlock()}
          >
            Unlock
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
            aria-label="Password"
            placeholder="Password"
            value={password}
            autoFocus
            aria-invalid={Boolean(error) || undefined}
            state={error ? "error" : "default"}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && password) void handleUnlock();
            }}
          />
          {error ? (
            <p className="text-[11.5px] text-[var(--z-danger)]">{error}</p>
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

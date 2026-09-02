import { useState } from "react";
import { Button, Callout, Input, ScreenScaffold } from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";

const CONFIRM_WORD = "REMOVE";

/**
 * A forgotten password can only be resolved by wiping local state and
 * restoring from the recovery phrase.
 */
export function ForgotPasswordScreen({
  onBack,
  onRemoved,
}: {
  onBack: () => void;
  onRemoved: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function wipe() {
    setBusy(true);
    setError(null);
    try {
      await sendToBackground("RESET_WALLET", {});
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScaffold
      title="Reset wallet"
      onBack={onBack}
      footer={
        <Button
          variant="danger"
          className="w-full"
          size="lg"
          loading={busy}
          disabled={confirm.trim().toUpperCase() !== CONFIRM_WORD}
          onClick={() => void wipe()}
        >
          Remove and restore
        </Button>
      }
    >
      <div className="flex flex-col gap-4 pt-2">
        <Callout tone="danger" title="There is no password recovery">
          The password never leaves this device, so it cannot be reset. To get
          back in, remove the wallet here and restore it with your 12 or 24 word
          recovery phrase.
        </Callout>

        <p className="text-[12.5px] leading-[1.55] text-fg-muted">
          Without the phrase, removing the wallet is permanent. Check that you
          have it written down before you continue.
        </p>

        <Input
          label={`Type ${CONFIRM_WORD} to confirm`}
          value={confirm}
          autoFocus
          spellCheck={false}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={CONFIRM_WORD}
        />

        {error ? (
          <p className="text-[11.5px] text-[var(--z-danger)]">{error}</p>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

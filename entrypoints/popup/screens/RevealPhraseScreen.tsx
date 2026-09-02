import { useState } from "react";
import {
  Button,
  Callout,
  MnemonicGrid,
  PasswordInput,
  ScreenScaffold,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import { IconCheck, IconCopy } from "./icons";

export function RevealPhraseScreen({ onBack }: { onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      const result = await sendToBackground<{ mnemonic: string }>(
        "REVEAL_MNEMONIC",
        { password },
      );
      setPhrase(result.mnemonic);
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!phrase) return;
    await navigator.clipboard.writeText(phrase);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <ScreenScaffold
      title="Recovery phrase"
      onBack={onBack}
      footer={
        phrase ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => void copy()}
            >
              {copied ? (
                <IconCheck width={16} height={16} />
              ) : (
                <IconCopy width={16} height={16} />
              )}
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button className="flex-1" onClick={() => setPhrase(null)}>
              Hide
            </Button>
          </div>
        ) : (
          <Button
            className="w-full"
            loading={busy}
            disabled={!password}
            onClick={() => void reveal()}
          >
            Reveal phrase
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <Callout tone="danger" title="Anyone with these words owns the wallet">
          Never type them into a website and never share them. Zunia support
          will never ask for them.
        </Callout>

        {phrase ? (
          <MnemonicGrid words={phrase.split(" ")} revealed />
        ) : (
          <>
            <PasswordInput
              label="Password"
              placeholder="Password"
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password) void reveal();
              }}
            />
            {error ? (
              <p className="text-[11.5px] text-[var(--z-danger-fg)]">{error}</p>
            ) : null}
          </>
        )}
      </div>
    </ScreenScaffold>
  );
}

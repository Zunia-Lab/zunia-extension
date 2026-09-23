import { useState } from "react";
import {
  Button,
  Callout,
  MnemonicGrid,
  PasswordInput,
  ScreenScaffold,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import {
  SENSITIVE_CLIPBOARD_NOTE,
  useSensitiveClipboard,
} from "../hooks/useSensitiveClipboard";
import { IconCheck, IconCopy } from "./icons";

export function RevealPhraseScreen({ onBack }: { onBack: () => void }) {
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copiedOnce, setCopiedOnce] = useState(false);
  const copySensitive = useSensitiveClipboard();

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
    try {
      await copySensitive(phrase);
    } catch {
      setError("Could not copy to clipboard");
      return;
    }
    setError(null);
    setCopied(true);
    setCopiedOnce(true);
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
          <>
            <MnemonicGrid words={phrase.split(" ")} revealed />
            {copiedOnce ? (
              <p
                role="status"
                className="text-[11px] leading-[1.45] text-fg-dim"
              >
                {SENSITIVE_CLIPBOARD_NOTE}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="text-[11.5px] text-[var(--z-danger-fg)]">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {/* No autofocus: the callout above this field is the warning that
                these words are the wallet, and jumping a screen reader straight
                into the password box is exactly how it gets skipped. */}
            <PasswordInput
              label="Password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && password) void reveal();
              }}
            />
            {error ? (
              <p role="alert" className="text-[11.5px] text-[var(--z-danger-fg)]">
                {error}
              </p>
            ) : null}
          </>
        )}
      </div>
    </ScreenScaffold>
  );
}

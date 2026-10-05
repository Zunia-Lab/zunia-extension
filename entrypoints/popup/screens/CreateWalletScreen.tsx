import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  Callout,
  Input,
  MnemonicGrid,
  PasswordInput,
  PasswordStrengthMeter,
  SEED_SAFETY,
  ScreenScaffold,
  SeedVerifier,
  Segmented,
  StepHeading,
  StepProgress,
} from "@zunialab/ui";
import { PINNED_CHAIN_IDS } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import {
  SENSITIVE_CLIPBOARD_NOTE,
  useSensitiveClipboard,
} from "../hooks/useSensitiveClipboard";
import { NetworkSelectStep } from "./NetworkSelectStep";
import { OnboardingStep, StepActions } from "./onboarding-ui";
import { IconCheck, IconCopy, IconEye, IconEyeOff } from "./icons";

type Step = "phrase" | "verify" | "password" | "name" | "networks";
type WordCount = 12 | 24;
type Variant = "onboard" | "add";

/** Result of the one background call this screen makes before the user acts. */
type PhraseState =
  | { status: "generating" }
  | { status: "ready"; mnemonic: string }
  | { status: "failed"; message: string };

const ONBOARD_STEPS: Step[] = ["phrase", "verify", "password", "networks"];
const ADD_STEPS: Step[] = ["phrase", "verify", "name", "networks"];
const STEP_LABELS: Record<Step, string> = {
  phrase: "Recovery phrase",
  verify: "Verify",
  password: "Password",
  name: "Name",
  networks: "Networks",
};

/** Step labels in order, for shells that render their own progress rail. */
export const CREATE_STEP_LABELS = ONBOARD_STEPS.map((s) => STEP_LABELS[s]);

const DISTRACTORS = [
  "ocean",
  "tiger",
  "crystal",
  "orbit",
  "velvet",
  "maple",
  "quartz",
  "ember",
  "harbor",
  "nova",
  "ridge",
  "willow",
];

function verifyCountFor(wordCount: WordCount): number {
  return wordCount === 24 ? 6 : 4;
}

function pickVerifyIndices(wordCount: WordCount): number[] {
  const indices = new Set<number>();
  while (indices.size < verifyCountFor(wordCount)) {
    indices.add(Math.floor(Math.random() * wordCount));
  }
  return [...indices].sort((a, b) => a - b);
}

function optionsFor(word: string): string[] {
  const pool = DISTRACTORS.filter((w) => w !== word);
  const picks = [word];
  while (picks.length < 3) {
    const next = pool[Math.floor(Math.random() * pool.length)]!;
    if (!picks.includes(next)) picks.push(next);
  }
  return picks.sort(() => Math.random() - 0.5);
}

export function CreateWalletScreen({
  onDone,
  onBack,
  onStepChange,
  hideProgress = false,
  variant = "onboard",
}: {
  onDone: () => void;
  onBack: () => void;
  /** Zero-based step index, for the full-tab shell's own progress rail. */
  onStepChange?: (index: number) => void;
  hideProgress?: boolean;
  /** `add` skips password: the wallet is already unlocked. */
  variant?: Variant;
}) {
  const adding = variant === "add";
  const STEPS = adding ? ADD_STEPS : ONBOARD_STEPS;
  const [step, setStep] = useState<Step>("phrase");
  const [wordCount, setWordCount] = useState<WordCount>(12);
  const [phrase, setPhrase] = useState<PhraseState>({ status: "generating" });
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const copySensitive = useSensitiveClipboard();
  const [verifyIdx, setVerifyIdx] = useState<number[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [cursor, setCursor] = useState(0);
  const [walletName, setWalletName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [selectedChains, setSelectedChains] = useState<Set<string>>(
    () => new Set(PINNED_CHAIN_IDS),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const walletNameRef = useRef<HTMLInputElement>(null);

  // The verify step is advanced by clicking a word tile, and that tile unmounts
  // with the step: by the time this step renders, focus has fallen back to
  // <body>. Placed explicitly rather than with autoFocus, because this is a step
  // transition and not a page load; the field is labelled "Wallet name", so a
  // screen reader announces where it has been put.
  useEffect(() => {
    if (step === "password" || step === "name") walletNameRef.current?.focus();
  }, [step]);

  // Generation state as one value rather than a mnemonic plus a spinner flag:
  // the effect below then only ever writes the result, and "a phrase is being
  // generated" is derived. Previously the effect reset five pieces of state
  // synchronously on entry, which re-rendered the whole wizard a second time on
  // mount and on every 12 <-> 24 switch.
  const generating = phrase.status === "generating";
  const mnemonic = phrase.status === "ready" ? phrase.mnemonic : "";

  const words = useMemo(
    () => (mnemonic ? mnemonic.split(/\s+/).filter(Boolean) : []),
    [mnemonic],
  );

  useEffect(() => {
    let cancelled = false;
    sendToBackground<{ mnemonic: string }>("GENERATE_MNEMONIC", {
      wordCount,
    })
      .then((result) => {
        if (!cancelled)
          setPhrase({ status: "ready", mnemonic: result.mnemonic });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setPhrase({
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
          });
      });
    return () => {
      cancelled = true;
    };
  }, [wordCount]);

  /**
   * Switching word count throws the current phrase away. The reset happens here
   * (in the handler that causes it) rather than in the effect, so the reveal
   * and copy acknowledgements can never outlive the phrase they were given for.
   */
  function chooseWordCount(next: WordCount) {
    if (next === wordCount) return;
    setPhrase({ status: "generating" });
    setRevealed(false);
    setCopied(false);
    setError(null);
    setWordCount(next);
  }

  useEffect(() => {
    onStepChange?.(STEPS.indexOf(step));
  }, [STEPS, step, onStepChange]);

  async function handleCopy() {
    if (!mnemonic) return;
    setError(null);
    try {
      await copySensitive(mnemonic);
      setCopied(true);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  function goBack() {
    setError(null);
    if (step === "phrase") onBack();
    else if (step === "verify") setStep("phrase");
    else if (step === "password" || step === "name") setStep("verify");
    else setStep(adding ? "name" : "password");
  }

  function handlePhraseContinue() {
    setError(null);
    if (!mnemonic || words.length !== wordCount) {
      setError("Generate a recovery phrase first");
      return;
    }
    if (!revealed && !copied) {
      setError("Reveal or copy your phrase before continuing");
      return;
    }
    setVerifyIdx(pickVerifyIndices(wordCount));
    setAnswers({});
    setCursor(0);
    setStep("verify");
  }

  function currentIndex(): number {
    return verifyIdx[cursor] ?? 0;
  }

  function handleSelect(word: string) {
    const idx = currentIndex();
    setAnswers({ ...answers, [idx]: word });
    if (words[idx] !== word) {
      setError(`Word #${idx + 1} is incorrect`);
      return;
    }
    setError(null);
    if (cursor + 1 >= verifyIdx.length) {
      setStep(adding ? "name" : "password");
      return;
    }
    setCursor((c) => c + 1);
  }

  function handlePasswordContinue() {
    setError(null);
    if (walletName.trim().length === 0) {
      setError("Give this account a name");
      return;
    }
    if (adding) {
      setStep("networks");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match");
      return;
    }
    setStep("networks");
  }

  function mutateChains(ids: string[], add: boolean) {
    setSelectedChains((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function handleCreate() {
    setError(null);
    if (selectedChains.size < 1) {
      setError("Select at least one network");
      return;
    }
    setBusy(true);
    try {
      if (adding) {
        await sendToBackground("ADD_ACCOUNT_SEED", {
          mnemonic,
          name: walletName.trim(),
          enabledChainIds: [...selectedChains],
        });
      } else {
        await sendToBackground("CREATE_WALLET", {
          password,
          wordCount,
          mnemonic,
          name: walletName.trim(),
          enabledChainIds: [...selectedChains],
        });
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const stepIndex = STEPS.indexOf(step) + 1;

  const footer =
    step === "phrase" ? (
      <StepActions
        onBack={goBack}
        primaryLabel="Continue"
        primaryDisabled={!mnemonic || (!revealed && !copied)}
        onPrimary={handlePhraseContinue}
      />
    ) : step === "verify" ? (
      <StepActions onBack={goBack} />
    ) : step === "password" || step === "name" ? (
      <StepActions
        onBack={goBack}
        primaryLabel="Continue"
        primaryDisabled={adding && walletName.trim().length === 0}
        onPrimary={handlePasswordContinue}
      />
    ) : (
      <StepActions
        onBack={goBack}
        primaryLabel={
          adding
            ? `Add account · ${selectedChains.size}`
            : `Create wallet · ${selectedChains.size}`
        }
        primaryDisabled={busy || selectedChains.size < 1}
        primaryLoading={busy}
        onPrimary={() => void handleCreate()}
      />
    );

  return (
    <ScreenScaffold footer={footer}>
      <OnboardingStep>
        {hideProgress ? null : (
          <StepProgress
            current={stepIndex}
            total={STEPS.length}
            label={STEP_LABELS[step]}
            className="relative"
          />
        )}

        {step === "phrase" && (
          <>
            <StepHeading
              title="Your recovery phrase"
              subtitle={SEED_SAFETY.wordLengthHint}
              className="relative"
            />
            <Segmented
              className="relative w-full min-w-0"
              value={String(wordCount)}
              onChange={(v) => chooseWordCount(Number(v) as WordCount)}
              options={[
                { value: "12", label: "12 words" },
                { value: "24", label: "24 words" },
              ]}
            />
            <Callout tone="warning" className="relative w-full min-w-0">
              Support will never ask for these words.
            </Callout>
            <div className="relative flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={!mnemonic}
                onClick={() => setRevealed((r) => !r)}
              >
                {revealed ? <IconEyeOff /> : <IconEye />}
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={!mnemonic}
                onClick={() => void handleCopy()}
              >
                {copied ? <IconCheck /> : <IconCopy />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            {mnemonic ? (
              <MnemonicGrid
                words={words}
                revealed={revealed}
                compact
                className="relative"
              />
            ) : null}
            {mnemonic && copied ? (
              <p
                role="status"
                className="relative text-[11px] leading-[1.45] text-fg-dim"
              >
                {SENSITIVE_CLIPBOARD_NOTE}
              </p>
            ) : null}
            {mnemonic ? null : (
              <p className="relative text-[11.5px] text-fg-dim">
                {generating
                  ? "Generating…"
                  : phrase.status === "failed"
                    ? `Could not generate a recovery phrase: ${phrase.message}. Go back and try again.`
                    : "Waiting for phrase…"}
              </p>
            )}
          </>
        )}

        {step === "verify" && (
          <>
            <StepHeading
              title="Confirm your phrase"
              subtitle={`Pick word #${currentIndex() + 1}, ${cursor + 1} of ${
                verifyIdx.length
              }.`}
              className="relative"
            />
            <SeedVerifier
              className="relative"
              options={optionsFor(words[currentIndex()] ?? "")}
              selected={answers[currentIndex()]}
              onSelect={handleSelect}
            />
          </>
        )}

        {(step === "password" || step === "name") && (
          <>
            <StepHeading
              title={adding ? "Name this account" : "Name and password"}
              subtitle={
                adding
                  ? "A label on this device. The existing password unlocks every account."
                  : "The name is just a label for this device. The password unlocks Zunia here and never recovers your phrase."
              }
              className="relative"
            />
            <div className="relative flex flex-col gap-2.5">
              <Input
                ref={walletNameRef}
                label="Account name"
                placeholder={adding ? "Account 2" : "Main"}
                maxLength={32}
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
              />
              {adding ? null : (
                <>
                  <PasswordInput
                    label="Password"
                    placeholder="At least 8 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <PasswordInput
                    label="Confirm password"
                    placeholder="Repeat the password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                  {password ? <PasswordStrengthMeter password={password} /> : null}
                </>
              )}
            </div>
          </>
        )}

        {step === "networks" && (
          <>
            <StepHeading
              title="Choose networks"
              subtitle={
                adding
                  ? "These networks belong to this account only. Other accounts keep their own list."
                  : "Pick one or more chains. Mainnets and testnets are both available, and you can change this later."
              }
              className="relative"
            />
            <div className="relative">
              <NetworkSelectStep
                selected={selectedChains}
                onToggle={(id) =>
                  mutateChains([id], !selectedChains.has(id))
                }
                onSelectMany={(ids) => mutateChains(ids, true)}
                onClearMany={(ids) => mutateChains(ids, false)}
              />
            </div>
          </>
        )}

        {error ? (
          <Callout tone="danger" className="relative w-full min-w-0">
            {error}
          </Callout>
        ) : null}
      </OnboardingStep>
    </ScreenScaffold>
  );
}

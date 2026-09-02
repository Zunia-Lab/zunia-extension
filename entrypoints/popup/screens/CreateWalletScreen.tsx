import { useCallback, useEffect, useMemo, useState } from "react";
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
import { NetworkSelectStep } from "./NetworkSelectStep";
import { OnboardingStep, StepActions } from "./onboarding-ui";
import { IconCheck, IconCopy, IconEye, IconEyeOff } from "./icons";

type Step = "phrase" | "verify" | "password" | "networks";
type WordCount = 12 | 24;

const STEPS: Step[] = ["phrase", "verify", "password", "networks"];
const STEP_LABELS: Record<Step, string> = {
  phrase: "Recovery phrase",
  verify: "Verify",
  password: "Password",
  networks: "Networks",
};

/** Step labels in order, for shells that render their own progress rail. */
export const CREATE_STEP_LABELS = STEPS.map((s) => STEP_LABELS[s]);

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
}: {
  onDone: () => void;
  onBack: () => void;
  /** Zero-based step index, for the full-tab shell's own progress rail. */
  onStepChange?: (index: number) => void;
  hideProgress?: boolean;
}) {
  const [step, setStep] = useState<Step>("phrase");
  const [wordCount, setWordCount] = useState<WordCount>(12);
  const [mnemonic, setMnemonic] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
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

  const words = useMemo(
    () => (mnemonic ? mnemonic.split(/\s+/).filter(Boolean) : []),
    [mnemonic],
  );

  const generate = useCallback(async (count: WordCount) => {
    setError(null);
    setBusy(true);
    setRevealed(false);
    setCopied(false);
    setMnemonic("");
    try {
      const result = await sendToBackground<{ mnemonic: string }>(
        "GENERATE_MNEMONIC",
        { wordCount: count },
      );
      setMnemonic(result.mnemonic);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void generate(wordCount);
  }, [wordCount, generate]);

  useEffect(() => {
    onStepChange?.(STEPS.indexOf(step));
  }, [step, onStepChange]);

  async function handleCopy() {
    if (!mnemonic) return;
    setError(null);
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
    } catch {
      setError("Could not copy to clipboard");
    }
  }

  function goBack() {
    setError(null);
    if (step === "phrase") onBack();
    else if (step === "verify") setStep("phrase");
    else if (step === "password") setStep("verify");
    else setStep("password");
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
      setStep("password");
      return;
    }
    setCursor((c) => c + 1);
  }

  function handlePasswordContinue() {
    setError(null);
    if (walletName.trim().length === 0) {
      setError("Give this wallet a name");
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
      await sendToBackground("CREATE_WALLET", {
        password,
        wordCount,
        mnemonic,
        name: walletName.trim(),
        enabledChainIds: [...selectedChains],
      });
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
        primaryDisabled={busy || !mnemonic || (!revealed && !copied)}
        onPrimary={handlePhraseContinue}
      />
    ) : step === "verify" ? (
      <StepActions onBack={goBack} />
    ) : step === "password" ? (
      <StepActions
        onBack={goBack}
        primaryLabel="Continue"
        onPrimary={handlePasswordContinue}
      />
    ) : (
      <StepActions
        onBack={goBack}
        primaryLabel={`Create wallet · ${selectedChains.size}`}
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
              onChange={(v) => setWordCount(Number(v) as WordCount)}
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
                disabled={!mnemonic || busy}
                onClick={() => setRevealed((r) => !r)}
              >
                {revealed ? <IconEyeOff /> : <IconEye />}
                {revealed ? "Hide" : "Reveal"}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="flex-1"
                disabled={!mnemonic || busy}
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
            ) : (
              <p className="relative text-[11.5px] text-fg-dim">
                {busy ? "Generating…" : "Waiting for phrase…"}
              </p>
            )}
          </>
        )}

        {step === "verify" && (
          <>
            <StepHeading
              title="Confirm your phrase"
              subtitle={`Pick word #${currentIndex() + 1} — ${cursor + 1} of ${
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

        {step === "password" && (
          <>
            <StepHeading
              title="Name and password"
              subtitle="The name is just a label for this device. The password unlocks Zunia here and never recovers your phrase."
              className="relative"
            />
            <div className="relative flex flex-col gap-2.5">
              <Input
                label="Wallet name"
                placeholder="Main"
                autoFocus
                maxLength={32}
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
              />
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
            </div>
          </>
        )}

        {step === "networks" && (
          <>
            <StepHeading
              title="Choose networks"
              subtitle="Pick one or more chains. Mainnets and testnets are both available, and you can change this later."
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

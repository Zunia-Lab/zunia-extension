import { useEffect, useMemo, useState } from "react";
import {
  Callout,
  Input,
  PasswordInput,
  PasswordStrengthMeter,
  ScreenScaffold,
  Segmented,
  StepHeading,
  StepProgress,
  Textarea,
} from "@zunialab/ui";
import { PINNED_CHAIN_IDS } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import { NetworkSelectStep } from "./NetworkSelectStep";
import { OnboardingStep, StepActions } from "./onboarding-ui";

type Step = "phrase" | "password" | "name" | "networks";
type WordCount = 12 | 24;
type Variant = "onboard" | "add";

const ONBOARD_STEPS: Step[] = ["phrase", "password", "networks"];
const ADD_STEPS: Step[] = ["phrase", "name", "networks"];
const STEP_LABELS: Record<Step, string> = {
  phrase: "Phrase",
  password: "Password",
  name: "Name",
  networks: "Networks",
};

/** Step labels in order, for shells that render their own progress rail. */
export const IMPORT_STEP_LABELS = ONBOARD_STEPS.map((s) => STEP_LABELS[s]);

export function ImportWalletScreen({
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
  // What the user picked with the 12 / 24 control. The effective count below
  // follows the phrase they typed or pasted, so this only decides the case
  // where the box holds fewer than 12 words and nothing can be inferred yet.
  const [chosenWordCount, setChosenWordCount] = useState<WordCount>(12);
  const [mnemonic, setMnemonic] = useState("");
  const [walletName, setWalletName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [selectedChains, setSelectedChains] = useState<Set<string>>(
    () => new Set(PINNED_CHAIN_IDS),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const wordParts = useMemo(
    () => mnemonic.trim().split(/\s+/).filter(Boolean),
    [mnemonic],
  );

  // Follow what the user typed or pasted; leave 0-11 words on their manual
  // choice so a "24 words" selection still holds while they start entering.
  // Derived rather than synced from an effect: the effect version wrote state
  // on the render that changed the phrase, so every keystroke past the twelfth
  // word cost the screen a second render pass.
  const wordCount: WordCount =
    wordParts.length > 12 ? 24 : wordParts.length === 12 ? 12 : chosenWordCount;

  useEffect(() => {
    onStepChange?.(STEPS.indexOf(step));
  }, [step, onStepChange]);

  function goBack() {
    setError(null);
    if (step === "phrase") onBack();
    else if (step === "password" || step === "name") setStep("phrase");
    else setStep(adding ? "name" : "password");
  }

  function handlePhraseContinue() {
    setError(null);
    if (wordParts.length !== wordCount) {
      setError(`Expected ${wordCount} words, found ${wordParts.length}`);
      return;
    }
    setStep(adding ? "name" : "password");
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

  async function handleImport() {
    setError(null);
    if (selectedChains.size < 1) {
      setError("Select at least one network");
      return;
    }
    setBusy(true);
    try {
      if (adding) {
        await sendToBackground("ADD_ACCOUNT_SEED", {
          mnemonic: wordParts.join(" "),
          name: walletName.trim(),
          enabledChainIds: [...selectedChains],
        });
      } else {
        await sendToBackground("IMPORT_WALLET", {
          mnemonic: wordParts.join(" "),
          password,
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
        primaryDisabled={wordParts.length === 0}
        onPrimary={handlePhraseContinue}
      />
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
            : `Restore wallet · ${selectedChains.size}`
        }
        primaryDisabled={busy || selectedChains.size < 1}
        primaryLoading={busy}
        onPrimary={() => void handleImport()}
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
              title="Restore wallet"
              subtitle="Enter your existing 12 or 24 word recovery phrase, separated by spaces."
              className="relative"
            />
            <Segmented
              className="relative w-full min-w-0"
              value={String(wordCount)}
              onChange={(v) => setChosenWordCount(Number(v) as WordCount)}
              options={[
                { value: "12", label: "12 words" },
                { value: "24", label: "24 words" },
              ]}
            />
            <Textarea
              className="relative"
              rows={wordCount === 24 ? 6 : 4}
              placeholder={
                wordCount === 24 ? "word1 word2 … word24" : "word1 word2 … word12"
              }
              value={mnemonic}
              onChange={(e) => setMnemonic(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <p className="relative font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
              {wordParts.length} / {wordCount} words
            </p>
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
                onToggle={(id) => mutateChains([id], !selectedChains.has(id))}
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

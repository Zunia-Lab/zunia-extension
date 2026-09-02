import { useCallback, useState } from "react";
import { Button, SectionLabel, ThemeProvider, cn } from "@zunialab/ui";
import { PrefsProvider } from "../popup/state/Prefs";
import { useExtensionState } from "../popup/hooks/useExtensionState";
import {
  CREATE_STEP_LABELS,
  CreateWalletScreen,
} from "../popup/screens/CreateWalletScreen";
import {
  IMPORT_STEP_LABELS,
  ImportWalletScreen,
} from "../popup/screens/ImportWalletScreen";
import { WelcomeScreen } from "../popup/screens/WelcomeScreen";

type Flow = "welcome" | "create" | "import" | "done";

function StepRail({
  labels,
  current,
}: {
  labels: readonly string[];
  current: number;
}) {
  return (
    <ol className="flex flex-col gap-1">
      {labels.map((label, index) => {
        const state =
          index < current ? "done" : index === current ? "active" : "todo";
        return (
          <li
            key={label}
            aria-current={state === "active" ? "step" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-[12px] px-3 py-2.5 transition-colors duration-[var(--z-duration-base)]",
              state === "active" && "bg-[image:var(--z-hero-soft-gradient)]",
            )}
          >
            <span
              className={cn(
                "flex size-[22px] shrink-0 items-center justify-center rounded-full font-mono text-[9.5px]",
                state === "done" &&
                  "bg-[var(--z-success-fill)] text-[var(--z-success)]",
                state === "active" &&
                  "bg-[image:var(--z-accent-gradient)] text-[var(--z-accent-fg)]",
                state === "todo" &&
                  "border border-[var(--z-line)] text-fg-faint",
              )}
            >
              {state === "done" ? "✓" : index + 1}
            </span>
            <span
              className={cn(
                "text-[12.5px]",
                state === "todo" ? "text-fg-dim" : "text-fg",
              )}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Full-tab onboarding. Runs the same create/import flows as the popup, but with
 * room for a persistent step rail so a 12 or 24 word phrase is readable without
 * scrolling — which is exactly when people make transcription mistakes.
 */
export default function OnboardingApp() {
  const state = useExtensionState();
  const [flow, setFlow] = useState<Flow>("welcome");
  const [step, setStep] = useState(0);

  const startCreate = useCallback(() => {
    setStep(0);
    setFlow("create");
  }, []);
  const startImport = useCallback(() => {
    setStep(0);
    setFlow("import");
  }, []);
  const backToWelcome = useCallback(() => setFlow("welcome"), []);

  const labels =
    flow === "create"
      ? CREATE_STEP_LABELS
      : flow === "import"
        ? IMPORT_STEP_LABELS
        : [];

  return (
    <ThemeProvider
      defaultTheme={state.settings?.theme ?? "dark"}
      storageKey="zunia.theme"
    >
      <PrefsProvider
        settings={state.settings}
        onChanged={() => void state.refresh()}
      >
        <div className="relative min-h-screen bg-bg text-fg">
          <div
            aria-hidden
            className="pointer-events-none absolute left-1/2 top-[-320px] size-[820px] -translate-x-1/2 bg-[image:var(--z-bloom-gradient)] opacity-[var(--z-bloom)] blur-[26px]"
          />

          <div className="relative mx-auto flex min-h-screen w-full max-w-[1040px] gap-10 px-6 py-12 max-lg:flex-col max-lg:gap-6">
            <aside className="flex w-[260px] shrink-0 flex-col gap-6 max-lg:w-full">
              <div className="flex items-center gap-2.5">
                <span className="flex size-[30px] items-center justify-center rounded-[10px] bg-accent font-medium text-[var(--z-accent-fg)]">
                  Z
                </span>
                <span className="text-[15px] font-medium tracking-[-0.03em]">
                  zunia
                </span>
              </div>

              {labels.length > 0 ? (
                <div className="flex flex-col gap-2.5">
                  <SectionLabel>
                    {flow === "create" ? "Create a wallet" : "Restore a wallet"}
                  </SectionLabel>
                  <StepRail labels={labels} current={step} />
                </div>
              ) : (
                <p className="max-w-[240px] text-[12.5px] leading-relaxed text-fg-muted">
                  One wallet for the Cosmos ecosystem. Keys are generated on this
                  device and never leave it.
                </p>
              )}

              <p className="mt-auto font-mono text-[9px] uppercase tracking-[0.14em] text-fg-faint max-lg:hidden">
                Keys stay on this device
              </p>
            </aside>

            <main className="flex min-w-0 flex-1 justify-center">
              <div className="flex h-[640px] w-full max-w-[420px] flex-col overflow-hidden rounded-[20px] border border-[var(--z-line)] bg-[image:var(--z-surface-gradient)] shadow-[0_26px_60px_var(--z-shadow)]">
                {flow === "welcome" ? (
                  <WelcomeScreen
                    showExpand={false}
                    onCreate={startCreate}
                    onImport={startImport}
                  />
                ) : null}

                {flow === "create" ? (
                  <CreateWalletScreen
                    hideProgress
                    onStepChange={setStep}
                    onBack={backToWelcome}
                    onDone={() => setFlow("done")}
                  />
                ) : null}

                {flow === "import" ? (
                  <ImportWalletScreen
                    hideProgress
                    onStepChange={setStep}
                    onBack={backToWelcome}
                    onDone={() => setFlow("done")}
                  />
                ) : null}

                {flow === "done" ? (
                  <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
                    <span className="flex size-[46px] items-center justify-center rounded-full bg-[var(--z-success-fill)] text-[20px] text-[var(--z-success)]">
                      ✓
                    </span>
                    <div>
                      <h1 className="text-[19px] font-medium tracking-[-0.03em]">
                        Wallet ready
                      </h1>
                      <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">
                        Open Zunia from the toolbar to see your balances. You can
                        close this tab.
                      </p>
                    </div>
                    <Button onClick={() => window.close()}>Close tab</Button>
                  </div>
                ) : null}
              </div>
            </main>
          </div>
        </div>
      </PrefsProvider>
    </ThemeProvider>
  );
}

import { Button, ScreenScaffold, StepHeading } from "@zunialab/ui";
import { OnboardingStep } from "./onboarding-ui";

/** Choose create or restore when adding another account. */
export function AddAccountScreen({
  onCreate,
  onRestore,
  onBack,
}: {
  onCreate: () => void;
  onRestore: () => void;
  onBack: () => void;
}) {
  return (
    <ScreenScaffold
      title="Add account"
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-2">
          <Button className="w-full" size="lg" onClick={onCreate}>
            Create new account
          </Button>
          <Button variant="secondary" className="w-full" size="lg" onClick={onRestore}>
            Restore with phrase
          </Button>
        </div>
      }
    >
      <OnboardingStep>
        <StepHeading
          title="Another key"
          subtitle="This is a new recovery phrase, not another address from the first one. The same password unlocks every account."
          className="relative"
        />
      </OnboardingStep>
    </ScreenScaffold>
  );
}

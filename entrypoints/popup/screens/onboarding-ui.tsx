import type { ReactNode } from "react";
import { Button } from "@zunialab/ui";

/** Shared vertical rhythm for every onboarding step body. */
export function OnboardingStep({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-w-0 max-w-full flex-col gap-4 pb-1 pt-4">
      {children}
    </div>
  );
}

/** Sticky footer actions: secondary Back plus an optional primary action. */
export function StepActions({
  onBack,
  backLabel = "Back",
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryLoading,
}: {
  onBack: () => void;
  backLabel?: string;
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryLoading?: boolean;
}) {
  if (!primaryLabel) {
    return (
      <Button variant="secondary" className="w-full" onClick={onBack}>
        {backLabel}
      </Button>
    );
  }
  return (
    <div className="flex gap-2">
      <Button variant="secondary" className="flex-1" onClick={onBack}>
        {backLabel}
      </Button>
      <Button
        className="flex-[1.5]"
        disabled={primaryDisabled}
        loading={primaryLoading}
        onClick={onPrimary}
      >
        {primaryLabel}
      </Button>
    </div>
  );
}

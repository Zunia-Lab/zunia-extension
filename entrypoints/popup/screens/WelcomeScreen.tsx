import { useState } from "react";
import {
  Button,
  ScreenScaffold,
  SeedSafetyAcks,
  SeedSafetyCallout,
  allSeedAcksAccepted,
  emptySeedAcks,
} from "@zunialab/ui";

/**
 * Safety acknowledgements live here only.
 * Create / Import flows never repeat this copy.
 */
export function WelcomeScreen({
  onCreate,
  onImport,
  /** Hidden in the full-tab flow, which is already the expanded view. */
  showExpand = true,
}: {
  onCreate: () => void;
  onImport: () => void;
  showExpand?: boolean;
}) {
  const [acks, setAcks] = useState(emptySeedAcks);
  const ready = allSeedAcksAccepted(acks);

  return (
    <ScreenScaffold
      footer={
        <div className="flex flex-col gap-2">
          <Button
            className="w-full"
            size="lg"
            disabled={!ready}
            onClick={onCreate}
          >
            Create wallet
          </Button>
          <Button
            variant="secondary"
            className="w-full"
            size="lg"
            disabled={!ready}
            onClick={onImport}
          >
            Restore with phrase
          </Button>
          {showExpand ? (
            <button
              type="button"
              onClick={() => {
                void browser.tabs.create({
                  url: browser.runtime.getURL("/onboarding.html"),
                });
                window.close();
              }}
              className="mt-0.5 text-center text-[11px] text-fg-dim underline-offset-2 hover:text-fg hover:underline"
            >
              Set up in a full tab instead
            </button>
          ) : null}
        </div>
      }
    >
      <div className="relative flex min-w-0 max-w-full flex-col gap-5 pt-7">
        <div className="relative flex flex-col items-center gap-3 text-center">
          <div className="flex items-center gap-2.5">
            <img
              src="/brand/mark.svg"
              alt=""
              width={28}
              height={26}
              className="block"
            />
            <span className="text-[26px] font-medium tracking-[-0.055em] text-fg">
              zunia
            </span>
          </div>
          <p className="max-w-[280px] text-[13px] leading-[1.5] text-fg-muted">
            Every Cosmos chain. One key.
          </p>
        </div>

        <SeedSafetyCallout compact className="relative" />
        <SeedSafetyAcks value={acks} onChange={setAcks} className="relative" />
      </div>
    </ScreenScaffold>
  );
}

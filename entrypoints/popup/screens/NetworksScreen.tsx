import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  ScreenScaffold,
  Text,
  cn,
  focusRing,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import { NetworkSelectStep } from "./NetworkSelectStep";
import { IconPlus } from "./icons";

/** Post-onboarding network manager. Toggles apply immediately across the popup. */
export function NetworksScreen({
  onBack,
  onSaved,
  onAddChain,
}: {
  onBack: () => void;
  onSaved: () => void;
  onAddChain: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void sendToBackground<string[]>("GET_ENABLED_CHAINS").then((ids) => {
      setSelected(new Set(ids));
    });
  }, []);

  async function apply(next: Set<string>) {
    if (next.size === 0) {
      setError("Keep at least one network enabled");
      return;
    }
    setBusy(true);
    setError(null);
    setSelected(next);
    try {
      const saved = await sendToBackground<string[]>("SET_ENABLED_CHAINS", {
        chainIds: [...next],
      });
      setSelected(new Set(saved));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      const ids = await sendToBackground<string[]>("GET_ENABLED_CHAINS");
      setSelected(new Set(ids));
    } finally {
      setBusy(false);
    }
  }

  function toggle(chainId: string) {
    const next = new Set(selected);
    if (next.has(chainId)) next.delete(chainId);
    else next.add(chainId);
    void apply(next);
  }

  return (
    <ScreenScaffold
      title="Networks"
      onBack={onBack}
      right={<Text variant="labelCaps">{selected.size} on</Text>}
      footer={
        <Button
          className="w-full"
          size="lg"
          loading={busy}
          disabled={selected.size === 0}
          onClick={onSaved}
        >
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {error ? <Callout tone="danger">{error}</Callout> : null}
        <NetworkSelectStep
          selected={selected}
          control="switch"
          onToggle={toggle}
          onSelectMany={(ids) => {
            void apply(new Set([...selected, ...ids]));
          }}
          onClearMany={(ids) => {
            const next = new Set(selected);
            for (const id of ids) next.delete(id);
            void apply(next);
          }}
        />
        <button
          type="button"
          onClick={onAddChain}
          className={cn(
            "flex w-full items-center justify-center gap-1.5 rounded-[12px] border border-dashed border-[var(--z-line)] py-2.5",
            "text-[11.5px] text-fg-muted transition-colors duration-[var(--z-duration-base)]",
            "hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)] hover:text-fg",
            focusRing,
          )}
        >
          <IconPlus width={16} height={16} />
          Add chain manually
        </button>
      </div>
    </ScreenScaffold>
  );
}

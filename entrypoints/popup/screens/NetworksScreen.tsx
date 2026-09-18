import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  Callout,
  ScreenScaffold,
  Text,
  cn,
  focusRing,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import { STORAGE_KEYS } from "../../../lib/storage-keys";
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
  // The apply queue below runs across awaits, so it needs the latest selection
  // without being rebuilt on every render. The mirror used to be written during
  // render, which React forbids: a render that is thrown away (StrictMode, a
  // concurrent retry) would still have moved the ref, and the queued write
  // would then apply a selection the user never committed. Every update goes
  // through commitSelected instead, so ref and state cannot drift.
  const selectedRef = useRef(selected);
  const commitSelected = useCallback((next: Set<string>) => {
    selectedRef.current = next;
    setSelected(next);
  }, []);
  // Serialize writes so rapid toggles / Select all cannot clobber each other
  // or clear `busy` while a later apply is still in flight.
  const applyChain = useRef(Promise.resolve());
  const applyGeneration = useRef(0);

  useEffect(() => {
    void sendToBackground<string[]>("GET_ENABLED_CHAINS").then((ids) => {
      commitSelected(new Set(ids));
    });
  }, [commitSelected]);

  // Stay in sync if another surface (Add Chain, storage) mutates enabled ids
  // while this screen is open.
  useEffect(() => {
    const onChanged: Parameters<
      typeof browser.storage.onChanged.addListener
    >[0] = (changes, area) => {
      if (area !== "local") return;
      if (!changes[STORAGE_KEYS.enabledChains]) return;
      // Skip while we are writing; the apply result is the source of truth.
      if (applyGeneration.current > 0) return;
      const value = changes[STORAGE_KEYS.enabledChains].newValue;
      if (!Array.isArray(value)) return;
      commitSelected(new Set(value as string[]));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [commitSelected]);

  function enqueueApply(mutator: (prev: Set<string>) => Set<string>) {
    const generation = ++applyGeneration.current;
    setBusy(true);
    setError(null);

    applyChain.current = applyChain.current
      .catch(() => undefined)
      .then(async () => {
        const next = mutator(selectedRef.current);
        if (next.size === 0) {
          setError("Keep at least one network enabled");
          return;
        }
        commitSelected(next);
        try {
          const saved = await sendToBackground<string[]>("SET_ENABLED_CHAINS", {
            chainIds: [...next],
          });
          // Only commit if nothing newer has queued after us.
          if (generation === applyGeneration.current) {
            commitSelected(new Set(saved));
          }
        } catch (err) {
          if (generation !== applyGeneration.current) return;
          setError(err instanceof Error ? err.message : String(err));
          const ids = await sendToBackground<string[]>("GET_ENABLED_CHAINS");
          commitSelected(new Set(ids));
        }
      })
      .finally(() => {
        if (generation === applyGeneration.current) {
          applyGeneration.current = 0;
          setBusy(false);
        }
      });
  }

  function toggle(chainId: string) {
    enqueueApply((prev) => {
      const next = new Set(prev);
      if (next.has(chainId)) next.delete(chainId);
      else next.add(chainId);
      return next;
    });
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
          defaultFilter="all"
          onToggle={toggle}
          onSelectMany={(ids) => {
            enqueueApply((prev) => new Set([...prev, ...ids]));
          }}
          onClearMany={(ids) => {
            enqueueApply((prev) => {
              const next = new Set(prev);
              for (const id of ids) next.delete(id);
              return next;
            });
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

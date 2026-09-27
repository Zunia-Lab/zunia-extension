import { useEffect, useRef, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  ScreenScaffold,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import { avatarSeedOf, type SessionStatus } from "../../../lib/session";
import { sendToBackground } from "../../../lib/popup-client";
import { IconCheck, IconPlus, IconTrash } from "./icons";

export function WalletsScreen({
  status,
  onBack,
  onRefresh,
  onAdd,
}: {
  status: SessionStatus;
  onBack: () => void;
  onRefresh: () => void;
  onAdd: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removeIndex, setRemoveIndex] = useState<number | null>(null);
  const draftRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing !== null) draftRef.current?.focus();
  }, [editing]);

  const removing = status.accounts.find((row) => row.index === removeIndex);
  const canRemove = status.accounts.length > 1;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScaffold
      title="Accounts"
      onBack={onBack}
      right={
        <span className="font-mono text-[9.5px] text-fg-dim">
          {status.accounts.length}
        </span>
      }
      footer={
        <Button variant="secondary" className="w-full" onClick={onAdd}>
          <IconPlus width={16} height={16} />
          Add account
        </Button>
      }
    >
      <div className="flex flex-col gap-2 pt-1">
        {error ? <Callout compact tone="danger">{error}</Callout> : null}

        <ul className="flex flex-col gap-1.5">
          {status.accounts.map((account) => {
            const active = account.index === status.activeAccountIndex;
            const isEditing = editing === account.index;
            return (
              <li
                key={account.index}
                className={cn(
                  "rounded-[10px] border px-2.5 py-2",
                  active
                    ? "border-[color-mix(in_srgb,var(--z-accent)_50%,transparent)] bg-[var(--z-state-selected)]"
                    : "border-[var(--z-line)] bg-[var(--z-glass)]",
                )}
              >
                <div className="flex items-center gap-2">
                  <Avatar
                    seed={avatarSeedOf(account)}
                    fallback={account.name}
                    size={26}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium leading-none text-fg">
                        {account.name}
                      </span>
                      {active ? (
                        <span className="font-mono text-[8.5px] uppercase tracking-[0.08em] text-accent">
                          active
                        </span>
                      ) : null}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9.5px] text-fg-dim">
                      {truncateAddress(account.address, 10, 6)}
                    </span>
                  </span>
                  {active ? (
                    <IconCheck
                      width={14}
                      height={14}
                      className="shrink-0 text-accent"
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        void run(() =>
                          sendToBackground("SET_ACTIVE_ACCOUNT", {
                            index: account.index,
                          }),
                        )
                      }
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] text-fg-muted",
                        "hover:text-fg",
                        focusRing,
                      )}
                    >
                      Use
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${account.name}`}
                    disabled={!canRemove}
                    onClick={() => setRemoveIndex(account.index)}
                    className={cn(
                      "flex size-7 shrink-0 items-center justify-center rounded-full text-fg-dim",
                      "hover:text-[var(--z-danger)] disabled:cursor-not-allowed disabled:opacity-30",
                      focusRing,
                    )}
                  >
                    <IconTrash width={13} height={13} />
                  </button>
                </div>

                {isEditing ? (
                  <div className="mt-2 flex gap-1.5">
                    <Input
                      ref={draftRef}
                      className="flex-1"
                      aria-label={`Rename ${account.name}`}
                      value={draft}
                      maxLength={32}
                      onChange={(e) => setDraft(e.target.value)}
                    />
                    <Button
                      size="sm"
                      loading={busy}
                      onClick={() =>
                        void run(async () => {
                          await sendToBackground("RENAME_ACCOUNT", {
                            index: account.index,
                            name: draft,
                          });
                          setEditing(null);
                        })
                      }
                    >
                      Save
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(account.index);
                      setDraft(account.name);
                    }}
                    className={cn(
                      "mt-1.5 font-mono text-[9px] uppercase tracking-[0.1em] text-fg-dim",
                      "hover:text-fg",
                      focusRing,
                    )}
                  >
                    Rename
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      <Dialog
        open={removeIndex !== null}
        onOpenChange={(open) => {
          if (!open) setRemoveIndex(null);
        }}
      >
        <DialogContent className="w-[min(320px,calc(100%-28px))] p-4">
          <DialogTitle className="text-[16px]">Remove account</DialogTitle>
          <DialogDescription className="mt-1 text-[12px] leading-snug">
            {removing
              ? `Remove ${removing.name} from this device? The recovery phrase is not deleted. You can restore it later.`
              : "Remove this account from this device?"}
          </DialogDescription>
          <div className="mt-4 flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => setRemoveIndex(null)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  if (removeIndex === null) return;
                  await sendToBackground("REMOVE_ACCOUNT", { index: removeIndex });
                  setRemoveIndex(null);
                })
              }
            >
              Remove
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </ScreenScaffold>
  );
}

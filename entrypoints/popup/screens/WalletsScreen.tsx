import { useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  Input,
  Pill,
  ScreenScaffold,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { SessionStatus } from "../../../lib/session";
import { sendToBackground } from "../../../lib/popup-client";
import { IconCheck, IconPlus } from "./icons";

export function WalletsScreen({
  status,
  onBack,
  onRefresh,
}: {
  status: SessionStatus;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        adding ? (
          <div className="flex flex-col gap-2">
            <Input
              placeholder="Account name"
              value={newName}
              autoFocus
              maxLength={32}
              onChange={(e) => setNewName(e.target.value)}
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                onClick={() => {
                  setAdding(false);
                  setNewName("");
                }}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await sendToBackground("ADD_ACCOUNT", {
                      name: newName.trim() || undefined,
                    });
                    setAdding(false);
                    setNewName("");
                  })
                }
              >
                Create
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setAdding(true)}
          >
            <IconPlus width={16} height={16} />
            Add account
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {error ? <Callout tone="danger">{error}</Callout> : null}

        <ul className="flex flex-col gap-2">
          {status.accounts.map((account) => {
            const active = account.index === status.activeAccountIndex;
            const isEditing = editing === account.index;
            return (
              <li
                key={account.index}
                className={cn(
                  "rounded-[14px] border px-3 py-2.5",
                  active
                    ? "border-[color-mix(in_srgb,var(--z-accent)_55%,transparent)] bg-[var(--z-state-selected)]"
                    : "border-[var(--z-line)]",
                )}
              >
                <div className="flex items-center gap-2.5">
                  <Avatar
                    seed={account.address}
                    fallback={account.name}
                    size={30}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[12.5px] font-medium text-fg">
                        {account.name}
                      </span>
                      {active ? <Pill tone="accent">active</Pill> : null}
                    </span>
                    <span className="mt-[3px] block truncate font-mono text-[9.5px] text-fg-dim">
                      {truncateAddress(account.address, 12, 8)}
                    </span>
                  </span>
                  {active ? (
                    <IconCheck
                      width={16}
                      height={16}
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
                        "shrink-0 rounded-full border border-[var(--z-line)] px-2.5 py-1 text-[10.5px] text-fg-muted",
                        "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
                        focusRing,
                      )}
                    >
                      Use
                    </button>
                  )}
                </div>

                {isEditing ? (
                  <div className="mt-2.5 flex gap-2">
                    <Input
                      className="flex-1"
                      value={draft}
                      autoFocus
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
                      "mt-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim",
                      "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
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

        <Callout tone="neutral" title="One phrase, many accounts">
          Every account here is a different BIP-44 index derived from the same
          recovery phrase, so one backup restores all of them.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

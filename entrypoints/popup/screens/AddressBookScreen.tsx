import { useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Input,
  ScreenScaffold,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { AddressBookEntry } from "../../../lib/address-book";
import { sendToBackground } from "../../../lib/popup-client";
import { isBech32, prefixOf } from "../../../lib/format";
import { IconBook, IconPlus, IconTrash } from "./icons";

export function AddressBookScreen({
  contacts,
  onBack,
  onChanged,
}: {
  contacts: AddressBookEntry[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const addressValid = isBech32(address);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await sendToBackground("SAVE_ADDRESS_BOOK_ENTRY", { label, address });
      setLabel("");
      setAddress("");
      setAdding(false);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await sendToBackground("REMOVE_ADDRESS_BOOK_ENTRY", { id });
    onChanged();
  }

  return (
    <ScreenScaffold
      title="Address book"
      onBack={onBack}
      right={
        <span className="font-mono text-[9.5px] text-fg-dim">
          {contacts.length}
        </span>
      }
      footer={
        adding ? (
          <div className="flex gap-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() => {
                setAdding(false);
                setError(null);
              }}
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              loading={busy}
              disabled={!label.trim() || !addressValid}
              onClick={() => void save()}
            >
              Save
            </Button>
          </div>
        ) : (
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => setAdding(true)}
          >
            <IconPlus width={16} height={16} />
            Add address
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {error ? <Callout tone="danger">{error}</Callout> : null}

        {adding ? (
          <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] px-3 py-3">
            <Input
              label="Label"
              placeholder="Treasury"
              value={label}
              autoFocus
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Input
              label="Address"
              placeholder="cosmos1…"
              value={address}
              spellCheck={false}
              autoComplete="off"
              state={address ? (addressValid ? "valid" : "error") : "default"}
              hint={
                address
                  ? addressValid
                    ? `${prefixOf(address)} chain family`
                    : "Not a valid bech32 address"
                  : undefined
              }
              onChange={(e) => setAddress(e.target.value.trim())}
            />
          </div>
        ) : null}

        {contacts.length === 0 && !adding ? (
          <EmptyState
            icon={<IconBook width={16} height={16} />}
            title="No saved addresses"
            description="Save the addresses you send to often and they show up as chips in the send flow."
          />
        ) : null}

        <ul className="flex flex-col gap-2">
          {contacts.map((contact) => (
            <li
              key={contact.id}
              className="flex items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-3 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-fg">
                  {contact.label}
                </span>
                <span className="mt-[3px] block break-all font-mono text-[9.5px] leading-[1.4] text-fg-dim">
                  {contact.address}
                </span>
              </span>
              <button
                type="button"
                aria-label={`Remove ${contact.label}`}
                onClick={() => void remove(contact.id)}
                className={cn(
                  "flex size-[26px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-dim",
                  "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-danger-line)] hover:text-[var(--z-danger-fg)]",
                  focusRing,
                )}
              >
                <IconTrash width={16} height={16} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </ScreenScaffold>
  );
}

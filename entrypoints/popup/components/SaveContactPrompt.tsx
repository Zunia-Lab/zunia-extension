import { useState } from "react";
import { Button, Input, truncateAddress } from "@zunialab/ui";
import type { AddressBookEntry } from "../../../lib/address-book";
import { sendToBackground } from "../../../lib/popup-client";
import { useToast } from "../state/Toasts";

/**
 * Offered after a successful send to an address the book does not have yet.
 * Disappears once the address is saved, because the contact list it reads
 * from then includes it.
 */
export function SaveContactPrompt({
  address,
  chainId,
  contacts,
  onSaved,
}: {
  address: string;
  chainId?: string;
  contacts: readonly AddressBookEntry[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!address || contacts.some((contact) => contact.address === address)) return null;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await sendToBackground("SAVE_ADDRESS_BOOK_ENTRY", {
        label: label.trim(),
        address,
        ...(chainId ? { chainId } : {}),
      });
      toast("Contact saved", { meta: label.trim() });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
      <div>
        <p className="text-[12px] font-medium text-fg">Save this recipient?</p>
        <p className="mt-0.5 font-mono text-[9.5px] text-fg-dim">
          {truncateAddress(address, 12, 8)}
        </p>
      </div>
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (label.trim() && !busy) void save();
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Contact name"
            placeholder="Name, e.g. Treasury"
            value={label}
            maxLength={40}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <Button type="submit" loading={busy} disabled={!label.trim()}>
          Save
        </Button>
      </form>
      {error ? <p className="text-[10.5px] text-[var(--z-danger-fg)]">{error}</p> : null}
    </section>
  );
}

import { useId, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  Dialog,
  DialogDescription,
  DialogTitle,
  Input,
  SheetContent,
  cn,
  focusRing,
} from "@zunialab/ui";
import {
  MAX_LABEL_LENGTH,
  MAX_NOTE_LENGTH,
  catalogPrefix,
  contactAddressProblem,
  type AddressBookEntry,
} from "../../../lib/address-book";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import { useToast } from "../state/Toasts";
import { ChainSheet, PickerTrigger, type ChainOption } from "./ChainSheet";

/**
 * Create or edit one contact, and delete it after a confirmation. The address
 * is checked as it is typed: checksum first, then the prefix of the network
 * the contact is pinned to, the same rules the background applies on save.
 */
export function ContactSheet({
  open,
  contact,
  chains,
  onClose,
  onChanged,
}: {
  open: boolean;
  /** `null` creates a new contact. */
  contact: AddressBookEntry | null;
  chains: readonly ChainOption[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const descriptionId = useId();
  const [label, setLabel] = useState("");
  const [address, setAddress] = useState("");
  const [chainId, setChainId] = useState<string | undefined>(undefined);
  const [note, setNote] = useState("");
  const [picking, setPicking] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each opening starts from the contact as saved, not from an abandoned edit.
  const openedKey = open ? (contact?.id ?? "new") : "";
  const [loadedKey, setLoadedKey] = useState("");
  if (openedKey !== loadedKey) {
    setLoadedKey(openedKey);
    if (openedKey) {
      setLabel(contact?.label ?? "");
      setAddress(contact?.address ?? "");
      setChainId(contact?.chainId);
      setNote(contact?.note ?? "");
      setConfirmDelete(false);
      setError(null);
    }
  }

  const trimmed = address.trim();
  const problem = trimmed ? contactAddressProblem(trimmed, chainId, catalogPrefix) : null;
  const canSave = Boolean(label.trim()) && Boolean(trimmed) && !problem && !busy;
  const network = chainId ? chains.find((chain) => chain.chainId === chainId) : undefined;
  const networkName = chainId ? (findCatalogEntry(chainId)?.chainName ?? chainId) : undefined;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (contact) {
        await sendToBackground("UPDATE_ADDRESS_BOOK_ENTRY", {
          id: contact.id,
          label,
          address: trimmed,
          chainId: chainId ?? null,
          note: note.trim() || null,
        });
        toast("Contact updated", { meta: label.trim() });
      } else {
        await sendToBackground("SAVE_ADDRESS_BOOK_ENTRY", {
          label,
          address: trimmed,
          ...(chainId ? { chainId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        toast("Contact saved", { meta: label.trim() });
      }
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!contact) return;
    setBusy(true);
    setError(null);
    try {
      await sendToBackground("REMOVE_ADDRESS_BOOK_ENTRY", { id: contact.id });
      toast("Contact deleted", { tone: "neutral", meta: contact.label });
      onChanged();
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={descriptionId}
        className="flex max-h-[92vh] flex-col overflow-hidden px-0 pb-0 pt-3"
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSave && !confirmDelete) void save();
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
            <DialogTitle className="text-[15px]">
              {contact ? "Edit contact" : "New contact"}
            </DialogTitle>
            <DialogDescription id={descriptionId} className="mt-1 text-[11px]">
              Pin a network when the address only works there, such as an exchange
              deposit address. Send then offers it on that network only.
            </DialogDescription>

            <div className="mt-3 flex flex-col gap-3">
              <Input
                label="Name"
                placeholder="Treasury"
                value={label}
                maxLength={MAX_LABEL_LENGTH}
                onChange={(event) => setLabel(event.target.value)}
              />
              <Input
                label="Address"
                placeholder={`${network?.entry.bech32Prefix ?? "cosmos"}1…`}
                value={address}
                spellCheck={false}
                autoComplete="off"
                state={trimmed ? (problem ? "error" : "valid") : "default"}
                hint={
                  trimmed
                    ? (problem ?? (networkName ? `Valid on ${networkName}` : "Valid address"))
                    : undefined
                }
                onChange={(event) => setAddress(event.target.value)}
              />
              <div className="flex flex-col gap-2">
                <span className="font-mono text-[length:var(--z-type-micro)] uppercase tracking-[0.14em] text-fg-muted">
                  Network
                </span>
                <PickerTrigger
                  aria-label={`Network: ${networkName ?? "any network"}. Change`}
                  icon={
                    networkName ? (
                      <Avatar src={network?.iconUrl} fallback={networkName} size={24} />
                    ) : undefined
                  }
                  title={networkName ?? "Any network"}
                  subtitle={networkName ? chainId : "Offered wherever the address prefix fits"}
                  expanded={picking}
                  onClick={() => setPicking(true)}
                />
                {chainId ? (
                  <button
                    type="button"
                    onClick={() => setChainId(undefined)}
                    className={cn(
                      "self-start text-[10.5px] text-fg-muted underline underline-offset-2 hover:text-fg",
                      focusRing,
                    )}
                  >
                    Use on any network
                  </button>
                ) : null}
              </div>
              <Input
                label="Note (optional)"
                placeholder="Cold storage, memo required, …"
                value={note}
                maxLength={MAX_NOTE_LENGTH}
                onChange={(event) => setNote(event.target.value)}
              />
            </div>

            {error ? (
              <Callout tone="danger" className="mt-3">
                {error}
              </Callout>
            ) : null}
          </div>

          {confirmDelete && contact ? (
            <div className="flex flex-col gap-2 border-t border-[var(--z-line)] px-4 py-3">
              <p className="text-[11.5px] text-fg" role="alert">
                Delete {contact.label}? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  className="flex-1"
                  disabled={busy}
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  className="flex-1"
                  loading={busy}
                  onClick={() => void remove()}
                >
                  Delete
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex gap-2 border-t border-[var(--z-line)] px-4 py-3">
              {contact ? (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={busy}
                  onClick={() => setConfirmDelete(true)}
                >
                  Delete
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                size="sm"
                className="flex-1"
                loading={busy}
                disabled={!canSave}
              >
                {contact ? "Save changes" : "Save contact"}
              </Button>
            </div>
          )}
        </form>

        <ChainSheet
          open={picking}
          onClose={() => setPicking(false)}
          title="Network for this contact"
          chains={chains}
          selectedId={chainId}
          onSelect={(id) => {
            setChainId(id);
            setPicking(false);
          }}
        />
      </SheetContent>
    </Dialog>
  );
}

import { useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  ScreenScaffold,
  SearchField,
  SectionLabel,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { AddressBookEntry } from "../../../lib/address-book";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { isBech32, relativeTime } from "../../../lib/format";
import { searchItems } from "../../../lib/picker";
import { sendToBackground } from "../../../lib/popup-client";
import { ContactSheet } from "../components/ContactSheet";
import type { ChainOption } from "../components/ChainSheet";
import { IconBook, IconChevronRight, IconPlus, IconStar } from "./icons";

/** Shown when the book is long enough that scanning it is slower than typing. */
const SEARCH_FROM = 4;

function usage(contact: AddressBookEntry): string | null {
  if (!contact.lastUsedAt || contact.useCount === 0) return null;
  const times = contact.useCount === 1 ? "once" : `${contact.useCount} times`;
  return `Sent ${times}, last ${relativeTime(contact.lastUsedAt)}`;
}

function ContactRow({
  contact,
  onToggleFavorite,
  onEdit,
}: {
  contact: AddressBookEntry;
  onToggleFavorite: () => void;
  onEdit: () => void;
}) {
  const network = contact.chainId
    ? (findCatalogEntry(contact.chainId)?.chainName ?? contact.chainId)
    : null;
  const valid = isBech32(contact.address);
  const detail = contact.note ?? usage(contact);
  return (
    <li className="flex items-center gap-1 rounded-[12px] border border-[var(--z-line)] py-1 pl-1 pr-1.5">
      <button
        type="button"
        aria-pressed={contact.favorite}
        aria-label={`Favorite ${contact.label}`}
        onClick={onToggleFavorite}
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          contact.favorite ? "text-[var(--z-warning)]" : "text-fg-dim hover:text-fg",
          focusRing,
        )}
      >
        <IconStar filled={contact.favorite} width={16} height={16} />
      </button>
      <button
        type="button"
        onClick={onEdit}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 rounded-[9px] px-1.5 py-1.5 text-left",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[12.5px] font-medium text-fg">{contact.label}</span>
            {network ? (
              <span className="shrink-0 rounded-full border border-[var(--z-line)] px-1.5 font-mono text-[8.5px] uppercase tracking-[0.08em] text-fg-dim">
                {network}
              </span>
            ) : null}
          </span>
          <span className="mt-[3px] block truncate font-mono text-[9.5px] text-fg-dim">
            {truncateAddress(contact.address, 14, 8)}
          </span>
          {!valid ? (
            <span className="mt-[3px] block text-[10px] text-[var(--z-danger-fg)]">
              This address fails its checksum. Fix it or delete it.
            </span>
          ) : detail ? (
            <span className="mt-[3px] block truncate text-[10px] text-fg-muted">{detail}</span>
          ) : null}
        </span>
        <IconChevronRight width={16} height={16} className="shrink-0 text-fg-dim" />
        <span className="sr-only">Edit</span>
      </button>
    </li>
  );
}

export function AddressBookScreen({
  contacts,
  chains,
  onBack,
  onChanged,
}: {
  contacts: AddressBookEntry[];
  chains: readonly ChainOption[];
  onBack: () => void;
  onChanged: () => void;
}) {
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<AddressBookEntry | "new" | null>(null);

  const results = useMemo(() => {
    if (!query.trim()) return null;
    const byId = new Map(contacts.map((c) => [c.id, c]));
    return searchItems(
      contacts.map((c) => ({
        id: c.id,
        label: c.label,
        keywords: [
          c.address,
          c.note ?? "",
          c.chainId ?? "",
          c.chainId ? (findCatalogEntry(c.chainId)?.chainName ?? "") : "",
        ],
      })),
      query,
    ).flatMap((item) => byId.get(item.id) ?? []);
  }, [contacts, query]);

  const favorites = useMemo(() => contacts.filter((c) => c.favorite), [contacts]);

  async function toggleFavorite(contact: AddressBookEntry) {
    await sendToBackground("TOGGLE_ADDRESS_BOOK_FAVORITE", { id: contact.id });
    onChanged();
  }

  function list(rows: readonly AddressBookEntry[]) {
    return (
      <ul className="flex flex-col gap-1.5">
        {rows.map((contact) => (
          <ContactRow
            key={contact.id}
            contact={contact}
            onToggleFavorite={() => void toggleFavorite(contact)}
            onEdit={() => setEditing(contact)}
          />
        ))}
      </ul>
    );
  }

  return (
    <ScreenScaffold
      title="Address book"
      onBack={onBack}
      right={<span className="font-mono text-[9.5px] text-fg-dim">{contacts.length}</span>}
      footer={
        <Button variant="secondary" className="w-full" onClick={() => setEditing("new")}>
          <IconPlus width={16} height={16} />
          Add contact
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {contacts.length === 0 ? (
          <EmptyState
            icon={<IconBook width={16} height={16} />}
            title="No saved addresses"
            description="Add a contact for a specific network. Send then offers it on that network only."
          />
        ) : null}

        {contacts.length >= SEARCH_FROM ? (
          <SearchField
            value={query}
            onValueChange={setQuery}
            placeholder="Search by name, address, note or network"
          />
        ) : null}

        {results ? (
          results.length === 0 ? (
            <p className="py-6 text-center text-[12px] text-fg-muted">
              No saved address matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            list(results)
          )
        ) : (
          <>
            {favorites.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                <SectionLabel>Favorites</SectionLabel>
                {list(favorites)}
              </section>
            ) : null}
            {contacts.length > 0 ? (
              <section className="flex flex-col gap-1.5">
                {favorites.length > 0 ? <SectionLabel>All</SectionLabel> : null}
                {list(contacts)}
              </section>
            ) : null}
          </>
        )}
      </div>

      <ContactSheet
        open={editing !== null}
        contact={editing === "new" ? null : editing}
        chains={chains}
        onClose={() => setEditing(null)}
        onChanged={onChanged}
      />
    </ScreenScaffold>
  );
}

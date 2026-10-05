import {
  useEffect,
  useId,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  Dialog,
  DialogTitle,
  SearchField,
  SheetContent,
  Skeleton,
  cn,
} from "@zunialab/ui";
import { pickerSections, type Searchable } from "../../../lib/picker";
import { IconCheck, IconStar } from "../screens/icons";

export interface PickerItem extends Searchable {
  icon?: ReactNode;
  /** Right-aligned detail, usually a balance. */
  trailing?: ReactNode;
  disabled?: boolean;
  /**
   * Why a disabled item cannot be picked, on its own line under the sublabel
   * and never cut. The sublabel stays: it is often what tells two disabled
   * rows apart, such as one token on two chains with the same reason.
   */
  disabledReason?: string;
  /**
   * Drawn in place of `label`, which stays the text a search matches. For a
   * label whose end must not be cut: a token ticker keeps its suffix
   * (`.axl.polygon`, the `·8EF1` an impostor gets) and gives up its family
   * part first. A plain `label` wraps rather than being cut.
   */
  labelNode?: ReactNode;
  /**
   * Read by assistive tech after the row's visible text, never shown: what
   * the icon says and the text does not, such as a token's proven seal.
   */
  srNote?: string;
}

interface Entry {
  key: string;
  domId: string;
  item: PickerItem;
}

function defaultSearchOnlyNote(count: number): string {
  return `${count.toLocaleString()} more ${count === 1 ? "appears" : "appear"} when you search.`;
}

/**
 * Bottom sheet for choosing one item from a list: search box on top, then
 * Favorites, Recent, and All. The search box keeps focus the whole time; the
 * arrow keys move a highlight through the list (announced through
 * aria-activedescendant), Enter picks, Shift+Enter toggles a favorite, and
 * Escape clears the search before it closes the sheet.
 *
 * Search-only items (lib/picker.ts) are listed only in search results; the
 * footer says how many a search would add. A disabled item stays readable:
 * its icon and label are dimmed, its sublabel and its reason are not.
 */
export function PickerSheet({
  open,
  onClose,
  title,
  items,
  selectedId,
  onSelect,
  searchPlaceholder = "Search",
  favorites,
  recents,
  allTitle,
  onToggleFavorite,
  loading = false,
  emptyLabel = "Nothing to choose from yet.",
  renderLimit,
  searchOnlyNote,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: readonly PickerItem[];
  selectedId?: string;
  onSelect: (id: string) => void;
  searchPlaceholder?: string;
  favorites?: readonly string[];
  recents?: readonly string[];
  /** Heading of the full list under Favorites and Recent. Defaults to "All". */
  allTitle?: string;
  onToggleFavorite?: (id: string) => void;
  loading?: boolean;
  emptyLabel?: string;
  /**
   * Rows rendered per section. A long list (Osmosis lists over a thousand
   * tokens) shows its head and says how many more a search would reach.
   */
  renderLimit?: number;
  /**
   * The footer line while search-only items are left out of the list, given
   * their count. Defaults to "N more appear when you search."
   */
  searchOnlyNote?: (count: number) => string;
}) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const hintId = `${baseId}-hint`;
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // Every opening starts from an empty search and the current selection.
  const [openedFor, setOpenedFor] = useState(open);
  if (openedFor !== open) {
    setOpenedFor(open);
    if (open) {
      setQuery("");
      setActiveKey(null);
    }
  }

  const { sections, hiddenCount } = useMemo(() => {
    const full = pickerSections(items, { query, favorites, recents, allTitle });
    if (!renderLimit) return { sections: full, hiddenCount: 0 };
    let hidden = 0;
    const capped = full.map((section) => {
      if (section.items.length <= renderLimit) return section;
      hidden += section.items.length - renderLimit;
      return { ...section, items: section.items.slice(0, renderLimit) };
    });
    return { sections: capped, hiddenCount: hidden };
  }, [items, query, favorites, recents, allTitle, renderLimit]);
  // Left out of the list until a search finds them (lib/picker.ts). A search
  // lists them with everything else, so there is nothing to count then.
  const searching = sections.some((section) => section.key === "results");
  const searchOnlyCount = useMemo(
    () => (searching ? 0 : items.filter((item) => item.searchOnly).length),
    [items, searching],
  );

  const entries = useMemo(() => {
    const out: Entry[] = [];
    for (const section of sections) {
      for (const item of section.items) {
        out.push({
          key: `${section.key}:${item.id}`,
          domId: `${baseId}-opt-${out.length}`,
          item,
        });
      }
    }
    return out;
  }, [sections, baseId]);

  const entryByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry])),
    [entries],
  );
  const enabled = entries.filter((entry) => !entry.item.disabled);
  const favoriteSet = useMemo(() => new Set(favorites ?? []), [favorites]);

  // Derived: the highlighted row is the one the user moved to, else the
  // selected item, else the first row that can be picked.
  const active =
    enabled.find((entry) => entry.key === activeKey) ??
    (query ? undefined : enabled.find((entry) => entry.item.id === selectedId)) ??
    enabled[0];

  useEffect(() => {
    if (!open || !active) return;
    document.getElementById(active.domId)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function choose(id: string) {
    onSelect(id);
    onClose();
  }

  function move(step: 1 | -1) {
    if (enabled.length === 0) return;
    const at = active ? enabled.indexOf(active) : -1;
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (next) setActiveKey(next.key);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter" && active) {
      event.preventDefault();
      if (event.shiftKey && onToggleFavorite) onToggleFavorite(active.item.id);
      else choose(active.item.id);
    }
  }

  const showTitles = sections.length > 1;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent
        aria-describedby={hintId}
        className="flex max-h-[86vh] flex-col overflow-hidden px-0 pb-0 pt-3"
        onEscapeKeyDown={(event) => {
          if (query) {
            event.preventDefault();
            setQuery("");
            setActiveKey(null);
          }
        }}
      >
        <div className="px-4">
          <DialogTitle className="text-[15px]">{title}</DialogTitle>
          <SearchField
            className="mt-3"
            value={query}
            onValueChange={(value) => {
              setQuery(value);
              setActiveKey(null);
            }}
            placeholder={searchPlaceholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active?.domId}
            aria-describedby={hintId}
            onKeyDown={onKeyDown}
          />
        </div>

        <div
          id={listId}
          role="listbox"
          aria-label={title}
          className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-2"
        >
          {loading && items.length === 0 ? (
            <div className="flex flex-col gap-2 px-2 py-2" aria-busy="true">
              {[0, 1, 2, 3].map((row) => (
                <div key={row} className="flex items-center gap-2.5 py-1.5">
                  <Skeleton className="size-7 shrink-0 rounded-full" />
                  <div className="flex flex-1 flex-col gap-1.5">
                    <Skeleton className="h-2.5 w-2/5" />
                    <Skeleton className="h-2 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : entries.length === 0 ? (
            <p className="px-3 py-8 text-center text-[12px] leading-relaxed text-fg-muted">
              {query ? `Nothing matches "${query.trim()}".` : emptyLabel}
            </p>
          ) : (
            sections.map((section) =>
              section.items.length === 0 ? null : (
                <div
                  key={section.key}
                  role="group"
                  aria-label={section.title || title}
                  className="pt-1"
                >
                  {showTitles && section.title ? (
                    <p
                      aria-hidden
                      className="px-2 pb-1 pt-2 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim"
                    >
                      {section.title}
                    </p>
                  ) : null}
                  {section.items.map((item) => {
                    const entry = entryByKey.get(`${section.key}:${item.id}`);
                    if (!entry) return null;
                    const isActive = entry.key === active?.key;
                    const isSelected = item.id === selectedId;
                    const isFavorite = favoriteSet.has(item.id);
                    // A disabled row dims its logo, label and balance. Its
                    // sublabel stays readable (it tells one token on two chains
                    // apart), and so does the reason it is off.
                    const dim = item.disabled ? "opacity-50" : undefined;
                    return (
                      <div key={entry.key} role="presentation" className="flex items-center">
                        <button
                          type="button"
                          id={entry.domId}
                          role="option"
                          tabIndex={-1}
                          aria-selected={isSelected}
                          aria-disabled={item.disabled || undefined}
                          onMouseDown={(event) => event.preventDefault()}
                          onMouseMove={() => {
                            if (!item.disabled && !isActive) setActiveKey(entry.key);
                          }}
                          onClick={() => {
                            if (!item.disabled) choose(item.id);
                          }}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] px-2 py-2 text-left",
                            "transition-colors duration-[var(--z-duration-fast)]",
                            isActive && "bg-[var(--z-state-hover)]",
                            isSelected && "bg-[var(--z-state-selected)]",
                            item.disabled && "cursor-not-allowed",
                          )}
                        >
                          {item.icon ? <span className={cn("shrink-0", dim)}>{item.icon}</span> : null}
                          <span className="min-w-0 flex-1">
                            {/* Wrapped, never cut: the end of a label is where a ticker keeps its suffix. */}
                            <span
                              className={cn(
                                "block min-w-0 text-[12.5px] font-medium leading-snug text-fg [overflow-wrap:anywhere]",
                                dim,
                              )}
                            >
                              {item.labelNode ?? item.label}
                            </span>
                            {item.sublabel ? (
                              <span className="mt-[2px] block font-mono text-[9.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">
                                {item.sublabel}
                              </span>
                            ) : null}
                            {item.disabled && item.disabledReason ? (
                              <span className="mt-1 block text-[10px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
                                {item.disabledReason}
                              </span>
                            ) : null}
                            {item.srNote ? <span className="sr-only">{item.srNote}</span> : null}
                          </span>
                          {item.trailing ? (
                            <span className={cn("shrink-0 text-right", dim)}>{item.trailing}</span>
                          ) : null}
                          {isSelected ? (
                            <IconCheck width={14} height={14} className="shrink-0 text-accent" />
                          ) : null}
                        </button>
                        {onToggleFavorite ? (
                          // Mouse shortcut only: keyboard and screen reader users
                          // toggle with Shift+Enter, described in the hint below.
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-hidden
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onToggleFavorite(item.id)}
                            className={cn(
                              "ml-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
                              "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)]",
                              isFavorite ? "text-[var(--z-warning)]" : "text-fg-dim",
                            )}
                          >
                            <IconStar filled={isFavorite} width={14} height={14} />
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ),
            )
          )}
        </div>

        {hiddenCount > 0 || searchOnlyCount > 0 ? (
          <p className="border-t border-[var(--z-line)] px-4 py-1.5 text-[10.5px] leading-snug text-fg-muted">
            {[
              hiddenCount > 0
                ? `${hiddenCount.toLocaleString()} more not shown. Search to find them.`
                : null,
              searchOnlyCount > 0 ? (searchOnlyNote ?? defaultSearchOnlyNote)(searchOnlyCount) : null,
            ]
              .filter(Boolean)
              .join(" ")}
          </p>
        ) : null}
        <p
          id={hintId}
          className="border-t border-[var(--z-line)] px-4 py-2 font-mono text-[9px] text-fg-dim"
        >
          Arrows to move, Enter to choose
          {onToggleFavorite ? ", Shift+Enter to favorite" : ""}, Esc to close.
        </p>
      </SheetContent>
    </Dialog>
  );
}

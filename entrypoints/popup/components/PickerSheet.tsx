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
  /** Replaces the sublabel while the item is disabled. */
  disabledReason?: string;
}

interface Entry {
  key: string;
  domId: string;
  item: PickerItem;
}

/**
 * Bottom sheet for choosing one item from a list: search box on top, then
 * Favorites, Recent, and All. The search box keeps focus the whole time; the
 * arrow keys move a highlight through the list (announced through
 * aria-activedescendant), Enter picks, Shift+Enter toggles a favorite, and
 * Escape clears the search before it closes the sheet.
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

  const sections = useMemo(
    () => pickerSections(items, { query, favorites, recents, allTitle }),
    [items, query, favorites, recents, allTitle],
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
                            item.disabled && "cursor-not-allowed opacity-50",
                          )}
                        >
                          {item.icon ? <span className="shrink-0">{item.icon}</span> : null}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[12.5px] font-medium text-fg">
                              {item.label}
                            </span>
                            {item.disabled && item.disabledReason ? (
                              <span className="mt-[2px] block truncate text-[10px] text-fg-muted">
                                {item.disabledReason}
                              </span>
                            ) : item.sublabel ? (
                              <span className="mt-[2px] block truncate font-mono text-[9.5px] text-fg-dim">
                                {item.sublabel}
                              </span>
                            ) : null}
                          </span>
                          {item.trailing ? (
                            <span className="shrink-0 text-right">{item.trailing}</span>
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

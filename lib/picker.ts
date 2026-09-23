/**
 * Search, favorites, and recents for the popup's pickers (chains, tokens,
 * contacts). Pure so the ranking and the memory rules can be tested directly.
 */

export interface PickerMemory {
  favorites: string[];
  recents: string[];
}

export const EMPTY_PICKER_MEMORY: PickerMemory = { favorites: [], recents: [] };

export const MAX_RECENTS = 5;
const MAX_FAVORITES = 24;

function idList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry && !out.includes(entry)) out.push(entry);
    if (out.length >= max) break;
  }
  return out;
}

/** Stored memory for every picker, tolerant of anything malformed. */
export function readPickerMemory(value: unknown): Record<string, PickerMemory> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, PickerMemory> = {};
  for (const [kind, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = (raw ?? {}) as Partial<Record<keyof PickerMemory, unknown>>;
    out[kind] = {
      favorites: idList(entry.favorites, MAX_FAVORITES),
      recents: idList(entry.recents, MAX_RECENTS),
    };
  }
  return out;
}

export function rememberRecent(memory: PickerMemory, id: string): PickerMemory {
  return {
    ...memory,
    recents: [id, ...memory.recents.filter((entry) => entry !== id)].slice(0, MAX_RECENTS),
  };
}

export function toggleFavorite(memory: PickerMemory, id: string): PickerMemory {
  const favorites = memory.favorites.includes(id)
    ? memory.favorites.filter((entry) => entry !== id)
    : [...memory.favorites, id].slice(-MAX_FAVORITES);
  return { ...memory, favorites };
}

export interface Searchable {
  id: string;
  label: string;
  sublabel?: string;
  keywords?: readonly string[];
}

function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

/**
 * Items matching every word of the query, best matches first: the label
 * starting with the query, then any field starting with it, then the rest.
 * Order is otherwise kept, so an unranked list stays in its given order.
 */
export function searchItems<T extends Searchable>(items: readonly T[], query: string): T[] {
  const q = normalize(query);
  if (!q) return [...items];
  const terms = q.split(/\s+/);
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    const label = normalize(item.label);
    const fields = [label, normalize(item.sublabel ?? ""), ...(item.keywords ?? []).map(normalize)];
    const haystack = fields.join(" ");
    if (!terms.every((term) => haystack.includes(term))) return;
    const score = label.startsWith(q) ? 0 : fields.some((f) => f.startsWith(q)) ? 1 : 2;
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

export interface PickerSection<T> {
  key: "results" | "favorites" | "recents" | "all";
  title: string;
  items: T[];
}

/**
 * What the picker lists. With a query, one ranked list of matches. Without,
 * Favorites and Recent first (in the order the user built them), then every
 * item. Ids no longer in `items` are skipped rather than shown as blanks.
 */
export function pickerSections<T extends Searchable>(
  items: readonly T[],
  options: {
    query: string;
    favorites?: readonly string[];
    recents?: readonly string[];
    /** Heading of the full list when other sections precede it. */
    allTitle?: string;
  },
): PickerSection<T>[] {
  if (normalize(options.query)) {
    return [{ key: "results", title: "Results", items: searchItems(items, options.query) }];
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const pick = (ids: readonly string[] | undefined) =>
    (ids ?? []).map((id) => byId.get(id)).filter((item): item is T => item !== undefined);
  const favorites = pick(options.favorites);
  const favoriteIds = new Set(favorites.map((item) => item.id));
  const recents = pick(options.recents).filter((item) => !favoriteIds.has(item.id));
  const sections: PickerSection<T>[] = [];
  if (favorites.length) sections.push({ key: "favorites", title: "Favorites", items: favorites });
  if (recents.length) sections.push({ key: "recents", title: "Recent", items: recents });
  sections.push({
    key: "all",
    title: sections.length ? (options.allTitle ?? "All") : "",
    items: [...items],
  });
  return sections;
}

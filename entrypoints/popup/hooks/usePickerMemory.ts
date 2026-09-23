import { useCallback, useEffect, useState } from "react";
import {
  EMPTY_PICKER_MEMORY,
  readPickerMemory,
  rememberRecent,
  toggleFavorite,
  type PickerMemory,
} from "../../../lib/picker";
import { STORAGE_KEYS } from "../../../lib/storage-keys";

export type PickerKind = "chain" | "token";

/**
 * Favorites and recent picks for one kind of picker, kept in local storage so
 * they survive the popup closing. Every picker of the same kind shares them.
 */
export function usePickerMemory(kind: PickerKind) {
  const [memory, setMemory] = useState<PickerMemory>(EMPTY_PICKER_MEMORY);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      browser.storage.local.get(STORAGE_KEYS.pickerMemory).then((result) => {
        if (cancelled) return;
        setMemory(
          readPickerMemory(result[STORAGE_KEYS.pickerMemory])[kind] ?? EMPTY_PICKER_MEMORY,
        );
      });
    void load();
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === "local" && STORAGE_KEYS.pickerMemory in changes) void load();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      browser.storage.onChanged.removeListener(onChanged);
    };
  }, [kind]);

  const update = useCallback(
    async (change: (current: PickerMemory) => PickerMemory) => {
      const result = await browser.storage.local.get(STORAGE_KEYS.pickerMemory);
      const all = readPickerMemory(result[STORAGE_KEYS.pickerMemory]);
      const next = change(all[kind] ?? EMPTY_PICKER_MEMORY);
      await browser.storage.local.set({
        [STORAGE_KEYS.pickerMemory]: { ...all, [kind]: next },
      });
    },
    [kind],
  );

  const remember = useCallback(
    (id: string) => void update((current) => rememberRecent(current, id)),
    [update],
  );
  const toggle = useCallback(
    (id: string) => void update((current) => toggleFavorite(current, id)),
    [update],
  );

  return {
    favorites: memory.favorites,
    recents: memory.recents,
    remember,
    toggleFavorite: toggle,
  };
}

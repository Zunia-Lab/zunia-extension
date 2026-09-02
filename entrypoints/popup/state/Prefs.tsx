import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  type ReactNode,
} from "react";
import { useTheme } from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import {
  DEFAULT_SETTINGS,
  type ExtensionSettings,
} from "../../../lib/settings";
import { formatFiat, maskAmount } from "../../../lib/format";

interface PrefsValue {
  settings: ExtensionSettings;
  update: (patch: Partial<ExtensionSettings>) => Promise<void>;
  /** True when the user turned amounts off. */
  hidden: boolean;
  toggleHidden: () => void;
  /** Wrap any rendered amount so the privacy toggle applies everywhere. */
  mask: (value: string) => string;
  fiat: (value: number) => string;
}

const PrefsContext = createContext<PrefsValue | null>(null);

export function PrefsProvider({
  settings,
  onChanged,
  children,
}: {
  settings: ExtensionSettings | null;
  onChanged: () => void;
  children: ReactNode;
}) {
  const resolved = settings ?? DEFAULT_SETTINGS;
  const { theme, setTheme } = useTheme();

  // Stored settings are the source of truth; ThemeProvider's own localStorage
  // copy only exists to avoid a flash before those settings load.
  useEffect(() => {
    if (settings && settings.theme !== theme) setTheme(settings.theme);
  }, [settings, theme, setTheme]);

  const update = useCallback(
    async (patch: Partial<ExtensionSettings>) => {
      await sendToBackground<ExtensionSettings>("SET_SETTINGS", patch);
      if (patch.theme) setTheme(patch.theme === "system" ? "system" : patch.theme);
      onChanged();
    },
    [onChanged, setTheme],
  );

  const value = useMemo<PrefsValue>(
    () => ({
      settings: resolved,
      update,
      hidden: resolved.hideBalances,
      toggleHidden: () => void update({ hideBalances: !resolved.hideBalances }),
      mask: (v: string) => maskAmount(v, resolved.hideBalances),
      fiat: (v: number) =>
        maskAmount(formatFiat(v, resolved.currency), resolved.hideBalances),
    }),
    [resolved, update],
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): PrefsValue {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error("usePrefs must be used inside PrefsProvider");
  return ctx;
}

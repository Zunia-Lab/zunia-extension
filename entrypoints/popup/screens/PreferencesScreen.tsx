import { useEffect, useState } from "react";
import {
  Callout,
  ScreenScaffold,
  Segmented,
} from "@zunialab/ui";
import {
  CURRENCIES,
  INERT_SETTINGS,
  type CurrencyCode,
} from "../../../lib/settings";
import {
  dropLiveBalancePermission,
  hasLiveBalancePermission,
  liveBalanceRefusalNote,
  requestLiveBalancePermission,
} from "../../../lib/balances";
import {
  SettingsGroup,
  SettingsToggle,
  SettingsValue,
} from "../components/SettingsList";
import { useBrowserAlerts } from "../hooks/useBrowserAlerts";
import { usePrefs } from "../state/Prefs";

export function PreferencesScreen({ onBack }: { onBack: () => void }) {
  const { settings, update, hidden, toggleHidden } = usePrefs();
  const alerts = useBrowserAlerts();
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the Live balances switch shows. The setting alone is on by default
  // before any host access is granted, so the artwork switch below reads this
  // too, or it would sit enabled under a Live balances switch that is off.
  const liveOn = settings.liveBalances && granted;

  useEffect(() => {
    void hasLiveBalancePermission().then(setGranted);
  }, []);

  async function toggleLiveBalances(next: boolean) {
    setError(null);
    if (!next) {
      await update({ liveBalances: false });
      await dropLiveBalancePermission();
      setGranted(false);
      return;
    }
    const ok = await requestLiveBalancePermission();
    if (!ok) {
      setError(liveBalanceRefusalNote());
      return;
    }
    setGranted(true);
    await update({ liveBalances: true });
  }

  return (
    <ScreenScaffold title="Preferences" onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        {error ? <Callout tone="warning">{error}</Callout> : null}

        <SettingsGroup label="Appearance">
          <SettingsValue title="Theme">
            <Segmented
              size="sm"
              value={settings.theme}
              onChange={(theme) => void update({ theme })}
              options={[
                { value: "dark", label: "Dark" },
                { value: "light", label: "Light" },
                { value: "system", label: "System" },
              ]}
            />
          </SettingsValue>
          <SettingsValue title="Currency">
            <Segmented
              size="sm"
              value={settings.currency}
              onChange={(currency) =>
                void update({ currency: currency as CurrencyCode })
              }
              options={CURRENCIES.map((code) => ({
                value: code,
                label: code,
              }))}
            />
          </SettingsValue>
        </SettingsGroup>

        <SettingsGroup label="Privacy">
          <SettingsToggle
            title="Hide amounts"
            description="Replace every balance with dots until you toggle it back."
            checked={hidden}
            onCheckedChange={toggleHidden}
          />
          <SettingsToggle
            title="Anonymous diagnostics"
            description={
              INERT_SETTINGS.diagnostics ??
              "Crash counts only. Never addresses, balances, or phrases."
            }
            checked={INERT_SETTINGS.diagnostics ? false : settings.diagnostics}
            disabled={Boolean(INERT_SETTINGS.diagnostics)}
            onCheckedChange={(diagnostics) => void update({ diagnostics })}
          />
        </SettingsGroup>

        <SettingsGroup label="Data">
          <SettingsToggle
            title="Live balances"
            description="Read balances from each chain's public endpoint, once you allow the wallet to reach them."
            checked={liveOn}
            onCheckedChange={(next) => void toggleLiveBalances(next)}
          />
          <SettingsToggle
            title="Load artwork and off-chain details"
            description={liveOn ? undefined : "Turn on live balances first."}
            checked={settings.nftMedia && liveOn}
            disabled={!liveOn}
            onCheckedChange={(nftMedia) => void update({ nftMedia })}
          />
          <SettingsToggle
            title="Browser alerts"
            description={alerts.description}
            checked={alerts.checked}
            disabled={alerts.disabled}
            onCheckedChange={(next) => void alerts.toggle(next)}
          />
        </SettingsGroup>
      </div>
    </ScreenScaffold>
  );
}

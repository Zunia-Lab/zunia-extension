import { useEffect, useState } from "react";
import { Callout, ScreenScaffold, Segmented } from "@zunialab/ui";
import { CURRENCIES, type CurrencyCode } from "../../../lib/settings";
import {
  dropLiveBalancePermission,
  hasLiveBalancePermission,
  requestLiveBalancePermission,
} from "../../../lib/balances";
import {
  SettingsGroup,
  SettingsToggle,
  SettingsValue,
} from "../components/SettingsList";
import { usePrefs } from "../state/Prefs";

export function PreferencesScreen({ onBack }: { onBack: () => void }) {
  const { settings, update, hidden, toggleHidden } = usePrefs();
  const [granted, setGranted] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    const ok = (await hasLiveBalancePermission())
      ? true
      : await requestLiveBalancePermission();
    if (!ok) {
      setError("Permission denied, so balances stay hidden.");
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
            description="Crash counts only. Never addresses, balances, or phrases."
            checked={settings.diagnostics}
            onCheckedChange={(diagnostics) => void update({ diagnostics })}
          />
        </SettingsGroup>

        <SettingsGroup label="Data">
          <SettingsToggle
            title="Live balances"
            description="Read balances from each chain's public endpoint. Asks for host access the first time."
            checked={settings.liveBalances && granted}
            onCheckedChange={(next) => void toggleLiveBalances(next)}
          />
          <SettingsToggle
            title="Browser alerts"
            description="Notify on transfers and governance deadlines."
            checked={settings.browserAlerts}
            onCheckedChange={(browserAlerts) => void update({ browserAlerts })}
          />
        </SettingsGroup>

        <Callout tone="neutral" title="Reads stay optional">
          Live balances contact only the REST hosts listed in the chain
          registry. You can turn them off here at any time.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

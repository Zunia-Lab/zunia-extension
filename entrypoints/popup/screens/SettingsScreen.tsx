import { Button, ScreenScaffold, truncateAddress } from "@zunialab/ui";
import type { OriginGrant } from "../../../lib/permissions";
import type { SessionStatus } from "../../../lib/session";
import { sendToBackground } from "../../../lib/popup-client";
import { SettingsGroup, SettingsLink } from "../components/SettingsList";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import { IconLock, IconShield } from "./icons";

const NOTIFY_LABELS: Record<string, string> = {
  once: "rewards once",
  daily: "rewards daily",
  weekly: "rewards weekly",
  off: "rewards off",
};

const LOCK_LABELS: Record<number, string> = {
  60_000: "1 min",
  300_000: "5 min",
  600_000: "10 min",
  1_800_000: "30 min",
  3_600_000: "60 min",
};

/** The version the browser installed, so the label cannot drift from a release. */
function manifestVersion(): string | null {
  try {
    return browser.runtime.getManifest().version;
  } catch {
    return null;
  }
}

const BROWSER_NAMES: Record<string, string> = {
  chrome: "Chrome",
  firefox: "Firefox",
  safari: "Safari",
  edge: "Edge",
};

/** Which build this is: worth saying when someone reports a problem. */
const BUILD_NAME = BROWSER_NAMES[import.meta.env.BROWSER] ?? "browser";

/** Settings hub. Each group links to a focused screen instead of one long list. */
export function SettingsScreen({
  status,
  grants,
  contactCount,
  onBack,
  onNavigate,
  onRefresh,
}: {
  status: SessionStatus;
  grants: OriginGrant[];
  contactCount: number;
  onBack: () => void;
  onNavigate: (route: PopupRoute) => void;
  onRefresh: () => void;
}) {
  const { settings } = usePrefs();
  const active =
    status.accounts.find((a) => a.index === status.activeAccountIndex) ??
    status.accounts[0];
  const version = manifestVersion();

  return (
    <ScreenScaffold
      title="Settings"
      onBack={onBack}
      footer={
        <div className="flex flex-col gap-2">
          <Button
            variant="secondary"
            className="w-full"
            onClick={() => {
              void sendToBackground("LOCK").then(onRefresh);
            }}
          >
            <IconLock width={16} height={16} />
            Lock wallet
          </Button>
          {version ? (
            <p
              className="text-center font-mono text-[10px] tracking-[0.06em] text-fg-dim"
              aria-label={`Zunia version ${version} for ${BUILD_NAME}`}
            >
              Zunia <span className="text-fg-muted">v{version}</span> · {BUILD_NAME}
            </p>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <SettingsGroup label="Wallet">
          <SettingsLink
            title="Accounts"
            description={
              active
                ? `${active.name} · ${truncateAddress(active.address, 8, 6)}`
                : undefined
            }
            meta={`${status.accounts.length}`}
            onClick={() => onNavigate("wallets")}
          />
          <SettingsLink
            title="Networks"
            description="Choose which chains appear in the wallet"
            onClick={() => onNavigate("networks")}
          />
          <SettingsLink
            title="Address book"
            description="Saved recipients for the send flow"
            meta={contactCount > 0 ? String(contactCount) : undefined}
            onClick={() => onNavigate("address-book")}
          />
        </SettingsGroup>

        <SettingsGroup label="Security">
          <SettingsLink
            title="Security"
            description="Auto-lock, signing rules, recovery phrase"
            meta={LOCK_LABELS[settings.autoLockMs] ?? "custom"}
            onClick={() => onNavigate("security")}
          />
          <SettingsLink
            title="Connected dApps"
            description={`${grants.length} connected ${grants.length === 1 ? "site" : "sites"}`}
            onClick={() => onNavigate("sites")}
          />
        </SettingsGroup>

        <SettingsGroup label="App">
          <SettingsLink
            title="Preferences"
            description="Theme, currency, privacy, live balances"
            meta={settings.theme}
            onClick={() => onNavigate("preferences")}
          />
          <SettingsLink
            title="Notifications"
            description="Which notifications show, and reward reminders"
            meta={NOTIFY_LABELS[settings.notify.rewards]}
            onClick={() => onNavigate("notification-settings")}
          />
        </SettingsGroup>

        <div className="flex items-center justify-center gap-2 pb-1 font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
          <IconShield width={16} height={16} />
          Local keys · Apache 2.0
        </div>
      </div>
    </ScreenScaffold>
  );
}

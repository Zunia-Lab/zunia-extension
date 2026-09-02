import { useState } from "react";
import {
  Button,
  Callout,
  Input,
  PasswordInput,
  ScreenScaffold,
  Segmented,
} from "@zunialab/ui";
import { sendToBackground } from "../../../lib/popup-client";
import {
  SettingsGroup,
  SettingsLink,
  SettingsToggle,
  SettingsValue,
} from "../components/SettingsList";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";

const LOCK_OPTIONS = [
  { value: "60000", label: "1 min" },
  { value: "300000", label: "5 min" },
  { value: "600000", label: "10 min" },
  { value: "1800000", label: "30 min" },
];

const CONFIRM_WORD = "REMOVE";

function RemoveWallet({
  onCancel,
  onRemoved,
}: {
  onCancel: () => void;
  onRemoved: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await sendToBackground("RESET_WALLET", { password });
      onRemoved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-1">
      <Callout tone="danger" title="This erases the wallet from this browser">
        Only your recovery phrase can bring it back. Make sure it is written
        down before continuing.
      </Callout>
      <PasswordInput
        label="Password"
        placeholder="Password"
        value={password}
        autoFocus
        onChange={(e) => setPassword(e.target.value)}
      />
      <Input
        label={`Type ${CONFIRM_WORD} to confirm`}
        placeholder={CONFIRM_WORD}
        value={confirm}
        autoCapitalize="characters"
        onChange={(e) => setConfirm(e.target.value.toUpperCase())}
      />
      {error ? (
        <p className="text-[11.5px] text-[var(--z-danger-fg)]">{error}</p>
      ) : null}
      <div className="flex gap-2">
        <Button variant="secondary" className="flex-1" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant="danger"
          className="flex-1"
          loading={busy}
          disabled={!password || confirm !== CONFIRM_WORD}
          onClick={() => void remove()}
        >
          Remove
        </Button>
      </div>
    </div>
  );
}

export function SecurityScreen({
  autoLockMs,
  grantCount,
  onBack,
  onNavigate,
  onRemoved,
}: {
  autoLockMs: number;
  grantCount: number;
  onBack: () => void;
  onNavigate: (route: PopupRoute) => void;
  onRemoved: () => void;
}) {
  const { settings, update } = usePrefs();
  const [removing, setRemoving] = useState(false);

  if (removing) {
    return (
      <ScreenScaffold title="Remove wallet" onBack={() => setRemoving(false)}>
        <RemoveWallet
          onCancel={() => setRemoving(false)}
          onRemoved={onRemoved}
        />
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold title="Security" onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        <SettingsGroup label="Session">
          <SettingsValue title="Auto-lock">
            <Segmented
              size="sm"
              value={String(autoLockMs)}
              onChange={(value) => void update({ autoLockMs: Number(value) })}
              options={LOCK_OPTIONS}
            />
          </SettingsValue>
          <SettingsToggle
            title="Password on every signature"
            description="Ask again before signing, even while unlocked."
            checked={settings.requirePasswordOnSign}
            onCheckedChange={(requirePasswordOnSign) =>
              void update({ requirePasswordOnSign })
            }
          />
        </SettingsGroup>

        <p className="-mt-2 px-1 text-[10.5px] leading-[1.45] text-fg-dim">
          The session key is wiped after this much idle time, on browser close,
          and on device lock.
        </p>

        <SettingsGroup label="Signing">
          <SettingsToggle
            title="Blind signing"
            description="Allow approving message types Zunia cannot decode."
            checked={settings.blindSigning}
            onCheckedChange={(blindSigning) => void update({ blindSigning })}
          />
          <SettingsToggle
            title="Keplr alias"
            description="Expose window.keplr for dApps that only detect Keplr."
            checked={settings.exposeKeplrAlias}
            onCheckedChange={(exposeKeplrAlias) =>
              void update({ exposeKeplrAlias })
            }
          />
        </SettingsGroup>

        <SettingsGroup label="Keys">
          <SettingsLink
            title="Reveal recovery phrase"
            description="Password required"
            onClick={() => onNavigate("reveal")}
          />
          <SettingsLink
            title="Connected dApps"
            description={`${grantCount} active ${grantCount === 1 ? "grant" : "grants"}`}
            onClick={() => onNavigate("sites")}
          />
        </SettingsGroup>

        <SettingsGroup label="Danger zone">
          <SettingsLink
            title="Remove wallet from browser"
            description="Erases the sealed keyring, accounts, and every grant"
            danger
            onClick={() => setRemoving(true)}
          />
        </SettingsGroup>
      </div>
    </ScreenScaffold>
  );
}

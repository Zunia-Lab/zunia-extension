import { ScreenScaffold, Segmented } from "@zunialab/ui";
import type { NotifyPrefs, RewardReminder } from "../../../lib/settings";
import { SettingsGroup, SettingsToggle, SettingsValue } from "../components/SettingsList";
import { useBrowserAlerts } from "../hooks/useBrowserAlerts";
import { usePrefs } from "../state/Prefs";

const REWARD_REMINDERS: ReadonlyArray<{ value: RewardReminder; label: string }> = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "off", label: "Off" },
];

const REWARD_REMINDER_HINT: Record<RewardReminder, string> = {
  once: "One notification when rewards can be claimed. After you claim, the next one waits until a whole token is ready.",
  daily: "Reminds you once a day while rewards are waiting to be claimed.",
  weekly: "Reminds you once a week while rewards are waiting to be claimed.",
  off: "No notifications for staking rewards. Earn still shows what you can claim.",
};

/**
 * Settings → Notifications: which notifications show, how often reward
 * reminders come back, and browser alerts. The one place these preferences
 * live; the notification list links here.
 *
 * The defaults favour quiet (`DEFAULT_NOTIFY_PREFS` in lib/settings.ts):
 * tokens arriving and one staking-rewards notice per cycle are on; governance
 * deadlines and unbonding progress stay off until someone wants them.
 */
export function NotificationSettingsScreen({ onBack }: { onBack: () => void }) {
  const { settings, update } = usePrefs();
  const alerts = useBrowserAlerts();
  const prefs = settings.notify;
  const setPrefs = (patch: Partial<NotifyPrefs>) => void update({ notify: { ...prefs, ...patch } });

  return (
    <ScreenScaffold title="Notification settings" onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        <SettingsGroup label="Show">
          <SettingsToggle
            title="Transfers"
            description="Tokens arriving in this wallet."
            checked={prefs.transfers}
            onCheckedChange={(transfers) => setPrefs({ transfers })}
          />
          <SettingsValue title="Staking rewards" description={REWARD_REMINDER_HINT[prefs.rewards]}>
            <Segmented
              size="sm"
              value={prefs.rewards}
              onChange={(rewards) => setPrefs({ rewards: rewards as RewardReminder })}
              options={REWARD_REMINDERS.map((option) => ({ ...option }))}
            />
          </SettingsValue>
          <SettingsToggle
            title="Governance"
            description="Proposals still open for your vote, on every network you use."
            checked={prefs.governance}
            onCheckedChange={(governance) => setPrefs({ governance })}
          />
          <SettingsToggle
            title="Unbonding"
            description="Stake you are unbonding, with the days left until it is liquid."
            checked={prefs.unbonding}
            onCheckedChange={(unbonding) => setPrefs({ unbonding })}
          />
          <p className="px-3 pb-2.5 text-[10.5px] leading-[1.45] text-fg-dim">
            Approvals always show: a site is waiting on each one.
          </p>
        </SettingsGroup>

        <SettingsGroup label="Alerts">
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

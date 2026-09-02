import { Avatar, Drawer, Segmented, cn, focusRing, interactiveSurface, truncateAddress } from "@zunialab/ui";
import type { AccountInfo } from "../../../lib/session";
import { usePrefs } from "../state/Prefs";
import type { PopupRoute } from "../routes";
import {
  IconBell,
  IconBook,
  IconBridge,
  IconClose,
  IconEye,
  IconEyeOff,
  IconGlobe,
  IconGovernance,
  IconLock,
  IconSettings,
  IconShield,
} from "../screens/icons";

interface Item {
  route: PopupRoute;
  label: string;
  icon: React.ReactNode;
  meta?: string;
}

function Row({
  icon,
  label,
  meta,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[11px] px-2 py-2 text-left",
        interactiveSurface,
        focusRing,
      )}
    >
      <span className="flex size-[26px] shrink-0 items-center justify-center rounded-[9px] border border-[var(--z-line)] text-fg-muted">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg">
        {label}
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[9.5px] text-fg-dim">
          {meta}
        </span>
      ) : null}
    </button>
  );
}

/**
 * Secondary navigation. The tab bar owns the four daily destinations; this
 * drawer owns everything else so no screen is more than two taps away.
 */
export function MoreDrawer({
  open,
  onClose,
  account,
  networkCount,
  sessionCount,
  pendingCount,
  onNavigate,
  onLock,
}: {
  open: boolean;
  onClose: () => void;
  account?: AccountInfo;
  networkCount: number;
  sessionCount: number;
  pendingCount: number;
  onNavigate: (route: PopupRoute) => void;
  onLock: () => void;
}) {
  const { settings, update, hidden, toggleHidden } = usePrefs();

  const explore: Item[] = [
    {
      route: "networks",
      label: "Manage networks",
      icon: <IconGlobe width={16} height={16} />,
      meta: String(networkCount),
    },
    {
      route: "bridge",
      label: "Bridge",
      icon: <IconBridge width={16} height={16} />,
    },
    {
      route: "governance",
      label: "Governance",
      icon: <IconGovernance width={16} height={16} />,
    },
    {
      route: "notifications",
      label: "Notifications",
      icon: <IconBell width={16} height={16} />,
      meta: pendingCount > 0 ? String(pendingCount) : undefined,
    },
  ];

  const wallet: Item[] = [
    {
      route: "address-book",
      label: "Address book",
      icon: <IconBook width={16} height={16} />,
    },
    {
      route: "sites",
      label: "Connected dApps",
      icon: <IconShield width={16} height={16} />,
      meta: sessionCount > 0 ? String(sessionCount) : undefined,
    },
    {
      route: "settings",
      label: "Settings & security",
      icon: <IconSettings width={16} height={16} />,
    },
  ];

  return (
    <Drawer open={open} onClose={onClose}>
      <div className="flex items-start gap-2.5">
        <Avatar
          seed={account?.address ?? account?.name ?? "zunia"}
          fallback={account?.name ?? "Z"}
          size={30}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-fg">
            {account?.name ?? "Wallet"}
          </span>
          <span className="block truncate font-mono text-[9.5px] text-fg-dim">
            {account ? truncateAddress(account.address, 8, 6) : "—"}
          </span>
        </span>
        <button
          type="button"
          aria-label="Close menu"
          onClick={onClose}
          className={cn(
            "flex size-[26px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted",
            "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
            focusRing,
          )}
        >
          <IconClose width={16} height={16} />
        </button>
      </div>

      <button
        type="button"
        onClick={toggleHidden}
        className={cn(
          "mt-3.5 flex w-full items-center gap-2 rounded-[11px] border border-[var(--z-line)] px-2.5 py-2 text-left",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        {hidden ? (
          <IconEyeOff width={16} height={16} className="text-fg-muted" />
        ) : (
          <IconEye width={16} height={16} className="text-fg-muted" />
        )}
        <span className="flex-1 text-[12px] text-fg">
          {hidden ? "Amounts hidden" : "Amounts visible"}
        </span>
      </button>

      <p className="mt-4 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        Explore
      </p>
      <div className="mt-1 flex flex-col">
        {explore.map((item) => (
          <Row
            key={item.route}
            icon={item.icon}
            label={item.label}
            meta={item.meta}
            onClick={() => {
              onNavigate(item.route);
              onClose();
            }}
          />
        ))}
      </div>

      <p className="mt-4 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        Wallet
      </p>
      <div className="mt-1 flex flex-col">
        {wallet.map((item) => (
          <Row
            key={item.route}
            icon={item.icon}
            label={item.label}
            meta={item.meta}
            onClick={() => {
              onNavigate(item.route);
              onClose();
            }}
          />
        ))}
        <Row
          icon={<IconLock width={16} height={16} />}
          label="Lock wallet"
          onClick={() => {
            onLock();
            onClose();
          }}
        />
      </div>

      <p className="mt-4 px-2 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        Theme
      </p>
      <div className="mt-1.5 px-2">
        <Segmented
          size="sm"
          value={settings.theme}
          onChange={(theme) => void update({ theme })}
          options={[
            { value: "dark", label: "Dark" },
            { value: "light", label: "Light" },
            { value: "system", label: "Auto" },
          ]}
        />
      </div>
    </Drawer>
  );
}

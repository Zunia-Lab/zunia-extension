import { useState } from "react";
import { Avatar, cn, focusRing } from "@zunialab/ui";
import type { AccountInfo } from "../../../lib/session";
import { AccountSwitcherSheet } from "./AccountSwitcherSheet";
import {
  IconBell,
  IconChevronDown,
  IconMenu,
} from "../screens/icons";

function HeaderIconButton({
  label,
  badge,
  onClick,
  children,
}: {
  label: string;
  badge?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "relative flex size-[28px] items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
        focusRing,
      )}
    >
      {children}
      {badge ? (
        <span className="absolute -right-px -top-px size-[7px] rounded-full bg-accent ring-2 ring-[var(--z-bg)]" />
      ) : null}
    </button>
  );
}

/**
 * Persistent popup header: account switcher sheet, network pill, alerts, menu.
 */
export function PopupHeader({
  accounts,
  activeIndex,
  networkLabel,
  networkCount,
  pendingCount,
  onSelectAccount,
  onAddAccount,
  onManageWallets,
  onNetworks,
  onNotifications,
  onMenu,
}: {
  accounts: AccountInfo[];
  activeIndex: number;
  networkLabel: string;
  networkCount: number;
  pendingCount: number;
  onSelectAccount: (index: number) => void;
  onAddAccount: () => void;
  onManageWallets: () => void;
  onNetworks: () => void;
  onNotifications: () => void;
  onMenu: () => void;
}) {
  const [open, setOpen] = useState(false);
  const active = accounts.find((a) => a.index === activeIndex) ?? accounts[0];

  return (
    <div className="border-b border-[var(--z-line)] bg-[color-mix(in_srgb,var(--z-bg)_86%,transparent)] backdrop-blur-[12px]">
      <div className="flex items-center gap-2 px-4 py-2.5">
        <button
          type="button"
          aria-label="Switch account"
          onClick={() => setOpen(true)}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-1 pr-2.5",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <Avatar
            seed={active?.address ?? active?.name ?? "zunia"}
            fallback={active?.name ?? "Z"}
            size={22}
          />
          <span className="min-w-0 truncate text-[12px] font-medium text-fg">
            {active?.name ?? "Wallet"}
          </span>
          <IconChevronDown
            width={16}
            height={16}
            className={cn(
              "shrink-0 text-fg-dim transition-transform duration-[var(--z-duration-base)]",
              open && "rotate-180",
            )}
          />
        </button>

        <button
          type="button"
          onClick={onNetworks}
          className={cn(
            "ml-auto flex max-w-[120px] items-center gap-1 rounded-full border border-[var(--z-line)] px-2.5 py-1",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <span className="truncate text-[11px] font-medium text-fg">
            {networkLabel}
          </span>
          <span className="font-mono text-[9px] text-fg-dim">{networkCount}</span>
        </button>

        <HeaderIconButton
          label="Notifications"
          badge={pendingCount > 0}
          onClick={onNotifications}
        >
          <IconBell width={14} height={14} />
        </HeaderIconButton>
        <HeaderIconButton label="Menu" onClick={onMenu}>
          <IconMenu width={14} height={14} />
        </HeaderIconButton>
      </div>

      <AccountSwitcherSheet
        open={open}
        onOpenChange={setOpen}
        accounts={accounts}
        activeIndex={activeIndex}
        onSelect={onSelectAccount}
        onAdd={onAddAccount}
        onManage={onManageWallets}
      />
    </div>
  );
}

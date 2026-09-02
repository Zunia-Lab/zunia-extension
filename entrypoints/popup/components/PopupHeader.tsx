import { useState } from "react";
import {
  Avatar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { AccountInfo } from "../../../lib/session";
import {
  IconBell,
  IconCheck,
  IconChevronDown,
  IconMenu,
  IconPlus,
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
 * Persistent popup header: account switcher, network pill, alerts, menu.
 * The switcher is a floating popover so opening it never reflows the page
 * underneath.
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
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              aria-label="Switch account"
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
          </PopoverTrigger>

          <PopoverContent
            align="start"
            sideOffset={8}
            className="z-50 w-[236px] p-1.5"
          >
            <p className="px-2 pb-1.5 pt-1 font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">
              Accounts
            </p>
            <ul className="flex max-h-[196px] flex-col overflow-y-auto">
              {accounts.map((account) => {
                const selected = account.index === activeIndex;
                return (
                  <li key={account.index}>
                    <button
                      type="button"
                      onClick={() => {
                        onSelectAccount(account.index);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left",
                        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
                        selected && "bg-[var(--z-state-selected)]",
                        focusRing,
                      )}
                    >
                      <Avatar
                        seed={account.address}
                        fallback={account.name}
                        size={24}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-fg">
                          {account.name}
                        </span>
                        <span className="block truncate font-mono text-[9.5px] text-fg-dim">
                          {truncateAddress(account.address, 8, 6)}
                        </span>
                      </span>
                      {selected ? (
                        <IconCheck
                          width={16}
                          height={16}
                          className="shrink-0 text-accent"
                        />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>

            <div className="mt-1 flex gap-1 border-t border-[var(--z-line)] pt-1.5">
              <button
                type="button"
                onClick={() => {
                  onAddAccount();
                  setOpen(false);
                }}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1.5 rounded-[10px] px-2 py-1.5 text-[11px] text-fg-muted",
                  "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                  focusRing,
                )}
              >
                <IconPlus width={16} height={16} />
                Add account
              </button>
              <button
                type="button"
                onClick={() => {
                  onManageWallets();
                  setOpen(false);
                }}
                className={cn(
                  "flex flex-1 items-center justify-center rounded-[10px] px-2 py-1.5 text-[11px] text-fg-muted",
                  "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                  focusRing,
                )}
              >
                Manage
              </button>
            </div>
          </PopoverContent>
        </Popover>

        <button
          type="button"
          onClick={onNetworks}
          className={cn(
            "flex min-w-0 items-center rounded-full border border-[var(--z-line)] px-2.5 py-1 text-[11px] text-fg-muted",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)] hover:text-fg",
            focusRing,
          )}
        >
          <span className="mr-1.5 size-[6px] shrink-0 rounded-full bg-[var(--z-success)]" />
          <span className="truncate">{networkLabel}</span>
          {networkCount > 1 ? (
            <span className="ml-1.5 shrink-0 text-fg-dim">
              +{networkCount - 1}
            </span>
          ) : null}
        </button>

        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <HeaderIconButton
            label="Notifications"
            badge={pendingCount > 0}
            onClick={onNotifications}
          >
            <IconBell width={16} height={16} />
          </HeaderIconButton>
          <HeaderIconButton label="Menu" onClick={onMenu}>
            <IconMenu width={16} height={16} />
          </HeaderIconButton>
        </span>
      </div>
    </div>
  );
}

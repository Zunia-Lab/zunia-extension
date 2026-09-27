"use client";

import {
  Avatar,
  Dialog,
  DialogDescription,
  DialogTitle,
  SheetContent,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import { avatarSeedOf, type AccountInfo } from "../../../lib/session";

/** Quick account switcher sheet for the popup home header. */
export function AccountSwitcherSheet({
  open,
  onOpenChange,
  accounts,
  activeIndex,
  onSelect,
  onAdd,
  onManage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: AccountInfo[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onAdd?: () => void;
  onManage?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle className="text-[15px] font-medium tracking-tight">
          Accounts
        </DialogTitle>
        <DialogDescription className="sr-only">
          Switch the active wallet account
        </DialogDescription>
        <ul className="mt-3 flex flex-col gap-1.5">
          {accounts.map((account) => {
            const selected = account.index === activeIndex;
            return (
              <li key={account.index}>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(account.index);
                    onOpenChange(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-[10px] border px-2.5 py-2 text-left",
                    selected
                      ? "border-[color-mix(in_srgb,var(--z-accent)_50%,transparent)] bg-[var(--z-state-selected)]"
                      : "border-[var(--z-line)] hover:bg-[var(--z-state-hover)]",
                    focusRing,
                  )}
                >
                  <Avatar
                    seed={avatarSeedOf(account)}
                    fallback={account.name}
                    size={26}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium leading-none text-fg">
                      {account.name}
                    </span>
                    <span className="mt-1 block truncate font-mono text-[9.5px] text-fg-dim">
                      {truncateAddress(account.address || `account-${account.index}`, 10, 6)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {onAdd ? (
          <button
            type="button"
            className={cn(
              "mt-3 w-full rounded-[10px] border border-[var(--z-line)] py-2 text-center text-[12.5px] font-medium text-fg",
              "hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
            onClick={() => {
              onAdd();
              onOpenChange(false);
            }}
          >
            Add account
          </button>
        ) : null}
        {onManage ? (
          <button
            type="button"
            className={cn(
              "mt-2 w-full rounded-[10px] py-1.5 text-center font-mono text-[11px] text-fg-dim",
              "hover:text-fg",
              focusRing,
            )}
            onClick={() => {
              onManage();
              onOpenChange(false);
            }}
          >
            Manage accounts
          </button>
        ) : null}
      </SheetContent>
    </Dialog>
  );
}

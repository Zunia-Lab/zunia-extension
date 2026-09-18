"use client";

import {
  AccountSwitcher,
  Dialog,
  DialogDescription,
  DialogTitle,
  SheetContent,
} from "@zunialab/ui";
import type { AccountInfo } from "../../../lib/session";

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
  const active = accounts.find((a) => a.index === activeIndex);
  const rows = accounts.map((a) => ({
    address: a.address || `account-${a.index}`,
    name: a.name,
  }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <SheetContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle className="sr-only">Accounts</DialogTitle>
        <DialogDescription className="sr-only">
          Switch the active wallet account
        </DialogDescription>
        <AccountSwitcher
          accounts={rows}
          activeAddress={active?.address || `account-${activeIndex}`}
          onSelect={(address) => {
            const match = accounts.find(
              (a) => (a.address || `account-${a.index}`) === address,
            );
            if (match) onSelect(match.index);
            onOpenChange(false);
          }}
          onAdd={
            onAdd
              ? () => {
                  onAdd();
                  onOpenChange(false);
                }
              : undefined
          }
        />
        {onManage ? (
          <button
            type="button"
            className="mt-3 w-full text-center font-mono text-[11px] text-fg-dim"
            onClick={() => {
              onManage();
              onOpenChange(false);
            }}
          >
            Manage wallets
          </button>
        ) : null}
      </SheetContent>
    </Dialog>
  );
}

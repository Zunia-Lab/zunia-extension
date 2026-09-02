import type { ReactNode } from "react";
import { Switch, cn, focusRing, interactiveSurface } from "@zunialab/ui";
import { IconChevronRight } from "../screens/icons";

export function SettingsGroup({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <p className="px-1 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
        {label}
      </p>
      <div className="mt-1.5 divide-y divide-[var(--z-line)] rounded-[14px] border border-[var(--z-line)]">
        {children}
      </div>
    </section>
  );
}

export function SettingsToggle({
  title,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  title: string;
  description?: string;
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-3 px-3 py-2.5",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] text-fg">{title}</span>
        {description ? (
          <span className="mt-[3px] block text-[10.5px] leading-[1.45] text-fg-dim">
            {description}
          </span>
        ) : null}
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
      />
    </label>
  );
}

export function SettingsLink({
  title,
  description,
  meta,
  danger,
  onClick,
}: {
  title: string;
  description?: string;
  meta?: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-2.5 text-left",
        interactiveSurface,
        "first:rounded-t-[14px] last:rounded-b-[14px]",
        focusRing,
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-[12.5px]",
            danger ? "text-[var(--z-danger-fg)]" : "text-fg",
          )}
        >
          {title}
        </span>
        {description ? (
          <span className="mt-[3px] block text-[10.5px] leading-[1.45] text-fg-dim">
            {description}
          </span>
        ) : null}
      </span>
      {meta ? (
        <span className="shrink-0 font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-dim">
          {meta}
        </span>
      ) : null}
      <IconChevronRight
        width={16}
        height={16}
        className="shrink-0 text-fg-dim"
      />
    </button>
  );
}

export function SettingsValue({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <span className="text-[12.5px] text-fg">{title}</span>
      {children}
    </div>
  );
}

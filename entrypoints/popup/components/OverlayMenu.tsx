import type { ReactNode } from "react";
import { cn, focusRing } from "@zunialab/ui";

/**
 * Floating menu that overlays content instead of expanding the document flow.
 * Matches EarnScreen chain picker: scrim + absolute panel.
 */
export function OverlayMenu({
  open,
  onClose,
  align = "left",
  className,
  children,
}: {
  open: boolean;
  onClose: () => void;
  align?: "left" | "right";
  className?: string;
  children: ReactNode;
}) {
  if (!open) return null;
  return (
    <>
      <button
        type="button"
        aria-label="Close menu"
        className="fixed inset-0 z-30 cursor-default"
        onClick={onClose}
      />
      <ul
        role="listbox"
        className={cn(
          "absolute top-[calc(100%+6px)] z-40 max-h-[220px] min-w-full overflow-y-auto",
          "rounded-[14px] border border-[var(--z-line-strong)] bg-[var(--z-surface-raised)] p-1",
          "shadow-[var(--z-shadow-overlay)]",
          align === "right" ? "right-0" : "left-0",
          className,
        )}
      >
        {children}
      </ul>
    </>
  );
}

export function OverlayMenuItem({
  selected,
  onSelect,
  children,
}: {
  selected?: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-2 rounded-[10px] px-2 py-1.5 text-left",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          selected && "bg-[var(--z-state-selected)]",
          focusRing,
        )}
      >
        {children}
      </button>
    </li>
  );
}

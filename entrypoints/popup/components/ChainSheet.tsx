import { useMemo, type ReactNode } from "react";
import { TokenLogo, cn, focusRing } from "@zunialab/ui";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePickerMemory } from "../hooks/usePickerMemory";
import { IconChevronDown } from "../screens/icons";
import { PickerSheet, type PickerItem } from "./PickerSheet";

/** The fields every chain picker needs, so callers can pass a lighter shape. */
export interface ChainOption {
  chainId: string;
  iconUrl?: string;
  entry: Pick<
    ChainAccountView["entry"],
    "chainName" | "coinDenom" | "bech32Prefix" | "inCosmosRegistry"
  >;
}

/**
 * Network picker shared by every screen. Favorites and recent picks are the
 * same everywhere, so a network starred in Send is starred in Earn too.
 */
export function ChainSheet<T extends ChainOption>({
  open,
  onClose,
  title = "Choose a network",
  chains,
  selectedId,
  onSelect,
  trailing,
  disabledReason,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  chains: readonly T[];
  selectedId?: string;
  onSelect: (chainId: string) => void;
  /** Right-aligned detail per chain, usually the balance. */
  trailing?: (chain: T) => ReactNode;
  /** Why a chain cannot be picked here, or undefined when it can. */
  disabledReason?: (chain: T) => string | undefined;
  loading?: boolean;
}) {
  const memory = usePickerMemory("chain");
  const items = useMemo<PickerItem[]>(
    () =>
      chains.map((chain) => {
        const reason = disabledReason?.(chain);
        return {
          id: chain.chainId,
          label: chain.entry.chainName,
          sublabel: `${chain.entry.coinDenom} · ${chain.chainId}`,
          keywords: [chain.entry.coinDenom, chain.chainId, chain.entry.bech32Prefix],
          icon: (
            <TokenLogo
              src={chain.iconUrl}
              symbol={chain.entry.chainName}
              size={26}
              verified={chain.entry.inCosmosRegistry}
              verifiedLabel="Listed in the Cosmos chain registry"
            />
          ),
          trailing: trailing?.(chain),
          disabled: Boolean(reason),
          disabledReason: reason,
        };
      }),
    [chains, trailing, disabledReason],
  );

  return (
    <PickerSheet
      open={open}
      onClose={onClose}
      title={title}
      items={items}
      selectedId={selectedId}
      searchPlaceholder="Search networks"
      favorites={memory.favorites}
      recents={memory.recents}
      onToggleFavorite={memory.toggleFavorite}
      loading={loading}
      emptyLabel="No networks enabled. Add one from Manage networks."
      onSelect={(id) => {
        memory.remember(id);
        onSelect(id);
      }}
    />
  );
}

/**
 * The field that opens a picker sheet. Radix hands focus back to it when the
 * sheet closes, so keyboard users land where they started.
 */
export function PickerTrigger({
  icon,
  title,
  subtitle,
  detail,
  expanded,
  onClick,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  icon?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  detail?: ReactNode;
  expanded: boolean;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-expanded={expanded}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[12px] border border-[var(--z-line)] px-3 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        focusRing,
        className,
      )}
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] font-medium text-fg">{title}</span>
        {subtitle ? (
          <span className="block truncate font-mono text-[9.5px] text-fg-dim">{subtitle}</span>
        ) : null}
      </span>
      {detail ? (
        <span className="shrink-0 font-mono text-[10px] text-fg-dim">{detail}</span>
      ) : null}
      <IconChevronDown width={16} height={16} className="shrink-0 text-fg-dim" />
    </button>
  );
}

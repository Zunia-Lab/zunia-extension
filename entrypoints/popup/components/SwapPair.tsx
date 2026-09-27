/**
 * Skip-widget style from / to pair: stacked cards, overlapping flip, Max
 * on the source, token pill, fiat + chain on the footer of each card.
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import { TokenLogo, cn, focusRing } from "@zunialab/ui";

import { decimalText, formatUnitsExact } from "../../../lib/format";
import { fieldFocusWithin } from "./field-focus";
import { PickerSheet, type PickerItem } from "./PickerSheet";
import { usePickerMemory } from "../hooks/usePickerMemory";
import type { AssetOption } from "../screens/interchain-ui";
import { IconChevronDown, IconFlip, IconInfo } from "../screens/icons";

function SwapLeg({
  label,
  hint,
  meta,
  asset,
  options,
  onSelect,
  amount,
  onAmountChange,
  readOnly,
  quoting,
  emptyLabel,
  renderLimit,
  fiat,
}: {
  label: string;
  hint?: string;
  meta?: ReactNode;
  asset: AssetOption | undefined;
  options: readonly AssetOption[];
  onSelect: (key: string) => void;
  amount: string;
  onAmountChange?: (value: string) => void;
  readOnly?: boolean;
  /** Route and price are still being fetched for the amount the user typed. */
  quoting?: boolean;
  emptyLabel: string;
  renderLimit?: number;
  fiat?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const amountId = useId();
  const memory = usePickerMemory("token");
  const items = useMemo<PickerItem[]>(
    () =>
      options.map((option) => ({
        id: option.key,
        label: option.label,
        sublabel: option.note ? `${option.chainName} · ${option.note}` : option.chainName,
        keywords: [
          option.symbol,
          option.denom,
          option.chainId,
          ...(option.note ? [option.note] : []),
        ],
        icon: (
          <TokenLogo
            src={option.iconUrl ?? option.chainIconUrl}
            symbol={option.symbol}
            size={24}
            verified={option.verified}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        ),
        trailing:
          option.amount === "0" ? null : (
            <span className="font-mono text-[9.5px] tabular-nums text-fg-dim">
              {formatUnitsExact(option.amount, option.decimals, 6)}
            </span>
          ),
      })),
    [options],
  );

  return (
    <section
      aria-busy={quoting || undefined}
      className={cn(
        "rounded-[18px] border border-[var(--z-line)] bg-[var(--z-surface-raised)] px-3.5 py-3",
        !readOnly && fieldFocusWithin,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[12px] font-medium text-fg-muted">
          {label}
          {hint ? (
            <span
              className="inline-flex text-fg-dim"
              title={hint}
              aria-label={hint}
            >
              <IconInfo width={12} height={12} />
            </span>
          ) : null}
        </span>
        {meta}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <label className="sr-only" htmlFor={amountId}>
          {label} amount
        </label>
        <input
          id={amountId}
          inputMode="decimal"
          placeholder="0"
          value={amount}
          readOnly={readOnly}
          onChange={(event) => onAmountChange?.(decimalText(event.target.value))}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-left text-[28px] font-semibold leading-none tracking-[-0.04em] tabular-nums outline-none",
            readOnly ? "text-fg-muted" : "text-fg",
            "placeholder:text-fg-faint",
          )}
        />
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${label} asset: ${asset ? `${asset.symbol} on ${asset.chainName}` : emptyLabel}`}
          disabled={options.length === 0}
          onClick={() => setOpen(true)}
          className={cn(
            "flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--z-line)] bg-[var(--z-glass)] py-1 pl-1 pr-2",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)]",
            "disabled:cursor-not-allowed disabled:opacity-50",
            focusRing,
          )}
        >
          <TokenLogo
            src={asset?.iconUrl ?? asset?.chainIconUrl}
            symbol={asset?.symbol ?? "?"}
            size={22}
            verified={asset?.verified}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
          <span className="max-w-[88px] truncate text-[13px] font-semibold tracking-tight text-fg">
            {asset?.symbol ?? emptyLabel}
          </span>
          <IconChevronDown width={12} height={12} className="shrink-0 text-fg-dim" />
        </button>
        <PickerSheet
          open={open}
          onClose={() => setOpen(false)}
          title={`${label}: choose an asset`}
          items={items}
          selectedId={asset?.key}
          searchPlaceholder="Search by token or network"
          favorites={memory.favorites}
          recents={memory.recents}
          onToggleFavorite={memory.toggleFavorite}
          emptyLabel={emptyLabel}
          renderLimit={renderLimit}
          onSelect={(key) => {
            memory.remember(key);
            onSelect(key);
          }}
        />
      </div>

      {quoting ? (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-[10px] leading-none tracking-[0.01em] text-fg-dim">
          <span
            className="size-2 shrink-0 animate-spin rounded-full border border-[var(--z-line-strong)] border-t-[var(--z-accent)]"
            aria-hidden
          />
          Finding route and price
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] tabular-nums text-fg-dim">
          {fiat ?? ""}
        </span>
        <span className="truncate text-[11px] text-fg-dim">
          {asset ? `On ${asset.chainName}` : ""}
        </span>
      </div>
    </section>
  );
}

export function SwapPair({
  from,
  to,
  fromOptions,
  toOptions,
  amount,
  receiveAmount,
  onAmountChange,
  onSelectFrom,
  onSelectTo,
  onFlip,
  flipLabel,
  canFlip,
  hidden,
  fromFiat,
  toFiat,
  maxLabel,
  onMax,
  quoting,
}: {
  from: AssetOption | undefined;
  to: AssetOption | undefined;
  fromOptions: readonly AssetOption[];
  toOptions: readonly AssetOption[];
  amount: string;
  receiveAmount: string;
  onAmountChange: (value: string) => void;
  onSelectFrom: (key: string) => void;
  onSelectTo: (key: string) => void;
  onFlip: () => void;
  flipLabel: string;
  canFlip: boolean;
  hidden: boolean;
  fromFiat?: string | null;
  toFiat?: string | null;
  maxLabel: string | null;
  onMax: () => void;
  quoting?: boolean;
}) {
  return (
    <div className="relative flex flex-col">
      <SwapLeg
        label="From"
        asset={from}
        options={fromOptions}
        onSelect={onSelectFrom}
        amount={amount}
        onAmountChange={onAmountChange}
        emptyLabel="Nothing held"
        fiat={fromFiat}
        meta={
          maxLabel ? (
            <button
              type="button"
              onClick={onMax}
              disabled={!from}
              className={cn(
                "truncate font-mono text-[11px] tabular-nums text-fg-muted",
                "hover:text-fg disabled:cursor-not-allowed disabled:opacity-40",
                focusRing,
              )}
            >
              {hidden ? "Max: ••••" : `Max: ${maxLabel}`}
            </button>
          ) : (
            <span className="font-mono text-[11px] text-fg-dim">Max: —</span>
          )
        }
      />

      <div className="relative z-20 -my-3 flex justify-center">
        <button
          type="button"
          onClick={onFlip}
          disabled={!canFlip}
          aria-label={flipLabel}
          title={flipLabel}
          className={cn(
            "flex size-10 items-center justify-center rounded-full border border-[var(--z-line-strong)] bg-bg text-fg",
            // The page-colored ring covers the focused card's border, which
            // otherwise cuts straight through this control.
            "shadow-[0_0_0_4px_var(--z-bg),0_6px_16px_color-mix(in_srgb,var(--z-fg)_16%,transparent)]",
            "transition-[color,border-color,transform] duration-[var(--z-duration-base)]",
            "hover:border-accent hover:text-accent active:scale-95",
            "disabled:cursor-not-allowed disabled:opacity-40",
            focusRing,
          )}
        >
          <IconFlip width={16} height={16} />
        </button>
      </div>

      <SwapLeg
        label="To"
        hint="Estimated after the swap. The contract can deliver less, down to your slippage."
        asset={to}
        options={toOptions}
        onSelect={onSelectTo}
        amount={receiveAmount}
        readOnly
        quoting={quoting}
        emptyLabel="No network"
        renderLimit={400}
        fiat={toFiat}
      />
    </div>
  );
}

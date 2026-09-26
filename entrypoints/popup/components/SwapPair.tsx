/**
 * Skip-widget style from / to pair: stacked cards, overlapping flip, Max
 * on the source, token pill, fiat + chain on the footer of each card.
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import { Avatar, cn, focusRing } from "@zunialab/ui";

import { formatUnitsExact } from "../../../lib/format";
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
          <Avatar
            src={option.iconUrl ?? option.chainIconUrl}
            fallback={option.symbol}
            size={24}
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
          onChange={(event) => onAmountChange?.(event.target.value)}
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
          <Avatar
            src={asset?.iconUrl ?? asset?.chainIconUrl}
            fallback={asset?.symbol ?? "?"}
            size={22}
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

      <div className="relative z-10 -my-3 flex justify-center">
        <button
          type="button"
          onClick={onFlip}
          disabled={!canFlip}
          aria-label={flipLabel}
          title={flipLabel}
          className={cn(
            "flex size-9 items-center justify-center rounded-full border border-[var(--z-line)] bg-bg text-fg",
            "shadow-[0_4px_12px_color-mix(in_srgb,var(--z-fg)_12%,transparent)]",
            "transition-colors duration-[var(--z-duration-base)] hover:border-[var(--z-line-strong)]",
            "disabled:cursor-not-allowed disabled:opacity-40",
            focusRing,
          )}
        >
          <IconFlip width={15} height={15} />
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
        emptyLabel="No network"
        renderLimit={400}
        fiat={toFiat}
      />
    </div>
  );
}

/**
 * Skip-widget style from / to pair: stacked cards, overlapping flip, Max
 * on the source, token pill, fiat and location on the footer of each card.
 *
 * Every token is drawn from its identity (lib/token-identity.ts, through
 * TokenLabel.tsx): the pill's ticker never loses its suffix, its second line
 * says where the token is, and the footer says where it is held (From) or
 * delivered (To). A To row the swap cannot use keeps its reason and is listed
 * only by a search (lib/swap-assets.ts).
 */

import { useId, useMemo, useState, type ReactNode } from "react";
import { cn, focusRing } from "@zunialab/ui";

import { decimalText } from "../../../lib/format";
import type { AssetOption } from "../../../lib/swap-assets";
import { MAX_ONLY_NOTE, canTypeAmount } from "../../../lib/token-amount";
import type { TokenIdentity } from "../../../lib/token-identity";
import { fieldFocusWithin } from "./field-focus";
import { PickerSheet, type PickerItem } from "./PickerSheet";
import {
  TokenPill,
  TokenTicker,
  provenanceLabel,
  tokenA11yName,
  tokenLocationText,
  tokenPickerItem,
  tokenTooltip,
} from "./TokenLabel";
import { usePickerMemory } from "../hooks/usePickerMemory";
import { IconFlip, IconInfo } from "../screens/icons";

/** Where a side's token sits, in the card's words: held (From) or delivered (To). */
type Side = "held" | "delivered";

/** Under the To amount when the token's decimals are unknown. */
const TO_BASE_UNITS_NOTE = "This token's decimals are unknown, so its amount is in base units.";

/**
 * The identity a swap row is drawn with. A chain's own staking coin with no
 * token logo of its own wears its chain's logo, as on Home: `iconUrl` is a
 * chain logo only for that coin (lib/swap-assets.ts), never for a token the
 * chain merely holds.
 */
export function shownIdentity(option: AssetOption): TokenIdentity {
  return option.identity.logoUrl || !option.iconUrl
    ? option.identity
    : { ...option.identity, logoUrl: option.iconUrl };
}

/**
 * The To picker's words for what it does not list: its empty state, and the
 * footer that counts the rows only a search shows. "More" only when some rows
 * are listed; when none are, the empty state already says why.
 */
export function buyListCopy(
  options: readonly Pick<AssetOption, "searchOnly">[],
  fromTicker: string | undefined,
): { empty: string; searchOnlyNote: (count: number) => string } {
  const hidden = options.filter((option) => option.searchOnly).length;
  const listed = options.length - hidden;
  const count = (n: number) => n.toLocaleString();
  return {
    empty:
      hidden > 0 && listed === 0 && fromTicker
        ? `Nothing can be bought with ${fromTicker} here. Search to see each token and why.`
        : "No token to receive yet.",
    searchOnlyNote: (n) =>
      listed === 0
        ? `${count(n)} ${n === 1 ? "token appears" : "tokens appear"} when you search.`
        : fromTicker
          ? `${count(n)} more cannot be bought with ${fromTicker}. Search to see why.`
          : `${count(n)} more ${n === 1 ? "appears" : "appear"} when you search.`,
  };
}

/** The pill's accessible name: the side, the token, where it is, and its seal. */
function pillName(label: string, option: AssetOption | undefined, side: Side, empty: string): string {
  if (!option) return `${label} asset: ${empty}`;
  const identity = shownIdentity(option);
  return `${label} asset: ${tokenA11yName(identity, side)}${provenanceLabel(identity) ? ", verified" : ""}`;
}

/**
 * One picker row, from TokenLabel's builder: the ticker drawn whole (the
 * family part gives way first, never the suffix), the identity's line, the
 * token logo with its location badge, the balance, and the seal said aloud.
 */
export function swapPickerItem(option: AssetOption, hidden: boolean): PickerItem {
  const identity = shownIdentity(option);
  const seal = provenanceLabel(identity);
  const item = tokenPickerItem(identity, {
    amount: option.amount,
    hidden,
    disabledReason: option.disabledReason,
    searchOnly: option.searchOnly,
    locationChain: true,
  });
  return {
    ...item,
    labelNode: <TokenTicker identity={identity} />,
    // PickerSheet keeps a disabled row's location line, so the reason is
    // shown as is under it, without an "On Osmosis ·" of its own.
    ...(option.disabledReason ? { disabledReason: option.disabledReason } : {}),
    ...(seal ? { srNote: seal } : {}),
  };
}

function SwapLeg({
  label,
  side,
  hint,
  meta,
  asset,
  options,
  onSelect,
  amount,
  onAmountChange,
  readOnly,
  editable,
  note,
  quoting,
  pillEmptyLabel,
  listEmptyLabel,
  searchOnlyNote,
  renderLimit,
  fiat,
  hidden,
}: {
  label: string;
  side: Side;
  hint?: string;
  meta?: ReactNode;
  asset: AssetOption | undefined;
  options: readonly AssetOption[];
  onSelect: (key: string) => void;
  amount: string;
  onAmountChange?: (value: string) => void;
  readOnly?: boolean;
  /** The side the user types into, even while it takes only Max. */
  editable?: boolean;
  /** A line under the amount, e.g. why the field takes only Max. */
  note?: string | null;
  /** Route and price are still being fetched for the amount the user typed. */
  quoting?: boolean;
  /** The pill's text when no token is picked. */
  pillEmptyLabel: string;
  /** The picker's text when it lists nothing. */
  listEmptyLabel: string;
  searchOnlyNote?: (count: number) => string;
  renderLimit?: number;
  fiat?: string | null;
  hidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  const amountId = useId();
  const noteId = useId();
  const memory = usePickerMemory("token");
  const items = useMemo<PickerItem[]>(
    () => options.map((option) => swapPickerItem(option, hidden)),
    [options, hidden],
  );
  const identity = asset ? shownIdentity(asset) : undefined;

  return (
    <section
      aria-busy={quoting || undefined}
      className={cn(
        "rounded-[18px] border border-[var(--z-line)] bg-[var(--z-surface-raised)] px-3.5 py-3",
        editable && fieldFocusWithin,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-fg-muted">
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
          aria-describedby={note ? noteId : undefined}
          onChange={(event) => onAmountChange?.(decimalText(event.target.value))}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-left text-[28px] font-semibold leading-none tracking-[-0.04em] tabular-nums outline-none",
            readOnly ? "text-fg-muted" : "text-fg",
            "placeholder:text-fg-faint",
          )}
        />
        <TokenPill
          identity={identity}
          location="on"
          emptyLabel={pillEmptyLabel}
          aria-label={pillName(label, asset, side, pillEmptyLabel)}
          title={identity ? tokenTooltip(identity, side) : undefined}
          aria-haspopup="dialog"
          aria-expanded={open}
          disabled={options.length === 0}
          onClick={() => setOpen(true)}
        />
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
          emptyLabel={listEmptyLabel}
          renderLimit={renderLimit}
          {...(searchOnlyNote ? { searchOnlyNote } : {})}
          onSelect={(key) => {
            memory.remember(key);
            onSelect(key);
          }}
        />
      </div>

      {note ? (
        <p id={noteId} className="mt-1.5 text-[10.5px] leading-snug text-fg-muted">
          {note}
        </p>
      ) : null}

      {quoting ? (
        <p className="mt-1.5 flex items-center gap-1 font-mono text-[10px] leading-none tracking-[0.01em] text-fg-dim">
          <span
            className="size-2 shrink-0 animate-spin rounded-full border border-[var(--z-line-strong)] border-t-[var(--z-accent)]"
            aria-hidden
          />
          Finding route and price
        </p>
      ) : null}

      <div className="mt-2 flex items-start justify-between gap-2">
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-fg-dim">
          {fiat ?? ""}
        </span>
        {/* Wrapped, never cut: the chain is the point of this line. */}
        <span className="min-w-0 text-right text-[11px] leading-snug text-fg-dim [overflow-wrap:anywhere]">
          {identity ? tokenLocationText(identity, side) : ""}
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
  /** Held balances only (lib/swap-assets.ts `sellOptions`). */
  fromOptions: readonly AssetOption[];
  /** Gated against `from` (lib/swap-assets.ts `buyOptions`). */
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
  // Typed text is converted with the From's decimals; without them only Max,
  // the exact balance, can be used (lib/token-amount.ts).
  const maxOnly = from ? !canTypeAmount(from.identity) : false;
  const toCopy = buyListCopy(toOptions, from?.identity.ticker);
  return (
    <div className="relative flex flex-col">
      <SwapLeg
        label="From"
        side="held"
        asset={from}
        options={fromOptions}
        onSelect={onSelectFrom}
        amount={amount}
        onAmountChange={onAmountChange}
        readOnly={maxOnly}
        editable
        note={maxOnly ? MAX_ONLY_NOTE : null}
        pillEmptyLabel={fromOptions.length === 0 ? "Nothing held" : "Choose"}
        listEmptyLabel="Nothing held"
        fiat={fromFiat}
        hidden={hidden}
        meta={
          maxLabel ? (
            <button
              type="button"
              onClick={onMax}
              disabled={!from}
              className={cn(
                "min-w-0 text-right font-mono text-[11px] tabular-nums text-fg-muted [overflow-wrap:anywhere]",
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
        side="delivered"
        hint="Estimated after the swap. The contract can deliver less, down to your slippage."
        asset={to}
        options={toOptions}
        onSelect={onSelectTo}
        amount={receiveAmount}
        readOnly
        note={to && !to.decimalsKnown ? TO_BASE_UNITS_NOTE : null}
        quoting={quoting}
        pillEmptyLabel="Choose"
        listEmptyLabel={toCopy.empty}
        searchOnlyNote={toCopy.searchOnlyNote}
        renderLimit={400}
        fiat={toFiat}
        hidden={hidden}
      />
    </div>
  );
}

/**
 * Collapsed fee row plus a sheet for low / mid / high and gas adjustment.
 * Preference is persisted; the parent rebuilds the preview when it changes.
 */

import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Segmented,
  Slider,
  cn,
  focusRing,
} from "@zunialab/ui";

import { FEE_SPEEDS } from "../../../lib/fee-prefs";
import type { FeeSpeedPref } from "../../../lib/settings";
import { formatTokenAmount } from "../../../lib/token-amount";
import { usePrefs } from "../state/Prefs";

/**
 * The collapsed row's text: `Tx Fee: 0.004012 OSMO`. The fee is what the
 * transaction pays, so it goes through the confirm screens' amount policy
 * (lib/token-amount.ts `confirm`): every digit up to six decimals, cut and
 * never rounded up, and `<0.000001` rather than 0 for a fee too small to
 * show. The compact list format read 0.004012 OSMO as `0.00`.
 *
 * `feeAmount` is in base units and `feeDecimals` is the fee coin's exponent
 * from its chain's catalog row; with no fee yet the amount reads `—`.
 */
export function feeLabelText(
  feeAmount: string | undefined,
  feeDecimals: number,
  feeSymbol: string,
): string {
  return `Tx Fee: ${feeAmountText(feeAmount, feeDecimals, feeSymbol)}`;
}

/** The fee alone, under the same policy: `0.004012 OSMO`, or `— OSMO` before there is one. */
export function feeAmountText(feeAmount: string | undefined, feeDecimals: number, feeSymbol: string): string {
  if (feeAmount === undefined) return `— ${feeSymbol}`;
  const amount = formatTokenAmount(
    feeAmount,
    { decimals: feeDecimals, decimalsKnown: true, ticker: feeSymbol, denom: "", provenance: "native" },
    "confirm",
  );
  return `${amount} ${feeSymbol}`;
}

export function GasFeePrefs({
  feeAmount,
  feeDecimals,
  feeSymbol,
  onChanged,
  variant = "bar",
}: {
  feeAmount?: string;
  feeDecimals: number;
  feeSymbol: string;
  /** Rebuild the preview after prefs are saved. */
  onChanged?: () => void;
  /**
   * `bar`: the `Tx Fee:` line with its own button, as a section of its own.
   * `fact`: one line of a summary, `Network fee  0.004 OSMO  Edit`, lined up
   * with the rows around it.
   */
  variant?: "bar" | "fact";
}) {
  const { settings, update } = usePrefs();
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState<FeeSpeedPref>(settings.feeSpeed);
  const [adjustment, setAdjustment] = useState(settings.gasAdjustment);

  const feeLabel = feeLabelText(feeAmount, feeDecimals, feeSymbol);

  function openSheet() {
    setSpeed(settings.feeSpeed);
    setAdjustment(settings.gasAdjustment);
    setOpen(true);
  }

  async function save() {
    await update({ feeSpeed: speed, gasAdjustment: Number(adjustment.toFixed(1)) });
    setOpen(false);
    onChanged?.();
  }

  return (
    <>
      {variant === "fact" ? (
        <div className="flex min-w-0 items-baseline justify-between gap-3">
          <span className="shrink-0 text-[11.5px] text-fg-muted">Network fee</span>
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 truncate text-[11.5px] font-medium tabular-nums text-fg">
              {feeAmountText(feeAmount, feeDecimals, feeSymbol)}
            </span>
            <button
              type="button"
              onClick={openSheet}
              aria-label="Change the network fee speed"
              className={cn("shrink-0 rounded-[6px] text-[10.5px] text-accent hover:underline", focusRing)}
            >
              Edit
            </button>
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="min-w-0 truncate font-mono text-[11px] tabular-nums text-fg">
            {feeLabel}
          </p>
          <button
            type="button"
            onClick={openSheet}
            className={cn(
              "shrink-0 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-muted",
              "hover:text-fg",
              focusRing,
            )}
          >
            Change pref gas fees
          </button>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="w-[min(340px,calc(100%-28px))] p-4">
          <DialogTitle className="text-[16px]">Gas fees</DialogTitle>
          <DialogDescription className="mt-1 text-[11.5px] leading-snug">
            Used on every transaction. Mid is the default.
          </DialogDescription>

          <div className="mt-3">
            <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim">
              Speed
            </p>
            <Segmented
              size="sm"
              value={speed}
              onChange={(value) => setSpeed(value as FeeSpeedPref)}
              options={FEE_SPEEDS.map((row) => ({ value: row.id, label: row.label }))}
            />
          </div>

          <div className="mt-4">
            <div className="mb-1 flex items-baseline justify-between">
              <p className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim">
                Gas adjustment
              </p>
              <p className="font-mono text-[11px] tabular-nums text-fg">
                {adjustment.toFixed(1)}×
              </p>
            </div>
            <Slider
              min={1}
              max={2}
              step={0.1}
              value={[adjustment]}
              onValueChange={(value) => {
                const next = value[0];
                if (typeof next === "number") setAdjustment(next);
              }}
            />
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={() => void save()}>
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

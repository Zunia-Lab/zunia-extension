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

import { formatUnits } from "../../../lib/format";
import { FEE_SPEEDS } from "../../../lib/fee-prefs";
import type { FeeSpeedPref } from "../../../lib/settings";
import { usePrefs } from "../state/Prefs";

export function GasFeePrefs({
  feeAmount,
  feeDecimals,
  feeSymbol,
  onChanged,
}: {
  feeAmount?: string;
  feeDecimals: number;
  feeSymbol: string;
  /** Rebuild the preview after prefs are saved. */
  onChanged?: () => void;
}) {
  const { settings, update } = usePrefs();
  const [open, setOpen] = useState(false);
  const [speed, setSpeed] = useState<FeeSpeedPref>(settings.feeSpeed);
  const [adjustment, setAdjustment] = useState(settings.gasAdjustment);

  const feeLabel =
    feeAmount !== undefined
      ? `Tx Fee: ${formatUnits(feeAmount, feeDecimals)} ${feeSymbol}`
      : `Tx Fee: — ${feeSymbol}`;

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

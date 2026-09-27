/**
 * Swap settings sheet: slippage plus the same gas prefs used on every tx.
 */

import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Input,
  Segmented,
  Slider,
  Switch,
  cn,
  focusRing,
} from "@zunialab/ui";

import {
  HIGH_SLIPPAGE_PERCENT,
  MAX_SLIPPAGE_PERCENT,
  SLIPPAGE_PRESETS,
} from "../../../config/interchain";
import { FEE_SPEEDS } from "../../../lib/fee-prefs";
import type { FeeSpeedPref } from "../../../lib/settings";
import { usePrefs } from "../state/Prefs";

export function SwapSettingsDialog({
  open,
  onOpenChange,
  advanced,
  onAdvancedChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  advanced: boolean;
  onAdvancedChange: (next: boolean) => void;
}) {
  const { settings, update } = usePrefs();
  const [slippage, setSlippage] = useState(settings.swapSlippage);
  const [speed, setSpeed] = useState<FeeSpeedPref>(settings.feeSpeed);
  const [adjustment, setAdjustment] = useState(settings.gasAdjustment);

  function handleOpen(next: boolean) {
    if (next) {
      setSlippage(settings.swapSlippage);
      setSpeed(settings.feeSpeed);
      setAdjustment(settings.gasAdjustment);
    }
    onOpenChange(next);
  }

  const slippageOk =
    Number.isFinite(slippage) && slippage > 0 && slippage <= MAX_SLIPPAGE_PERCENT;
  const presetValue = SLIPPAGE_PRESETS.includes(slippage)
    ? String(slippage)
    : "custom";

  async function save() {
    if (!slippageOk) return;
    await update({
      swapSlippage: Number(slippage.toFixed(2)),
      feeSpeed: speed,
      gasAdjustment: Number(adjustment.toFixed(1)),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpen}>
      <DialogContent className="w-[min(340px,calc(100%-28px))] p-4">
        <DialogTitle className="text-[16px]">Swap settings</DialogTitle>
        <DialogDescription className="mt-1 text-[11.5px] leading-snug">
          Slippage is how far the pool can move before the swap is refused. Gas
          prefs apply to every transaction.
        </DialogDescription>

        <div className="mt-3">
          <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim">
            Slippage
          </p>
          <Segmented
            size="sm"
            value={presetValue}
            onChange={(value) => {
              if (value === "custom") return;
              setSlippage(Number(value));
            }}
            options={[
              ...SLIPPAGE_PRESETS.map((pct) => ({
                value: String(pct),
                label: `${pct}%`,
              })),
              { value: "custom", label: "Custom" },
            ]}
          />
          <div className="mt-2 flex items-center gap-2">
            <Input
              type="text"
              inputMode="decimal"
              min={0.1}
              max={MAX_SLIPPAGE_PERCENT}
              step={0.1}
              value={Number.isFinite(slippage) ? String(slippage) : ""}
              onChange={(event) => setSlippage(Number(event.target.value))}
              className="h-9"
            />
            <span className="shrink-0 font-mono text-[11px] text-fg-muted">%</span>
          </div>
          {slippage > HIGH_SLIPPAGE_PERCENT ? (
            <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--z-warning)]">
              Wide tolerance. The contract can take a worse price before it
              refuses.
            </p>
          ) : null}
          {!slippageOk ? (
            <p className="mt-1.5 text-[10.5px] leading-snug text-[var(--z-danger)]">
              Use a value between 0 and {MAX_SLIPPAGE_PERCENT}%.
            </p>
          ) : null}
        </div>

        <div className="mt-4">
          <p className="mb-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-dim">
            Gas speed
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

        <label
          className={cn(
            "mt-4 flex items-center justify-between gap-3 rounded-[12px] border border-[var(--z-line)] px-3 py-2",
            focusRing,
          )}
        >
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-fg">
              Route details
            </span>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-fg-muted">
              Hops, channels, and the contract.
            </span>
          </span>
          <Switch
            checked={advanced}
            onCheckedChange={onAdvancedChange}
            aria-label="Show route details"
          />
        </label>

        <div className="mt-4 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button className="flex-1" disabled={!slippageOk} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

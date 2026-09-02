import { useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  KeyValueRow,
  ScreenScaffold,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import { NO_VALUE, formatUnits } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import {
  OverlayMenu,
  OverlayMenuItem,
} from "../components/OverlayMenu";
import { IconChevronDown, IconSwap } from "./icons";

function Side({
  label,
  chain,
  chains,
  balance,
  amount,
  onAmount,
  onSelect,
  readOnly,
  hidden,
}: {
  label: string;
  chain?: ChainAccountView;
  chains: ChainAccountView[];
  balance?: ChainBalance;
  amount: string;
  onAmount?: (value: string) => void;
  onSelect: (chainId: string) => void;
  readOnly?: boolean;
  hidden: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-[13px] border border-[var(--z-line)] px-3 py-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
          {label}
        </span>
        <span className="font-mono text-[9.5px] text-fg-dim">
          {hidden
            ? "••••"
            : balance
              ? `${formatUnits(balance.available, balance.decimals)} available`
              : NO_VALUE}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <div className="relative shrink-0">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-1 pr-2",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
              focusRing,
            )}
          >
            <Avatar
              src={chain?.iconUrl}
              fallback={chain?.entry.chainName ?? "?"}
              size={20}
            />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-fg">
              {chain?.entry.coinDenom ?? "—"}
            </span>
            <IconChevronDown width={16} height={16} className="text-fg-dim" />
          </button>
          <OverlayMenu
            open={open}
            onClose={() => setOpen(false)}
            className="w-[200px]"
          >
            {chains.map((option) => (
              <OverlayMenuItem
                key={option.chainId}
                selected={option.chainId === chain?.chainId}
                onSelect={() => {
                  onSelect(option.chainId);
                  setOpen(false);
                }}
              >
                <Avatar
                  src={option.iconUrl}
                  fallback={option.entry.chainName}
                  size={18}
                />
                <span className="min-w-0 flex-1 truncate text-[11px] text-fg">
                  {option.entry.chainName}
                </span>
                <span className="font-mono text-[9px] uppercase text-fg-dim">
                  {option.entry.coinDenom}
                </span>
              </OverlayMenuItem>
            ))}
          </OverlayMenu>
        </div>
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amount}
          readOnly={readOnly}
          onChange={(e) => onAmount?.(e.target.value)}
          className={cn(
            "min-w-0 flex-1 bg-transparent text-right text-[24px] font-medium tracking-[-0.04em] outline-none",
            readOnly ? "text-fg-muted" : "text-fg",
            "placeholder:text-fg-faint",
          )}
        />
      </div>
    </section>
  );
}

export function SwapScreen({
  chains,
  balances,
  initialChainId,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  initialChainId?: string;
}) {
  const { hidden } = usePrefs();
  const [fromId, setFromId] = useState(
    initialChainId ?? chains[0]?.chainId ?? "",
  );
  const [toId, setToId] = useState(chains[1]?.chainId ?? chains[0]?.chainId ?? "");
  const [amount, setAmount] = useState("");

  const from = chains.find((c) => c.chainId === fromId);
  const to = chains.find((c) => c.chainId === toId);

  function flip() {
    setFromId(toId);
    setToId(fromId);
    setAmount("");
  }

  return (
    <ScreenScaffold
      title="Swap"
      right={
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          slippage 0.5%
        </span>
      }
      footer={
        <Button className="w-full" disabled>
          Review swap
        </Button>
      }
    >
      <div className="flex flex-col gap-2 pt-1">
        <Side
          label="From"
          chain={from}
          chains={chains}
          balance={from ? balances[from.chainId] : undefined}
          amount={amount}
          onAmount={setAmount}
          onSelect={setFromId}
          hidden={hidden}
        />

        <div className="flex justify-center">
          <button
            type="button"
            aria-label="Flip direction"
            onClick={flip}
            className={cn(
              "-my-3.5 z-[1] flex size-[30px] items-center justify-center rounded-full border-[3px] border-[var(--z-bg)] bg-accent text-[var(--z-accent-fg)]",
              "transition-transform duration-[var(--z-duration-base)] hover:scale-105",
              focusRing,
            )}
          >
            <IconSwap width={16} height={16} />
          </button>
        </div>

        <Side
          label="To"
          chain={to}
          chains={chains}
          balance={to ? balances[to.chainId] : undefined}
          amount={amount ? NO_VALUE : ""}
          onSelect={setToId}
          readOnly
          hidden={hidden}
        />

        <section className="mt-2 flex flex-col gap-2 rounded-[13px] border border-[var(--z-line)] px-3 py-3">
          <KeyValueRow label="Rate" value={NO_VALUE} />
          <KeyValueRow
            label="Route"
            value={
              from && to
                ? from.chainId === to.chainId
                  ? "Same chain"
                  : `${from.entry.chainId} → IBC → ${to.entry.chainId}`
                : NO_VALUE
            }
          />
          <KeyValueRow label="Price impact" value={NO_VALUE} />
          <KeyValueRow
            label="Fee"
            value={
              from
                ? `${from.entry.gasPriceStep?.average ?? 0.025} ${from.entry.feeMinimalDenom}`
                : NO_VALUE
            }
          />
        </section>

        <Callout tone="info" title="No router connected">
          Quotes need a DEX aggregator. Zunia will not guess a rate, so the
          numbers above stay blank until a router is wired in.
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

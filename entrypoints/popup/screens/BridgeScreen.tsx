import { useMemo, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  KeyValueRow,
  ScreenScaffold,
  Segmented,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ChainBalance } from "../../../lib/balances";
import { NO_VALUE, formatUnits } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { usePrefs } from "../state/Prefs";
import { IconChevronDown, IconReceive } from "./icons";

type Rail = "ibc" | "evm" | "solana";

const EVM_SOURCES = [
  { id: "ethereum", label: "Ethereum", asset: "WETH" },
  { id: "arbitrum", label: "Arbitrum", asset: "ETH" },
  { id: "base", label: "Base", asset: "USDC" },
] as const;

/** One side of the transfer: a chain pill plus the amount. */
function Leg({
  label,
  meta,
  name,
  iconUrl,
  amount,
  onAmountChange,
  onPick,
  readOnly,
}: {
  label: string;
  meta: string;
  name: string;
  iconUrl?: string;
  amount: string;
  onAmountChange?: (value: string) => void;
  onPick?: () => void;
  readOnly?: boolean;
}) {
  return (
    <section className="rounded-[14px] border border-[var(--z-line)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
          {label}
        </span>
        <span className="truncate font-mono text-[9.5px] text-fg-dim">
          {meta}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onPick}
          disabled={!onPick}
          className={cn(
            "flex min-w-0 shrink-0 items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-1 pr-2",
            onPick &&
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <Avatar src={iconUrl} fallback={name} size={20} />
          <span className="max-w-[86px] truncate text-[11.5px] font-medium text-fg">
            {name}
          </span>
          {onPick ? (
            <IconChevronDown width={16} height={16} className="text-fg-dim" />
          ) : null}
        </button>
        <input
          inputMode="decimal"
          value={amount}
          readOnly={readOnly}
          onChange={(event) => onAmountChange?.(event.target.value)}
          placeholder="0.00"
          className={cn(
            "min-w-0 flex-1 bg-transparent text-right text-[24px] font-medium tracking-[-0.03em] tabular-nums",
            "text-fg outline-none placeholder:text-fg-dim",
            readOnly && "text-fg-muted",
          )}
        />
      </div>
    </section>
  );
}

/** Cross-chain transfers: IBC between enabled chains, external rails for the rest. */
export function BridgeScreen({
  chains,
  balances,
  onBack,
}: {
  chains: ChainAccountView[];
  balances: Record<string, ChainBalance>;
  onBack: () => void;
}) {
  const { hidden, settings } = usePrefs();
  const [rail, setRail] = useState<Rail>("ibc");
  const [fromId, setFromId] = useState(chains[0]?.chainId ?? "");
  const [toId, setToId] = useState(chains[1]?.chainId ?? chains[0]?.chainId ?? "");
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState<(typeof EVM_SOURCES)[number]["id"]>(
    "ethereum",
  );

  const from = chains.find((c) => c.chainId === fromId) ?? chains[0];
  const to = chains.find((c) => c.chainId === toId) ?? chains[1] ?? chains[0];
  const fromBalance = from ? balances[from.chainId] : undefined;
  const evmSource = EVM_SOURCES.find((s) => s.id === source) ?? EVM_SOURCES[0];

  const available = useMemo(() => {
    if (!fromBalance) return NO_VALUE;
    if (hidden) return "••••";
    return `${formatUnits(fromBalance.available, fromBalance.decimals, 3)} ${fromBalance.symbol}`;
  }, [fromBalance, hidden]);

  function rotate(setter: (id: string) => void, current: string) {
    if (chains.length < 2) return;
    const index = chains.findIndex((c) => c.chainId === current);
    setter(chains[(index + 1) % chains.length]!.chainId);
  }

  if (chains.length === 0) {
    return (
      <ScreenScaffold title="Bridge" onBack={onBack}>
        <Callout tone="warning" title="No networks enabled">
          Enable at least one network before bridging.
        </Callout>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title="Bridge"
      onBack={onBack}
      right={
        <span className="rounded-full border border-[var(--z-warning-line)] px-2 py-[2px] font-mono text-[8.5px] uppercase tracking-[0.1em] text-[var(--z-warning)]">
          external
        </span>
      }
      footer={
        <Button className="w-full" disabled>
          Review bridge
        </Button>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <Segmented
          value={rail}
          onChange={setRail}
          options={[
            { value: "ibc", label: "IBC" },
            { value: "evm", label: "EVM" },
            { value: "solana", label: "Solana" },
          ]}
        />

        <div className="relative flex flex-col gap-1.5">
          {rail === "ibc" ? (
            <Leg
              label="From"
              meta={available}
              name={from?.entry.chainName ?? NO_VALUE}
              iconUrl={from?.iconUrl}
              amount={amount}
              onAmountChange={setAmount}
              onPick={() => rotate(setFromId, fromId)}
            />
          ) : (
            <Leg
              label={`From ${rail === "evm" ? "EVM" : "Solana"}`}
              meta={rail === "evm" ? evmSource.asset : "SOL"}
              name={rail === "evm" ? evmSource.label : "Solana"}
              amount={amount}
              onAmountChange={setAmount}
              onPick={
                rail === "evm"
                  ? () => {
                      const index = EVM_SOURCES.findIndex(
                        (s) => s.id === source,
                      );
                      setSource(
                        EVM_SOURCES[(index + 1) % EVM_SOURCES.length]!.id,
                      );
                    }
                  : undefined
              }
            />
          )}

          <button
            type="button"
            aria-label="Flip direction"
            onClick={() => {
              if (rail !== "ibc") return;
              setFromId(toId);
              setToId(fromId);
            }}
            className={cn(
              "absolute left-1/2 top-1/2 z-10 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center",
              "rounded-full border border-[var(--z-line-strong)] bg-accent text-[var(--z-accent-fg)]",
              focusRing,
            )}
          >
            <IconReceive width={16} height={16} />
          </button>

          <Leg
            label="To"
            meta={to?.chainId ?? ""}
            name={to?.entry.chainName ?? NO_VALUE}
            iconUrl={to?.iconUrl}
            amount={amount ? amount : ""}
            readOnly
            onPick={rail === "ibc" ? () => rotate(setToId, toId) : undefined}
          />
        </div>

        <section className="flex flex-col gap-1.5 rounded-[13px] border border-[var(--z-line)] px-3 py-2.5">
          <KeyValueRow
            label="Provider"
            value={rail === "ibc" ? "Native IBC" : NO_VALUE}
          />
          <KeyValueRow
            label="Bridge fee"
            value={rail === "ibc" ? "None" : NO_VALUE}
          />
          <KeyValueRow label="Gas" value={NO_VALUE} />
          <KeyValueRow
            label="Arrival"
            value={rail === "ibc" ? "~1 min" : NO_VALUE}
          />
        </section>

        {rail === "ibc" ? (
          <Callout tone="neutral" title="IBC is the safest rail">
            Transfers between the Cosmos chains you already have enabled stay
            inside the interchain and need no external custodian, only a live
            channel.
          </Callout>
        ) : (
          <Callout tone="warning" title="Bridges are third parties">
            Funds leave Zunia&rsquo;s control while they are in transit. Zunia
            names the provider and the wrapped asset before you sign.
          </Callout>
        )}

        <Callout tone="neutral" title="No route resolved">
          {settings.liveBalances
            ? "Channel discovery and relayer quotes land with the broadcasting path."
            : "Turn on on-chain reads in Preferences so Zunia can check channels and balances."}
        </Callout>
      </div>
    </ScreenScaffold>
  );
}

import { useEffect, useState } from "react";
import {
  Avatar,
  Button,
  Callout,
  ScreenScaffold,
  Spinner,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { SessionStatus } from "../../../lib/session";
import { QrCode } from "../components/QrCode";
import { useChainAccounts } from "../hooks/useChainAccounts";
import { IconCheck, IconCopy } from "./icons";

export function ReceiveScreen({
  status,
  initialChainId,
  onBack,
}: {
  status: SessionStatus;
  initialChainId?: string;
  onBack: () => void;
}) {
  const { accounts, loading } = useChainAccounts(
    status.unlocked,
    status.activeAccountIndex,
  );
  const [chainId, setChainId] = useState<string | null>(
    initialChainId ?? null,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chainId && accounts.length > 0) setChainId(accounts[0]!.chainId);
  }, [accounts, chainId]);

  const selected = accounts.find((a) => a.chainId === chainId) ?? accounts[0];

  async function copyAddress() {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <ScreenScaffold
      title="Receive"
      onBack={onBack}
      footer={
        <Button
          className="w-full"
          size="lg"
          disabled={!selected}
          onClick={() => void copyAddress()}
        >
          {copied ? (
            <IconCheck width={16} height={16} />
          ) : (
            <IconCopy width={16} height={16} />
          )}
          {copied ? "Address copied" : "Copy address"}
        </Button>
      }
    >
      {loading && accounts.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-16 text-fg-dim">
          <Spinner />
          <span className="text-[12px]">Deriving addresses…</span>
        </div>
      ) : null}

      {selected ? (
        <div className="flex flex-col gap-4 pt-1">
          <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
            {accounts.map((chain) => {
              const active = chain.chainId === selected.chainId;
              return (
                <li key={chain.chainId} className="shrink-0">
                  <button
                    type="button"
                    onClick={() => setChainId(chain.chainId)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border py-1 pl-1 pr-2.5 text-[11.5px] font-medium",
                      "transition-colors duration-[var(--z-duration-base)]",
                      active
                        ? "border-[color-mix(in_srgb,var(--z-accent)_50%,var(--z-line))] bg-[color-mix(in_srgb,var(--z-accent)_12%,transparent)] text-fg"
                        : "border-[var(--z-line)] text-fg-muted hover:bg-[var(--z-state-hover)] hover:text-fg",
                      focusRing,
                    )}
                  >
                    <Avatar
                      src={chain.iconUrl}
                      fallback={chain.entry.chainName}
                      size={18}
                    />
                    {chain.entry.chainName}
                  </button>
                </li>
              );
            })}
          </ul>

          <div className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--z-line)] bg-[var(--z-glass)] px-4 py-5">
            <QrCode value={selected.address} size={168} />
            <p className="w-full break-all text-center font-mono text-[11px] leading-[1.6] text-fg">
              {selected.address}
            </p>
            <p className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-fg-dim">
              {selected.entry.chainId}
            </p>
          </div>

          <Callout tone="warning" title="Same chain only">
            Only {selected.entry.bech32Prefix}1… addresses on{" "}
            {selected.entry.chainName} can receive here. Funds sent from another
            chain without a bridge are lost.
          </Callout>
        </div>
      ) : null}

      {!loading && accounts.length === 0 ? (
        <Callout tone="neutral" title="No networks enabled">
          Enable at least one network to get a receiving address.
        </Callout>
      ) : null}
    </ScreenScaffold>
  );
}

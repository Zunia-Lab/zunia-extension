import { useMemo, useState } from "react";
import {
  Button,
  Callout,
  ScreenScaffold,
  SearchField,
  Skeleton,
  TokenLogo,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { SessionStatus } from "../../../lib/session";
import { searchItems } from "../../../lib/picker";
import { QrCode } from "../components/QrCode";
import { useChainAccounts, type ChainAccountView } from "../hooks/useChainAccounts";
import { usePickerMemory } from "../hooks/usePickerMemory";
import { useToast } from "../state/Toasts";
import { IconCopy, IconQr, IconStar } from "./icons";

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
  const memory = usePickerMemory("chain");
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [qrChainId, setQrChainId] = useState<string | null>(
    initialChainId ?? null,
  );

  const shown = useMemo(() => {
    const favorites = new Set(memory.favorites);
    const ranked = [
      ...accounts.filter((row) => favorites.has(row.chainId)),
      ...accounts.filter((row) => !favorites.has(row.chainId)),
    ];
    return searchItems(
      ranked.map((row) => ({
        id: row.chainId,
        label: row.entry.chainName,
        sublabel: row.address,
        keywords: [row.chainId, row.entry.coinDenom, row.entry.bech32Prefix],
      })),
      query,
    ).flatMap((item) => accounts.find((row) => row.chainId === item.id) ?? []);
  }, [accounts, memory.favorites, query]);

  const qrAccount =
    accounts.find((row) => row.chainId === qrChainId) ??
    (initialChainId ? accounts.find((row) => row.chainId === initialChainId) : undefined);

  async function copyAddress(row: ChainAccountView) {
    if (!row.address) return;
    try {
      await navigator.clipboard.writeText(row.address);
      toast("Address copied", { meta: row.entry.chainName });
    } catch {
      toast("Could not copy. Select the address and copy it by hand.", {
        tone: "danger",
      });
    }
  }

  if (qrAccount && qrChainId) {
    return (
      <ScreenScaffold
        title="Deposit"
        onBack={() => {
          setQrChainId(null);
          if (initialChainId && qrChainId === initialChainId) onBack();
        }}
        footer={
          <Button
            className="w-full"
            size="lg"
            disabled={!qrAccount.address}
            onClick={() => void copyAddress(qrAccount)}
          >
            <IconCopy width={16} height={16} />
            Copy address
          </Button>
        }
      >
        <div className="flex flex-col gap-4 pt-1">
          <div className="flex items-center gap-2.5">
            <TokenLogo
              src={qrAccount.iconUrl}
              symbol={qrAccount.entry.chainName}
              size={28}
              verified={qrAccount.entry.inCosmosRegistry}
              verifiedLabel="Listed in the Cosmos chain registry"
            />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-fg">
                {qrAccount.entry.chainName}
              </span>
              <span className="block truncate font-mono text-[9.5px] text-fg-dim">
                {qrAccount.entry.chainId}
              </span>
            </span>
          </div>

          <div className="flex flex-col items-center gap-3 rounded-[18px] border border-[var(--z-line)] bg-[var(--z-glass)] px-4 py-5">
            {qrAccount.address ? (
              <QrCode value={qrAccount.address} size={168} />
            ) : (
              <Skeleton className="size-[168px] rounded-[12px]" />
            )}
            <p className="w-full break-all text-center font-mono text-[11px] leading-[1.6] text-fg">
              {qrAccount.address || "Deriving address…"}
            </p>
          </div>

          <Callout tone="warning" title="Same chain only">
            Only {qrAccount.entry.bech32Prefix}1… addresses on{" "}
            {qrAccount.entry.chainName} can deposit here. Funds sent from
            another chain without a bridge are lost.
          </Callout>
        </div>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title="Deposit"
      onBack={onBack}
      right={
        <span className="font-mono text-[10px] text-fg-dim">
          {accounts.length} {accounts.length === 1 ? "network" : "networks"}
        </span>
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        <SearchField
          value={query}
          onValueChange={setQuery}
          placeholder="Search for a chain"
        />

        {loading && accounts.length === 0 ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Deriving addresses">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-[52px] w-full rounded-[12px]" />
            ))}
          </div>
        ) : accounts.length === 0 ? (
          <Callout tone="neutral" title="No networks enabled">
            Enable at least one network to get a deposit address.
          </Callout>
        ) : shown.length === 0 ? (
          <p className="py-8 text-center text-[12px] text-fg-muted">
            Nothing matches &ldquo;{query.trim()}&rdquo;.
          </p>
        ) : (
          <ul className="-mx-1 flex flex-col">
            {shown.map((row) => {
              const starred = memory.favorites.includes(row.chainId);
              return (
                <li key={row.chainId} className="flex items-center">
                  <button
                    type="button"
                    aria-label={
                      starred
                        ? `Unstar ${row.entry.chainName}`
                        : `Star ${row.entry.chainName}`
                    }
                    onClick={() => memory.toggleFavorite(row.chainId)}
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full",
                      "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)]",
                      starred ? "text-[var(--z-warning)]" : "text-fg-dim",
                      focusRing,
                    )}
                  >
                    <IconStar filled={starred} width={16} height={16} />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      memory.remember(row.chainId);
                      setQrChainId(row.chainId);
                    }}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] px-1.5 py-2.5 text-left",
                      "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)]",
                      focusRing,
                    )}
                  >
                    <TokenLogo
                      src={row.iconUrl}
                      symbol={row.entry.chainName}
                      size={30}
                      verified={row.entry.inCosmosRegistry}
                      verifiedLabel="Listed in the Cosmos chain registry"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">
                        {row.entry.chainName}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-dim">
                        {row.address
                          ? truncateAddress(row.address, 11, 8)
                          : "Deriving…"}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy ${row.entry.chainName} address`}
                    disabled={!row.address}
                    onClick={() => void copyAddress(row)}
                    className={cn(
                      "flex size-9 shrink-0 items-center justify-center rounded-full text-fg-dim",
                      "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                      "disabled:opacity-40",
                      focusRing,
                    )}
                  >
                    <IconCopy width={15} height={15} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Show ${row.entry.chainName} QR code`}
                    disabled={!row.address}
                    onClick={() => {
                      memory.remember(row.chainId);
                      setQrChainId(row.chainId);
                    }}
                    className={cn(
                      "mr-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-fg-dim",
                      "transition-colors duration-[var(--z-duration-fast)] hover:bg-[var(--z-state-hover)] hover:text-fg",
                      "disabled:opacity-40",
                      focusRing,
                    )}
                  >
                    <IconQr width={15} height={15} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </ScreenScaffold>
  );
}

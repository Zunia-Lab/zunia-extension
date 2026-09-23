import { useState } from "react";
import { Avatar, Button, Callout, ScreenScaffold, Skeleton } from "@zunialab/ui";
import type { SessionStatus } from "../../../lib/session";
import { ChainSheet, PickerTrigger } from "../components/ChainSheet";
import { QrCode } from "../components/QrCode";
import { useChainAccounts } from "../hooks/useChainAccounts";
import { useToast } from "../state/Toasts";
import { IconCopy } from "./icons";

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
  const [pickerOpen, setPickerOpen] = useState(false);
  const toast = useToast();

  // The fallback to the first account is the whole default, so there is nothing
  // for an effect to seed: writing `chainId` from an effect just to have the
  // next line read it back re-rendered the screen a second time on open, and
  // left one committed render pointing at an account that had gone away.
  const selected = accounts.find((a) => a.chainId === chainId) ?? accounts[0];

  async function copyAddress() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.address);
      toast("Address copied", { meta: selected.entry.chainName });
    } catch {
      toast("Could not copy. Select the address and copy it by hand.", { tone: "danger" });
    }
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
          <IconCopy width={16} height={16} />
          Copy address
        </Button>
      }
    >
      {loading && accounts.length === 0 ? (
        <div className="flex flex-col gap-4 pt-1" role="status" aria-label="Deriving addresses">
          <Skeleton className="h-[50px] w-full rounded-[12px]" />
          <Skeleton className="h-[260px] w-full rounded-[18px]" />
        </div>
      ) : null}

      {selected ? (
        <div className="flex flex-col gap-4 pt-1">
          <PickerTrigger
            expanded={pickerOpen}
            onClick={() => setPickerOpen(true)}
            aria-label={`Network: ${selected.entry.chainName}`}
            icon={
              <Avatar src={selected.iconUrl} fallback={selected.entry.chainName} size={26} />
            }
            title={selected.entry.chainName}
            subtitle={selected.entry.chainId}
            detail={accounts.length > 1 ? `${accounts.length} networks` : undefined}
          />
          <ChainSheet
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            title="Receive on"
            chains={accounts}
            selectedId={selected.chainId}
            onSelect={setChainId}
          />

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

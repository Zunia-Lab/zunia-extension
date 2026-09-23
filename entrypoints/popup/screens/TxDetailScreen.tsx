import {
  Button,
  ScreenScaffold,
  TxDetail,
  truncateAddress,
} from "@zunialab/ui";
import type { ActivityItem } from "../../../lib/chain-queries";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { useToast } from "../state/Toasts";
import { IconCopy } from "./icons";

export function TxDetailScreen({
  item,
  onBack,
}: {
  item: ActivityItem;
  onBack: () => void;
}) {
  const chain = findCatalogEntry(item.chainId);
  const toast = useToast();

  async function copyHash() {
    try {
      await navigator.clipboard.writeText(item.hash);
      toast("Hash copied", { meta: truncateAddress(item.hash, 6, 4) });
    } catch {
      toast("Could not copy the hash", { tone: "danger" });
    }
  }

  return (
    <ScreenScaffold title="Transaction" onBack={onBack}>
      <div className="flex flex-col gap-4 pt-1">
        <TxDetail
          hash={item.hash}
          status={item.success ? "success" : "failed"}
          chainLabel={chain?.chainName ?? item.chainId}
          messages={[
            {
              type: item.kind,
              summary: `${item.title} · ${item.subtitle}`,
            },
          ]}
        />
        <Button variant="secondary" onClick={() => void copyHash()}>
          <IconCopy width={15} height={15} />
          Copy hash
        </Button>
        {chain?.rest ? (
          <Button variant="secondary" asChild>
            <a
              href={`${chain.rest.replace(/\/$/, "")}/cosmos/tx/v1beta1/txs/${item.hash}`}
              target="_blank"
              rel="noreferrer"
            >
              Open LCD tx
            </a>
          </Button>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

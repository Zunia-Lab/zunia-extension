import {
  Button,
  ScreenScaffold,
  TxDetail,
} from "@zunialab/ui";
import type { ActivityItem } from "../../../lib/chain-queries";
import { findCatalogEntry } from "../../../lib/chain-catalog";

export function TxDetailScreen({
  item,
  onBack,
}: {
  item: ActivityItem;
  onBack: () => void;
}) {
  const chain = findCatalogEntry(item.chainId);
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
          fees={[{ label: "Fee", value: "—" }]}
        />
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

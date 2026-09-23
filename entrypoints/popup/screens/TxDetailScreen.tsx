import {
  Button,
  Callout,
  KeyValueRow,
  PacketTracker,
  ScreenScaffold,
  Skeleton,
  TxDetail,
  truncateAddress,
} from "@zunialab/ui";
import { explorerTxUrl } from "../../../config/interchain";
import type { ChainBalance } from "../../../lib/balances";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import {
  formatCoin,
  type ActivityItem,
  type TxDetailInfo,
  type TxFeeCoin,
} from "../../../lib/chain-queries";
import type { PendingTransfer } from "../../../lib/pending-transfers";
import { useTxDetail } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { IconCopy } from "./icons";
import { TruncatedValue, usePacketWalk, useRouteTracking } from "./interchain-ui";

function grouped(value: string): string {
  return /^\d+$/.test(value) ? Number(value).toLocaleString() : value;
}

/** A fee in a voucher the catalog cannot name takes its ticker from the balances. */
function feeLabel(
  coin: TxFeeCoin,
  chainId: string,
  balances: Record<string, ChainBalance>,
): string {
  if (coin.known) return formatCoin(coin.amount, coin);
  const token = balances[chainId]?.tokens.find((row) => row.denom === coin.denom);
  return formatCoin(
    coin.amount,
    token ? { symbol: token.symbol, decimals: token.decimals, known: true } : coin,
  );
}

function feeRows(detail: TxDetailInfo, balances: Record<string, ChainBalance>) {
  const rows = [
    {
      label: "Fee",
      value:
        detail.fee.length > 0
          ? detail.fee.map((coin) => feeLabel(coin, detail.chainId, balances)).join(" + ")
          : "None",
    },
  ];
  if (detail.gasUsed) {
    rows.push({
      label: "Gas used",
      value: detail.gasWanted
        ? `${grouped(detail.gasUsed)} of ${grouped(detail.gasWanted)}`
        : grouped(detail.gasUsed),
    });
  }
  return rows;
}

/** The route the wallet is still following, with the recover step when a swap needs it. */
function RouteSteps({
  transfer,
  onCopyTxHash,
  onOpenSwap,
}: {
  transfer: PendingTransfer;
  onCopyTxHash: (hash: string) => void;
  onOpenSwap: () => void;
}) {
  const tracking = useRouteTracking({
    plan: transfer.plan,
    sourceTxHash: transfer.txHash,
    expectedAmount: transfer.amountBaseUnits,
    ...(transfer.swapContract ? { swapContract: transfer.swapContract } : {}),
    ...(transfer.recoveryAddress ? { recoveryAddress: transfer.recoveryAddress } : {}),
  });
  const route = tracking.route;
  return (
    <PacketTracker
      compact
      title="IBC steps"
      hops={route?.hops ?? []}
      sourceChainId={transfer.chainId}
      failure={route?.failure ?? null}
      recoveryReady={Boolean(route?.recovery?.msg)}
      onRecover={onOpenSwap}
      recoverLabel="Recover in Swap"
      txUrl={explorerTxUrl}
      onCopyTxHash={onCopyTxHash}
      loading={tracking.loading && !route}
      error={tracking.error}
      onRefresh={tracking.refresh}
      lastUpdatedAt={route?.updatedAt ?? null}
    />
  );
}

/** Where the packets of a transaction from the history went. */
function PacketSteps({
  detail,
  onCopyTxHash,
}: {
  detail: TxDetailInfo;
  onCopyTxHash: (hash: string) => void;
}) {
  const walk = usePacketWalk({
    chainId: detail.chainId,
    txHash: detail.hash,
    packets: detail.packets,
  });
  return (
    <PacketTracker
      compact
      title="IBC steps"
      hops={walk.walk?.hops ?? []}
      sourceChainId={detail.chainId}
      failure={walk.walk?.failure ?? null}
      txUrl={explorerTxUrl}
      onCopyTxHash={onCopyTxHash}
      loading={walk.loading && !walk.walk}
      error={walk.error}
      onRefresh={walk.refresh}
      lastUpdatedAt={walk.walk?.updatedAt ?? null}
    />
  );
}

export function TxDetailScreen({
  item,
  transfer,
  balances,
  onOpenSwap,
  onBack,
}: {
  item: ActivityItem;
  transfer?: PendingTransfer;
  balances: Record<string, ChainBalance>;
  onOpenSwap: () => void;
  onBack: () => void;
}) {
  const { settings } = usePrefs();
  const live = settings.liveBalances;
  const chain = findCatalogEntry(item.chainId);
  const toast = useToast();
  const tx = useTxDetail(item.chainId, item.hash, live);
  const detail = tx.detail;
  const explorerUrl = explorerTxUrl(item.chainId, item.hash);
  const linkUrl =
    explorerUrl ??
    (chain?.rest
      ? `${chain.rest.replace(/\/$/, "")}/cosmos/tx/v1beta1/txs/${encodeURIComponent(item.hash)}`
      : null);

  async function copyHash(hash: string) {
    try {
      await navigator.clipboard.writeText(hash);
      toast("Hash copied", { meta: truncateAddress(hash, 6, 4) });
    } catch {
      toast("Could not copy the hash", { tone: "danger" });
    }
  }

  // A route signed a moment ago is not in the node's index yet.
  const status = detail
    ? detail.success
      ? "success"
      : "failed"
    : transfer || tx.missing
      ? "pending"
      : item.success
        ? "success"
        : "failed";

  return (
    <ScreenScaffold
      title="Transaction"
      onBack={onBack}
      footer={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => void copyHash(item.hash)}
          >
            <IconCopy width={15} height={15} />
            Copy hash
          </Button>
          {linkUrl ? (
            <Button className="flex-1" asChild>
              <a href={linkUrl} target="_blank" rel="noreferrer">
                {explorerUrl ? "View on explorer" : "Raw transaction"}
              </a>
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-4 pt-1">
        <TxDetail
          hash={item.hash}
          status={status}
          chainLabel={chain?.chainName ?? item.chainId}
          messages={
            detail && detail.messages.length > 0
              ? detail.messages
              : [{ type: item.kind, summary: `${item.title} · ${item.subtitle}` }]
          }
          fees={detail ? feeRows(detail, balances) : undefined}
        />

        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Turn on live balances in Preferences to load the fee, every message,
            and the IBC steps.
          </Callout>
        ) : tx.loading && !detail ? (
          <div className="flex flex-col gap-2" aria-busy="true">
            <span className="sr-only">Loading the transaction</span>
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-3 w-1/2" />
          </div>
        ) : tx.error && !detail ? (
          <Callout tone="warning" title="Could not load the details">
            <p>{tx.error}</p>
            <Button variant="secondary" size="sm" className="mt-2" onClick={tx.reload}>
              Try again
            </Button>
          </Callout>
        ) : tx.missing ? (
          <Callout tone="neutral" title="Not on this node yet">
            <p>
              {tx.retrying
                ? "The node has not indexed this transaction yet. Zunia checks again every few seconds."
                : "The node still does not have this transaction. Public nodes prune old ones, so it may only be on a block explorer."}
            </p>
            {tx.retrying ? null : (
              <Button variant="secondary" size="sm" className="mt-2" onClick={tx.reload}>
                Check again
              </Button>
            )}
          </Callout>
        ) : null}

        {detail ? (
          <div className="flex flex-col gap-2.5">
            {detail.timestamp ? (
              <KeyValueRow label="Time" value={new Date(detail.timestamp).toLocaleString()} />
            ) : null}
            {detail.height ? <KeyValueRow label="Block" value={grouped(detail.height)} /> : null}
            {detail.memo ? (
              <KeyValueRow label="Memo" value={<TruncatedValue>{detail.memo}</TruncatedValue>} />
            ) : null}
          </div>
        ) : null}

        {detail?.error ? (
          <Callout tone="danger" title="Why the chain refused it">
            <span className="break-words font-mono text-[10.5px]">{detail.error}</span>
          </Callout>
        ) : null}

        {transfer ? (
          <RouteSteps
            transfer={transfer}
            onCopyTxHash={(hash) => void copyHash(hash)}
            onOpenSwap={onOpenSwap}
          />
        ) : detail && detail.packets.length > 0 ? (
          <PacketSteps detail={detail} onCopyTxHash={(hash) => void copyHash(hash)} />
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

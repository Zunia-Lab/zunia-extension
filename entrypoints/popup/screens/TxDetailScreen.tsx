import {
  Button,
  Callout,
  PacketTracker,
  Pill,
  ScreenScaffold,
  Skeleton,
  TokenLogo,
  activityAmountClass,
  amountInlineClass,
  cn,
  focusRing,
} from "@zunialab/ui";
import { explorerTxUrl } from "../../../config/interchain";
import type { ChainBalance } from "../../../lib/balances";
import { catalogIconFor, findCatalogEntry } from "../../../lib/chain-catalog";
import {
  formatCoin,
  type ActivityItem,
  type ActivityKind,
  type TxDetailInfo,
  type TxFeeCoin,
} from "../../../lib/chain-queries";
import { formatUnits, isBech32 } from "../../../lib/format";
import type { PendingTransfer } from "../../../lib/pending-transfers";
import { ActivityBadge } from "../components/ActivityBadge";
import { useTxDetail } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { IconCopy } from "./icons";
import { TruncatedValue, usePacketWalk, useRouteTracking } from "./interchain-ui";

function grouped(value: string): string {
  return /^\d+$/.test(value) ? Number(value).toLocaleString() : value;
}

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

function addressesIn(...texts: string[]): string[] {
  const out: string[] = [];
  for (const text of texts) {
    for (const part of text.split(/[^a-z0-9]+/i)) {
      if (isBech32(part) && !out.includes(part)) out.push(part);
    }
  }
  return out;
}

function CopyBlock({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (value: string) => void;
}) {
  return (
    <div className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-muted">
          {label}
        </p>
        <button
          type="button"
          onClick={() => onCopy(value)}
          className={cn(
            "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
            "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
            focusRing,
          )}
        >
          <IconCopy width={11} height={11} />
          Copy
        </button>
      </div>
      <p className="mt-1.5 break-all font-mono text-[12px] leading-[1.55] text-fg">
        {value}
      </p>
    </div>
  );
}

function KindEyebrow(kind: ActivityKind, title: string): string {
  switch (kind) {
    case "sent":
      return "Sent";
    case "received":
      return "Received";
    case "ibc":
      return title.toLowerCase().includes("receive") ? "IBC receive" : "IBC send";
    case "swap":
      return "Swap";
    case "staking":
      return title.toLowerCase().includes("undelegate")
        ? "Unstake"
        : title.toLowerCase().includes("redelegate")
          ? "Redelegate"
          : "Stake";
    case "claim":
      return "Rewards";
    case "governance":
      return "Governance";
    default:
      return title;
  }
}

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

  const token = item.denom
    ? balances[item.chainId]?.tokens.find((row) => row.denom === item.denom)
    : undefined;
  const symbol = token?.symbol ?? item.symbol;
  const decimals = token?.decimals ?? item.decimals;
  const unsigned = item.amount?.replace(/^-/, "");
  const outgoing = item.amount?.startsWith("-") ?? false;
  const sign =
    outgoing
      ? "-"
      : item.kind === "received" || item.kind === "ibc" || item.kind === "claim"
        ? "+"
        : "";
  const amount = unsigned
    ? `${sign}${formatUnits(unsigned, decimals, 3)} ${symbol}`
    : null;
  const amountClass = activityAmountClass(item.kind, item.success, item.amount);

  const primary =
    detail?.messages.find((message) => message.kind === item.kind) ??
    detail?.messages[0];
  const from = primary?.from ?? item.from;
  const to = primary?.to ?? item.to;
  const fallbackPeers = addressesIn(
    item.subtitle,
    ...(detail?.messages.map((message) => message.summary) ?? []),
  ).filter((address) => address !== from && address !== to);

  async function copy(value: string, title: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast(title);
    } catch {
      toast(`Could not copy the ${title.toLowerCase().replace(" copied", "")}`, {
        tone: "danger",
      });
    }
  }

  const status = detail
    ? detail.success
      ? "Confirmed"
      : "Failed"
    : transfer || tx.missing
      ? "Pending"
      : item.success
        ? "Confirmed"
        : "Failed";
  const statusTone =
    status === "Failed"
      ? "danger"
      : status === "Pending"
        ? "warning"
        : "success";
  const kind = primary?.kind ?? item.kind;
  const eyebrow = KindEyebrow(kind, primary?.title ?? item.title);
  const extraMessages = (detail?.messages ?? []).filter((message) => message !== primary);

  return (
    <ScreenScaffold
      title={eyebrow}
      onBack={onBack}
      right={
        <ActivityBadge
          kind={kind}
          messageType={primary?.type ?? item.messageType}
          success={item.success}
        />
      }
      footer={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => void copy(item.hash, "Hash copied")}
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
      <div className="flex flex-col gap-3 pt-1">
        <section className="rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3.5">
          <div className="flex items-center gap-3">
            <TokenLogo
              src={token?.iconUrl ?? (chain ? catalogIconFor(chain) : undefined)}
              symbol={symbol || chain?.chainName || item.chainId}
              size={40}
              verified={chain?.inCosmosRegistry}
              verifiedLabel="Listed in the Cosmos chain registry"
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13.5px] font-semibold tracking-tight text-fg">
                {primary?.title ?? item.title}
              </span>
              <span className="mt-0.5 block truncate font-mono text-[10px] text-fg-dim">
                {chain?.chainName ?? item.chainId}
              </span>
            </span>
            <Pill tone={statusTone} className="shrink-0">
              {status}
            </Pill>
          </div>

          {amount ? (
            <p className={cn(amountInlineClass, "mt-3 text-[26px] tracking-[-0.04em]", amountClass)}>
              {amount}
            </p>
          ) : (
            <p className="mt-3 text-[14px] font-medium text-fg">{item.subtitle}</p>
          )}

          {kind === "governance" && (primary?.proposalId || primary?.vote) ? (
            <p className="mt-2 font-mono text-[11px] text-fg-muted">
              {primary.proposalId ? `Proposal #${primary.proposalId}` : null}
              {primary.proposalId && primary.vote ? " · " : null}
              {primary.vote ? `Vote ${primary.vote}` : null}
            </p>
          ) : null}
          {kind === "ibc" && primary?.channel ? (
            <p className="mt-2 font-mono text-[11px] text-fg-muted">
              Channel {primary.channel}
            </p>
          ) : null}
          {primary?.contract ? (
            <p className="mt-2 font-mono text-[11px] text-fg-muted">
              Contract call
            </p>
          ) : null}
          {detail?.timestamp || item.timestamp ? (
            <p className="mt-2 font-mono text-[10px] text-fg-dim">
              {new Date(detail?.timestamp || item.timestamp).toLocaleString()}
            </p>
          ) : null}
        </section>

        {from ? (
          <CopyBlock
            label={kind === "staking" || kind === "claim" ? "Validator" : "From"}
            value={from}
            onCopy={(value) => void copy(value, "Address copied")}
          />
        ) : null}
        {to && to !== from ? (
          <CopyBlock
            label={
              kind === "staking"
                ? from
                  ? "To validator"
                  : "Validator"
                : primary?.contract
                  ? "Contract"
                  : "To"
            }
            value={to}
            onCopy={(value) => void copy(value, "Address copied")}
          />
        ) : null}
        {fallbackPeers.map((address) => (
          <CopyBlock
            key={address}
            label="Address"
            value={address}
            onCopy={(value) => void copy(value, "Address copied")}
          />
        ))}

        <CopyBlock
          label="Hash"
          value={item.hash}
          onCopy={(value) => void copy(value, "Hash copied")}
        />

        {detail ? (
          <div className="rounded-[14px] border border-[var(--z-line)] px-3.5 py-3">
            {detail.height ? (
              <p className="flex justify-between gap-3 font-mono text-[11px]">
                <span className="text-fg-dim">Block</span>
                <span className="text-fg">{grouped(detail.height)}</span>
              </p>
            ) : null}
            {detail.fee.length > 0 ? (
              <p className="mt-1.5 flex justify-between gap-3 font-mono text-[11px]">
                <span className="text-fg-dim">Fee</span>
                <span className="text-right text-fg">
                  {detail.fee.map((coin) => feeLabel(coin, detail.chainId, balances)).join(" + ")}
                </span>
              </p>
            ) : null}
            {detail.gasUsed ? (
              <p className="mt-1.5 flex justify-between gap-3 font-mono text-[11px]">
                <span className="text-fg-dim">Gas</span>
                <span className="text-fg">
                  {detail.gasWanted
                    ? `${grouped(detail.gasUsed)} of ${grouped(detail.gasWanted)}`
                    : grouped(detail.gasUsed)}
                </span>
              </p>
            ) : null}
            {detail.memo ? (
              <p className="mt-1.5 font-mono text-[11px]">
                <span className="text-fg-dim">Memo </span>
                <TruncatedValue>{detail.memo}</TruncatedValue>
              </p>
            ) : null}
            {extraMessages.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1.5 border-t border-[var(--z-line)] pt-2">
                {extraMessages.map((message, index) => (
                  <li key={`${message.type}:${index}`} className="font-mono text-[10.5px]">
                    <span className="text-fg-dim">{message.type}</span>
                    <span className="mt-0.5 block text-fg">{message.summary}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

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

        {detail?.error ? (
          <Callout tone="danger" title="Why the chain refused it">
            <span className="break-words font-mono text-[10.5px]">{detail.error}</span>
          </Callout>
        ) : null}

        {transfer ? (
          <RouteSteps
            transfer={transfer}
            onCopyTxHash={(hash) => void copy(hash, "Hash copied")}
            onOpenSwap={onOpenSwap}
          />
        ) : detail && detail.packets.length > 0 ? (
          <PacketSteps detail={detail} onCopyTxHash={(hash) => void copy(hash, "Hash copied")} />
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

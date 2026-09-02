import {
  Button,
  Callout,
  EmptyState,
  KeyValueRow,
  ScreenScaffold,
  SectionLabel,
  cn,
  truncateAddress,
} from "@zunialab/ui";
import type { ApprovalRequest } from "../../../lib/approvals";
import type { SessionStatus } from "../../../lib/session";
import type { SignSafetySummary } from "../../../lib/signing";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import { IconCheck, IconGlobe, IconShield } from "./icons";

function summaryFrom(approval: ApprovalRequest): SignSafetySummary | null {
  const detail = approval.detail as { summary?: SignSafetySummary } | undefined;
  return detail?.summary ?? null;
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^https?:\/\//, "");
  }
}

const KIND_LABEL: Record<ApprovalRequest["kind"], string> = {
  enable: "Connection request",
  signAmino: "Signature request",
  signDirect: "Signature request",
  sendTx: "Broadcast request",
  suggestChain: "Add network request",
};

function OriginHeader({
  origin,
  chainIds,
  kind,
  queued,
}: {
  origin: string;
  chainIds: string[];
  kind: ApprovalRequest["kind"];
  queued: number;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--z-line)] px-4 pb-3 pt-3">
      <div className="flex items-center gap-2">
        <SectionLabel>{KIND_LABEL[kind]}</SectionLabel>
        {queued > 1 ? (
          <span className="ml-auto rounded-full border border-[var(--z-line)] px-2 py-[2px] font-mono text-[9px] uppercase tracking-[0.08em] text-fg-dim">
            +{queued - 1} queued
          </span>
        ) : null}
      </div>
      <div className="flex items-center gap-2.5">
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted">
          <IconGlobe width={18} height={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-fg">
            {hostOf(origin)}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
            {chainIds
              .map((id) => findCatalogEntry(id)?.chainName ?? id)
              .join(" · ")}
          </span>
        </span>
      </div>
    </div>
  );
}

export function ApproveScreen({
  approvals,
  status,
  onDone,
}: {
  approvals: ApprovalRequest[];
  status: SessionStatus;
  onDone: () => void;
}) {
  const current = approvals[0];
  const active =
    status.accounts.find((a) => a.index === status.activeAccountIndex) ??
    status.accounts[0];

  if (!current) {
    return (
      <ScreenScaffold
        title="Requests"
        onBack={onDone}
        footer={
          <Button className="w-full" size="lg" onClick={onDone}>
            Back to wallet
          </Button>
        }
      >
        <EmptyState
          icon={<IconCheck width={16} height={16} />}
          title="Nothing to approve"
          description="Connection and signature requests from dApps land here."
        />
      </ScreenScaffold>
    );
  }

  const summary = summaryFrom(current);
  const warnings = current.warnings ?? summary?.warnings ?? [];
  const blocked = Boolean(summary?.requiresBlindSigning);

  async function approve() {
    await sendToBackground("RESOLVE_APPROVAL", {
      id: current!.id,
      result: { approved: true },
    });
    onDone();
  }

  async function reject() {
    await sendToBackground("REJECT_APPROVAL", {
      id: current!.id,
      reason: "User rejected",
    });
    onDone();
  }

  return (
    <ScreenScaffold
      header={
        <OriginHeader
          origin={current.origin}
          chainIds={current.chainIds}
          kind={current.kind}
          queued={approvals.length}
        />
      }
      footer={
        <div className="flex gap-2">
          <Button
            variant="secondary"
            className="flex-1"
            size="lg"
            onClick={() => void reject()}
          >
            Reject
          </Button>
          <Button
            className="flex-[1.4]"
            size="lg"
            disabled={blocked}
            onClick={() => void approve()}
          >
            Approve
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3.5 pt-3.5">
        <h1 className="text-[17px] font-medium leading-tight tracking-[-0.025em] text-fg">
          {summary && summary.messages.length > 0
            ? `Approve ${summary.messages.length} message${summary.messages.length === 1 ? "" : "s"}`
            : current.title}
        </h1>

        {blocked ? (
          <Callout tone="danger" title="Blind signing required">
            This request contains messages Zunia could not decode. Turn on blind
            signing in Settings if you trust this dApp, or reject.
          </Callout>
        ) : null}

        {warnings.length > 0 && !blocked ? (
          <Callout tone="warning" title="Check before approving">
            <ul className="flex flex-col gap-1">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Callout>
        ) : null}

        {summary && summary.messages.length > 0 ? (
          <ol className="flex flex-col gap-2">
            {summary.messages.map((message, i) => (
              <li
                key={`${message.type}-${i}`}
                className={cn(
                  "flex gap-2.5 rounded-[14px] border px-3 py-2.5",
                  message.unknown
                    ? "border-[var(--z-danger-line)] bg-[var(--z-danger-fill)]"
                    : "border-[var(--z-line)] bg-[var(--z-glass)]",
                )}
              >
                <span className="flex size-[18px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] font-mono text-[9px] text-fg-dim">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] leading-snug text-fg">
                    {message.summary}
                  </span>
                  <span className="mt-1 block truncate font-mono text-[9.5px] text-fg-dim">
                    {message.type}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] px-3 py-3">
          <KeyValueRow
            label="Wallet"
            value={
              active
                ? `${active.name} · ${truncateAddress(active.address, 8, 4)}`
                : "—"
            }
          />
          {summary?.fees.map((fee) => (
            <KeyValueRow key={fee.label} label={fee.label} value={fee.value} />
          ))}
          {summary?.memo ? (
            <KeyValueRow label="Memo" value={summary.memo} />
          ) : null}
        </div>

        <p className="flex items-center justify-center gap-1.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          <IconShield width={16} height={16} />
          Signed locally, key never leaves this device
        </p>
      </div>
    </ScreenScaffold>
  );
}

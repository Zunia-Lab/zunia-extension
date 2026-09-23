import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  KeyValueRow,
  PasswordInput,
  ScreenScaffold,
  SectionLabel,
  cn,
  truncateAddress,
} from "@zunialab/ui";
import { SIGNING_KINDS, type ApprovalRequest } from "../../../lib/approvals";
import type { CustomChainDraft } from "../../../lib/chain-draft";
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
  signArbitrary: "Message signature",
  sendTx: "Broadcast request",
  suggestChain: "Add network request",
};

/**
 * What approving actually does, spelled out on the screen. Users read "Approve"
 * as "the transfer happens"; for every kind Zunia handles, it does not. The
 * dApp is the one that talks to the network.
 *
 * sendTx is absent on purpose: it cannot be approved at all, and says so in a
 * danger Callout instead.
 */
const KIND_EFFECT: Partial<Record<ApprovalRequest["kind"], string>> = {
  enable:
    "Approving lets this site read your addresses on these networks. It cannot move funds, and nothing is signed.",
  signAmino:
    "Approving signs this transaction and returns the signature to the site. Zunia does not broadcast it; the site submits it to the network.",
  signDirect:
    "Approving signs this transaction and returns the signature to the site. Zunia does not broadcast it; the site submits it to the network.",
  signArbitrary:
    "Approving signs this off-chain message (ADR-36) and returns the signature to the site. It cannot move funds by itself.",
  suggestChain:
    "Approving adds this network to your wallet. Nothing is signed and no funds move.",
};

function useSecondsLeft(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!expiresAt) return null;
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function OriginHeader({
  origin,
  chainIds,
  kind,
  queued,
  secondsLeft,
}: {
  origin: string;
  chainIds: string[];
  kind: ApprovalRequest["kind"];
  queued: number;
  secondsLeft: number | null;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--z-line)] px-4 pb-3 pt-3">
      <div className="flex items-center gap-2">
        <SectionLabel>{KIND_LABEL[kind]}</SectionLabel>
        <span className="ml-auto flex items-center gap-1.5">
          {secondsLeft !== null ? (
            <span
              className={cn(
                "font-mono text-[9px] uppercase tracking-[0.08em]",
                secondsLeft <= 30 ? "text-[var(--z-warning-fg)]" : "text-fg-dim",
              )}
              aria-label={`Expires in ${formatCountdown(secondsLeft)}`}
            >
              {formatCountdown(secondsLeft)}
            </span>
          ) : null}
          {queued > 1 ? (
            <span className="rounded-full border border-[var(--z-line)] px-2 py-[2px] font-mono text-[9px] uppercase tracking-[0.08em] text-fg-dim">
              +{queued - 1} queued
            </span>
          ) : null}
        </span>
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

function SuggestedChainDetails({ draft }: { draft: CustomChainDraft }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] px-3 py-3">
      <KeyValueRow label="Name" value={draft.chainName} />
      <KeyValueRow label="Chain ID" value={draft.chainId} />
      <KeyValueRow label="Token" value={`${draft.coinDenom} (${draft.coinMinimalDenom}, ${draft.coinDecimals} decimals)`} />
      <KeyValueRow label="Address prefix" value={draft.bech32Prefix} />
      <KeyValueRow label="Coin type" value={String(draft.coinType)} />
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-fg-dim">RPC</span>
        <span className="break-all font-mono text-[10.5px] text-fg">{draft.rpc}</span>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-fg-dim">REST</span>
        <span className="break-all font-mono text-[10.5px] text-fg">{draft.rest}</span>
      </div>
    </div>
  );
}

export function ApproveScreen({
  approvals,
  status,
  requirePassword,
  onDone,
}: {
  approvals: ApprovalRequest[];
  status: SessionStatus;
  requirePassword: boolean;
  onDone: () => void;
}) {
  const current = approvals[0];
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const secondsLeft = useSecondsLeft(current?.expiresAt);
  const currentId = current?.id;

  // Each request starts clean: an error or a typed password never carries over
  // to the next one in the queue.
  const [shownId, setShownId] = useState(currentId);
  if (shownId !== currentId) {
    setShownId(currentId);
    setPassword("");
    setError(null);
    setBusy(null);
  }

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
  // sendTx is refused in lib/provider-handler.ts before it can reach this
  // queue, so this branch should never render. It stays because the kind is
  // still part of the approval type: if one ever arrives, the screen has to say
  // it cannot be approved rather than offer a button that broadcasts nothing.
  const unsupported = current.kind === "sendTx";
  const blocked = Boolean(summary?.requiresBlindSigning);
  const effect = KIND_EFFECT[current.kind];
  const needsPassword = requirePassword && SIGNING_KINDS.has(current.kind);
  const signer = (current.detail as { signer?: unknown } | undefined)?.signer;
  const draft = (current.detail as { draft?: CustomChainDraft } | undefined)?.draft;
  const expired = secondsLeft === 0;

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      await sendToBackground("RESOLVE_APPROVAL", {
        id: current!.id,
        result: { approved: true },
        password: needsPassword ? password : undefined,
      });
      setPassword("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    try {
      await sendToBackground("REJECT_APPROVAL", {
        id: current!.id,
        reason: "User rejected",
      });
    } catch {
      // Already gone from the queue (expired, or the tab closed): nothing left to reject.
    }
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
          secondsLeft={secondsLeft}
        />
      }
      footer={
        unsupported ? (
          <Button
            variant="secondary"
            className="w-full"
            size="lg"
            onClick={() => void reject()}
          >
            Reject request
          </Button>
        ) : (
          <div className="flex flex-col gap-2.5">
            {needsPassword && !blocked ? (
              <PasswordInput
                aria-label="Password to sign"
                placeholder="Password to sign"
                value={password}
                state={error ? "error" : "default"}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && password && !busy) void approve();
                }}
              />
            ) : null}
            {error ? (
              <p role="alert" className="text-[11.5px] text-[var(--z-danger-fg)]">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                size="lg"
                loading={busy === "reject"}
                disabled={busy !== null}
                onClick={() => void reject()}
              >
                Reject
              </Button>
              <Button
                className="flex-[1.4]"
                size="lg"
                loading={busy === "approve"}
                disabled={
                  blocked || expired || busy !== null || (needsPassword && !password)
                }
                onClick={() => void approve()}
              >
                {needsPassword ? "Sign" : "Approve"}
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="flex flex-col gap-3.5 pt-3.5">
        <h1 className="text-[17px] font-medium leading-tight tracking-[-0.025em] text-fg">
          {summary && summary.messages.length > 0
            ? `Approve ${summary.messages.length} message${summary.messages.length === 1 ? "" : "s"}`
            : current.title}
        </h1>

        {unsupported ? (
          <Callout tone="danger" title="Zunia cannot broadcast transactions yet">
            This site asked Zunia to submit a signed transaction to the network.
            That path does not exist, so there is nothing to approve here and
            nothing has been sent. Reject the request and let the site broadcast
            the signature itself.
          </Callout>
        ) : null}

        {expired ? (
          <Callout tone="warning" title="This request expired">
            Nothing was signed. Ask the site to send the request again.
          </Callout>
        ) : null}

        {effect ? (
          <p className="text-[length:var(--z-type-meta)] leading-[1.5] text-fg-muted">
            {effect}
          </p>
        ) : null}

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

        {draft ? <SuggestedChainDetails draft={draft} /> : null}

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
                  {message.type ? (
                    <span className="mt-1 block truncate font-mono text-[9.5px] text-fg-dim">
                      {message.type}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}

        {current.kind === "signArbitrary" ? (
          <div className="rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-2.5">
            <div className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-fg-dim">
              Message
            </div>
            <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-fg">
              {String(
                (current.detail as { preview?: string } | undefined)?.preview ??
                  "",
              )}
            </pre>
          </div>
        ) : null}

        {current.kind !== "suggestChain" ? (
          <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] px-3 py-3">
            <KeyValueRow
              label="Wallet"
              value={
                active
                  ? `${active.name} · ${truncateAddress(
                      typeof signer === "string" ? signer : active.address,
                      8,
                      4,
                    )}`
                  : "No account"
              }
            />
            {summary?.fees.map((fee) => (
              <KeyValueRow key={fee.label} label={fee.label} value={fee.value} />
            ))}
            {summary?.memo ? (
              <KeyValueRow label="Memo" value={summary.memo} />
            ) : null}
          </div>
        ) : null}

        <p className="flex items-center justify-center gap-1.5 pb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          <IconShield width={16} height={16} />
          Signed locally, key never leaves this device
        </p>
      </div>
    </ScreenScaffold>
  );
}

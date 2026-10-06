/**
 * The pieces every transaction screen is built from, so a send, a transfer, a
 * swap, a stake or an NFT reads the same way:
 *
 * - before signing, one card with what matters (what leaves, what arrives,
 *   the fees), then everything else about the transaction folded into
 *   sections that start closed ({@link ReviewDisclosure});
 * - what stops the signature, never folded ({@link ReviewProblems});
 * - after signing, one status (`Confirming`, `Sent`, `Failed`) with the
 *   amount and the hash ({@link TxStatusHero}), and for a cross-chain route
 *   where the funds are now and what comes next ({@link TransferProgress}).
 *
 * Presentational only: every number and sentence comes from the screen,
 * which reads it from the messages it signs.
 */

import { useState, type ReactNode } from "react";
import {
  Button,
  Callout,
  KeyValueRow,
  PacketTracker,
  Spinner,
  cn,
  focusRing,
  formatApproxDuration,
  packetFundsSummary,
  resolveHopStatus,
  toneStyle,
  truncateAddress,
  type PacketFundsSummary,
} from "@zunialab/ui";

import type { TrackedRoute } from "../../../lib/packet-tracking";
import type { TokenIdentity } from "../../../lib/token-identity";
import { IconCheck, IconChevronDown, IconCopy } from "../screens/icons";
import { TokenAvatar } from "./TokenLabel";

/* -------------------------------------------------------------------------- *
 * Before signing
 * -------------------------------------------------------------------------- */

/** The summary card: the essentials of a transaction, on one surface. */
export function ReviewCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3 py-3", className)}>
      {children}
    </section>
  );
}

/**
 * One side of a transaction: what it is (`You pay`, `You send`, `To`), the
 * token's logo (or another picture, for an NFT or a validator), the amount in
 * large type, and a line under it saying where.
 */
export function ReviewAmount({
  label,
  identity = null,
  avatar = null,
  amount,
  line = null,
  srNote = null,
}: {
  label: string;
  /** Draws the token's logo with its location badge. */
  identity?: TokenIdentity | null;
  /** Any other picture, used when there is no token identity. */
  avatar?: ReactNode;
  amount: ReactNode;
  line?: ReactNode;
  /** Said to assistive tech only: a seal the logo draws. */
  srNote?: string | null;
}) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">{label}</p>
      <div className="mt-1.5 flex items-center gap-2.5">
        {identity ? <TokenAvatar identity={identity} size={32} locationBadge="always" /> : avatar}
        <div className="min-w-0 flex-1">
          <p className="text-[18px] font-semibold leading-tight tracking-[-0.03em] tabular-nums text-fg [overflow-wrap:anywhere]">
            {amount}
          </p>
          {line ? (
            <p className="mt-0.5 text-[10.5px] leading-snug text-fg-dim [overflow-wrap:anywhere]">{line}</p>
          ) : null}
          {srNote ? <span className="sr-only">{srNote}</span> : null}
        </div>
      </div>
    </div>
  );
}

/** The divider between what leaves and what arrives. */
export function ReviewArrow() {
  return (
    <div className="my-2.5 flex items-center" aria-hidden="true">
      <span className="h-px flex-1 bg-[var(--z-line)]" />
      <span className="mx-2 flex size-6 items-center justify-center rounded-full border border-[var(--z-line)] bg-[var(--z-surface)] text-fg-muted">
        <IconChevronDown width={13} height={13} />
      </span>
      <span className="h-px flex-1 bg-[var(--z-line)]" />
    </div>
  );
}

/** The facts under the sides: a thin rule, then one {@link ReviewFact} per line. */
export function ReviewFacts({ children }: { children: ReactNode }) {
  return <div className="mt-3 flex flex-col gap-1.5 border-t border-[var(--z-line)] pt-2.5">{children}</div>;
}

/** One line of a summary: what it is on the left, the value on the right, a quiet note under it. */
export function ReviewFact({
  label,
  children,
  note = null,
}: {
  label: string;
  children: ReactNode;
  note?: string | null;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3">
      <span className="shrink-0 text-[11.5px] text-fg-muted">{label}</span>
      <span className="flex min-w-0 flex-col items-end text-right">
        <span className="max-w-full text-[11.5px] font-medium tabular-nums text-fg [overflow-wrap:anywhere]">
          {children}
        </span>
        {note ? <span className="text-[10px] leading-snug text-fg-dim [overflow-wrap:anywhere]">{note}</span> : null}
      </span>
    </div>
  );
}

/**
 * A section that opens on demand and starts closed: a native `<details>`, so
 * the keyboard and assistive tech open it with no script, and what is inside
 * stays in the page for anyone who wants to read it.
 */
export function ReviewDisclosure({
  title,
  hint = null,
  children,
}: {
  title: string;
  /** Beside the title, quieter: what is inside, in a word or two. */
  hint?: string | null;
  children: ReactNode;
}) {
  return (
    <details className="group min-w-0 rounded-[12px] border border-[var(--z-line)]">
      <summary
        className={cn(
          "flex cursor-pointer select-none list-none items-center justify-between gap-2 rounded-[12px] px-3 py-2.5",
          "text-[12px] font-medium text-fg-muted transition-colors duration-[var(--z-duration-base)] hover:text-fg",
          "[&::-webkit-details-marker]:hidden",
          focusRing,
        )}
      >
        <span className="min-w-0">{title}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          {hint ? <span className="text-[10.5px] font-normal text-fg-dim">{hint}</span> : null}
          <IconChevronDown
            width={14}
            height={14}
            aria-hidden
            className="transition-transform duration-[var(--z-duration-base)] group-open:rotate-180"
          />
        </span>
      </summary>
      <div className="flex min-w-0 flex-col gap-2 px-3 pb-3">{children}</div>
    </details>
  );
}

/** A plain row inside a folded section: a label and a value that may be long (an address, a denom). */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <KeyValueRow label={label} value={children} />;
}

/** What stops the signature, said where it cannot be missed: above the folded details, never inside them. */
export function ReviewProblems({ problems }: { problems: readonly string[] }) {
  if (problems.length === 0) return null;
  return (
    <Callout compact tone="danger" title="Zunia will not sign this">
      <ul className="flex flex-col gap-0.5">
        {problems.map((problem) => (
          <li key={problem} className="text-[10.5px] leading-snug">
            {problem}
          </li>
        ))}
      </ul>
    </Callout>
  );
}

/** Back, and the action, with the reason it is off as its label when it is. */
export function ConfirmFooter({
  busy,
  label = null,
  action = "Sign and send",
  disabled = false,
  onBack,
  onSign,
}: {
  busy: boolean;
  /** The short reason signing is blocked; `null` when it is not. */
  label?: string | null;
  /** What the button says when it can be pressed. */
  action?: string;
  disabled?: boolean;
  onBack: () => void;
  onSign: () => void;
}) {
  return (
    <div className="flex gap-2">
      <Button variant="secondary" className="flex-1" disabled={busy} onClick={onBack}>
        Back
      </Button>
      <Button className="flex-1" disabled={busy || disabled} onClick={onSign}>
        {busy ? "Signing…" : (label ?? action)}
      </Button>
    </div>
  );
}

/** The kernel's own line for each message, exactly as it will be signed, and the memo. */
export function ExactMessages({ summaries, memo = "" }: { summaries: readonly string[]; memo?: string }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
        {summaries.length > 1 ? "Exact messages" : "Exact message"}
      </p>
      {summaries.map((line, index) => (
        <p
          key={index}
          className="mt-0.5 min-w-0 break-words font-mono text-[10.5px] leading-snug text-fg [overflow-wrap:anywhere]"
        >
          {line}
        </p>
      ))}
      {memo ? (
        <div className="mt-1.5">
          <KeyValueRow label="Memo" value={memo} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The transaction as one JSON text, for whoever wants to check it by hand:
 * the chain, the memo, the fee and every message.
 */
export function rawTxJson(args: {
  readonly chainId: string;
  readonly memo: string;
  readonly fee: unknown;
  readonly messages: readonly unknown[];
}): string {
  return JSON.stringify(
    { chain_id: args.chainId, memo: args.memo, fee: args.fee, messages: args.messages },
    null,
    2,
  );
}

/** The raw transaction, folded: monospace, scrollable, selectable. */
export function RawTxDisclosure({ json }: { json: string }) {
  return (
    <ReviewDisclosure title="Raw transaction" hint="JSON">
      <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[8px] bg-[var(--z-surface-sunken)] p-2 font-mono text-[10px] leading-snug text-fg">
        {json}
      </pre>
    </ReviewDisclosure>
  );
}

/* -------------------------------------------------------------------------- *
 * After signing
 * -------------------------------------------------------------------------- */

/**
 * Where a signed transaction stands:
 * - `pending`: broadcast, and not in a block yet;
 * - `submitted`: accepted by a node, and not followed further here;
 * - `success`: included, and the chain says it worked;
 * - `failed`: rejected, or included with an error.
 */
export type TxStatus = "pending" | "submitted" | "success" | "failed";

function StatusBadge({ status }: { status: TxStatus }) {
  if (status === "pending") {
    return (
      <div className="relative flex size-[64px] items-center justify-center" aria-hidden="true">
        <span className="absolute inset-0 rounded-full border border-[var(--z-line)]" />
        <span className="absolute inset-[5px] animate-spin rounded-full border-2 border-transparent border-t-accent" />
        <Spinner className="size-5 text-accent" />
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className={cn(
        "flex size-[64px] items-center justify-center rounded-full",
        status === "failed"
          ? "bg-[var(--z-danger-fill)] text-[var(--z-danger)]"
          : status === "success"
            ? "bg-[var(--z-success-fill)] text-[var(--z-success)]"
            : "bg-[var(--z-glass)] text-accent",
      )}
    >
      {status === "failed" ? (
        <span className="text-[26px] font-semibold leading-none">!</span>
      ) : (
        <IconCheck width={28} height={28} />
      )}
    </div>
  );
}

/** A transaction hash, short on screen and whole in the clipboard and its tooltip. */
export function TxHashLine({ txHash, onCopy }: { txHash: string; onCopy?: (txHash: string) => void }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    if (onCopy) {
      onCopy(txHash);
      return;
    }
    try {
      await navigator.clipboard.writeText(txHash);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // The full hash stays in the tooltip.
    }
  }
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={txHash}
      aria-label={`Copy the transaction hash: ${txHash}`}
      className={cn(
        "mt-4 inline-flex items-center gap-1.5 rounded-full border border-[var(--z-line)] px-2.5 py-1 font-mono text-[10px] text-fg-muted",
        "transition-colors duration-[var(--z-duration-base)] hover:text-fg",
        focusRing,
      )}
    >
      {truncateAddress(txHash, 8, 6)}
      {copied ? <IconCheck width={11} height={11} aria-hidden /> : <IconCopy width={11} height={11} aria-hidden />}
    </button>
  );
}

/**
 * A chain's error in plain words, for the result screen, with the chain's own
 * text kept as the detail. The patterns are the Cosmos SDK's and Osmosis's own
 * messages; anything else is shown as the chain wrote it.
 */
export function explainTxError(raw: string): { readonly message: string; readonly detail: string | null } {
  const text = raw.trim();
  const rules: readonly [RegExp, string][] = [
    [
      /lesser than min amount|price impact protection|slippage/i,
      "The price moved more than your slippage allows before the swap ran, so the chain refused it. Nothing was swapped, and no fee was taken.",
    ],
    [/insufficient fee/i, "The network fee was too low for this chain right now. Try again with a higher gas speed."],
    [/out of gas/i, "The transaction ran out of gas. Try again with a higher gas adjustment."],
    [
      /insufficient funds|is smaller than|spendable balance/i,
      "There was not enough balance for the amount and the network fee. Nothing moved.",
    ],
    [/account sequence mismatch|incorrect account sequence/i, "Another transaction from this account went first. Try again."],
    [/timed? ?out|deadline exceeded/i, "The network did not answer in time. Check Activity before trying again: it may still go through."],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(text)) return { message, detail: text || null };
  }
  return { message: text || "The chain refused this transaction.", detail: null };
}

/**
 * The result of a transaction, centred: its status, the amount it moved, one
 * sentence about what that means, and its hash. Nothing that needs reading
 * twice; the explorer is a button under it (ResultFooter), and the details
 * live on the transaction's own page in Activity.
 */
export function TxStatusHero({
  status,
  title,
  amount = null,
  line = null,
  message = null,
  errorDetail = null,
  txHash = null,
  onCopyHash,
}: {
  status: TxStatus;
  title: string;
  /** The amount moved, large. */
  amount?: ReactNode;
  /** Under the amount: where it went (`Osmosis → Injective`, `To osmo1…`). */
  line?: ReactNode;
  /** One sentence: what the status means for the funds. */
  message?: ReactNode;
  /** The chain's own error text, folded under the message ({@link explainTxError}). */
  errorDetail?: string | null;
  txHash?: string | null;
  onCopyHash?: (txHash: string) => void;
}) {
  return (
    <div className="flex flex-col items-center px-2 pt-7 text-center" role="status" aria-live="polite">
      <StatusBadge status={status} />
      <p className="mt-4 text-[17px] font-semibold tracking-tight text-fg">{title}</p>
      {amount ? (
        <p className="mt-2 max-w-full text-[22px] font-semibold leading-tight tracking-[-0.03em] tabular-nums text-fg [overflow-wrap:anywhere]">
          {amount}
        </p>
      ) : null}
      {line ? (
        <p className="mt-1 max-w-[280px] text-[11px] leading-snug text-fg-muted [overflow-wrap:anywhere]">{line}</p>
      ) : null}
      {message ? (
        <p
          className={cn(
            "mt-3 max-w-[280px] text-[12px] leading-snug [overflow-wrap:anywhere]",
            status === "failed" ? "text-[var(--z-danger)]" : "text-fg-muted",
          )}
        >
          {message}
        </p>
      ) : null}
      {errorDetail ? (
        <details className="group mt-2 max-w-[280px] text-left">
          <summary
            className={cn(
              "flex cursor-pointer list-none items-center justify-center gap-1 text-[10.5px] text-fg-dim hover:text-fg-muted",
              "[&::-webkit-details-marker]:hidden",
              focusRing,
            )}
          >
            The chain's error
            <IconChevronDown width={11} height={11} aria-hidden className="transition-transform group-open:rotate-180" />
          </summary>
          <p className="mt-1 break-words font-mono text-[10px] leading-snug text-fg-muted [overflow-wrap:anywhere]">
            {errorDetail}
          </p>
        </details>
      ) : null}
      {txHash ? <TxHashLine txHash={txHash} {...(onCopyHash ? { onCopy: onCopyHash } : {})} /> : null}
    </div>
  );
}

/** The result screen's buttons: the explorer when there is one, and Done. */
export function ResultFooter({ explorerUrl = null, onDone }: { explorerUrl?: string | null; onDone: () => void }) {
  return (
    <div className="flex gap-2">
      {explorerUrl ? (
        <Button variant="secondary" className="flex-1" asChild>
          <a href={explorerUrl} target="_blank" rel="noreferrer noopener">
            View on explorer
          </a>
        </Button>
      ) : null}
      <Button className="flex-1" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * A route in flight
 * -------------------------------------------------------------------------- */

type StepState = "done" | "current" | "waiting" | "error";

/** Each place the funds pass, in order: the chain that signed, then each chain a hop delivers to. */
export function routeSteps(
  route: Pick<TrackedRoute, "hops" | "failure"> | null,
  sourceChainName: string,
  destChainName: string,
): { readonly label: string; readonly state: StepState }[] {
  if (!route || route.hops.length === 0) {
    const failed = route?.failure === "source-failed";
    return [
      { label: sourceChainName, state: failed ? "error" : "current" },
      { label: destChainName, state: "waiting" },
    ];
  }
  const steps: { label: string; state: StepState }[] = [
    { label: route.hops[0]?.chainName ?? sourceChainName, state: "done" },
  ];
  let blocked = false;
  for (const hop of route.hops) {
    const status = resolveHopStatus(hop.status, hop.stalled);
    const label = hop.counterpartyChainName ?? hop.counterpartyChainId ?? destChainName;
    let state: StepState;
    if (blocked) state = "waiting";
    else if (status === "received" || status === "acknowledged") state = "done";
    else if (status === "failed" || status === "timeout") state = "error";
    else state = "current";
    if (state !== "done") blocked = true;
    steps.push({ label, state });
  }
  return steps;
}

function StepDot({ state }: { state: StepState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-[18px] shrink-0 items-center justify-center rounded-full border text-[10px] leading-none",
        state === "done" && "border-transparent bg-[var(--z-success-fill)] text-[var(--z-success)]",
        state === "current" && "border-accent text-accent",
        state === "waiting" && "border-[var(--z-line)] text-fg-dim",
        state === "error" && "border-transparent bg-[var(--z-danger-fill)] text-[var(--z-danger)]",
      )}
    >
      {state === "done" ? (
        <IconCheck width={11} height={11} />
      ) : state === "error" ? (
        "!"
      ) : state === "current" ? (
        <span className="size-1.5 animate-pulse rounded-full bg-accent" />
      ) : null}
    </span>
  );
}

/** The route as a row of steps: each chain, and how far the funds got. */
function RouteSteps({ steps }: { steps: readonly { label: string; state: StepState }[] }) {
  return (
    <ol className="mt-3 flex min-w-0 items-start">
      {steps.map((step, index) => (
        <li key={`${step.label}-${index}`} className="flex min-w-0 flex-1 flex-col items-center last:flex-none">
          <div className="flex w-full min-w-0 items-center">
            <StepDot state={step.state} />
            {index < steps.length - 1 ? (
              <span
                aria-hidden="true"
                className={cn(
                  "mx-1 h-px flex-1",
                  step.state === "done" ? "bg-[var(--z-success)]" : "bg-[var(--z-line)]",
                )}
              />
            ) : null}
          </div>
          <span
            className={cn(
              "mt-1 w-full truncate text-left text-[10px] leading-snug",
              step.state === "waiting" ? "text-fg-dim" : "text-fg-muted",
            )}
          >
            <span className="sr-only">
              {step.state === "done"
                ? "Done: "
                : step.state === "error"
                  ? "Failed: "
                  : step.state === "current"
                    ? "In progress: "
                    : "Next: "}
            </span>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The headline of a route in flight, from the same summary the tracker uses. */
export function routeHeadline(route: TrackedRoute | null, recoveryReady: boolean): PacketFundsSummary {
  return packetFundsSummary(
    (route?.hops ?? []).map((hop) => ({ status: resolveHopStatus(hop.status, hop.stalled) })),
    { failure: route?.failure ?? null, recoveryReady },
  );
}

/**
 * A cross-chain transfer or swap after signing: where the funds are (one
 * headline, in the tracker's own words), the amount and the two ends, the
 * route as steps, and how long is left. A recovery the user has to start is
 * a button here, not a line in the details. The full tracker (channels,
 * sequences, every hash) is folded under "Transfer details".
 */
export function TransferProgress({
  amount,
  identity = null,
  fromChainName,
  toChainName,
  route,
  loading,
  error,
  onRefresh,
  txHash,
  sourceChainId,
  txUrl,
  recoveryReady = false,
  onRecover,
  recoverDisabledReason,
}: {
  /** What left, as the screen names it: `10 OSMO`. */
  amount: string;
  identity?: TokenIdentity | null;
  fromChainName: string;
  toChainName: string;
  route: TrackedRoute | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  txHash: string;
  sourceChainId: string;
  txUrl: (chainId: string, txHash: string) => string | null;
  recoveryReady?: boolean;
  onRecover?: () => void;
  recoverDisabledReason?: string | null;
}) {
  const headline = routeHeadline(route, recoveryReady);
  const tone = toneStyle(headline.tone);
  const steps = routeSteps(route, fromChainName, toChainName);
  const remaining =
    route && headline.state === "in-flight" && route.estimatedDurationSeconds > 0
      ? formatApproxDuration(Math.max(0, route.estimatedDurationSeconds - (route.elapsedSeconds ?? 0)))
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <ReviewCard>
        <div className="flex items-start gap-2.5" role="status" aria-live="polite">
          {identity ? <TokenAvatar identity={identity} size={32} locationBadge="always" /> : null}
          <div className="min-w-0 flex-1">
            <p className="text-[18px] font-semibold leading-tight tracking-[-0.03em] tabular-nums text-fg [overflow-wrap:anywhere]">
              {amount}
            </p>
            <p className="mt-0.5 text-[10.5px] leading-snug text-fg-dim">
              {fromChainName} → {toChainName}
            </p>
          </div>
          <span
            className="shrink-0 rounded-full border px-2 py-0.5 text-[10.5px] font-medium"
            style={{ color: tone.fg, background: tone.bg, borderColor: tone.border }}
          >
            {loading && !route ? "Checking…" : headline.title}
          </span>
        </div>
        <RouteSteps steps={steps} />
        <p className="mt-2.5 text-[11px] leading-snug text-fg-muted">
          {error ? "Zunia could not read the transfer's status just now. The transfer itself is unaffected." : headline.detail}
          {remaining ? ` About ${remaining} left.` : ""}
        </p>
        {headline.actionRequired && onRecover ? (
          <div className="mt-2.5 flex flex-col gap-1">
            <Button size="sm" onClick={onRecover} disabled={!recoveryReady || Boolean(recoverDisabledReason)}>
              Recover funds
            </Button>
            {recoverDisabledReason ? (
              <span className="text-[10px] leading-snug text-fg-muted">{recoverDisabledReason}</span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[9.5px] text-fg-dim">{truncateAddress(txHash, 8, 6)}</span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className={cn(
              "-mr-1.5 shrink-0 rounded-full px-1.5 py-0.5 font-mono text-[9.5px] text-accent",
              "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
              "disabled:cursor-not-allowed disabled:opacity-40",
              focusRing,
            )}
          >
            {loading ? "Checking…" : "Check again"}
          </button>
        </div>
      </ReviewCard>
      <ReviewDisclosure title="Transfer details" hint="hops, channels, hashes">
        <PacketTracker
          compact
          title={null}
          hops={route?.hops ?? []}
          sourceTxHash={txHash}
          sourceChainId={sourceChainId}
          failure={route?.failure ?? null}
          recoveryReady={recoveryReady}
          {...(onRecover ? { onRecover } : {})}
          {...(recoverDisabledReason ? { recoverDisabledReason } : {})}
          txUrl={txUrl}
          loading={loading && !route}
          error={error}
          lastUpdatedAt={route?.updatedAt ?? null}
        />
      </ReviewDisclosure>
    </div>
  );
}

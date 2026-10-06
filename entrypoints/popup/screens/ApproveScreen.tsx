import { useEffect, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  KeyValueRow,
  PasswordInput,
  ScreenScaffold,
  SectionLabel,
  Segmented,
  cn,
  truncateAddress,
} from "@zunialab/ui";
import { SIGNING_KINDS, type ApprovalRequest } from "../../../lib/approvals";
import type { CustomChainDraft } from "../../../lib/chain-draft";
import { exactCoinText } from "../../../lib/chain-queries";
import type { FeeChoice, FeeTier } from "../../../lib/fee-tiers";
import { assessOrigin } from "../../../lib/origin-risk";
import type { SessionStatus } from "../../../lib/session";
import type { SignInMessage } from "../../../lib/sign-in";
import type { SignSafetySummary } from "../../../lib/signing";
import { findCatalogEntry } from "../../../lib/chain-catalog";
import { sendToBackground } from "../../../lib/popup-client";
import { IconCheck, IconGlobe, IconShield } from "./icons";
import { RawTxDisclosure, ReviewDisclosure } from "../components/TxReview";

function summaryFrom(approval: ApprovalRequest): SignSafetySummary | null {
  const detail = approval.detail as { summary?: SignSafetySummary } | undefined;
  return detail?.summary ?? null;
}

/** A message signature the worker already matched to this site, chain and account. */
function signInFrom(approval: ApprovalRequest): { signIn: SignInMessage; message: string } | null {
  if (approval.kind !== "signArbitrary") return null;
  const detail = approval.detail as { signIn?: SignInMessage; message?: string } | undefined;
  return detail?.signIn ? { signIn: detail.signIn, message: detail.message ?? "" } : null;
}

function expiryLabel(iso: string): string {
  const minutes = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (minutes < 1) return "In less than a minute";
  if (minutes < 60) return `In ${minutes} min`;
  return new Date(iso).toLocaleString();
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

const SIGN_IN_EFFECT =
  "Signing proves to this site that you control this address. It is not a transaction: nothing is sent and no funds move.";

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

type FeePick = FeeTier | "site";

const FEE_OPTIONS: { value: FeePick; label: string }[] = [
  { value: "site", label: "Site" },
  { value: "low", label: "Low" },
  { value: "average", label: "Medium" },
  { value: "high", label: "High" },
];

const FEE_HINT: Record<FeePick, string> = {
  site: "The fee this site set.",
  low: "Cheapest. A busy network can refuse it.",
  average: "The network's usual price.",
  high: "Pays extra to get through a busy network.",
};

function feeChoiceFrom(approval: ApprovalRequest): FeeChoice | null {
  return (approval.detail as { feeChoice?: FeeChoice } | undefined)?.feeChoice ?? null;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function OriginHeader({
  origin,
  chainIds,
  label,
  queued,
  secondsLeft,
  suspicious,
  showSite = true,
}: {
  origin: string;
  chainIds: string[];
  label: string;
  queued: number;
  secondsLeft: number | null;
  suspicious: boolean;
  /** Connection requests draw the site in the body, so the header stays a single line. */
  showSite?: boolean;
}) {
  return (
    <div className={cn("flex flex-col px-4 pt-3", showSite ? "gap-3 border-b border-[var(--z-line)] pb-3" : "pb-1")}>
      <div className="flex items-center gap-2">
        <SectionLabel>{label}</SectionLabel>
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
      {showSite ? <div className="flex items-center gap-2.5">
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full border border-[var(--z-line)] text-fg-muted">
          <IconGlobe width={18} height={18} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              "block truncate text-[13.5px] font-medium",
              suspicious ? "text-[var(--z-danger-fg)]" : "text-fg",
            )}
          >
            {hostOf(origin)}
          </span>
          <span className="mt-0.5 block truncate font-mono text-[9.5px] text-fg-dim">
            {chainIds
              .map((id) => findCatalogEntry(id)?.chainName ?? id)
              .join(" · ")}
          </span>
        </span>
      </div> : null}
    </div>
  );
}

const LOCAL_SITE = "This is a site running on your own computer.";

function chainNames(chainIds: string[]): string {
  return chainIds.map((id) => findCatalogEntry(id)?.chainName ?? id).join(", ");
}

/** A connection has no transaction. One mark, the site, the account. */
function ConnectBody({
  origin,
  chainIds,
  accountName,
  address,
  local,
  warnings,
}: {
  origin: string;
  chainIds: string[];
  accountName: string;
  address: string;
  local: boolean;
  warnings: string[];
}) {
  return (
    <div className="flex flex-col items-center px-1 pt-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border border-[var(--z-line)] bg-[var(--z-glass)] text-fg">
        <IconGlobe width={22} height={22} />
      </span>
      <h1 className="mt-4 max-w-full truncate text-[20px] font-medium tracking-[-0.03em] text-fg">
        {hostOf(origin)}
      </h1>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-dim">
        {chainNames(chainIds)}
      </p>
      <p className="mt-4 max-w-[15.5rem] text-[13px] leading-relaxed text-fg-muted">
        This site can see your address. It cannot move funds.
      </p>
      {local ? (
        <p className="mt-2 text-[11.5px] text-fg-dim">Running on this computer.</p>
      ) : null}
      {warnings.length > 0 ? (
        <div className="mt-3 w-full text-left">
          <Callout compact tone="warning" title="Check before approving">
            <ul className="flex flex-col gap-0.5">
              {warnings.map((warning) => (
                <li key={warning} className="break-all leading-snug">
                  {warning}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}
      <div className="mt-5 w-full rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3 text-left">
        <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">Account</div>
        <div className="mt-1 truncate text-[13.5px] font-medium text-fg">{accountName}</div>
        {address ? <div className="mt-0.5 font-mono text-[11.5px] text-fg-muted">{address}</div> : null}
      </div>
    </div>
  );
}

/** Sign-in shows the site, the sentence, and the account. The raw message stays one tap away. */
function SignInBody({
  origin,
  network,
  statement,
  expires,
  accountName,
  address,
  local,
  warnings,
  message,
}: {
  origin: string;
  network: string;
  statement?: string;
  expires?: string;
  accountName: string;
  address: string;
  local: boolean;
  warnings: string[];
  message: string;
}) {
  return (
    <div className="flex flex-col items-center px-1 pt-6 text-center">
      <span className="flex size-12 items-center justify-center rounded-full border border-[var(--z-line)] bg-[var(--z-glass)] text-fg">
        <IconGlobe width={22} height={22} />
      </span>
      <h1 className="mt-4 max-w-full truncate text-[20px] font-medium tracking-[-0.03em] text-fg">
        {hostOf(origin)}
      </h1>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-dim">{network}</p>
      <p className="mt-4 max-w-[16rem] text-[13.5px] leading-relaxed text-fg">
        {statement || "Sign in with this account."}
      </p>
      <p className="mt-2 max-w-[16rem] text-[12.5px] leading-relaxed text-fg-muted">
        This proves you control the account below. Nothing is sent.
      </p>
      {local ? <p className="mt-2 text-[11.5px] text-fg-dim">Running on this computer.</p> : null}
      {warnings.length > 0 ? (
        <div className="mt-3 w-full text-left">
          <Callout compact tone="warning" title="Check before approving">
            <ul className="flex flex-col gap-0.5">
              {warnings.map((warning) => (
                <li key={warning} className="break-all leading-snug">
                  {warning}
                </li>
              ))}
            </ul>
          </Callout>
        </div>
      ) : null}
      <div className="mt-5 flex w-full flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3 text-left">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">Account</div>
          <div className="mt-1 truncate text-[13.5px] font-medium text-fg">{accountName}</div>
          {address ? <div className="mt-0.5 font-mono text-[11.5px] text-fg-muted">{address}</div> : null}
        </div>
        {expires ? (
          <div className="flex items-baseline justify-between gap-3 border-t border-[var(--z-line)] pt-2.5">
            <span className="text-[12px] text-fg-dim">Expires</span>
            <span className="text-[12.5px] text-fg">{expires}</span>
          </div>
        ) : null}
      </div>
      {message ? (
        <details className="mt-3 w-full rounded-[14px] border border-[var(--z-line)] px-3.5 py-2.5 text-left">
          <summary className="cursor-pointer select-none text-[12.5px] text-fg-muted">Show the signed message</summary>
          <pre className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug text-fg">
            {message}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function jsonFrom(approval: ApprovalRequest): string | null {
  const json = (approval.detail as { json?: unknown } | undefined)?.json;
  return typeof json === "string" && json.trim() ? json : null;
}

/** The transaction the site asks to sign, as JSON, folded like every review's raw transaction. */
function TxJson({ json }: { json: string }) {
  return <RawTxDisclosure json={json} />;
}

/** "Send 1 uosmo to osmo1..." splits so the address can wrap on its own line. */
function splitRecipient(summary: string): { lead: string; address?: string } {
  const at = summary.lastIndexOf(" to ");
  if (at < 0) return { lead: summary };
  const address = summary.slice(at + 4);
  if (!/^[a-z0-9]{20,}$/.test(address)) return { lead: summary };
  return { lead: summary.slice(0, at), address };
}

/**
 * The coins a message moves in words, under its raw summary and never in its
 * place: `= 12.34 USDC.n · Noble → on Osmosis · verified by channel`. The
 * worker writes these only for proven identities (lib/signing.ts), so an
 * unnamed or look-alike token shows its raw amount and denom alone.
 */
function ResolvedLines({ lines, className }: { lines: readonly string[] | undefined; className?: string }) {
  if (!lines || lines.length === 0) return null;
  return (
    <>
      {lines.map((line, index) => (
        <span
          key={`${index}:${line}`}
          className={cn("block leading-snug text-fg-muted [overflow-wrap:anywhere]", className)}
        >
          {line}
        </span>
      ))}
    </>
  );
}

/** A decoded signature: the action, who it pays, then the account. JSON stays closed. */
function SignTxBody({
  messages,
  resolved,
  accountName,
  address,
  fees,
  feeChoice,
  feePick,
  onFeePick,
  memo,
  json,
  local,
  warnings,
}: {
  messages: SignSafetySummary["messages"];
  /** Same order as `messages`; see {@link ResolvedLines}. */
  resolved: SignSafetySummary["resolved"];
  accountName: string;
  address: string;
  fees: Array<{ label: string; value: string }>;
  feeChoice: FeeChoice | null;
  feePick: FeePick;
  onFeePick: (pick: FeePick) => void;
  memo?: string;
  json: string | null;
  local: boolean;
  warnings: string[];
}) {
  const single = messages.length === 1 ? messages[0] : null;
  const split = single && !single.unknown ? splitRecipient(single.summary) : null;

  return (
    <div className="flex flex-col gap-3 pt-4">
      {split ? (
        <div>
          <h1 className="text-[20px] font-medium leading-tight tracking-[-0.03em] text-fg [overflow-wrap:anywhere]">
            {split.lead}
          </h1>
          <ResolvedLines lines={resolved?.[0]} className="mt-1.5 text-[12.5px]" />
          {split.address ? (
            <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
              to{" "}
              <span className="font-mono text-[12px] text-fg [overflow-wrap:anywhere]">{split.address}</span>
            </p>
          ) : null}
        </div>
      ) : (
        <>
          <h1 className="text-[18px] font-medium leading-tight tracking-[-0.03em] text-fg">
            {messages.length > 0
              ? `Approve ${messages.length} message${messages.length === 1 ? "" : "s"}`
              : "Sign transaction"}
          </h1>
          {messages.length > 0 ? (
            <ol className="flex flex-col gap-2">
              {messages.map((message, i) => (
                <li
                  key={`${message.type}-${i}`}
                  className={cn(
                    "rounded-[14px] border px-3.5 py-2.5",
                    message.unknown
                      ? "border-[var(--z-danger-line)] bg-[var(--z-danger-fill)]"
                      : "border-[var(--z-line)] bg-[var(--z-glass)]",
                  )}
                >
                  <span className="block text-[13px] leading-snug text-fg [overflow-wrap:anywhere]">
                    {message.summary}
                  </span>
                  <ResolvedLines lines={resolved?.[i]} className="mt-1 text-[11.5px]" />
                  {message.type ? (
                    <span className="mt-1 block truncate font-mono text-[10px] text-fg-dim">
                      {message.type}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </>
      )}

      <p className="text-[12.5px] leading-relaxed text-fg-muted">
        The site submits this signature to the network.
      </p>
      {local ? <p className="text-[11.5px] text-fg-dim">Running on this computer.</p> : null}
      {warnings.length > 0 ? (
        <Callout compact tone="warning" title="Check before approving">
          <ul className="flex flex-col gap-0.5">
            {warnings.map((warning) => (
              <li key={warning} className="break-all leading-snug">
                {warning}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div className="flex flex-col gap-2.5 rounded-[14px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3">
        <div>
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-fg-dim">Account</div>
          <div className="mt-1 truncate text-[13.5px] font-medium text-fg">{accountName}</div>
          {address ? (
            <div className="mt-0.5 font-mono text-[11px] text-fg-muted" title={address}>
              {truncateAddress(address, 12, 8)}
            </div>
          ) : null}
        </div>
        {fees.map((fee) => (
          <div
            key={fee.label}
            className="flex items-baseline justify-between gap-3 border-t border-[var(--z-line)] pt-2.5"
          >
            <span className="shrink-0 text-[12px] text-fg-dim">{fee.label}</span>
            {/* A fee nothing names keeps its full denom, which must wrap, not spill. */}
            <span className="min-w-0 text-right text-[12.5px] text-fg [overflow-wrap:anywhere]">
              {fee.value}
            </span>
          </div>
        ))}
        {feeChoice ? (
          <div className="flex flex-col gap-1.5 border-t border-[var(--z-line)] pt-2.5">
            <Segmented<FeePick>
              size="sm"
              className="w-full"
              options={FEE_OPTIONS}
              value={feePick}
              onChange={onFeePick}
            />
            <p className="text-[10.5px] leading-snug text-fg-dim">{FEE_HINT[feePick]}</p>
          </div>
        ) : null}
      </div>

      {address || memo ? (
        <ReviewDisclosure title="Transaction details" hint={memo ? "account, memo" : "account"}>
          {address ? <KeyValueRow label="Signs with" value={address} /> : null}
          {memo ? <KeyValueRow label="Memo" value={memo} /> : null}
        </ReviewDisclosure>
      ) : null}
      {json ? <TxJson json={json} /> : null}
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
  /** Called with the id of the request just answered, or nothing when leaving. */
  onDone: (answeredId?: string) => void;
}) {
  const current = approvals[0];
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [feePick, setFeePick] = useState<FeePick>("site");
  const secondsLeft = useSecondsLeft(current?.expiresAt);
  const currentId = current?.id;

  // Each request starts clean: an error, a typed password or a fee tier never
  // carries over to the next one in the queue.
  const [shownId, setShownId] = useState(currentId);
  if (shownId !== currentId) {
    setShownId(currentId);
    setPassword("");
    setError(null);
    setBusy(null);
    setFeePick("site");
  }

  const active =
    status.accounts.find((a) => a.index === status.activeAccountIndex) ??
    status.accounts[0];

  if (!current) {
    return (
      <ScreenScaffold
        title="Requests"
        onBack={() => onDone()}
        footer={
          <Button className="w-full" size="lg" onClick={() => onDone()}>
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
  const risk = assessOrigin(current.origin);
  const suspicious = risk.level === "suspicious";
  // The origin's own warnings get the banner; the rest stay in the list.
  const warnings = (current.warnings ?? summary?.warnings ?? []).filter(
    (warning) => !suspicious || !risk.warnings.includes(warning),
  );
  const feeChoice = feeChoiceFrom(current);
  const feeTier = feeChoice && feePick !== "site" ? feePick : null;
  // The fee coin named the way the worker named the site's fee: exact, and
  // in its full spelling when nothing names it.
  const feeChainId = current.chainIds[0] ?? summary?.chainId ?? "";
  const feeRows = (summary?.fees ?? []).map((row) =>
    row.label === "Fee" && feeChoice
      ? {
          ...row,
          value: exactCoinText(
            feeChainId,
            feeTier ? feeChoice.tiers[feeTier] : feeChoice.site,
            feeChoice.denom,
          ),
        }
      : row,
  );
  // sendTx is refused in lib/provider-handler.ts before it can reach this
  // queue, so this branch should never render. It stays because the kind is
  // still part of the approval type: if one ever arrives, the screen has to say
  // it cannot be approved rather than offer a button that broadcasts nothing.
  const unsupported = current.kind === "sendTx";
  const blocked = Boolean(summary?.requiresBlindSigning);
  const signIn = signInFrom(current);
  const txJson = jsonFrom(current);
  const localSite = warnings.includes(LOCAL_SITE);
  const restWarnings = localSite ? warnings.filter((warning) => warning !== LOCAL_SITE) : warnings;
  const effect = signIn ? SIGN_IN_EFFECT : KIND_EFFECT[current.kind];
  const needsPassword = requirePassword && SIGNING_KINDS.has(current.kind);
  const signer = (current.detail as { signer?: unknown } | undefined)?.signer;
  const draft = (current.detail as { draft?: CustomChainDraft } | undefined)?.draft;
  const expired = secondsLeft === 0;
  const connecting = current.kind === "enable" && !suspicious && !expired && !unsupported;
  const signingIn = Boolean(signIn) && !suspicious && !expired && !blocked;
  const signingTx =
    (current.kind === "signAmino" || current.kind === "signDirect") &&
    !suspicious &&
    !expired &&
    !blocked &&
    Boolean(summary && summary.messages.length > 0);

  async function approve() {
    setBusy("approve");
    setError(null);
    try {
      await sendToBackground("RESOLVE_APPROVAL", {
        id: current!.id,
        result: feeTier ? { approved: true, feeTier } : { approved: true },
        password: needsPassword ? password : undefined,
      });
      setPassword("");
      onDone(current!.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(null);
    }
  }

  async function reject() {
    setBusy("reject");
    try {
      await sendToBackground("REJECT_APPROVAL", { id: current!.id });
    } catch {
      // Already gone from the queue (expired, or the tab closed): nothing left to reject.
    }
    onDone(current!.id);
  }

  return (
    <ScreenScaffold
      header={
        <OriginHeader
          origin={current.origin}
          chainIds={current.chainIds}
          label={signIn ? "Sign-in request" : KIND_LABEL[current.kind]}
          queued={approvals.length}
          secondsLeft={secondsLeft}
          suspicious={suspicious}
          showSite={!connecting && !signingIn}
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
                {connecting ? "Connect" : signIn ? "Sign in" : needsPassword ? "Sign" : "Approve"}
              </Button>
            </div>
          </div>
        )
      }
    >
      {connecting ? (
        <ConnectBody
          origin={current.origin}
          chainIds={current.chainIds}
          accountName={active?.name ?? "No account"}
          address={
            active
              ? truncateAddress(typeof signer === "string" ? signer : active.address, 10, 6)
              : ""
          }
          local={localSite}
          warnings={restWarnings}
        />
      ) : signingIn && signIn ? (
        <SignInBody
          origin={current.origin}
          network={findCatalogEntry(signIn.signIn.chainId)?.chainName ?? signIn.signIn.chainId}
          statement={signIn.signIn.statement}
          expires={signIn.signIn.expirationTime ? expiryLabel(signIn.signIn.expirationTime) : undefined}
          accountName={active?.name ?? "No account"}
          address={
            active
              ? truncateAddress(typeof signer === "string" ? signer : active.address, 10, 6)
              : ""
          }
          local={localSite}
          warnings={restWarnings}
          message={signIn.message}
        />
      ) : signingTx && summary ? (
        <SignTxBody
          messages={summary.messages}
          resolved={summary.resolved}
          accountName={active?.name ?? "No account"}
          address={
            active
              ? truncateAddress(typeof signer === "string" ? signer : active.address, 10, 6)
              : ""
          }
          fees={feeRows}
          feeChoice={feeChoice}
          feePick={feePick}
          onFeePick={setFeePick}
          memo={summary.memo}
          json={txJson}
          local={localSite}
          warnings={restWarnings}
        />
      ) : (
      <div className="flex flex-col gap-2.5 pt-3">
        {suspicious ? (
          <Callout tone="danger" title="This site's address looks suspicious">
            <p className="break-all font-mono text-[10.5px]">{current.origin}</p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {risk.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-1.5">
              Reject unless you opened this address yourself and trust it.
            </p>
          </Callout>
        ) : null}

        <h1 className="text-[17px] font-medium leading-tight tracking-[-0.025em] text-fg">
          {signIn
            ? "Sign in"
            : summary && summary.messages.length > 0
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

        {restWarnings.length > 0 && !blocked ? (
          <Callout compact tone="warning" title="Check before approving">
            <ul className="flex flex-col gap-0.5">
              {restWarnings.map((w) => (
                <li key={w} className="break-all leading-snug">
                  {w}
                </li>
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
                  <span className="block text-[12.5px] leading-snug text-fg [overflow-wrap:anywhere]">
                    {message.summary}
                  </span>
                  <ResolvedLines lines={summary.resolved?.[i]} className="mt-1 text-[11.5px]" />
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

        {signIn?.signIn.statement ? (
          <p className="text-[13px] leading-snug text-fg">{signIn.signIn.statement}</p>
        ) : null}
        {signIn?.message ? (
          <details className="rounded-[12px] border border-[var(--z-line)] px-3 py-2.5">
            <summary className="cursor-pointer select-none text-[12.5px] text-fg-muted">Show the signed message</summary>
            <pre className="mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug text-fg">
              {signIn.message}
            </pre>
          </details>
        ) : null}
        {txJson && !signIn ? <TxJson json={txJson} /> : null}

        {current.kind === "signArbitrary" && !signIn ? (
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
            {feeRows.map((fee) => (
              <KeyValueRow key={fee.label} label={fee.label} value={fee.value} />
            ))}
            {feeChoice ? (
              <div className="flex flex-col gap-1.5">
                <Segmented<FeePick>
                  size="sm"
                  className="w-full"
                  options={FEE_OPTIONS}
                  value={feePick}
                  onChange={setFeePick}
                />
                <p className="text-[10.5px] leading-snug text-fg-dim">{FEE_HINT[feePick]}</p>
              </div>
            ) : null}
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
      )}
    </ScreenScaffold>
  );
}

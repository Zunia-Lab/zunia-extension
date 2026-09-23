import { useMemo, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { ProposalInfo, ProposalStatus } from "../../../lib/chain-queries";
import { estimateFee, msgVote, type VoteOption as AminoVote } from "../../../lib/amino-tx";
import { formatUnits } from "../../../lib/format";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useProposals } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { IconGovernance } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";
import { ListSkeleton } from "../components/ListSkeleton";

type VoteOption = AminoVote;

const VOTE_LABELS: Record<VoteOption, string> = {
  yes: "Yes",
  no: "No",
  veto: "Veto",
  abstain: "Abstain",
};

const VOTE_GAS = 200_000;

const STATUS_TONE: Record<
  ProposalStatus,
  { label: string; tone: "accent" | "success" | "danger" | "neutral" }
> = {
  voting: { label: "Voting", tone: "accent" },
  deposit: { label: "Deposit", tone: "neutral" },
  passed: { label: "Passed", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  failed: { label: "Failed", tone: "danger" },
  unknown: { label: "Closed", tone: "neutral" },
};

/** The vote being prepared. One at a time: picking another replaces it. */
interface Ballot {
  key: string;
  option: VoteOption;
}

function proposalKey(proposal: ProposalInfo): string {
  return `${proposal.chainId}:${proposal.id}`;
}

function endsIn(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Ends ${days}d`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `Ends ${hours}h`;
}

const TALLY_SEGMENTS = [
  { key: "yes", className: "bg-accent" },
  { key: "no", className: "bg-[var(--z-fg-dim)]" },
  { key: "veto", className: "bg-[var(--z-danger)]" },
  { key: "abstain", className: "bg-[var(--z-line-strong)]" },
] as const;

/** Four-segment tally bar: yes, no, veto, abstain. */
function Tally({ tally }: { tally: NonNullable<ProposalInfo["tally"]> }) {
  return (
    <div className="mt-2.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--z-glass-2)]">
        {TALLY_SEGMENTS.map((segment) =>
          tally[segment.key] > 0 ? (
            <span
              key={segment.key}
              className={segment.className}
              // The share is data, so the width is the one value set inline.
              style={{ width: `${tally[segment.key] * 100}%` }}
            />
          ) : null,
        )}
      </div>
      <p className="mt-1.5 font-mono text-[9px] text-fg-dim">
        Yes {Math.round(tally.yes * 100)}% · No {Math.round(tally.no * 100)}% ·
        Veto {Math.round(tally.veto * 100)}%
      </p>
    </div>
  );
}

function ProposalItem({
  proposal,
  chainName,
  choice,
  voted,
  onChoose,
}: {
  proposal: ProposalInfo;
  chainName: string;
  /** The option picked on this proposal, when the active ballot is this one. */
  choice?: VoteOption;
  /** What this wallet voted from this screen, once broadcast. */
  voted?: VoteOption;
  onChoose: (option: VoteOption) => void;
}) {
  const status = STATUS_TONE[proposal.status];
  const open = proposal.status === "voting";
  const deadline = endsIn(proposal.votingEndTime);

  return (
    <article
      className={cn(
        "rounded-[14px] border px-3 py-2.5",
        choice
          ? "border-accent bg-[var(--z-state-selected)]"
          : open
            ? "border-[var(--z-line-strong)]"
            : "border-[var(--z-line)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[9.5px] text-fg-dim">
          #{proposal.id} {chainName}
        </span>
        <span className="shrink-0">
          {voted ? (
            <Pill tone="success">Voted {VOTE_LABELS[voted]}</Pill>
          ) : deadline && open ? (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-accent">
              {deadline}
            </span>
          ) : (
            <Pill tone={status.tone}>{status.label}</Pill>
          )}
        </span>
      </div>

      <h3 className="mt-1.5 line-clamp-3 break-words text-[13px] font-medium leading-snug text-fg">
        {proposal.title}
      </h3>

      {proposal.tally ? <Tally tally={proposal.tally} /> : null}

      {open ? (
        <div
          className="mt-2.5 grid grid-cols-4 gap-1.5"
          role="group"
          aria-label={`Vote on proposal ${proposal.id}`}
        >
          {(Object.keys(VOTE_LABELS) as VoteOption[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={choice === option}
              onClick={() => onChoose(option)}
              className={cn(
                "h-[30px] rounded-[9px] border text-[11px] font-medium",
                "transition-colors duration-[var(--z-duration-base)]",
                choice === option
                  ? "border-accent bg-accent text-[var(--z-accent-fg)]"
                  : "border-[var(--z-line)] text-fg-muted hover:bg-[var(--z-state-hover)]",
                focusRing,
              )}
            >
              {VOTE_LABELS[option]}
            </button>
          ))}
        </div>
      ) : null}
    </article>
  );
}

/** Governance across every enabled chain, open proposals first. */
export function GovernanceScreen({
  chains,
  onBack,
}: {
  chains: ChainAccountView[];
  onBack: () => void;
}) {
  const signedSend = useSignedSend();
  const toast = useToast();
  const { settings } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows, loading } = useProposals(chainIds, live);
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [voted, setVoted] = useState<Record<string, VoteOption>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const names = new Map(chains.map((c) => [c.chainId, c.entry.chainName]));
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const rank = (p: ProposalInfo) => (p.status === "voting" ? 0 : 1);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return Number(b.id) - Number(a.id);
      }),
    [rows],
  );

  const open = sorted.filter((p) => p.status === "voting");
  const proposal = ballot
    ? sorted.find((p) => proposalKey(p) === ballot.key)
    : undefined;
  const voterChain = proposal
    ? chains.find((c) => c.chainId === proposal.chainId)
    : undefined;
  const fee = estimateFee({
    gasLimit: VOTE_GAS,
    gasPrice: voterChain?.entry.gasPriceStep?.average ?? 0.025,
    denom: voterChain?.entry.feeMinimalDenom ?? "uatom",
  });
  const feeText = voterChain
    ? `${formatUnits(fee.amount[0]!.amount, voterChain.entry.feeDecimals)} ${voterChain.entry.feeDenom}`
    : null;

  function choose(key: string, option: VoteOption) {
    setError(null);
    setBallot((current) =>
      current?.key === key && current.option === option
        ? null
        : { key, option },
    );
  }

  async function signVote() {
    if (!ballot || !proposal || !voterChain?.address) return;
    setBusy(true);
    setError(null);
    try {
      const result = await signedSend<{ txhash: string }>(
        "SIGN_AND_BROADCAST",
        {
          chainId: proposal.chainId,
          signerAddress: voterChain.address,
          msgs: [
            msgVote({
              proposalId: proposal.id,
              voter: voterChain.address,
              option: ballot.option,
            }),
          ],
          fee,
          gasLimit: VOTE_GAS,
        },
      );
      setVoted((prev) => ({ ...prev, [ballot.key]: ballot.option }));
      setBallot(null);
      setTxHash(result.txhash);
      toast(`Voted ${VOTE_LABELS[ballot.option]} on #${proposal.id}`, {
        meta: truncateAddress(result.txhash, 6, 4),
      });
    } catch (err) {
      setError(signingError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScreenScaffold
      title="Governance"
      onBack={onBack}
      right={
        <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
          {open.length} open
        </span>
      }
      footer={
        ballot && proposal ? (
          <div className="flex flex-col gap-2">
            {error ? (
              <p role="alert" className="text-[11px] leading-snug text-[var(--z-danger)]">
                {error}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-3 font-mono text-[9.5px] text-fg-dim">
              <span className="min-w-0 truncate">
                #{proposal.id} {names.get(proposal.chainId) ?? proposal.chainId}
              </span>
              <span className="shrink-0">
                Fee <span className="text-fg-muted">{feeText ?? "unknown"}</span>
              </span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                className="flex-1"
                disabled={busy}
                onClick={() => {
                  setBallot(null);
                  setError(null);
                }}
              >
                Clear
              </Button>
              <Button
                className="min-w-0 flex-[2]"
                disabled={busy || !voterChain?.address}
                onClick={() => void signVote()}
              >
                <span className="min-w-0 truncate">
                  {busy
                    ? "Signing…"
                    : voterChain?.address
                      ? `Sign vote · ${VOTE_LABELS[ballot.option]}`
                      : "No account on this network"}
                </span>
              </Button>
            </div>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3 pt-1">
        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Proposals come from the same public endpoints as balances, so
            governance follows that opt-in in Preferences.
          </Callout>
        ) : null}

        {txHash ? (
          <Callout tone="info" title="Vote broadcast">
            Tx {truncateAddress(txHash, 10, 8)}. Inclusion still depends on the
            network.
          </Callout>
        ) : null}

        {loading ? (
          <ListSkeleton rows={4} avatar={false} label="Loading proposals" />
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<IconGovernance width={16} height={16} />}
            title="No proposals"
            description={
              live
                ? "None of the enabled chains returned a proposal."
                : "Turn on on-chain reads to load proposals for every enabled chain."
            }
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {sorted.map((item) => {
              const key = proposalKey(item);
              return (
                <li key={key}>
                  <ProposalItem
                    proposal={item}
                    chainName={names.get(item.chainId) ?? item.chainId}
                    choice={ballot?.key === key ? ballot.option : undefined}
                    voted={voted[key]}
                    onChoose={(option) => choose(key, option)}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {sorted.length > 0 ? (
          <Callout tone="neutral" title="Signed on this device">
            Votes build MsgVote amino, sign with the unlocked keyring, and post
            to the chain REST endpoint.
          </Callout>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

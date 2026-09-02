import { useMemo, useState } from "react";
import {
  Button,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  Spinner,
  cn,
  focusRing,
} from "@zunialab/ui";
import type { ProposalInfo, ProposalStatus } from "../../../lib/chain-queries";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useProposals } from "../hooks/useChainQuery";
import { usePrefs } from "../state/Prefs";
import { IconGovernance } from "./icons";

type VoteOption = "yes" | "no" | "veto" | "abstain";

const VOTE_LABELS: Record<VoteOption, string> = {
  yes: "Yes",
  no: "No",
  veto: "Veto",
  abstain: "Abstain",
};

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

function endsIn(iso?: string): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `Ends ${days}d`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `Ends ${hours}h`;
}

/** Four-segment tally bar: yes, no, veto, abstain. */
function Tally({ tally }: { tally: NonNullable<ProposalInfo["tally"]> }) {
  const segments = [
    { key: "yes", value: tally.yes, color: "var(--z-accent)" },
    { key: "no", value: tally.no, color: "var(--z-fg-dim)" },
    { key: "veto", value: tally.veto, color: "var(--z-danger)" },
    { key: "abstain", value: tally.abstain, color: "var(--z-line-strong)" },
  ];
  return (
    <div className="mt-2.5">
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--z-glass-2)]">
        {segments.map((segment) =>
          segment.value > 0 ? (
            <span
              key={segment.key}
              style={{
                width: `${segment.value * 100}%`,
                background: segment.color,
              }}
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
  vote,
  onVote,
}: {
  proposal: ProposalInfo;
  chainName: string;
  vote?: VoteOption;
  onVote: (option: VoteOption) => void;
}) {
  const status = STATUS_TONE[proposal.status];
  const open = proposal.status === "voting";
  const deadline = endsIn(proposal.votingEndTime);

  return (
    <article
      className={cn(
        "rounded-[14px] border px-3 py-2.5",
        open
          ? "border-[var(--z-line-strong)] bg-[var(--z-state-selected)]"
          : "border-[var(--z-line)]",
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[9.5px] text-fg-dim">
          #{proposal.id} {chainName}
        </span>
        <span className="shrink-0">
          {deadline && open ? (
            <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-accent">
              {deadline}
            </span>
          ) : (
            <Pill tone={status.tone}>{status.label}</Pill>
          )}
        </span>
      </div>

      <h3 className="mt-1.5 text-[13px] font-medium leading-snug text-fg">
        {proposal.title}
      </h3>

      {proposal.tally ? <Tally tally={proposal.tally} /> : null}

      {open ? (
        <div className="mt-2.5 grid grid-cols-4 gap-1.5">
          {(Object.keys(VOTE_LABELS) as VoteOption[]).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onVote(option)}
              className={cn(
                "h-[30px] rounded-[9px] border text-[11px] font-medium",
                "transition-colors duration-[var(--z-duration-base)]",
                vote === option
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
  const { settings } = usePrefs();
  const live = settings.liveBalances;
  const chainIds = useMemo(() => chains.map((c) => c.chainId), [chains]);
  const { rows, loading } = useProposals(chainIds, live);
  const [votes, setVotes] = useState<Record<string, VoteOption>>({});

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
  const selected = Object.entries(votes)[0];
  const selectedProposal = selected
    ? sorted.find((p) => `${p.chainId}:${p.id}` === selected[0])
    : undefined;

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
        selectedProposal && selected ? (
          <Button className="w-full" disabled>
            Sign vote · {VOTE_LABELS[selected[1]]}
          </Button>
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

        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
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
            {sorted.map((proposal) => {
              const key = `${proposal.chainId}:${proposal.id}`;
              return (
                <li key={key}>
                  <ProposalItem
                    proposal={proposal}
                    chainName={names.get(proposal.chainId) ?? proposal.chainId}
                    vote={votes[key]}
                    onVote={(option) => setVotes({ [key]: option })}
                  />
                </li>
              );
            })}
          </ul>
        )}

        {sorted.length > 0 ? (
          <Callout tone="neutral" title="Voting needs signing">
            Picking an option stages the vote locally. Broadcasting arrives with
            the signing path.
          </Callout>
        ) : null}
      </div>
    </ScreenScaffold>
  );
}

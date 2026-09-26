import { useEffect, useMemo, useState } from "react";
import {
  Button,
  TokenLogo,
  Callout,
  EmptyState,
  Pill,
  ScreenScaffold,
  SearchField,
  cn,
  focusRing,
  truncateAddress,
} from "@zunialab/ui";
import type { ProposalInfo, ProposalStatus } from "../../../lib/chain-queries";
import { estimateFee, msgVote, type VoteOption as AminoVote } from "../../../lib/amino-tx";
import { searchItems } from "../../../lib/picker";
import { resolveTxMemo } from "../../../lib/tx-memo";
import { PickerSheet, type PickerItem } from "../components/PickerSheet";
import type { ChainAccountView } from "../hooks/useChainAccounts";
import { useProposals } from "../hooks/useChainQuery";
import { GasFeePrefs } from "../components/GasFeePrefs";
import { usePrefs } from "../state/Prefs";
import { useToast } from "../state/Toasts";
import { IconChevronDown, IconGovernance } from "./icons";
import { signingError, useSignedSend } from "../state/SigningPassword";
import { CardSkeleton } from "../components/ListSkeleton";
import { MarkdownBody } from "../components/MarkdownBody";

const ALL_NETWORKS = "all-networks";
const PAGE_SIZE = 10;

const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "voting", label: "Voting" },
  { id: "passed", label: "Passed" },
  { id: "rejected", label: "Rejected" },
  { id: "deposit", label: "Deposit" },
] as const;

type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

type VoteOption = AminoVote;

const VOTE_LABELS: Record<VoteOption, string> = {
  yes: "Yes",
  no: "No",
  veto: "Veto",
  abstain: "Abstain",
};

const VOTE_HINTS: Record<VoteOption, string> = {
  yes: "Support this proposal",
  no: "Reject this proposal",
  veto: "Reject as spam or harmful",
  abstain: "Count toward quorum",
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

function NetworkFilter({
  chains,
  value,
  onChange,
}: {
  chains: readonly ChainAccountView[];
  value: string | null;
  onChange: (chainId: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const active = value ? chains.find((chain) => chain.chainId === value) : undefined;
  const items = useMemo<PickerItem[]>(
    () => [
      {
        id: ALL_NETWORKS,
        label: "All networks",
        sublabel: `${chains.length} enabled`,
        keywords: ["all", "every"],
      },
      ...chains.map((chain) => ({
        id: chain.chainId,
        label: chain.entry.chainName,
        sublabel: chain.chainId,
        keywords: [chain.entry.coinDenom, chain.chainId],
        icon: (
          <TokenLogo
            src={chain.iconUrl}
            symbol={chain.entry.chainName}
            size={26}
            verified={chain.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        ),
      })),
    ],
    [chains],
  );

  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Show proposals on ${active?.entry.chainName ?? "all networks"}`}
        onClick={() => setOpen(true)}
        className={cn(
          "flex items-center gap-1.5 rounded-full border border-[var(--z-line)] py-1 pl-2 pr-1.5",
          "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
          focusRing,
        )}
      >
        {active ? (
          <TokenLogo
            src={active.iconUrl}
            symbol={active.entry.chainName}
            size={16}
            verified={active.entry.inCosmosRegistry}
            verifiedLabel="Listed in the Cosmos chain registry"
          />
        ) : null}
        <span className="max-w-[92px] truncate text-[11px] text-fg-muted">
          {active?.entry.chainName ?? "All"}
        </span>
        <IconChevronDown width={16} height={16} className="text-fg-dim" />
      </button>
      <PickerSheet
        open={open}
        onClose={() => setOpen(false)}
        title="Show proposals on"
        items={items}
        selectedId={value ?? ALL_NETWORKS}
        searchPlaceholder="Search networks"
        onSelect={(id) => onChange(id === ALL_NETWORKS ? null : id)}
      />
    </>
  );
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
  { key: "yes", label: "Yes", className: "bg-accent" },
  { key: "no", label: "No", className: "bg-[var(--z-fg-dim)]" },
  { key: "veto", label: "Veto", className: "bg-[var(--z-danger)]" },
  { key: "abstain", label: "Abstain", className: "bg-[var(--z-line-strong)]" },
] as const;

function sharePct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function tallyWinner(tally: NonNullable<ProposalInfo["tally"]>) {
  return TALLY_SEGMENTS.reduce((best, row) =>
    tally[row.key] > tally[best.key] ? row : best,
  );
}

function TallyBar({ tally }: { tally: NonNullable<ProposalInfo["tally"]> }) {
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--z-glass-2)]">
      {TALLY_SEGMENTS.map((segment) =>
        tally[segment.key] > 0 ? (
          <span
            key={segment.key}
            className={segment.className}
            style={{ width: `${tally[segment.key] * 100}%` }}
          />
        ) : null,
      )}
    </div>
  );
}

/** Compact bar for the proposal list. */
function Tally({ tally }: { tally: NonNullable<ProposalInfo["tally"]> }) {
  return (
    <div className="mt-2.5">
      <TallyBar tally={tally} />
      <p className="mt-1.5 break-words font-mono text-[9px] text-fg-dim [overflow-wrap:anywhere]">
        Yes {sharePct(tally.yes)} · No {sharePct(tally.no)} · Veto{" "}
        {sharePct(tally.veto)} · Abstain {sharePct(tally.abstain)}
      </p>
    </div>
  );
}

/** Full result for a closed proposal, or a live read while voting. */
function TallyResult({
  tally,
  status,
  ended,
}: {
  tally: NonNullable<ProposalInfo["tally"]>;
  status: ProposalStatus;
  ended: boolean;
}) {
  const winner = tallyWinner(tally);
  const headline = ended
    ? STATUS_TONE[status].label
    : `${winner.label} leading`;
  return (
    <section className="rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
            {ended ? "Result" : "Tally"}
          </p>
          <p className="mt-1 text-[18px] font-semibold tracking-tight text-fg">
            {headline}
          </p>
          <p className="mt-0.5 font-mono text-[10.5px] text-fg-muted">
            {winner.label} {sharePct(tally[winner.key])}
          </p>
        </div>
        <Pill tone={STATUS_TONE[status].tone}>{STATUS_TONE[status].label}</Pill>
      </div>
      <div className="mt-3">
        <TallyBar tally={tally} />
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {TALLY_SEGMENTS.map((segment) => (
          <li key={segment.key} className="flex items-center gap-2">
            <span className={cn("size-1.5 shrink-0 rounded-full", segment.className)} />
            <span className="w-14 shrink-0 font-mono text-[10px] text-fg-dim">
              {segment.label}
            </span>
            <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--z-glass-2)]">
              <span
                className={cn("block h-full rounded-full", segment.className)}
                style={{ width: `${Math.max(tally[segment.key] * 100, tally[segment.key] > 0 ? 2 : 0)}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-fg">
              {sharePct(tally[segment.key])}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ProposalItem({
  proposal,
  chainName,
  voted,
  onOpen,
}: {
  proposal: ProposalInfo;
  chainName: string;
  voted?: VoteOption;
  onOpen: () => void;
}) {
  const status = STATUS_TONE[proposal.status];
  const open = proposal.status === "voting";
  const deadline = endsIn(proposal.votingEndTime);

  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "w-full min-w-0 overflow-hidden rounded-[14px] border px-3 py-2.5 text-left",
        "transition-colors duration-[var(--z-duration-base)] hover:bg-[var(--z-state-hover)]",
        open ? "border-[var(--z-line-strong)]" : "border-[var(--z-line)]",
        focusRing,
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

      <h3 className="mt-1.5 line-clamp-3 min-w-0 break-words text-[13px] font-medium leading-snug text-fg [overflow-wrap:anywhere]">
        {proposal.title}
      </h3>

      {proposal.tally ? <Tally tally={proposal.tally} /> : null}

      <p className="mt-2 font-mono text-[9.5px] text-accent">
        {open ? "Open details and vote" : "Open details"}
      </p>
    </button>
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
  const [network, setNetwork] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [openedKey, setOpenedKey] = useState<string | null>(null);
  const [ballot, setBallot] = useState<Ballot | null>(null);
  const [voted, setVoted] = useState<Record<string, VoteOption>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const names = useMemo(
    () => new Map(chains.map((c) => [c.chainId, c.entry.chainName])),
    [chains],
  );
  const denoms = useMemo(
    () => new Map(chains.map((c) => [c.chainId, c.entry.coinDenom])),
    [chains],
  );
  const networkFilter = network && chainIds.includes(network) ? network : null;
  const sorted = useMemo(() => {
    const scoped = rows.filter((proposal) => {
      if (networkFilter && proposal.chainId !== networkFilter) return false;
      if (statusFilter !== "all" && proposal.status !== statusFilter) return false;
      return true;
    });
    const ranked = [...scoped].sort((a, b) => {
      const rank = (p: ProposalInfo) => (p.status === "voting" ? 0 : 1);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      return Number(b.id) - Number(a.id);
    });
    return searchItems(
      ranked.map((proposal) => ({
        id: proposalKey(proposal),
        label: proposal.title,
        sublabel: `#${proposal.id}`,
        keywords: [
          proposal.id,
          `#${proposal.id}`,
          proposal.chainId,
          names.get(proposal.chainId) ?? "",
          denoms.get(proposal.chainId) ?? "",
          proposal.status,
          STATUS_TONE[proposal.status].label,
          proposal.summary.slice(0, 280),
        ],
        proposal,
      })),
      query,
    ).map((item) => item.proposal);
  }, [rows, networkFilter, statusFilter, query, names, denoms]);
  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [networkFilter, statusFilter, query]);
  const shown = sorted.slice(0, visible);
  const hasMore = visible < sorted.length;
  const searching = query.trim().length > 0 || statusFilter !== "all";

  const open = rows.filter(
    (p) => p.status === "voting" && (!networkFilter || p.chainId === networkFilter),
  );
  const opened = openedKey
    ? rows.find((p) => proposalKey(p) === openedKey)
    : undefined;
  const proposal = opened
    ?? (ballot ? rows.find((p) => proposalKey(p) === ballot.key) : undefined);
  const voterChain = proposal
    ? chains.find((c) => c.chainId === proposal.chainId)
    : undefined;
  const fee = estimateFee({
    gasLimit: Math.max(1, Math.ceil(VOTE_GAS * settings.gasAdjustment)),
    gasPrice: voterChain?.entry.gasPriceStep?.[settings.feeSpeed] ?? 0.025,
    denom: voterChain?.entry.feeMinimalDenom ?? "uatom",
  });
  function choose(key: string, option: VoteOption) {
    setError(null);
    setBallot((current) =>
      current?.key === key && current.option === option
        ? null
        : { key, option },
    );
  }

  function closeDetail() {
    setOpenedKey(null);
    setBallot(null);
    setError(null);
  }

  async function signVote() {
    if (!ballot || !proposal || !voterChain?.address) return;
    setBusy(true);
    setError(null);
    try {
      const msgs = [
        msgVote({
          proposalId: proposal.id,
          voter: voterChain.address,
          option: ballot.option,
        }),
      ];
      const result = await signedSend<{ txhash: string }>(
        "SIGN_AND_BROADCAST",
        {
          chainId: proposal.chainId,
          signerAddress: voterChain.address,
          msgs,
          memo: resolveTxMemo("", msgs),
          fee,
          gasLimit: VOTE_GAS,
        },
      );
      setVoted((prev) => ({ ...prev, [ballot.key]: ballot.option }));
      setBallot(null);
      toast(`Voted ${VOTE_LABELS[ballot.option]} on #${proposal.id}`, {
        meta: truncateAddress(result.txhash, 10, 8),
        detail: "Inclusion still depends on the network.",
        alert: true,
      });
    } catch (err) {
      const message = signingError(err);
      setError(message);
      if (message) toast(message, { tone: "danger" });
    } finally {
      setBusy(false);
    }
  }

  if (opened) {
    const status = STATUS_TONE[opened.status];
    const open = opened.status === "voting";
    const ended = !open && opened.status !== "deposit";
    const key = proposalKey(opened);
    const choice = ballot?.key === key ? ballot.option : undefined;
    const already = voted[key];
    const deadline = endsIn(opened.votingEndTime);
    const chain = chains.find((row) => row.chainId === opened.chainId);
    return (
      <ScreenScaffold
        title={`#${opened.id}`}
        onBack={closeDetail}
        footer={
          open && !already && choice ? (
            <div className="flex flex-col gap-2">
              {error ? (
                <p role="alert" className="text-[11px] leading-snug text-[var(--z-danger)]">
                  {error}
                </p>
              ) : (
                <>
                  <div className="rounded-[12px] border border-[var(--z-line)] px-2.5 py-2">
                    <GasFeePrefs
                      feeAmount={fee.amount[0]?.amount}
                      feeDecimals={voterChain?.entry.feeDecimals ?? 6}
                      feeSymbol={voterChain?.entry.feeDenom ?? "ATOM"}
                    />
                  </div>
                  <p className="break-words font-mono text-[9.5px] text-fg-dim [overflow-wrap:anywhere]">
                    Vote {VOTE_LABELS[choice]}
                    {" · "}
                    {resolveTxMemo("", [
                      msgVote({
                        proposalId: opened.id,
                        voter: voterChain?.address ?? "",
                        option: choice,
                      }),
                    ])}
                  </p>
                </>
              )}
              <Button
                className="w-full"
                disabled={busy || !voterChain?.address}
                onClick={() => void signVote()}
              >
                {busy
                  ? "Signing…"
                  : voterChain?.address
                    ? `Sign vote · ${VOTE_LABELS[choice]}`
                    : "No account on this network"}
              </Button>
            </div>
          ) : error && open ? (
            <p role="alert" className="text-[11px] leading-snug text-[var(--z-danger)]">
              {error}
            </p>
          ) : undefined
        }
      >
        <div className="flex min-w-0 flex-col gap-3.5 pt-1">
          <div className="flex min-w-0 items-center gap-2.5">
            {chain ? (
              <TokenLogo
                src={chain.iconUrl}
                symbol={chain.entry.chainName}
                size={28}
                verified={chain.entry.inCosmosRegistry}
                verifiedLabel="Listed in the Cosmos chain registry"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-fg">
                {chain?.entry.chainName ?? names.get(opened.chainId) ?? opened.chainId}
              </p>
              <p className="mt-0.5 font-mono text-[10px] text-fg-dim">
                {deadline && open
                  ? deadline
                  : opened.votingEndTime
                    ? `Ended ${new Date(opened.votingEndTime).toLocaleDateString()}`
                    : opened.chainId}
              </p>
            </div>
            {already ? (
              <Pill tone="success">Voted {VOTE_LABELS[already]}</Pill>
            ) : (
              <Pill tone={status.tone}>{status.label}</Pill>
            )}
          </div>

          <h2 className="min-w-0 break-words text-[17px] font-semibold leading-snug tracking-[-0.03em] text-fg [overflow-wrap:anywhere]">
            {opened.title}
          </h2>

          {ended && opened.tally ? (
            <TallyResult tally={opened.tally} status={opened.status} ended />
          ) : ended ? (
            <section className="rounded-[16px] border border-[var(--z-line)] bg-[var(--z-glass)] px-3.5 py-3">
              <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                Result
              </p>
              <p className="mt-1 text-[18px] font-semibold tracking-tight text-fg">
                {status.label}
              </p>
            </section>
          ) : null}

          {opened.summary ? (
            <section className="min-w-0 overflow-hidden rounded-[16px] border border-[var(--z-line)] px-3.5 py-3.5">
              <p className="mb-3 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                Proposal
              </p>
              <MarkdownBody text={opened.summary} />
            </section>
          ) : (
            <p className="text-[12px] text-fg-dim">
              No description was published with this proposal.
            </p>
          )}

          {open && opened.tally ? (
            <TallyResult tally={opened.tally} status={opened.status} ended={false} />
          ) : null}

          {open && !already ? (
            <section>
              <p className="mb-2 font-mono text-[9px] uppercase tracking-[0.16em] text-fg-dim">
                Your vote
              </p>
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label={`Vote on proposal ${opened.id}`}
              >
                {(Object.keys(VOTE_LABELS) as VoteOption[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={choice === option}
                    onClick={() => choose(key, option)}
                    className={cn(
                      "flex flex-col items-start rounded-[14px] border px-3 py-2.5 text-left",
                      "transition-colors duration-[var(--z-duration-base)]",
                      choice === option
                        ? "border-transparent bg-[var(--z-button)] text-[var(--z-button-fg)]"
                        : "border-[var(--z-line)] bg-[var(--z-glass)] text-fg hover:bg-[var(--z-state-hover)]",
                      focusRing,
                    )}
                  >
                    <span className="text-[13.5px] font-semibold tracking-tight">
                      {VOTE_LABELS[option]}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 text-[10.5px] leading-snug",
                        choice === option ? "opacity-80" : "text-fg-dim",
                      )}
                    >
                      {VOTE_HINTS[option]}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </ScreenScaffold>
    );
  }

  return (
    <ScreenScaffold
      title="Governance"
      onBack={onBack}
      right={
        <div className="flex min-w-0 shrink-0 items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-fg-dim">
            {open.length} open
          </span>
          {chains.length > 0 ? (
            <NetworkFilter chains={chains} value={networkFilter} onChange={setNetwork} />
          ) : null}
        </div>
      }
      toolbar={
        !loading && rows.length > 0 ? (
          <div className="flex min-w-0 flex-col gap-2">
            <SearchField
              compact
              value={query}
              onValueChange={setQuery}
              placeholder="Search title, #id, or network"
            />
            <ul className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5">
              {STATUS_FILTERS.map((option) => (
                <li key={option.id}>
                  <button
                    type="button"
                    aria-pressed={option.id === statusFilter}
                    onClick={() => setStatusFilter(option.id)}
                    className={cn(
                      "whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[9.5px] uppercase tracking-[0.08em]",
                      "transition-colors duration-[var(--z-duration-base)]",
                      option.id === statusFilter
                        ? "border-[color-mix(in_srgb,var(--z-accent)_55%,transparent)] bg-[var(--z-state-selected)] text-fg"
                        : "border-[var(--z-line)] text-fg-dim hover:text-fg",
                      focusRing,
                    )}
                  >
                    {option.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : undefined
      }
      footer={undefined}
    >
      <div className="flex min-w-0 flex-col gap-3 pt-1">
        {!live ? (
          <Callout tone="info" title="On-chain reads are off">
            Proposals come from the same public endpoints as balances, so
            governance follows that opt-in in Preferences.
          </Callout>
        ) : null}

        {loading ? (
          <CardSkeleton rows={4} tally label="Loading proposals" />
        ) : sorted.length === 0 && searching ? (
          <p className="py-6 text-center text-[12px] text-fg-muted">
            {query.trim()
              ? <>Nothing matches &ldquo;{query.trim()}&rdquo;.</>
              : "Nothing here with this filter."}
          </p>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={<IconGovernance width={16} height={16} />}
            title="No proposals"
            description={
              live
                ? networkFilter
                  ? `No proposals on ${names.get(networkFilter) ?? networkFilter}.`
                  : "None of the enabled chains returned a proposal."
                : "Turn on on-chain reads to load proposals for every enabled chain."
            }
          />
        ) : (
          <>
            <ul className="flex min-w-0 flex-col gap-2">
              {shown.map((item) => {
                const key = proposalKey(item);
                return (
                  <li key={key} className="min-w-0">
                    <ProposalItem
                      proposal={item}
                      chainName={names.get(item.chainId) ?? item.chainId}
                      voted={voted[key]}
                      onOpen={() => {
                        setOpenedKey(key);
                        setBallot(null);
                        setError(null);
                      }}
                    />
                  </li>
                );
              })}
            </ul>
            {hasMore ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setVisible((n) => n + PAGE_SIZE)}
              >
                Load more
              </Button>
            ) : null}
          </>
        )}

      </div>
    </ScreenScaffold>
  );
}
